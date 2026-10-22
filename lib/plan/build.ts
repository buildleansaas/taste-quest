import { templateBlurb } from "@/lib/agent/blurb";
import { cacheGet, cacheSet, TTL } from "@/lib/cache";
import {
  closesWithin,
  diffRoutes,
  isOpenAt,
  lowestRatioIndex,
  prepareCandidates,
  radiusM,
  selectStops,
  shouldHeadBack,
  terminusFor,
  walkMinutes,
  withStability,
  type ChosenStop,
  type Scored,
} from "@/lib/engine/core";
import { geohash } from "@/lib/geohash";
import { sha } from "@/lib/hash";
import { getQuota, placesNear, qlooConfigured, quotaMode, resolveSampleIds, searchTags } from "@/lib/qloo/client";
import { formatMinutes } from "@/lib/format";
import { DEMO_AGENT_MODEL, DEMO_AGENT_STEPS, DESIGN_POOL, designReroute, designWalk } from "@/lib/plan/design-walk";
import { demoProfile } from "@/lib/taste/curated";
import { routeFoot, type Routed } from "@/lib/routing/osrm";
import { demoClock, readContext } from "@/lib/weather/open-meteo";
import type {
  BudgetMode,
  Candidate,
  ContextSnap,
  LatLon,
  Pace,
  RerouteReason,
  ShapeMode,
  StartPoint,
  Stop,
  TasteProfile,
  TasteTag,
  Walk,
  WalkRoute,
  WalkVersion,
} from "@/lib/types";

export type PlanInput = {
  profile: TasteProfile;
  start: StartPoint;
  budgetMin: number;
  pace: Pace;
  mode: BudgetMode;
  shape?: ShapeMode;
  end?: LatLon & { label?: string };
  demo?: boolean;
  widen?: boolean;
  tz?: string;
  /** Free text from "What's the vibe?". */
  vibe?: string;
  onStep?: (text: string) => void;
};

function poolCacheKey(profile: TasteProfile, hash: string, radius: number, weekday: string): string {
  const signature = sha(
    `${profile.entities.map((e) => e.id).sort().join(",")}|${profile.tags.map((t) => t.id).sort().join(",")}`,
  );
  // Bump the version when normalized Candidate fields change, so cached pools are not reused.
  return `qp:v6:${signature}:${hash}:${radius}:${weekday}`;
}

async function loadCandidates(input: PlanInput, weekday: string, rainy: boolean): Promise<{
  candidates: Candidate[];
  poolKey: string;
  fromCache: boolean;
}> {
  const radius = input.widen ? 2500 : radiusM(input.pace, input.budgetMin);
  const hash = geohash(input.start.lat, input.start.lon, 6);
  const resolved = await resolveSampleIds(input.profile.entities, input.profile.tags);
  const profile = { ...input.profile, entities: resolved.entities, tags: resolved.tags };
  const key = poolCacheKey(profile, hash, radius, weekday);
  const cached = await cacheGet<Candidate[]>(key);
  const quota = quotaMode((await getQuota()).remaining);
  const liveAllowed = Boolean(qlooConfigured() && (quota !== "demo-or-cache" || input.demo));
  if (cached) return { candidates: cached, poolKey: key, fromCache: true };
  if (qlooConfigured() && quota === "demo-or-cache" && !input.demo) {
    return { candidates: [], poolKey: key, fromCache: false };
  }

  let current = radius;
  let collected: Candidate[] = [];
  let partial = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let page: Candidate[];
    try {
      page = await placesNear({
        lat: input.start.lat,
        lon: input.start.lon,
        radius: current,
        weekday,
        entities: profile.entities,
        tags: profile.tags,
        allowLive: liveAllowed,
      });
    } catch (error) {
      // A later widen page failing (timeout, busy) keeps the pages we have.
      if (attempt === 0 || !collected.length) throw error;
      partial = true;
      break;
    }
    collected = page;
    const usable = prepareCandidates(page, {
      departAt: departAt(input),
      weekday,
      pace: input.pace,
      dropIds: [],
      userTags: profile.tags,
      rainy,
      evening: isEvening(input),
      windowMin: input.budgetMin,
    });
    if (usable.length >= 25 || attempt === 2) break;
    if (attempt === 1) {
      const more = await placesNear({
        lat: input.start.lat,
        lon: input.start.lon,
        radius: current,
        weekday,
        entities: profile.entities,
        tags: profile.tags,
        offset: 50,
        allowLive: liveAllowed,
      }).catch(() => [] as Candidate[]);
      const seen = new Set(collected.map((item) => item.entityId));
      collected = [...collected, ...more.filter((item) => !seen.has(item.entityId))];
    }
    current = Math.min(2500, Math.round(current * 1.6));
  }
  const finalKey = poolCacheKey(profile, hash, current, weekday);
  // A partial pool (a widen page failed) is used for this plan but never
  // cached, since its key would name a radius that was not fetched.
  if (collected.length && qlooConfigured() && !partial) {
    await cacheSet(finalKey, collected.slice(0, 100), TTL.pool, ["qloo", "pool"]);
  }
  return { candidates: collected.slice(0, 100), poolKey: finalKey, fromCache: false };
}

