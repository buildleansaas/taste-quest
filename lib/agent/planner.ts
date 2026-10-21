import { generateText, isStepCount, tool, type LanguageModel } from "ai";
import { z } from "zod";
import { gatewayReady, guardBlurb, modelOptions } from "@/lib/agent/blurb";
import { reserve } from "@/lib/agent/budget";
import type { ChosenStop, Scored } from "@/lib/engine/core";
import { log } from "@/lib/log";
import {
  assembleWalk,
  buildWalk,
  chooseStops,
  gatherPlan,
  isDemoProfile,
  osrmLine,
  readPlanContext,
  routeChosen,
  vibeMatches,
  vibeTags,
  type PlanBasis,
  type PlanInput,
} from "@/lib/plan/build";
import { qlooConfigured, searchTags } from "@/lib/qloo/client";
import type { ContextSnap, TasteTag, Walk } from "@/lib/types";

export const AGENT_MODEL = process.env.AI_MODEL || "google/gemini-2.5-flash";
// The team's AI Gateway is on the free tier, which serves Google's models but
// not Anthropic's (a one-off probe on a preview, 2026-10-21: "Free tier users do
// not have access to this model"). With paid credits,
// set AI_MODEL=anthropic/claude-haiku-5.5 (priced in lib/agent/budget.ts).
const FALLBACK_MODEL = process.env.AI_FALLBACK_MODEL || "google/gemini-2.5-flash-lite";
const MAX_STEPS = 8;
/** Leaves the fallback planner time inside the route's 60 s limit. */
const TIMEOUT_MS = 20_000;
const STEP_OUTPUT_TOKENS = 500;
/** What one run can cost at most: every step at its output cap, the prompt growing each step. */
const WORST_CASE = { inputTokens: 60_000, outputTokens: MAX_STEPS * STEP_OUTPUT_TOKENS };
/** Words in a reason that state facts Qloo didn't give the model (hours, prices). */
const INVENTED_FACTS = /\$|€|£|\b\d{1,2}(:\d{2})?\s?(am|pm)\b|\b(open|opens|closes|till|until)\s+(late|\d)|\b24\s?(hours|\/7)|(?<![\w-])free\b|\bcheap\b|\bprice|\bcover charge/i;
/** At most this many vibe lookups (each one Qloo call) per plan. */
const MAX_VIBE_LOOKUPS = 2;

const SYSTEM = [
  "You plan a short city walk for one person, using Qloo's taste data through tools.",
  "Work in this order: read_context, then add_vibe for each distinct idea in the walker's vibe (skip if there is no vibe), then find_places, then plan_walk, then explain_stops, then stop.",
  "Only choose places that find_places returned, by their id. Never invent a place, hours, prices or history.",
  "plan_walk owns timing and the route; accept the stops it returns.",
  "Use include (up to 3 ids) to favour the best matches for the vibe and exclude (up to 10) to drop places that clash with it (for example loud bars for 'quiet').",
  "add_vibe can be called at most twice.",
  "In explain_stops, write two plain sentences per stop. First: 'People who love <one of the walker's tastes from its evidence> tend to love <the place's exact name>.' Second: one concrete thing about it from its kind or Qloo tags (for example 'A blues club with live music most nights').",
  "Name only the place itself and the walker's own tastes. No quotes, no other venues, no emojis.",
].join("\n");

