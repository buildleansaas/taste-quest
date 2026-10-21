import { generateText, isStepCount, tool, type LanguageModel } from "ai";
import { z } from "zod";
import { gatewayReady, guardBlurb } from "@/lib/agent/blurb";
import { budgetLeft, recordSpend } from "@/lib/agent/budget";
import type { ChosenStop, Scored } from "@/lib/engine/core";
import { log } from "@/lib/log";
import {
  assembleWalk,
  buildWalk,
  chooseStops,
  gatherPlan,
  osrmLine,
  readPlanContext,
  routeChosen,
  vibeTags,
  type PlanBasis,
  type PlanInput,
} from "@/lib/plan/build";
import { searchTags } from "@/lib/qloo/client";
import type { ContextSnap, TasteTag, Walk } from "@/lib/types";

export const AGENT_MODEL = process.env.AI_MODEL || "anthropic/claude-haiku-5.5";
const FALLBACK_MODEL = process.env.AI_FALLBACK_MODEL || "google/gemini-2.5-flash";
const MAX_STEPS = 8;
const TIMEOUT_MS = 25_000;
/** At most this many vibe lookups (each one Qloo call) per plan. */
const MAX_VIBE_LOOKUPS = 2;

const SYSTEM = [
  "You plan a short city walk for one person, using Qloo's taste data through tools.",
  "Work in this order: read_context, then add_vibe for each distinct idea in the walker's vibe (skip if there is no vibe), then find_places, then plan_walk, then explain_stops, then stop.",
  "Only choose places that find_places returned, by their id. Never invent a place, hours, prices or history.",
  "plan_walk owns timing and the route: if it says the walk is full, accept it.",
  "Use include to keep the best matches for the vibe and exclude to drop places that clash with it (for example loud bars for 'quiet').",
  "In explain_stops, write two plain sentences per stop. First: 'People who love <one of the walker's tastes from its evidence> tend to love <the place's exact name>.' Second: one concrete thing about it from its kind or Qloo tags (for example 'A blues club with live music most nights').",
  "Name only the place itself and the walker's own tastes. No quotes, no other venues, no emojis.",
].join("\n");

type AgentState = {
  context?: ContextSnap;
  extraTags: TasteTag[];
  vibeLookups: number;
  basis?: PlanBasis;
  plan?: { chosen: ChosenStop[]; routed: Awaited<ReturnType<typeof routeChosen>>["routed"]; total: number };
  reasons: Map<string, string>;
  steps: string[];
};

function pct(value: number): number {
  return Math.round(value * 100);
}

function summarize(cand: Scored) {
  const because = [...cand.entityShares].sort((a, b) => b.share - a.share)[0];
  return {
    id: cand.entityId,
    name: cand.name,
    kind: cand.categoryLabel,
    match: `${pct(cand.affinity)}%`,
    because: because ? `${because.name} (${pct(because.share)}% of the match)` : undefined,
    tags: cand.tagOverlap.slice(0, 3).map((tag) => tag.name),
  };
}

/**
 * The agent planner (#7). A model drives Qloo through tools; the engine still
 * owns which places are eligible, timing and the street route, so the agent
 * can only choose among Qloo's results and never break the time budget. Any
 * failure (no gateway, the daily budget spent, a model error, a timeout, no
 * plan) falls back to buildWalk, so the app is never worse than before.
 */