function wallClock(date: Date, tz: string): Date {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
    return new Date(
      Date.UTC(
        Number(pick("year")),
        Number(pick("month")) - 1,
        Number(pick("day")),
        Number(pick("hour")),
        Number(pick("minute")),
      ),
    );
  } catch {
    return date;
  }
}

function departAt(input: PlanInput): Date {
  if (input.demo) return new Date(Date.UTC(2026, 9, 24, 19, 0));
  return wallClock(new Date(), input.tz || "UTC");
}

function isEvening(input: PlanInput): boolean {
  return departAt(input).getUTCHours() >= 17 || Boolean(input.demo);
}

function toStops(
  chosen: ChosenStop[],
  routed: Routed,
  input: PlanInput,
  weekday: string,
): Stop[] {
  const ranks = [...chosen].sort((a, b) => b.affinity - a.affinity);
  const rankOf = new Map(ranks.map((stop, index) => [stop.entityId, index + 1]));
  let elapsed = 0;
  return chosen.map((stop, index) => {
    const walkMin = routed.legs[index]?.minutes ?? 0;
    elapsed += walkMin;
    const eta = new Date(departAt(input).getTime() + elapsed * 60_000);
    const evidence = {
      entityShares: stop.entityShares,
      tagOverlap: stop.tagOverlap,
    };
    const blurb = templateBlurb({
      place: stop.name,
      evidence,
      shortDescription: stop.shortDescription,
      orderNote: stop.orderNote,
      kind: stop.categoryLabel,
    });
    const closedNow = stop.hours ? !isOpenAt(stop.hours, weekday, eta) : false;
    elapsed += stop.dwellMin;
    return {
      seq: index + 1,
      entityId: stop.entityId,
      name: stop.name,
      lat: stop.lat,
      lon: stop.lon,
      affinity: stop.affinity,
      affinityRank: rankOf.get(stop.entityId) ?? index + 1,
      etaMin: Math.round(elapsed - stop.dwellMin),
      walkMin: Math.round(walkMin),
      dwellMin: Math.round(stop.dwellMin),
      state: index === 0 ? "next" : "todo",
      category: stop.category,
      categoryLabel: stop.categoryLabel,
      address: stop.address,
      neighborhood: stop.neighborhood,
      evidence,
      blurb,
      hours: stop.hours,
      imageUrl: stop.imageUrl,
      closingSoon: closesWithin(stop.hours, weekday, eta, 45),
      closedNow,
      sample: stop.sample,
      orderNote: stop.orderNote,
    };
  });
}

export function isDemoProfile(profile: TasteProfile): boolean {
  const key = (p: TasteProfile) => [...p.entities.map((e) => e.id), ...p.tags.map((t) => t.id)].sort().join("|");
  return key(profile) === key(demoProfile());
}

/** What a plan is made from: the clock and weather, Qloo's pool, and the pool
 * filtered and scored by the engine. Shared by the planner and the agent. */
export type PlanBasis = {
  context: ContextSnap;
  loaded: { candidates: Candidate[]; poolKey: string; fromCache: boolean };
  prepared: Scored[];
};

export async function readPlanContext(input: PlanInput): Promise<ContextSnap> {
  return input.demo ? demoClock() : readContext(input.start.lat, input.start.lon, input.tz);
}

