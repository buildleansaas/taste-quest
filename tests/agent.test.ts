import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { agentWalk } from "@/lib/agent/planner";
import { demoProfile, DEMO_START } from "@/lib/taste/curated";
import type { PlanInput } from "@/lib/plan/build";

type Call = { tool: string; input: unknown };

// A scripted model: each generate call returns the next tool call (or text to
// stop). `next` may read the previous tool results to pick real ids.
function scripted(next: (results: unknown[]) => Call | "stop" | Error) {
  return new MockLanguageModelV4({
    doGenerate: async (options) => {
      const results: unknown[] = [];
      for (const message of options.prompt) {
        if (message.role !== "tool") continue;
        for (const part of message.content) if (part.type === "tool-result") results.push(part.output);
      }
      const step = next(results);
      if (step instanceof Error) throw step;
      const usage = {
        inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 100, text: 100, reasoning: 0 },
      };
      if (step === "stop") {
        return { content: [{ type: "text", text: "Done." }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] };
      }
      return {
        content: [{ type: "tool-call", toolCallId: `c${results.length}`, toolName: step.tool, input: JSON.stringify(step.input) }],
        finishReason: { unified: "tool-calls", raw: "tool_use" },
        usage,
        warnings: [],
      };
    },
  });
}

function input(steps: string[]): PlanInput {
  return {
    profile: demoProfile(),
    start: { ...DEMO_START, source: "pin" },
    budgetMin: 120,
    pace: "easy",
    mode: "2h",
    shape: "loop",
    tz: "America/Chicago",
    vibe: "live music, not too fancy",
    onStep: (text) => steps.push(text),
  };
}

// The JSON a tool returned, from the model's side of the conversation.
function value(result: unknown): Record<string, unknown> {
  const out = result as { type: string; value: unknown };
  return (out?.value ?? {}) as Record<string, unknown>;
}

describe("agent planner", () => {
  it("plans through the tools, keeps only Qloo's places, and uses its own reasons", async () => {
    const steps: string[] = [];
    let firstId = "";
    const model = scripted((results) => {
      switch (results.length) {
        case 0:
          return { tool: "read_context", input: {} };
        case 1:
          return { tool: "add_vibe", input: { phrase: "live music" } };
        case 2:
          return { tool: "find_places", input: {} };
        case 3: {
          const places = value(results[2]).places as { id: string }[];
          firstId = places[0]!.id;
          return { tool: "plan_walk", input: { include: [firstId] } };
        }
        case 4: {
          const stops = value(results[3]).stops as { id: string; name: string }[];
          return {
            tool: "explain_stops",
            input: { reasons: stops.map((stop) => ({ id: stop.id, why: `People who love Khruangbin tend to love ${stop.name}. A good stop on this walk.` })) },
          };
        }
        default:
          return "stop";
      }
    });
    const walk = await agentWalk(input(steps), { model });
    const stops = walk.versions[0]!.stops;
    expect(walk.agent?.steps.length).toBeGreaterThanOrEqual(5);
    expect(steps.some((line) => /^(Asked Qloo for places|Searched the sample Austin places)/.test(line))).toBe(true);
    expect(steps.some((line) => line.startsWith("Planned "))).toBe(true);
    expect(stops.length).toBeGreaterThan(0);
    expect(stops[0]!.blurb).toMatch(/^People who love Khruangbin tend to love /);
    const pool = new Set((walk.pool ?? []).map((cand) => cand.entityId));
    expect(stops.every((stop) => pool.has(stop.entityId))).toBe(true);
  });

  it("rejects a place id the model invents and falls back to the planner", async () => {
    let rejected: unknown;
    const model = scripted((results) => {
      if (results.length === 0) return { tool: "find_places", input: {} };
      if (results.length === 1) return { tool: "plan_walk", input: { include: ["made-up-place"] } };
      rejected = value(results[1]);
      return "stop";
    });
    const walk = await agentWalk(input([]), { model });
    expect(String((rejected as { error?: string }).error)).toMatch(/Unknown place ids: made-up-place/);
    expect(walk.agent).toBeUndefined();
    expect(walk.versions[0]!.stops.length).toBeGreaterThan(0);
  });

  it("falls back to the planner when the model errors", async () => {
    const walk = await agentWalk(input([]), { model: scripted(() => new Error("gateway down")) });
    expect(walk.agent).toBeUndefined();
    expect(walk.versions[0]!.stops.length).toBeGreaterThan(0);
  });

  it("never calls the model once the day's budget is spent", async () => {
    vi.resetModules();
    vi.doMock("@/lib/agent/budget", () => ({ reserve: async () => null }));
    const { agentWalk: capped } = await import("@/lib/agent/planner");
    const model = scripted(() => ({ tool: "read_context", input: {} }));
    const walk = await capped(input([]), { model });
    expect(model.doGenerateCalls.length).toBe(0);
    expect(walk.agent).toBeUndefined();
    vi.doUnmock("@/lib/agent/budget");
    vi.resetModules();
  });

  it("counts spend from a run that errors after billed steps", async () => {
    vi.resetModules();
    const { agentWalk: fresh } = await import("@/lib/agent/planner");
    const { spentToday } = await import("@/lib/agent/budget");
    const model = scripted((results) => (results.length < 2 ? { tool: "read_context", input: {} } : new Error("gateway dropped the stream")));
    const walk = await fresh(input([]), { model });
    expect(walk.agent).toBeUndefined();
    // The failed run keeps its reservation, so it can't spend for free.
    expect(await spentToday()).toBeGreaterThan(0.02);
  });

  it("drops a reason that states hours or prices Qloo didn't give", async () => {
    let planned: { id: string; name: string }[] = [];
    const model = scripted((results) => {
      if (results.length === 0) return { tool: "find_places", input: {} };
      if (results.length === 1) return { tool: "plan_walk", input: {} };
      if (results.length === 2) {
        planned = value(results[1]).stops as { id: string; name: string }[];
        return {
          tool: "explain_stops",
          input: { reasons: planned.map((stop) => ({ id: stop.id, why: `People who love Khruangbin tend to love ${stop.name}. Free entry and open till 4am.` })) },
        };
      }
      return "stop";
    });
    const walk = await agentWalk(input([]), { model });
    expect(walk.agent).toBeDefined();
    expect(walk.versions[0]!.stops.every((stop) => !/Free entry/.test(stop.blurb ?? ""))).toBe(true);
  });

  it("the Austin demo stays the scripted walk with the recorded agent steps", async () => {
    const model = scripted(() => ({ tool: "read_context", input: {} }));
    const walk = await agentWalk({ ...input([]), start: { ...DEMO_START, source: "demo" }, demo: true, vibe: undefined }, { model });
    expect(model.doGenerateCalls.length).toBe(0);
    expect(walk.agent?.recorded).toBe(true);
    expect(walk.versions[0]!.stops[0]!.name).toBe("Antone’s Nightclub");
  });
});