export async function agentWalk(input: PlanInput, opts: { model?: LanguageModel; recordDemo?: boolean } = {}): Promise<Walk> {
  // A model passed in (tests) skips the gateway check, never the budget.
  // recordDemo runs the agent on the demo's clock and tastes, to capture the
  // steps the Austin demo replays (DEMO_AGENT_STEPS); it's off in production.
  if ((input.demo && !opts.recordDemo) || (!opts.model && !gatewayReady()) || !(await budgetLeft())) return buildWalk(input);
  const state: AgentState = { extraTags: [], vibeLookups: 0, reasons: new Map(), steps: [] };
  const step = (text: string) => {
    state.steps.push(text);
    input.onStep?.(text);
  };
  const names = input.profile.entities.map((entity) => entity.name);

  const tools = {
    read_context: tool({
      description: "The walker's local time, weekday and weather. Call first.",
      inputSchema: z.object({}),
      execute: async () => {
        state.context = await readPlanContext(input);
        const weather = state.context.weather;
        step(`Checked the time and weather: ${state.context.localTime}${weather ? `, ${weather.tempF}°F${weather.isRainy ? ", rain likely" : ""}` : ""}`);
        return { localTime: state.context.localTime, weekday: state.context.weekday, weather };
      },
    }),
    add_vibe: tool({
      description: "Turn one idea from the walker's vibe (e.g. 'quiet', 'rooftop', 'cheap eats') into Qloo place tags that steer the search.",
      inputSchema: z.object({ phrase: z.string().min(2).max(40) }),
      execute: async ({ phrase }) => {
        if (state.vibeLookups >= MAX_VIBE_LOOKUPS) return { added: [], note: "Vibe lookups used up; go on to find_places." };
        state.vibeLookups += 1;
        const hits = (await searchTags(phrase).catch(() => [])).slice(0, 2);
        const added = hits
          .filter((hit) => !state.extraTags.some((tag) => tag.id === hit.id))
          .map((hit) => ({ id: hit.id, name: hit.name, cat: "vibe" as const }));
        state.extraTags.push(...added);
        step(added.length ? `Asked Qloo what “${phrase}” means for places: ${added.map((tag) => tag.name).join(", ")}` : `Qloo had no place tags for “${phrase}”`);
        return { added: added.map((tag) => tag.name) };
      },
    }),
    find_places: tool({
      description: "Ask Qloo for places near the start that people with these tastes love, filtered to what's open and walkable. Returns the top 15 with Qloo's evidence.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!state.basis) {
          state.context ??= await readPlanContext(input);
          state.basis = await gatherPlan(input, state.context, state.extraTags);
          const top = [...state.basis.prepared].sort((a, b) => b.baseScore - a.baseScore);
          const lead = names.slice(0, 2).join(" and ") || "your tastes";
          step(`Asked Qloo for places ${lead} fans love nearby: ${state.basis.loaded.candidates.length} found, ${top.length} open and walkable`);
        }
        const top = [...state.basis.prepared].sort((a, b) => b.baseScore - a.baseScore).slice(0, 15);
        return { places: top.map(summarize) };
      },
    }),
    plan_walk: tool({
      description: "Fit stops into the walker's time and route them on real streets. Optionally include up to 3 place ids to favour and exclude ids to drop. Returns the stops in order and the minutes used.",
      inputSchema: z.object({
        include: z.array(z.string()).max(3).optional(),
        exclude: z.array(z.string()).max(10).optional(),
      }),
      execute: async ({ include = [], exclude = [] }) => {
        if (!state.basis) return { error: "Call find_places first." };
        const known = new Set(state.basis.prepared.map((cand) => cand.entityId));
        // Only Qloo's own results: an id the model made up is rejected, not guessed at.
        const unknown = [...include, ...exclude].filter((id) => !known.has(id));
        if (unknown.length) return { error: `Unknown place ids: ${unknown.join(", ")}. Use ids from find_places.` };
        const favour = new Set(include);
        const pool = state.basis.prepared
          .filter((cand) => !exclude.includes(cand.entityId))
          .map((cand) => (favour.has(cand.entityId) ? { ...cand, baseScore: cand.baseScore * 1.5 } : cand));
        const chosen = chooseStops(input, state.basis, pool);
        if (!chosen.length) return { error: "No stops fit; plan with fewer exclusions." };
        step(osrmLine());
        state.plan = await routeChosen(input, chosen);
        const picked = state.plan.chosen;
        step(`Planned ${picked.length} stop${picked.length === 1 ? "" : "s"} in ${Math.round(state.plan.total)} of your ${input.budgetMin} minutes: ${picked.map((stop) => stop.name).join(", ")}`);
        return {
          stops: picked.map((stop) => ({ id: stop.entityId, name: stop.name, match: `${pct(stop.affinity)}%` })),
          minutesUsed: Math.round(state.plan.total),
          budgetMinutes: input.budgetMin,
        };
      },
    }),
    explain_stops: tool({
      description: "Give the walker a reason for each planned stop, grounded in its Qloo evidence. One or two sentences each.",
      inputSchema: z.object({
        reasons: z.array(z.object({ id: z.string(), why: z.string().min(10).max(320) })).max(8),
      }),
      execute: async ({ reasons }) => {
        if (!state.plan) return { error: "Call plan_walk first." };
        const planned = new Map(state.plan.chosen.map((stop) => [stop.entityId, stop.name]));
        let kept = 0;
        for (const reason of reasons) {
          const place = planned.get(reason.id);
          if (!place) continue;
          const why = reason.why.replace(/\s+/g, " ").trim();
          if (!guardBlurb(why, place, names).ok) continue;
          state.reasons.set(reason.id, why);
          kept += 1;
        }
        step(`Wrote why each stop fits you, from Qloo's evidence (${kept} of ${planned.size})`);
        return { kept, of: planned.size };
      },
    }),
  };

  const vibe = input.vibe?.trim();
  const prompt = [
    `Walker's tastes: ${[...names, ...input.profile.tags.map((tag) => tag.name)].join(", ") || "none given"}.`,
    `Vibe: ${vibe ? `"${vibe}"` : "none"}.`,
    `Time: ${input.budgetMin} minutes, ${input.pace} pace, ${input.shape ?? "loop"}.`,
  ].join("\n");

  try {
    step("Reading your tastes…");
    const result = await generateText({
      model: opts.model ?? AGENT_MODEL,
      system: SYSTEM,
      prompt,
      tools,
      stopWhen: isStepCount(MAX_STEPS),
      maxOutputTokens: 1200,
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
      ...(opts.model ? {} : { providerOptions: { gateway: { models: [FALLBACK_MODEL] } } }),
    });
    await recordSpend(result.totalUsage, "agent-plan");
    if (!state.basis || !state.plan) throw new Error("agent stopped without a plan");
    return assembleWalk(input, state.basis, state.plan, {
      blurbs: state.reasons,
      agent: { model: AGENT_MODEL, steps: state.steps },
    });
  } catch (error) {
    log("warn", "agent-fallback", { error: error instanceof Error ? error.message : String(error), steps: state.steps.length });
    // The deterministic planner, with the vibe tags the agent already found (or looks them up itself).
    input.onStep?.("Finishing the plan without the agent…");
    const extra = state.extraTags.length ? state.extraTags : await vibeTags(input.vibe);
    const context = state.context ?? (await readPlanContext(input));
    const basis = state.basis ?? (await gatherPlan(input, context, extra));
    return assembleWalk(input, basis, await routeChosen(input, chooseStops(input, basis)));
  }
}