export async function gatherPlan(input: PlanInput, context: ContextSnap, extraTags: TasteTag[] = []): Promise<PlanBasis> {
  const tags = [...input.profile.tags, ...extraTags.filter((tag) => !input.profile.tags.some((have) => have.id === tag.id))];
  const withTags = { ...input, profile: { ...input.profile, tags } };
  const loaded = await loadCandidates(withTags, context.weekday, Boolean(context.weather?.isRainy));
  if (qlooConfigured() && !loaded.fromCache && loaded.candidates.length === 0) {
    const mode = quotaMode((await getQuota()).remaining);
    if (mode === "demo-or-cache" && !input.demo) {
      throw Object.assign(new Error("quota"), { code: "quota" });
    }
  }
  const prepared = prepareCandidates(loaded.candidates, {
    departAt: departAt(input),
    weekday: context.weekday,
    pace: input.pace,
    dropIds: [],
    userTags: tags,
    rainy: Boolean(context.weather?.isRainy),
    evening: isEvening(input),
    windowMin: input.budgetMin,
  });
  return { context, loaded, prepared };
}

export function chooseStops(input: PlanInput, basis: PlanBasis, pool: Scored[] = basis.prepared): ChosenStop[] {
  return selectStops(pool, input.start, {
    budgetMin: input.budgetMin,
    pace: input.pace,
    mode: input.mode,
    departAt: departAt(input),
    weekday: basis.context.weekday,
    shape: input.shape ?? "loop",
    end: input.end,
  });
}

/** Routes the chosen stops on streets, drops one if the walk runs long, and
 * returns the routed stops. The engine owns time and the route. */
export async function routeChosen(input: PlanInput, chosen: ChosenStop[]): Promise<{ chosen: ChosenStop[]; routed: Routed; total: number }> {
  const shape = input.shape ?? "loop";
  let routed = await routeThrough(input.start, chosen, input.pace, shape, input.end);
  let total = routed.walkMin + chosen.reduce((sum, stop) => sum + stop.dwellMin, 0);
  if (chosen.length > 1 && total > input.budgetMin * 1.05) {
    const drop = lowestRatioIndex(chosen);
    chosen = chosen.filter((_, index) => index !== drop);
    routed = await routeThrough(input.start, chosen, input.pace, shape, input.end);
    total = routed.walkMin + chosen.reduce((sum, stop) => sum + stop.dwellMin, 0);
  }
  return { chosen, routed, total };
}

export function assembleWalk(
  input: PlanInput,
  basis: PlanBasis,
  routedPlan: { chosen: ChosenStop[]; routed: Routed; total: number },
  extra: { blurbs?: Map<string, string>; agent?: Walk["agent"] } = {},
): Walk {
  const shape = input.shape ?? "loop";
  const { chosen, routed, total } = routedPlan;
  const stops = toStops(chosen, routed, input, basis.context.weekday).map((stop) =>
    // An agent's reason keeps the engine's order note ("Go early: it closes at 6").
    extra.blurbs?.get(stop.entityId) ? { ...stop, blurb: withOrder(extra.blurbs.get(stop.entityId)!, stop.orderNote) } : stop,
  );
  const version = versionFrom(1, "initial", routed, stops);
  return {
    id: crypto.randomUUID(),
    status: "active",
    mode: input.mode,
    budgetMin: input.budgetMin,
    pace: input.pace,
    start: input.start,
    isDemo: Boolean(input.demo),
    mock: !qlooConfigured(),
    poolKey: basis.loaded.poolKey,
    pool: basis.loaded.candidates.slice(0, 100),
    currentVersion: 1,
    versions: [version],
    startedAt: new Date().toISOString(),
    stepsNote: input.pace === "stepfree" ? "Step-free is best-effort and may include steps." : undefined,
    shape,
    end: input.end,
    returnMin: closingMinutes(routed, shape, chosen.length),
    headingBack: false,
    remainingMin: Math.round(Math.min(input.budgetMin, total)),
    ...(extra.agent ? { agent: extra.agent } : {}),
  };
}

/**
 * Qloo's tag search matches loosely: for "not too fancy" live it returned dish
 * reviews ("Not Just Pizzas Sbarro Offers Stuffed Strombolis Too"). Keep short
 * tags that share a real word with the phrase, one per name.
 */
