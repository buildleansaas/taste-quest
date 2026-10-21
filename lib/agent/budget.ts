import { cacheGet, cacheSet } from "@/lib/cache";
import { log } from "@/lib/log";

/**
 * The app's own cap on AI spend: $0.30 a day keeps a month under Austin's $10
 * (2026-10-21). It works with or without the AI Gateway budget, but it is a
 * best-effort counter in the Runtime Cache (evictable, not atomic), so the
 * Gateway's own spend limit or credit balance is the hard backstop.
 *
 * How it holds:
 * - Every model call **reserves** its worst-case cost before it starts and
 *   settles to the real cost after, so a call that times out or errors after
 *   billed steps is still counted (at the reservation).
 * - Spend is recorded **per step** as each one finishes, not once at the end.
 * - At most MAX_IN_FLIGHT model runs at once per instance, and at most
 *   DAILY_RUNS runs a day, so concurrent requests can overshoot by cents.
 * - Prices are per model; an unknown model is refused rather than undercounted.
 * Override the cap with AI_DAILY_BUDGET_USD (a bad value turns AI off).
 */
const parsed = Number(process.env.AI_DAILY_BUDGET_USD ?? 0.3);
export const DAILY_BUDGET_USD = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
export const DAILY_RUNS = 300;
export const MAX_IN_FLIGHT = 2;

/** USD per token, from the AI Gateway price list (2026-10-21). */
const PRICES: Record<string, { input: number; output: number }> = {
  "google/gemini-2.5-flash": { input: 0.3 / 1e6, output: 2.5 / 1e6 },
  "google/gemini-2.5-flash-lite": { input: 0.1 / 1e6, output: 0.4 / 1e6 },
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
  return `${now.toISOString().slice(0, 10)}${process.env.AI_BUDGET_KEY_SUFFIX ?? ""}`;
}

type Day = { usd: number; runs: number };

async function readDay(): Promise<Day> {
  return (await cacheGet<Day>(`ai-day:${dayKey()}`)) ?? { usd: 0, runs: 0 };
}

async function addToDay(usd: number, runs: number): Promise<Day> {
  const day = await readDay();
  const next = { usd: Math.max(0, day.usd + usd), runs: day.runs + runs };
  // Two days, so the key outlives the day it counts.
  await cacheSet(`ai-day:${dayKey()}`, next, 2 * 24 * 60 * 60, ["ai-spend"]);
  return next;
}

export async function spentToday(): Promise<number> {
  return (await readDay()).usd;
}

let inFlight = 0;

export type Reservation = {
  /** Record one finished step's real usage. */
  step: (usage: Usage) => Promise<void>;
  /** Release the reservation; whatever was reserved and not yet covered by steps stays charged if `failed`. */
  settle: (failed: boolean) => Promise<void>;
};

/**
 * Reserve a run's worst case before calling a model. Returns null (call
 * nothing) when the day's cap or run count is reached, when too many runs are
 * in flight on this instance, or when a model has no known price.
 */
export async function reserve(what: string, models: string[], worstCase: { inputTokens: number; outputTokens: number }): Promise<Reservation | null> {
  const price = priceFor(models);
  if (!price || DAILY_BUDGET_USD <= 0) return null;
  if (inFlight >= MAX_IN_FLIGHT) return null;
  const held = costOf(worstCase, price);
  const day = await readDay();
  if (day.usd + held > DAILY_BUDGET_USD || day.runs >= DAILY_RUNS) return null;
  inFlight += 1;
  await addToDay(held, 1);
  let used = 0;
  let done = false;
  return {
    step: async (usage) => {
      const cost = costOf(usage, price);
      used += cost;
      // Steps past the reservation are charged as they happen.
      if (used > held) await addToDay(Math.min(cost, used - held), 0);
    },
    settle: async (failed) => {
      if (done) return;
      done = true;
      inFlight -= 1;
      // On success, hand back what the run didn't use. On failure keep the
      // whole reservation: a provider may have billed tokens we never saw.
      const refund = failed ? 0 : Math.max(0, held - used);
      const day = refund ? await addToDay(-refund, 0) : await readDay();
      log("info", "ai-spend", { what, used: Number(used.toFixed(5)), held: Number(held.toFixed(5)), failed, today: Number(day.usd.toFixed(4)) });
    },
  };
}
