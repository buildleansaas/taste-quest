import { beforeEach, describe, expect, it, vi } from "vitest";

const HAIKU = "anthropic/claude-haiku-5.5";
const FLASH = "google/gemini-2.5-flash";

// Fresh modules per test: the day's counter lives in lib/cache's memory map.
async function load() {
  vi.resetModules();
  return import("@/lib/agent/budget");
}

describe("AI spend cap", () => {
  beforeEach(() => {
    delete process.env.AI_DAILY_BUDGET_USD;
    process.env.AI_BUDGET_KEY_SUFFIX = `:${Math.random()}`;
  });

  it("charges the dearer model's price and settles to what was used", async () => {
    const budget = await load();
    const run = await budget.reserve("test", [HAIKU, FLASH], { inputTokens: 60_000, outputTokens: 4_000 });
    expect(run).not.toBeNull();
    // The reservation (worst case at Flash prices) is held while the run is open.
    expect(await budget.spentToday()).toBeCloseTo(60_000 * 0.3e-6 + 4_000 * 2.5e-6, 6);
    await run!.step({ inputTokens: 1_000, outputTokens: 100 });
    await run!.settle(false);
    expect(await budget.spentToday()).toBeCloseTo(1_000 * 0.3e-6 + 100 * 2.5e-6, 6);
  });

  it("a failed run keeps its whole reservation, since the provider may have billed", async () => {
    const budget = await load();
    const run = await budget.reserve("test", [HAIKU, FLASH], { inputTokens: 10_000, outputTokens: 1_000 });
    await run!.step({ inputTokens: 500, outputTokens: 50 });
    await run!.settle(true);
    expect(await budget.spentToday()).toBeCloseTo(10_000 * 0.3e-6 + 1_000 * 2.5e-6, 6);
  });

  it("steps past the reservation are charged as they happen", async () => {
    const budget = await load();
    const run = await budget.reserve("test", [HAIKU], { inputTokens: 1_000, outputTokens: 0 });
    await run!.step({ inputTokens: 3_000, outputTokens: 0 });
    expect(await budget.spentToday()).toBeCloseTo(3_000 * 0.1e-6, 9);
    await run!.settle(false);
    expect(await budget.spentToday()).toBeCloseTo(3_000 * 0.1e-6, 9);
  });

  it("refuses a model with no known price", async () => {
    const budget = await load();
    expect(await budget.reserve("test", ["openai/gpt-5-mini"], { inputTokens: 10, outputTokens: 10 })).toBeNull();
  });

  it("refuses once the day's cap would be passed", async () => {
    process.env.AI_DAILY_BUDGET_USD = "0.01";
    const budget = await load();
    // $0.007 fits under $0.01; a second $0.007 would not.
    const first = await budget.reserve("test", [FLASH], { inputTokens: 0, outputTokens: 2_800 });
    expect(first).not.toBeNull();
    await first!.settle(true);
    expect(await budget.reserve("test", [FLASH], { inputTokens: 0, outputTokens: 2_800 })).toBeNull();
  });

  it("a bad AI_DAILY_BUDGET_USD turns AI off rather than lifting the cap", async () => {
    process.env.AI_DAILY_BUDGET_USD = "lots";
    const budget = await load();
    expect(await budget.reserve("test", [HAIKU], { inputTokens: 10, outputTokens: 10 })).toBeNull();
  });

  it("allows only two runs in flight at once", async () => {
    const budget = await load();
    const size = { inputTokens: 100, outputTokens: 10 };
    const a = await budget.reserve("test", [HAIKU], size);
    const b = await budget.reserve("test", [HAIKU], size);
    expect(a && b).toBeTruthy();
    expect(await budget.reserve("test", [HAIKU], size)).toBeNull();
    await a!.settle(false);
    expect(await budget.reserve("test", [HAIKU], size)).not.toBeNull();
  });
});