const STOP_WORDS = new Set(["the", "and", "not", "too", "very", "with", "for", "but", "some", "lots", "really"]);
export function vibeMatches<T extends { name: string }>(phrase: string, hits: T[]): T[] {
  const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !STOP_WORDS.has(word));
  const wanted = new Set(words(phrase));
  const seen = new Set<string>();
  return hits.filter((hit) => {
    const name = hit.name.trim().toLowerCase();
    if (seen.has(name) || hit.name.split(/\s+/).length > 4) return false;
    // Same word, or the same word in the plural ("rooftops"/"Rooftop", "dive bar"/"Dive Bars").
    const same = (a: string, b: string) => a === b || a === `${b}s` || a === `${b}es` || b === `${a}s` || b === `${a}es`;
    if (!words(hit.name).some((word) => [...wanted].some((want) => same(word, want)))) return false;
    seen.add(name);
    return true;
  });
}

/** "What's the vibe?" without the agent: the top Qloo tags for the phrase. */
export async function vibeTags(vibe: string | undefined, limit = 2): Promise<TasteTag[]> {
  const phrase = vibe?.trim();
  if (!phrase) return [];
  const hits = vibeMatches(phrase, await searchTags(phrase).catch(() => []));
  return hits.slice(0, limit).map((hit) => ({ id: hit.id, name: hit.name, cat: "vibe" as const }));
}

export async function buildWalk(input: PlanInput): Promise<Walk> {
  // "Try the Austin demo" (the preset demo tastes from the Austin start) is
  // always the scripted walk with its recorded street route, so judges see the
  // same polished loop whatever keys are set. Someone who picked their own
  // tastes and the Austin start still gets a live plan.
  if (input.demo && isDemoProfile(input.profile)) {
    for (const step of DEMO_AGENT_STEPS) input.onStep?.(step);
    return { ...designWalk(input), agent: { model: DEMO_AGENT_MODEL, steps: DEMO_AGENT_STEPS, recorded: true } };
  }
  input.onStep?.(input.demo ? "Setting the demo clock to Saturday evening…" : "Checking the time and the weather…");
  const context = await readPlanContext(input);
  const extra = await vibeTags(input.vibe);
  const source = qlooConfigured() ? "Qloo" : "the sample places";
  if (extra.length) input.onStep?.(`Turned your vibe into ${qlooConfigured() ? "Qloo" : "sample"} tags: ${extra.map((tag) => tag.name).join(", ")}`);
  input.onStep?.(`Searching ${source} near you…`);
  const basis = await gatherPlan(input, context, extra);
  input.onStep?.("Fitting stops to your time…");
  const chosen = chooseStops(input, basis);
  input.onStep?.(osrmLine());
  return assembleWalk(input, basis, await routeChosen(input, chosen));
}

export function osrmLine(): string {
  return process.env.OSRM_BASE_URL?.trim()
    ? "Drawing the walking path…"
    : "Drawing an approximate path (no router configured)…";
}

async function routeThrough(
  start: LatLon,
  chosen: ChosenStop[],
  pace: Pace,
  shape: ShapeMode,
  end?: LatLon | null,
): Promise<Routed> {
  const points: LatLon[] = [start, ...chosen.map((stop) => ({ lat: stop.lat, lon: stop.lon }))];
  const term = terminusFor(start, shape, end);
  if (term && chosen.length) points.push({ lat: term.lat, lon: term.lon });
  return routeFoot(points.length >= 2 ? points : [start, start], pace);
}

function closingMinutes(routed: Routed, shape: ShapeMode, stopCount: number): number {
  if (shape === "one-way" || stopCount === 0) return 0;
  const leg = routed.legs[stopCount] ?? (routed.legs.length === stopCount + 1 ? routed.legs.at(-1) : undefined);
  return Math.round(leg?.minutes ?? 0);
}

function versionFrom(version: number, reason: RerouteReason, routed: Routed, stops: Stop[]): WalkVersion {
  const dwellMin = stops.reduce((sum, stop) => sum + stop.dwellMin, 0);
  return {
    version,
    reason,
    createdAt: new Date().toISOString(),
    route: {
      geometry: routed.geometry,
      legs: routed.legs,
      approximate: routed.approximate,
    },
    totals: {
      walkMin: Math.round(routed.walkMin),
      dwellMin: Math.round(dwellMin),
      km: Math.round(routed.km * 10) / 10,
    },
    stops,
  };
}