type AgentState = {
  context?: ContextSnap;
  extraTags: TasteTag[];
  vibeLookups: number;
  basis?: PlanBasis;
  /** The in-flight pool load, so a timeout's fallback reuses it, not a second Qloo load. */
  loading?: Promise<PlanBasis>;
  plan?: { chosen: ChosenStop[]; routed: Awaited<ReturnType<typeof routeChosen>>["routed"]; total: number };
  reasons: Map<string, string>;
  explainCalls: number;
  lastRejected: number;
  placesShown: number;
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
 * can only choose among Qloo's results and never break the time budget. The
 * preset Austin demo never calls the model (that walk is scripted). Any
 * failure falls back to the planner as it was before the agent, so the app is
 * never worse: no gateway, no budget hold (the day's cap, the run count, two
 * runs already in flight, an unpriced model), a model error, a timeout, or no plan.
 */
export async function agentWalk(input: PlanInput, opts: { model?: LanguageModel; recordDemo?: boolean; timeoutMs?: number } = {}): Promise<Walk> {
  // A model passed in (tests) skips the gateway check, never the budget.
  // recordDemo runs the agent on the demo's clock and tastes, to capture the
  // steps the Austin demo replays (DEMO_AGENT_STEPS); it's off in production.
  // Only the preset demo tastes are the scripted demo; your own tastes from the
  // demo start get the agent too (on the demo's Saturday-evening clock).
  if ((input.demo && isDemoProfile(input.profile) && !opts.recordDemo) || (!opts.model && !gatewayReady())) return buildWalk(input);
  const budget = await reserve("agent-plan", [AGENT_MODEL, FALLBACK_MODEL], WORST_CASE, { countRun: true });
  if (!budget) return buildWalk(input);
  const state: AgentState = { extraTags: [], vibeLookups: 0, reasons: new Map(), explainCalls: 0, lastRejected: 0, placesShown: 0, steps: [] };
  const step = (text: string) => {
    state.steps.push(text);
    input.onStep?.(text);
  };
  const names = input.profile.entities.map((entity) => entity.name);
  // A reason may credit any of the walker's tastes: artists and films, or tags like "Live music".
  const tasteNames = [...names, ...input.profile.tags.map((tag) => tag.name)];

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
      description: "Turn one idea from the walker's vibe (e.g. 'quiet', 'rooftop', 'late-night food') into Qloo place tags that steer the search. At most 2 calls, before find_places.",
      inputSchema: z.object({ phrase: z.string().min(2).max(40) }),
      execute: async ({ phrase }) => {
        if (state.vibeLookups >= MAX_VIBE_LOOKUPS) return { added: [], note: "Vibe lookups used up; go on to find_places." };
        // The pool is fixed once loaded; a late vibe can't change it, so it isn't shown as a step.
        if (state.basis || state.loading) return { added: [], note: "Places are already loaded; call add_vibe before find_places." };
        state.vibeLookups += 1;
        const hits = vibeMatches(phrase, await searchTags(phrase).catch(() => [])).slice(0, 2);
        const added = hits
          .filter((hit) => !state.extraTags.some((tag) => tag.id === hit.id))
          .map((hit) => ({ id: hit.id, name: hit.name, cat: "vibe" as const }));
        state.extraTags.push(...added);
        const who = qlooConfigured() ? "Qloo" : "the sample tags";
        step(added.length ? `Asked ${who} what “${phrase}” means for places: ${added.map((tag) => tag.name).join(", ")}` : `${qlooConfigured() ? "Qloo" : "The sample tags"} had no place tags for “${phrase}”`);
        return { added: added.map((tag) => tag.name) };
      },
    }),
    find_places: tool({
      description: "Ask Qloo for places near the start that people with these tastes love, filtered to what's open and walkable. Returns the top 15 with Qloo's evidence.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!state.basis) {
          state.context ??= await readPlanContext(input);
          state.loading ??= gatherPlan(input, state.context, state.extraTags);
          state.basis = await state.loading;
          const top = [...state.basis.prepared].sort((a, b) => b.baseScore - a.baseScore);
          const lead = names.slice(0, 2).join(" and ") || "your tastes";
          // Say which data answered: Qloo, or the built-in sample places when no key is set.
          const source = qlooConfigured() ? `Asked Qloo for places ${lead} fans love nearby` : `Searched the sample Austin places for ${lead} fans`;
          step(`${source}: ${state.basis.loaded.candidates.length} found, ${top.length} open and walkable`);
        }
        // Only the first call returns the list; repeats would resend it every step.
        state.placesShown += 1;
        if (state.placesShown > 1) return { note: "Places already returned above; use those ids in plan_walk." };
        const top = [...state.basis.prepared].sort((a, b) => b.baseScore - a.baseScore).slice(0, 15);
        return { places: top.map(summarize) };
      },
    }),
    plan_walk: tool({
      description: "Fit stops into the walker's time and route them on real streets. Optionally favour up to 3 place ids (include) and drop up to 10 (exclude). Returns the stops in order and the minutes used.",
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
      description: "Give the walker a reason for each planned stop, grounded in its Qloo evidence. Two sentences each. Rejected reasons come back with why; rewrite those once.",
      inputSchema: z.object({
        reasons: z.array(z.object({ id: z.string(), why: z.string().min(10).max(320) })).max(8),
      }),
      execute: async ({ reasons }) => {
        if (!state.plan) return { error: "Call plan_walk first." };
        const planned = new Map(state.plan.chosen.map((stop) => [stop.entityId, stop.name]));
        const rejected: { id: string; reason: string }[] = [];
        for (const reason of reasons) {
          const place = planned.get(reason.id);
          if (!place) {
            rejected.push({ id: reason.id, reason: "not a planned stop" });
            continue;
          }
          const why = reason.why.replace(/\s+/g, " ").trim();
          const guard = guardBlurb(why, place, tasteNames);
          if (!guard.ok) rejected.push({ id: reason.id, reason: guard.reason === "quoted-name" ? "no quotation marks or other place names" : "name one of the walker's tastes" });
          else if (INVENTED_FACTS.test(why)) rejected.push({ id: reason.id, reason: "no hours, prices or 'free'" });
          else state.reasons.set(reason.id, why);
        }
        const kept = [...planned.keys()].filter((id) => state.reasons.has(id)).length;
        if (!rejected.length || state.explainCalls >= 1) step(`Wrote why each stop fits you, from the taste evidence (${kept} of ${planned.size})`);
        state.explainCalls += 1;
        state.lastRejected = rejected.length;
        // Rejected reasons go back to the model, so it can rewrite them once.
        return { kept, of: planned.size, rejected };
      },
    }),
  };

  const vibe = input.vibe?.trim();
  const prompt = [
    `Walker's tastes: ${[...names, ...input.profile.tags.map((tag) => tag.name)].join(", ") || "none given"}.`,
    `Vibe: ${vibe ? `"${vibe}"` : "none"}.`,
    `Time: ${input.budgetMin} minutes, ${input.pace} pace, ${input.shape ?? "loop"}.`,
  ].join("\n");

  // Set once the model loop ends; after that an error is ours, not the model's,
  // so the catch falls back to the plain planner instead of reusing the plan.
  let loopDone = false;
  try {
    step("Reading your tastes…");
    const result = await generateText({
      model: opts.model ?? AGENT_MODEL,
      system: SYSTEM,
      prompt,
      tools,
      // Stop at the step cap, or as soon as usage reaches the hold, so one run
      // costs at most its hold plus one step.
      // Done once the reasons are in: all kept, or after the one rewrite.
      stopWhen: [isStepCount(MAX_STEPS), () => state.explainCalls >= 2 || (state.explainCalls >= 1 && state.lastRejected === 0), () => budget.over()],
      // Every step must be a tool call: on live Qloo data the model once answered
      // in text after find_places and never planned. The run ends at explain_stops.
      toolChoice: "required",
      maxOutputTokens: STEP_OUTPUT_TOKENS,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
      // Each step is charged as it finishes, so a later error or timeout can't hide spend.
      onStepFinish: (stepResult) => budget.step(stepResult.usage),
      ...(opts.model ? {} : { providerOptions: modelOptions(FALLBACK_MODEL) }),
    });
    loopDone = true;
    await budget.settle(false);
    if (!state.basis || !state.plan) throw new Error("agent stopped without a plan");
    return assembleWalk(input, state.basis, state.plan, {
      blurbs: state.reasons,
      // The model that answered (the gateway may have used the fallback).
      agent: { model: result.response?.modelId || AGENT_MODEL, steps: state.steps },
    });
  } catch (error) {
    await budget.settle(true);
    // The agent got as far as a plan (the error came while writing reasons):
    // keep its plan; stops without a reason keep the template text.
    if (!loopDone && state.basis && state.plan) {
      log("warn", "agent-partial", { error: error instanceof Error ? error.message : String(error), steps: state.steps.length });
      return assembleWalk(input, state.basis, state.plan, { blurbs: state.reasons, agent: { model: AGENT_MODEL, steps: state.steps } });
    }
    log("warn", "agent-fallback", { error: error instanceof Error ? error.message : String(error), steps: state.steps.length });
    // The deterministic planner, with the vibe tags the agent already found (or looks them up itself).
    input.onStep?.("Finishing the plan without the agent…");
    const extra = state.extraTags.length ? state.extraTags : await vibeTags(input.vibe);
    const context = state.context ?? (await readPlanContext(input));
    const basis = state.basis ?? (await (state.loading ?? gatherPlan(input, context, extra)));
    return assembleWalk(input, basis, await routeChosen(input, chooseStops(input, basis)));
  }
}
