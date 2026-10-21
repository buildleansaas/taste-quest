import { cacheGet, cacheSet } from "@/lib/cache";
import { log } from "@/lib/log";

/**
 * The app's own cap on AI spend: $0.30 a day keeps a month under Austin's $10
 * (2026-10-21). It is best-effort: the counter lives in the Runtime Cache,
 * which is regional and evictable, so two instances can race. The AI Gateway's
 * own credit balance or spend limit is the hard backstop.
 *
 * Within one instance it holds:
 * - Every model call **reserves** a hold before it starts (taken under a
 *   per-instance lock, so concurrent requests can't all pass the check).
 * - Steps are counted as they finish. A run whose usage reaches its hold is
 *   stopped (see `over`), so one run costs at most its hold plus one step.
 * - A failed run keeps its whole hold: a provider may bill tokens we never saw.
 *   A successful run refunds what it didn't use.
 * - At most MAX_IN_FLIGHT model runs at once per instance, and DAILY_RUNS
 *   agent runs a day.
 * - Prices are per model; an unknown model is refused rather than undercounted.
 * Override the cap with AI_DAILY_BUDGET_USD (a bad value turns AI off).
 */
const parsed = Number(process.env.AI_DAILY_BUDGET_USD ?? 0.3);
export const DAILY_BUDGET_USD = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
export const DAILY_RUNS = 300;
export const MAX_IN_FLIGHT = 2;

/** USD per token, from https://ai-gateway.vercel.sh/v1/models (read 2026-10-21). */
const PRICES: Record<string, { input: number; output: number }> = {
  "google/gemini-2.5-flash": { input: 0.3 / 1e6, output: 2.5 / 1e6 },
  "google/gemini-2.5-flash-lite": { input: 0.1 / 1e6, output: 0.4 / 1e6 },
  // Not served on the free tier; priced for when paid credits exist.
  "anthropic/claude-haiku-5.5": { input: 0.1 / 1e6, output: 0.5 / 1e6 },
};

/** The dearer of the primary and its fallback: a call may be served by either. */
export function priceFor(models: string[]): { input: number; output: number } | null {
  const known = models.map((model) => PRICES[model]);
  if (known.some((price) => !price)) return null;
  return {
    input: Math.max(...known.map((price) => price!.input)),
    output: Math.max(...known.map((price) => price!.output)),
  };
}

type Usage = { inputTokens?: number; outputTokens?: number } | undefined;

export function costOf(usage: Usage, price: { input: number; output: number }): number {
  return (usage?.inputTokens ?? 0) * price.input + (usage?.outputTokens ?? 0) * price.output;
}

function dayKey(now = new Date()): string {
  // AI_BUDGET_KEY_SUFFIX gives each test its own counter.
  return `ai-day:${now.toISOString().slice(0, 10)}${process.env.AI_BUDGET_KEY_SUFFIX ?? ""}`;
}

type Day = { usd: number; runs: number };

// Every read-modify-write of the day's counter goes through this chain, so
// concurrent requests on one instance can't overwrite each other's updates.
let chain: Promise<unknown> = Promise.resolve();
function locked<T>(work: () => Promise<T>): Promise<T> {
  const next = chain.then(work, work);
  chain = next.catch(() => undefined);
  return next;
}

async function readDay(): Promise<Day> {
  return (await cacheGet<Day>(dayKey())) ?? { usd: 0, runs: 0 };
}

async function writeDay(day: Day): Promise<void> {
  // Two days, so the key outlives the day it counts.
  await cacheSet(dayKey(), day, 2 * 24 * 60 * 60, ["ai-spend"]);
}

function addToDay(usd: number): Promise<Day> {
  return locked(async () => {
    const day = await readDay();
    const next = { usd: Math.max(0, day.usd + usd), runs: day.runs };
    await writeDay(next);
    return next;
  });
}

export async function spentToday(): Promise<number> {
  return (await locked(readDay)).usd;
}

let inFlight = 0;

export type Reservation = {
  /** Record one finished step's real usage. */
  step: (usage: Usage) => Promise<void>;
  /** True once usage has reached the hold: stop the run. */
  over: () => boolean;
  /** Close the run. A failed run keeps its whole hold; a good one refunds the unused part. */
  settle: (failed: boolean) => Promise<void>;
};

/**
 * Reserve a hold before calling a model. Returns null (call nothing) when the
 * day's cap or run count is reached, when MAX_IN_FLIGHT runs are already open
 * on this instance, or when a model has no known price.
 */
export async function reserve(
  what: string,
  models: string[],
  hold: { inputTokens: number; outputTokens: number },
  opts: { countRun?: boolean } = {},
): Promise<Reservation | null> {
  const price = priceFor(models);
  if (!price || DAILY_BUDGET_USD <= 0) return null;
  // Take the slot before any await, so concurrent callers see it.
  if (inFlight >= MAX_IN_FLIGHT) return null;
  inFlight += 1;
  const held = costOf(hold, price);
  const granted = await locked(async () => {
    const day = await readDay();
    if (day.usd + held > DAILY_BUDGET_USD) return false;
    if (opts.countRun && day.runs >= DAILY_RUNS) return false;
    await writeDay({ usd: day.usd + held, runs: day.runs + (opts.countRun ? 1 : 0) });
    return true;
  });
  if (!granted) {
    inFlight -= 1;
    return null;
  }
  let used = 0;
  let done = false;
  return {
    step: async (usage) => {
      const cost = costOf(usage, price);
      const before = used;
      used += cost;
      // Only the part past the hold is new spend; the hold already counts the rest.
      const extra = Math.max(0, used - Math.max(before, held));
      if (extra > 0) await addToDay(extra);
    },
    over: () => used >= held,
    settle: async (failed) => {
      if (done) return;
      done = true;
      inFlight -= 1;
      const refund = failed ? 0 : Math.max(0, held - used);
      const day = refund ? await addToDay(-refund) : await locked(readDay);
      log("info", "ai-spend", { what, used: Number(used.toFixed(5)), held: Number(held.toFixed(5)), failed, today: Number(day.usd.toFixed(4)) });
    },
  };
}