export async function rerouteWalk(input: {
  profile: TasteProfile;
  walk: Walk;
  fix: { lat: number; lon: number };
  reason: RerouteReason;
  pool?: Candidate[];
  tz?: string;
}): Promise<{ walk: Walk; diff: ReturnType<typeof diffRoutes>; toast: string }> {
  // The scripted beat is the demo's first skip only (Antone's visited, Midnight
  // Cowboy skipped). Later skips, or a skip after "I'm here" past Antone's,
  // re-plan from the demo's sample pool like any walk, so the walk never repeats.
  const scriptedOk =
    input.walk.currentVersion === 1 &&
    (input.walk.versions[input.walk.versions.length - 1]?.stops ?? []).every(
      (stop) => stop.state !== "visited" || stop.seq === 1,
    );
  if (input.walk.poolKey === DESIGN_POOL && input.walk.mock && input.reason === "skip" && scriptedOk) {
    const scripted = designReroute(input.walk);
    const previous = input.walk.versions[input.walk.versions.length - 1]?.stops ?? [];
    const nextStops = scripted.walk.versions[scripted.walk.versions.length - 1]?.stops ?? [];
    return {
      walk: scripted.walk,
      diff: diffRoutes(
        previous,
        nextStops,
        0,
      ),
      toast: scripted.toast,
    };
  }
  const current = input.walk.versions[input.walk.versions.length - 1];
  const previous = current?.stops ?? [];
  const visited = previous.filter((stop) => stop.state === "visited");
  const dropIds = [
    ...visited.map((stop) => stop.entityId),
    ...previous.filter((stop) => stop.state === "skipped" || stop.state === "vetoed").map((stop) => stop.entityId),
  ];
  if (input.reason === "skip" || input.reason === "veto") {
    const next = previous.find((stop) => stop.state === "next");
    if (next) dropIds.push(next.entityId);
  }
  let pool: Candidate[] = input.pool ?? input.walk.pool ?? [];
  if (!pool.length && input.walk.poolKey.startsWith("qp:")) pool = (await cacheGet<Candidate[]>(input.walk.poolKey)) ?? [];
  if (!pool.length) {
    const loaded = await loadCandidates(
      {
        profile: input.profile,
        start: { ...input.walk.start, lat: input.fix.lat, lon: input.fix.lon },
        budgetMin: input.walk.budgetMin,
        pace: input.walk.pace,
        mode: input.walk.mode,
        demo: input.walk.isDemo,
        tz: input.tz,
      },
      input.walk.isDemo ? "saturday" : (await readContext(input.fix.lat, input.fix.lon, input.tz)).weekday,
      false,
    );
    pool = loaded.candidates;
  }
  pool = pool.slice(0, 100);
  const elapsed = input.walk.startedAt
    ? Math.max(0, (Date.now() - new Date(input.walk.startedAt).getTime()) / 60_000)
    : 0;
  const remainingRaw = Math.max(0, input.walk.budgetMin - elapsed);
  const shape = input.walk.shape ?? "loop";
  const terminus = terminusFor(input.walk.start, shape, input.walk.end);
  const returnEstimate = terminus ? walkMinutes(input.fix, terminus, input.walk.pace) : 0;
  let headingBack = Boolean(terminus && shouldHeadBack(remainingRaw, returnEstimate));
  const remaining = headingBack ? remainingRaw : Math.max(30, remainingRaw);
  const contextWeekday = input.walk.isDemo ? "saturday" : (await readContext(input.fix.lat, input.fix.lon, input.tz)).weekday;
  const depart = input.walk.isDemo ? new Date(Date.UTC(2026, 9, 24, 19, 0)) : wallClock(new Date(), input.tz || "UTC");
  const prepared = withStability(
    prepareCandidates(pool, {
      departAt: depart,
      weekday: contextWeekday,
      pace: input.walk.pace,
      dropIds,
      userTags: input.profile.tags,
      rainy: false,
      evening: true,
      windowMin: remaining,
    }),
    previous.filter((stop) => stop.state === "todo" || stop.state === "next").map((stop) => stop.entityId),
  );
  const chosen = headingBack
    ? []
    : selectStops(prepared, input.fix, {
        budgetMin: remaining,
        pace: input.walk.pace,
        mode: input.walk.mode,
        departAt: depart,
        weekday: contextWeekday,
        shape,
        end: input.walk.end,
      });
  if (!headingBack && terminus && chosen.length === 0) headingBack = true;
  // A one-way walk has nowhere to head back to: no stops left means it is done.
  const doneNow = !terminus && chosen.length === 0;
  const points: LatLon[] = [
    { lat: input.fix.lat, lon: input.fix.lon },
    ...chosen.map((stop) => ({ lat: stop.lat, lon: stop.lon })),
    ...(terminus ? [{ lat: terminus.lat, lon: terminus.lon }] : []),
  ];
  const routed = await routeFoot(points.length >= 2 ? points : [input.fix, input.fix], input.walk.pace);
  const returnMin = headingBack
    ? Math.max(1, Math.round(routed.legs.at(-1)?.minutes ?? returnEstimate))
    : closingMinutes(routed, shape, chosen.length);
  const fresh = toStops(chosen, routed, {
    profile: input.profile,
    start: input.walk.start,
    budgetMin: remaining,
    pace: input.walk.pace,
    mode: input.walk.mode,
    shape,
    end: input.walk.end,
    demo: input.walk.isDemo,
  }, contextWeekday);
  const skippedNow = previous
    .filter((stop) => dropIds.includes(stop.entityId) && stop.state !== "visited")
    .map((stop) => ({ ...stop, state: "skipped" as const }));
  const stops = [...visited, ...skippedNow, ...fresh.map((stop, index) => ({ ...stop, seq: visited.length + skippedNow.length + index + 1 }))];
  const versionNumber = input.walk.currentVersion + 1;
  const version = versionFrom(versionNumber, input.reason, routed, stops);
  const diff = diffRoutes(previous, stops, version.totals.walkMin - (current?.totals.walkMin ?? 0));
  const plannedLeft = routed.walkMin + fresh.reduce((sum, stop) => sum + stop.dwellMin, 0);
  const walk: Walk = {
    ...input.walk,
    ...(doneNow ? { status: "done" as const } : {}),
    currentVersion: versionNumber,
    versions: [...input.walk.versions, version],
    pool,
    shape,
    returnMin,
    headingBack,
    remainingMin: headingBack ? returnMin : Math.round(Math.min(remainingRaw || input.walk.budgetMin, plannedLeft)),
  };
  const toast = doneNow ? "That was your last stop. Walk complete." : toastFrom(diff, stops, headingBack ? returnMin : remaining, headingBack, returnMin, previous, input.reason);
  return { walk, diff, toast };
}

