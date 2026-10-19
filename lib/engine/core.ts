import type {
  BudgetMode,
  Candidate,
  LatLon,
  Pace,
  PlaceHours,
  RerouteDiff,
  Stop,
  TasteTag,
} from "@/lib/types";

const EARTH_M = 6_371_000;
const OSRM_FOOT_KMH = 4.4;

const DWELL: Record<string, number> = {
  cafe: 20,
  bar: 35,
  live_music: 45,
  museum: 50,
  park: 15,
  restaurant: 60,
};

const OUTDOOR = /park|trail|rooftop|garden|outdoor|plaza/i;
const EVENING = /nightlife|evening|live_music|bar|night/i;
const DENY = /parking|hotel|lodging|nail|gas station|gas_station|\batm\b|car wash|hospital/i;

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function paceKmh(pace: Pace): number {
  if (pace === "brisk") return 5.2;
  return 4.0;
}

export function paceFactor(pace: Pace): number {
  return OSRM_FOOT_KMH / paceKmh(pace);
}

export function radiusM(pace: Pace, budgetMin: number): number {
  const speedMPerMin = (paceKmh(pace) * 1000) / 60;
  return Math.round(clamp(speedMPerMin * budgetMin * 0.35, 600, 2500));
}

export function haversineM(a: LatLon, b: LatLon): number {
  const φ1 = (a.lat * Math.PI) / 180;
  const φ2 = (b.lat * Math.PI) / 180;
  const dφ = ((b.lat - a.lat) * Math.PI) / 180;
  const dλ = ((b.lon - a.lon) * Math.PI) / 180;
  const h =
    Math.sin(dφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function walkMinutes(a: LatLon, b: LatLon, pace: Pace): number {
  return (haversineM(a, b) * 1.3) / ((paceKmh(pace) * 1000) / 60);
}

export function dwellMinutes(category: string, pace: Pace): number {
  const base = DWELL[category] ?? 25;
  return pace === "easy" ? base * 1.1 : base;
}

export function stopCap(mode: BudgetMode): number {
  if (mode === "1h") return 3;
  if (mode === "2h") return 4;
  if (mode === "tonight") return 5;
  return 8;
}

export function minutesOfDay(value: string): number {
  const match = /(\d{2}):(\d{2})/.exec(value);
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function isOpenAt(
  hours: PlaceHours | undefined,
  weekday: string,
  eta: Date,
): boolean {
  if (!hours) return true;
  const intervals = hours[weekday.toLowerCase()];
  if (!intervals) return true;
  if (intervals.length === 0) return false;
  const now = eta.getUTCHours() * 60 + eta.getUTCMinutes();
  return intervals.some((interval) => {
    const opens = minutesOfDay(interval.opens);
    const closes = minutesOfDay(interval.closes);
    if (closes === opens) return true;
    if (closes > opens) return now >= opens && now < closes;
    return now >= opens || now < closes;
  });
}

export function closesWithin(
  hours: PlaceHours | undefined,
  weekday: string,
  eta: Date,
  withinMin: number,
): boolean {
  if (!hours) return false;
  const intervals = hours[weekday.toLowerCase()];
  if (!intervals?.length) return false;
  const now = eta.getUTCHours() * 60 + eta.getUTCMinutes();
  return intervals.some((interval) => {
    const closes = minutesOfDay(interval.closes);
    const delta = closes >= now ? closes - now : closes + 1440 - now;
    return delta > 0 && delta < withinMin;
  });
}

function normAddress(address?: string): string {
  return (address ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function denied(candidate: Candidate): boolean {
  if (DENY.test(candidate.name) || DENY.test(candidate.categoryLabel)) return true;
  return candidate.tags.some((tag) => DENY.test(tag.name) || DENY.test(tag.id));
}

export type Scored = Candidate & {
  baseScore: number;
  tagOverlap: { id: string; name: string }[];
  dwellMin: number;
};

export function prepareCandidates(
  raw: Candidate[],
  opts: {
    departAt: Date;
    weekday: string;
    pace: Pace;
    dropIds: string[];
    userTags: TasteTag[];
    rainy: boolean;
    evening: boolean;
  },
): Scored[] {
  const drop = new Set(opts.dropIds);
  const kept: Candidate[] = [];
  const byAddress = new Map<string, Candidate>();

  for (const candidate of raw) {
    if (drop.has(candidate.entityId)) continue;
    if (candidate.isClosed) continue;
    if (denied(candidate)) continue;
    if (!isOpenAt(candidate.hours, opts.weekday, opts.departAt)) continue;
    const address = normAddress(candidate.address);
    if (address) {
      const prev = byAddress.get(address);
      if (prev && prev.affinity >= candidate.affinity) continue;
      if (prev) {
        const index = kept.findIndex((item) => item.entityId === prev.entityId);
        if (index >= 0) kept.splice(index, 1);
      }
      byAddress.set(address, candidate);
    }
    kept.push(candidate);
  }

  const spaced: Candidate[] = [];
  for (const candidate of kept.sort((a, b) => b.affinity - a.affinity)) {
    const close = spaced.find(
      (other) =>
        other.category === candidate.category &&
        haversineM(other, candidate) < 40,
    );
    if (close) continue;
    spaced.push(candidate);
  }

  const affinities = spaced.map((item) => item.affinity);
  const min = affinities.length ? Math.min(...affinities) : 0;
  const max = affinities.length ? Math.max(...affinities) : 1;

  return spaced.map((candidate) => {
    const affinityNorm = max === min ? 1 : (candidate.affinity - min) / (max - min);
    const tagOverlap = overlap(candidate, opts.userTags);
    let score =
      affinityNorm ** 1.5 * (1 + 0.15 * tagOverlap.length);
    const outdoor =
      candidate.category === "park" ||
      candidate.tags.some((tag) => OUTDOOR.test(tag.name) || OUTDOOR.test(tag.id));
    if (opts.rainy && outdoor) score *= 0.3;
    const eveningish =
      candidate.tags.some((tag) => EVENING.test(tag.name) || EVENING.test(tag.id)) ||
      candidate.category === "bar" ||
      candidate.category === "live_music";
    if (opts.evening && eveningish) score *= 1.15;
    return {
      ...candidate,
      baseScore: score,
      tagOverlap,
      dwellMin: dwellMinutes(candidate.category, opts.pace),
    };
  });
}

function overlap(candidate: Candidate, tags: TasteTag[]): { id: string; name: string }[] {
  const names = new Set(tags.map((tag) => tag.name.toLowerCase()));
  const ids = new Set(tags.map((tag) => tag.id));
  const seen = new Set<string>();
  const hits: { id: string; name: string }[] = [];
  for (const tag of candidate.tags) {
    if (!ids.has(tag.id) && !names.has(tag.name.toLowerCase())) continue;
    if (seen.has(tag.id)) continue;
    seen.add(tag.id);
    hits.push({ id: tag.id, name: tag.name });
  }
  return hits;
}

function pathMeters(start: LatLon, seq: LatLon[]): number {
  let meters = 0;
  let prev = start;
  for (const point of seq) {
    meters += haversineM(prev, point) * 1.3;
    prev = point;
  }
  return meters;
}

function routeMinutes(start: LatLon, seq: Scored[], pace: Pace): number {
  let minutes = 0;
  let prev: LatLon = start;
  for (const stop of seq) {
    minutes += walkMinutes(prev, stop, pace) + stop.dwellMin;
    prev = stop;
  }
  return minutes;
}

function marginalWalk(
  start: LatLon,
  seq: Scored[],
  index: number,
  cand: Scored,
  pace: Pace,
): number {
  const prev = index === 0 ? start : seq[index - 1];
  const next = seq[index];
  const added = walkMinutes(prev, cand, pace) + (next ? walkMinutes(cand, next, pace) : 0);
  const removed = next ? walkMinutes(prev, next, pace) : 0;
  return added - removed;
}

function diversity(seq: Scored[], cand: Scored): number {
  const same = seq.filter((item) => item.category === cand.category).length;
  return 0.6 ** same;
}

function scoreSum(seq: Scored[]): number {
  let total = 0;
  seq.forEach((cand, index) => {
    const prior = seq.slice(0, index);
    total += cand.baseScore * diversity(prior, cand);
  });
  return total;
}

export type ChosenStop = Scored & { ratio: number };

export function selectStops(
  pool: Scored[],
  start: LatLon,
  opts: { budgetMin: number; pace: Pace; mode: BudgetMode; departAt: Date; weekday: string },
): ChosenStop[] {
  const limit = opts.budgetMin - 5;
  const cap = stopCap(opts.mode);
  const ranked = [...pool].sort((a, b) => b.baseScore - a.baseScore).slice(0, 40);
  let seq: Scored[] = [];

  while (seq.length < cap) {
    let best: { cand: Scored; index: number; ratio: number } | null = null;
    for (const cand of ranked) {
      if (seq.some((item) => item.entityId === cand.entityId)) continue;
      for (let index = 0; index <= seq.length; index += 1) {
        const next = [...seq.slice(0, index), cand, ...seq.slice(index)];
        if (!openAlong(next, start, opts)) continue;
        const cost = routeMinutes(start, next, opts.pace);
        if (cost > limit) continue;
        const deltaWalk = marginalWalk(start, seq, index, cand, opts.pace);
        const ratio =
          (cand.baseScore * diversity(seq, cand)) /
          Math.max(deltaWalk + cand.dwellMin, 0.5);
        if (!best || ratio > best.ratio) best = { cand, index, ratio };
      }
    }
    if (!best) break;
    seq = [...seq.slice(0, best.index), best.cand, ...seq.slice(best.index)];
  }

  seq = twoOpt(start, seq);
  seq = swapPass(ranked, start, seq, opts.pace, limit, opts);

  return seq.map((cand) => {
    const walk = walkMinutes(start, cand, opts.pace);
    return {
      ...cand,
      ratio: cand.baseScore / Math.max(walk + cand.dwellMin, 0.5),
    };
  });
}

function openAlong(
  seq: Scored[],
  start: LatLon,
  opts: { pace: Pace; departAt: Date; weekday: string },
): boolean {
  let elapsed = 0;
  let prev: LatLon = start;
  for (const stop of seq) {
    elapsed += walkMinutes(prev, stop, opts.pace);
    const eta = new Date(opts.departAt.getTime() + elapsed * 60_000);
    if (!isOpenAt(stop.hours, opts.weekday, eta)) return false;
    elapsed += stop.dwellMin;
    prev = stop;
  }
  return true;
}

export function twoOpt(start: LatLon, seq: Scored[]): Scored[] {
  let route = seq;
  let guard = 0;
  let improved = true;
  while (improved && guard < 8) {
    improved = false;
    guard += 1;
    for (let i = 0; i < route.length - 1; i += 1) {
      for (let k = i + 1; k < route.length; k += 1) {
        const next = [
          ...route.slice(0, i),
          ...route.slice(i, k + 1).reverse(),
          ...route.slice(k + 1),
        ];
        if (pathMeters(start, next) + 1e-6 < pathMeters(start, route)) {
          route = next;
          improved = true;
        }
      }
    }
  }
  return route;
}

function swapPass(
  pool: Scored[],
  start: LatLon,
  seq: Scored[],
  pace: Pace,
  limit: number,
  opts: { departAt: Date; weekday: string; pace: Pace },
): Scored[] {
  let route = seq;
  let bestScore = scoreSum(route);
  for (let index = 0; index < route.length; index += 1) {
    for (const cand of pool) {
      if (route.some((item) => item.entityId === cand.entityId)) continue;
      const next = [...route.slice(0, index), cand, ...route.slice(index + 1)];
      if (!openAlong(next, start, opts)) continue;
      if (routeMinutes(start, next, pace) > limit) continue;
      const score = scoreSum(next);
      if (score > bestScore + 1e-9) {
        route = next;
        bestScore = score;
      }
    }
  }
  return route;
}

export function withStability(pool: Scored[], keepIds: string[]): Scored[] {
  const keep = new Set(keepIds);
  return pool.map((cand) =>
    keep.has(cand.entityId) ? { ...cand, baseScore: cand.baseScore * 1.2 } : cand,
  );
}

export function diffRoutes(previous: Stop[], next: Stop[], deltaMin: number): RerouteDiff {
  const prevIds = previous.filter((stop) => stop.state !== "visited").map((stop) => stop.entityId);
  const nextIds = next.filter((stop) => stop.state !== "visited").map((stop) => stop.entityId);
  const prevSet = new Set(prevIds);
  const nextSet = new Set(nextIds);
  const removed = prevIds.filter((id) => !nextSet.has(id));
  const added = nextIds.filter((id) => !prevSet.has(id));
  const sharedPrev = prevIds.filter((id) => nextSet.has(id));
  const sharedNext = nextIds.filter((id) => prevSet.has(id));
  const reordered = sharedPrev.some((id, index) => sharedNext[index] !== id);
  return { removed, added, reordered, deltaMin };
}

export function distanceToPolylineM(point: LatLon, line: [number, number][]): number {
  if (line.length === 0) return Infinity;
  if (line.length === 1) {
    return haversineM(point, { lon: line[0][0], lat: line[0][1] });
  }
  let best = Infinity;
  for (let i = 1; i < line.length; i += 1) {
    best = Math.min(best, distanceToSegment(point, line[i - 1], line[i]));
  }
  return best;
}

function distanceToSegment(
  point: LatLon,
  a: [number, number],
  b: [number, number],
): number {
  const start = { lon: a[0], lat: a[1] };
  const end = { lon: b[0], lat: b[1] };
  const ab = haversineM(start, end);
  if (ab < 1) return haversineM(point, start);
  const ap = haversineM(start, point);
  const bp = haversineM(end, point);
  const along = clamp((ap ** 2 + ab ** 2 - bp ** 2) / (2 * ab), 0, ab);
  const cross = Math.sqrt(Math.max(ap ** 2 - along ** 2, 0));
  return cross;
}

export function shouldAutoReroute(input: {
  distanceM: number;
  accuracyM: number;
  consecutiveOffRoute: number;
  sinceLastMs: number;
}): boolean {
  return (
    input.distanceM > 60 &&
    input.accuracyM < 50 &&
    input.consecutiveOffRoute >= 2 &&
    input.sinceLastMs >= 90_000
  );
}

export function lowestRatioIndex(stops: { ratio: number }[]): number {
  let index = 0;
  for (let i = 1; i < stops.length; i += 1) {
    if (stops[i].ratio < stops[index].ratio) index = i;
  }
  return index;
}
