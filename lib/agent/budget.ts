import { cacheGet, cacheSet } from "@/lib/cache";
import { log } from "@/lib/log";

/**
 * A hard cap on AI spend, kept in the app so it holds even if the AI Gateway
 * budget isn't set. Austin's limit is $10 a month (2026-10-21); $0.30 a day
 * keeps any month under it. When the day's spend reaches the cap, the agent and
 * the model blurbs switch off and the planner works as it did before #7.
 *
 * The counter lives in the Runtime Cache, so concurrent requests can each read
 * the same total before writing; with a few cents per plan that overshoots by
 * cents at most. Override with AI_DAILY_BUDGET_USD.
 */
export const DAILY_BUDGET_USD = Number(process.env.AI_DAILY_BUDGET_USD ?? 0.3);

// Prices per token. The fallback model (Gemini 2.5 Flash) costs more than the
// primary, so every call is charged at the higher price.
const INPUT_USD = 0.3 / 1_000_000;
const OUTPUT_USD = 2.5 / 1_000_000;

function dayKey(now = new Date()): string {
  return `ai-spend:${now.toISOString().slice(0, 10)}`;
}

export async function spentToday(): Promise<number> {
  return (await cacheGet<number>(dayKey())) ?? 0;
}

export async function budgetLeft(): Promise<boolean> {
  return (await spentToday()) < DAILY_BUDGET_USD;
}

export function costOf(usage: { inputTokens?: number; outputTokens?: number } | undefined): number {
  return (usage?.inputTokens ?? 0) * INPUT_USD + (usage?.outputTokens ?? 0) * OUTPUT_USD;
}

export async function recordSpend(usage: { inputTokens?: number; outputTokens?: number } | undefined, what: string): Promise<void> {
  const cost = costOf(usage);
  if (cost <= 0) return;
  const total = (await spentToday()) + cost;
  // Two days, so the key outlives the day it counts.
  await cacheSet(dayKey(), total, 2 * 24 * 60 * 60, ["ai-spend"]);
  log("info", "ai-spend", { what, cost: Number(cost.toFixed(5)), today: Number(total.toFixed(4)) });
}
