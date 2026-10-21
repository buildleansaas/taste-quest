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
    expect(steps.some((line) => line.startsWith("Asked Qloo for places"))).toBe(true);
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
    vi.doMock("@/lib/agent/budget", () => ({ budgetLeft: async () => false, recordSpend: async () => undefined }));
    const { agentWalk: capped } = await import("@/lib/agent/planner");
    const model = scripted(() => ({ tool: "read_context", input: {} }));
    const walk = await capped(input([]), { model });
    expect(model.doGenerateCalls.length).toBe(0);
    expect(walk.agent).toBeUndefined();
    vi.doUnmock("@/lib/agent/budget");
  });

  it("the Austin demo stays the scripted walk with the recorded agent steps", async () => {
    const model = scripted(() => ({ tool: "read_context", input: {} }));
    const walk = await agentWalk({ ...input([]), start: { ...DEMO_START, source: "demo" }, demo: true, vibe: undefined }, { model });
    expect(model.doGenerateCalls.length).toBe(0);
    expect(walk.agent?.recorded).toBe(true);
    expect(walk.versions[0]!.stops[0]!.name).toBe("Antone’s Nightclub");
  });
});