function toastFrom(
  diff: ReturnType<typeof diffRoutes>,
  stops: Stop[],
  remaining: number,
  headingBack = false,
  returnMin = 0,
  previous: Stop[] = [],
  reason: RerouteReason = "skip",
): string {
  if (headingBack) return `Time to head back · ${Math.max(1, Math.round(returnMin))} min`;
  const added = stops.find((stop) => diff.added.includes(stop.entityId));
  const skipped = previous.find((stop) => stop.state === "next")
    ?? previous.find((stop) => diff.removed.includes(stop.entityId));
  const left = `${formatMinutes(remaining)} left`;
  // Only a skip or veto removed the next stop; other re-plans just changed the route.
  const skippedText = reason === "skip" || reason === "veto"
    ? (skipped ? `Skipped ${skipped.name}.` : "Skipped a stop.")
    : "Route updated.";
  if (added) return `${skippedText} Added ${added.name}, ${matchPhrase(added.affinity)}. ${left}.`;
  if (!stops.some((stop) => stop.state === "next" || stop.state === "todo")) {
    if (returnMin > 0) return `Time to head back · ${Math.max(1, Math.round(returnMin))} min`;
    return "That was your last stop. Head back?";
  }
  return `${skippedText} ${left}.`;
}

/** "an 86% match" / "a 70% match": the article follows how the number is said. */
function matchPhrase(affinity: number): string {
  const pct = Math.round(affinity * 100);
  const article = pct === 8 || pct === 11 || pct === 18 || (pct >= 80 && pct < 90) ? "an" : "a";
  return `${article} ${pct}% match`;
}

function withOrder(blurb: string, note?: string): string {
  if (!note) return blurb;
  const sentence = `${note.charAt(0).toUpperCase()}${note.slice(1)}.`;
  if (blurb.includes(sentence)) return blurb;
  return `${blurb} ${sentence}`;
}

export function currentRoute(walk: Walk): WalkRoute | undefined {
  return walk.versions[walk.versions.length - 1]?.route;
}