describe("agent planner, more", () => {
  it("the demo emits exactly the recorded steps", async () => {
    const { DEMO_AGENT_STEPS } = await import("@/lib/plan/design-walk");
    const steps: string[] = [];
    const walk = await agentWalk({ ...input(steps), start: { ...DEMO_START, source: "demo" }, demo: true, vibe: undefined });
    expect(steps).toEqual(DEMO_AGENT_STEPS);
    expect(walk.agent?.steps).toEqual(DEMO_AGENT_STEPS);
  });

  it("a timeout falls back to the planner", async () => {
    const slow = scripted(() => ({ tool: "read_context", input: {} }));
    const original = slow.doGenerate;
    slow.doGenerate = async (options) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 2_000);
        options.abortSignal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(options.abortSignal?.reason ?? new Error("aborted"));
        });
      });
      return original(options);
    };
    const walk = await agentWalk(input([]), { model: slow, timeoutMs: 50 });
    expect(walk.agent).toBeUndefined();
    expect(walk.versions[0]!.stops.length).toBeGreaterThan(0);
  });

  it("your own tastes from the demo start get the agent", async () => {
    const model = scripted((results) => (results.length === 0 ? { tool: "find_places", input: {} } : results.length === 1 ? { tool: "plan_walk", input: {} } : "stop"));
    const profile = { ...demoProfile(), entities: demoProfile().entities.slice(0, 2), tags: [] };
    const walk = await agentWalk({ ...input([]), profile, start: { ...DEMO_START, source: "demo" }, demo: true }, { model });
    expect(model.doGenerateCalls.length).toBeGreaterThan(0);
    expect(walk.agent).toBeDefined();
  });

  it("a reason crediting a taste tag is kept", async () => {
    const model = scripted((results) => {
      if (results.length === 0) return { tool: "find_places", input: {} };
      if (results.length === 1) return { tool: "plan_walk", input: {} };
      if (results.length === 2) {
        const stops = value(results[1]).stops as { id: string; name: string }[];
        return { tool: "explain_stops", input: { reasons: stops.map((stop) => ({ id: stop.id, why: `People who love Live music tend to love ${stop.name}. A room for bands.` })) } };
      }
      return "stop";
    });
    const walk = await agentWalk(input([]), { model });
    expect(walk.versions[0]!.stops[0]!.blurb).toMatch(/^People who love Live music/);
  });
});

describe("agent spend stays bounded", () => {
  it("a run that floods tool calls stops at its hold", async () => {
    vi.resetModules();
    process.env.AI_BUDGET_KEY_SUFFIX = `:${Math.random()}`;
    const { agentWalk: fresh } = await import("@/lib/agent/planner");
    const { spentToday } = await import("@/lib/agent/budget");
    let calls = 0;
    const flood = new MockLanguageModelV4({
      doGenerate: async () => {
        calls += 1;
        return {
          content: Array.from({ length: 30 }, (_, i) => ({ type: "tool-call" as const, toolCallId: `f${calls}-${i}`, toolName: "find_places", input: "{}" })),
          finishReason: { unified: "tool-calls" as const, raw: "tool_use" },
          // Each step reports a big prompt, as a flood of repeated results would.
          usage: { inputTokens: { total: 40_000, noCache: 40_000, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 400, text: 400, reasoning: 0 } },
          warnings: [],
        };
      },
    });
    await fresh(input([]), { model: flood });
    // Hold: 60k in + 4k out at Flash prices = $0.028. Each step here costs $0.013,
    // so the run stops after the step that passes the hold (the 3rd), not at 8.
    expect(calls).toBe(3);
    expect(await spentToday()).toBeLessThanOrEqual(0.028 + 0.013 + 1e-9);
    delete process.env.AI_BUDGET_KEY_SUFFIX;
  });
});
