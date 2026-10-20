import { explainBlurb, templateBlurb } from "@/lib/agent/blurb";
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
} from "@/lib/engine/core";
import { geohash } from "@/lib/geohash";
import { sha } from "@/lib/hash";
import { getQuota, placesNear, qlooConfigured, quotaMode, resolveSampleIds } from "@/lib/qloo/client";
import { formatMinutes } from "@/lib/format";
import { DESIGN_POOL, designReroute, designWalk } from "@/lib/plan/design-walk";
import { osrmConfigured, routeFoot, type Routed } from "@/lib/routing/osrm";
import { demoClock, readContext } from "@/lib/weather/open-meteo";
import type {
  BudgetMode,
  Candidate,
  LatLon,
  Pace,
  RerouteReason,
  ShapeMode,
  StartPoint,
  Stop,
  TasteProfile,
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
  onStep?: (text: string) => void;
};

function poolCacheKey(profile: TasteProfile, hash: string, radius: number, weekday: string): string {
  const signature = sha(
    `${profile.entities.map((e) => e.id).sort().join(",")}|${profile.tags.map((t) => t.id).sort().join(",")}`,
  );
  // Bump the version when normalized Candidate fields change, so cached pools are not reused.
  return `qp:v2:${signature}:${hash}:${radius}:${weekday}`;
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
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const page = await placesNear({
      lat: input.start.lat,
      lon: input.start.lon,
      radius: current,
      weekday,
      entities: profile.entities,
      tags: profile.tags,
      allowLive: liveAllowed,
    });
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
      });
      const seen = new Set(collected.map((item) => item.entityId));
      collected = [...collected, ...more.filter((item) => !seen.has(item.entityId))];
    }
    current = Math.min(2500, Math.round(current * 1.6));
  }
  const finalKey = poolCacheKey(profile, hash, current, weekday);
  if (collected.length && qlooConfigured()) {
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

export async function buildWalk(input: PlanInput): Promise<Walk> {
  if (input.demo && !qlooConfigured() && !osrmConfigured()) {
    input.onStep?.("Setting the demo clock to Saturday evening…");
    input.onStep?.("Searching Qloo near you…");
    input.onStep?.("Fitting stops to your time…");
    input.onStep?.("Drawing the Austin sample path…");
    return designWalk(input);
  }
  input.onStep?.(input.demo ? "Setting the demo clock to Saturday evening…" : "Checking the time and the weather…");
  const context = input.demo ? demoClock() : await readContext(input.start.lat, input.start.lon, input.tz);
  input.onStep?.("Searching Qloo near you…");
  const loaded = await loadCandidates(input, context.weekday, Boolean(context.weather?.isRainy));
  if (qlooConfigured() && !loaded.fromCache && loaded.candidates.length === 0) {
    const mode = quotaMode((await getQuota()).remaining);
    if (mode === "demo-or-cache" && !input.demo) {
      throw Object.assign(new Error("quota"), { code: "quota" });
    }
  }
  input.onStep?.("Fitting stops to your time…");
  const prepared = prepareCandidates(loaded.candidates, {
    departAt: departAt(input),
    weekday: context.weekday,
    pace: input.pace,
    dropIds: [],
    userTags: input.profile.tags,
    rainy: Boolean(context.weather?.isRainy),
    evening: isEvening(input),
    windowMin: input.budgetMin,
  });
  const shape = input.shape ?? "loop";
  let chosen = selectStops(prepared, input.start, {
    budgetMin: input.budgetMin,
    pace: input.pace,
    mode: input.mode,
    departAt: departAt(input),
    weekday: context.weekday,
    shape,
    end: input.end,
  });
  input.onStep?.(osrmLine());
  let routed = await routeThrough(input.start, chosen, input.pace, shape, input.end);
  let total = routed.walkMin + chosen.reduce((sum, stop) => sum + stop.dwellMin, 0);
  if (chosen.length > 1 && total > input.budgetMin * 1.05) {
    const drop = lowestRatioIndex(chosen);
    chosen = chosen.filter((_, index) => index !== drop);
    routed = await routeThrough(input.start, chosen, input.pace, shape, input.end);
    total = routed.walkMin + chosen.reduce((sum, stop) => sum + stop.dwellMin, 0);
  }
  const stops = toStops(chosen, routed, input, context.weekday);
  const version = versionFrom(1, "initial", routed, stops);
  const returnMin = closingMinutes(routed, shape, chosen.length);
  return {
    id: crypto.randomUUID(),
    status: "active",
    mode: input.mode,
    budgetMin: input.budgetMin,
    pace: input.pace,
    start: input.start,
    isDemo: Boolean(input.demo),
    mock: !qlooConfigured(),
    poolKey: loaded.poolKey,
    pool: loaded.candidates.slice(0, 100),
    currentVersion: 1,
    versions: [version],
    startedAt: new Date().toISOString(),
    stepsNote: input.pace === "stepfree" ? "Step-free is best-effort and may include steps." : undefined,
    shape,
    end: input.end,
    returnMin,
    headingBack: false,
    remainingMin: Math.round(Math.min(input.budgetMin, total)),
  };
}

function osrmLine(): string {
  return process.env.OSRM_BASE_URL
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
  if (input.walk.poolKey === DESIGN_POOL && input.walk.mock && input.reason === "skip") {
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
    currentVersion: versionNumber,
    versions: [...input.walk.versions, version],
    pool,
    shape,
    returnMin,
    headingBack,
    remainingMin: headingBack ? returnMin : Math.round(Math.min(remainingRaw || input.walk.budgetMin, plannedLeft)),
  };
  return { walk, diff, toast: toastFrom(diff, stops, headingBack ? returnMin : remaining, headingBack, returnMin) };
}

function toastFrom(
  diff: ReturnType<typeof diffRoutes>,
  stops: Stop[],
  remaining: number,
  headingBack = false,
  returnMin = 0,
): string {
  if (headingBack) return `Time to head back · ${Math.max(1, Math.round(returnMin))} min`;
  const added = stops.find((stop) => diff.added.includes(stop.entityId));
  const removed = diff.removed[0];
  const left = formatMinutes(remaining);
  if (added && removed) {
    return `Skipped a stop. Added ${added.name}, a ${added.affinity.toFixed(2)} match. Still ${left}.`;
  }
  if (added) return `Added ${added.name}, a ${added.affinity.toFixed(2)} match. Still ${left}.`;
  if (!stops.some((stop) => stop.state === "next" || stop.state === "todo")) {
    if (returnMin > 0) return `Time to head back · ${Math.max(1, Math.round(returnMin))} min`;
    return "That was your last stop. Head back?";
  }
  return `Route updated. Still ${left}.`;
}

export async function maybeLlmBlurb(walk: Walk, profile: TasteProfile): Promise<Walk> {
  const version = walk.versions[walk.versions.length - 1];
  if (!version) return walk;
  if (!process.env.VERCEL_OIDC_TOKEN && !process.env.AI_GATEWAY_API_KEY) return walk;
  const stops = await Promise.all(
    version.stops.map(async (stop) => ({
      ...stop,
      blurb: withOrder(
        await explainBlurb({
          place: stop.name,
          evidence: stop.evidence,
          profile,
          entityId: stop.entityId,
        }),
        stop.orderNote,
      ),
    })),
  );
  const versions = walk.versions.slice(0, -1).concat({ ...version, stops });
  return { ...walk, versions };
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
