import type {
  BudgetMode,
  Candidate,
  LatLon,
  Pace,
  PlaceHours,
  PlaceTag,
  RerouteDiff,
  ShapeMode,
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
  shop: 20,
  sight: 15,
};

const OUTDOOR = /park|trail|rooftop|garden|outdoor|plaza/i;
const EVENING = /nightlife|evening|live_music|bar|night/i;
const DENY = /parking|hotel|lodging|nail|gas station|gas_station|\batm\b|car wash|hospital/i;
// Places nobody walks to on a taste walk. Checked against the name and Qloo's
// category tags only, since other tags ("near a college") are context.
const NOT_A_STOP =
  /\b(coworking|office|business school|school|college|university|academic|alumni|gym|fitness|crossfit|apartments?|furnished|wedding venue|convention center|tattoo|piercing|animal rescue|rowing club|boat club|dance class|corporate|bank|dentist|clinic|pharmacy|real estate)\b/i;

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

const MEAL_GAP_MIN = 90;
const RETURN_SLACK_MIN = 8;
const RIDE_WALK_MIN = 20;
const LATE_HOUR = 21;

export type MealWindow = "breakfast" | "lunch" | "dinner";
type DayPart = "cafe" | "day" | "meal" | "evening" | "nightcap" | "any";

export function terminusFor(start: LatLon, shape?: ShapeMode, end?: LatLon | null): LatLon | null {
  const mode = shape ?? "loop";
  if (mode === "one-way") return null;
  if (mode === "end-near") return end ?? start;
  return start;
}

export function mealWindow(minuteOfDay: number): MealWindow | null {
  if (minuteOfDay < 11 * 60) return "breakfast";
  if (minuteOfDay < 15 * 60) return "lunch";
  if (minuteOfDay >= 17.5 * 60 && minuteOfDay < 21 * 60) return "dinner";
  return null;
}

function dayPart(category: string, tags: PlaceTag[]): DayPart {
  // Category tags only. Other tags are context ("offers coffee", "near a
  // dessert spot") and used to turn a doughnut shop into a nightcap.
  const blob = `${category} ${categoryTagText(tags)}`.toLowerCase();
  if (/dessert|nightcap|ice cream|gelato/.test(blob)) return "nightcap";
  if (category === "cafe" || /breakfast|coffee|brunch|\bcafe\b|café/.test(blob)) return "cafe";
  if (category === "bar" || category === "live_music" || /nightlife|live music|night club/.test(blob)) return "evening";
  if (category === "restaurant" || /\bdinner\b|\brestaurant\b/.test(blob)) return "meal";
  if (
    category === "museum" ||
    category === "park" ||
    category === "shop" ||
    category === "sight" ||
    /museum|gallery|\bshop\b|bookstore|\bsight\b|\bpark\b/.test(blob)
  ) {
    return "day";
  }
  return "any";
}

export function timeOfDayFit(
  category: string,
  tags: PlaceTag[],
  minuteOfDay: number,
  opts?: { last?: boolean; nearOrigin?: boolean },
): number {
  const part = dayPart(category, tags);
  if (part === "cafe") {
    if (minuteOfDay < 11 * 60) return 1.35;
    if (minuteOfDay < 14 * 60) return 0.85;
    return 0.4;
  }
  if (part === "day") return minuteOfDay >= 9 * 60 && minuteOfDay <= 17 * 60 ? 1.25 : 0.5;
  if (part === "meal") {
    if (minuteOfDay >= 17.5 * 60 && minuteOfDay < 21 * 60) return 1.4;
    if (minuteOfDay >= 11 * 60 && minuteOfDay < 15 * 60) return 1.1;
    return 0.35;
  }
  if (part === "evening") {
    if (minuteOfDay >= 20 * 60) return 1.4;
    if (minuteOfDay >= 17 * 60) return 1.25;
    return 0.45;
  }
  if (part === "nightcap") {
    if (opts?.last && opts.nearOrigin && minuteOfDay >= 19 * 60) return 1.45;
    if (minuteOfDay >= 20 * 60) return 0.7;
    return 0.35;
  }
  return 1;
}

export function orderNoteFor(
  category: string,
  tags: PlaceTag[],
  minuteOfDay: number,
  opts?: { last?: boolean; nearOrigin?: boolean },
): string | undefined {
  const part = dayPart(category, tags);
  if (part === "cafe" && minuteOfDay < 11 * 60) return "coffee while the morning is quiet";
  if (part === "meal" && minuteOfDay >= 17.5 * 60 && minuteOfDay < 21 * 60) return "dinner while kitchens are open";
  if (part === "meal" && minuteOfDay >= 11 * 60 && minuteOfDay < 15 * 60) return "lunch while kitchens are open";
  if (part === "day" && minuteOfDay >= 9 * 60 && minuteOfDay <= 17 * 60) return "a daytime stop while it's open";
  if (part === "evening" && minuteOfDay >= 17 * 60) return "once the room is open for the night";
  if (part === "nightcap" && opts?.last && opts.nearOrigin) return "a nightcap close to the start";
  return undefined;
}

function openWithin(hours: PlaceHours | undefined, weekday: string, from: Date, windowMin: number): boolean {
  for (let m = 0; m <= windowMin; m += 15) {
    if (isOpenAt(hours, weekday, new Date(from.getTime() + m * 60_000))) return true;
  }
  return false;
}

export function openThrough(
  hours: PlaceHours | undefined,
  weekday: string,
  eta: Date,
  dwellMin: number,
): boolean {
  if (!isOpenAt(hours, weekday, eta)) return false;
  if (!hours || dwellMin <= 1) return true;
  const last = new Date(eta.getTime() + (dwellMin - 1) * 60_000);
  return isOpenAt(hours, weekday, last);
}

export function shouldHeadBack(remainingMin: number, returnMin: number): boolean {
  if (returnMin <= 0) return false;
  return remainingMin <= returnMin + RETURN_SLACK_MIN;
}

export function shouldOfferRide(returnMin: number, hour: number): boolean {
  return returnMin > RIDE_WALK_MIN || hour >= LATE_HOUR;
}

function isFullMeal(cand: { category: string }): boolean {
  return cand.category === "restaurant";
}

function minuteOf(date: Date): number {
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

function normAddress(address?: string): string {
  return (address ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function categoryTagText(tags: PlaceTag[]): string {
  return tags
    .filter((tag) => tag.type?.includes("category:place") || tag.id.includes("category:place"))
    .map((tag) => tag.name)
    .join(" · ");
}

function denied(candidate: Candidate): boolean {
  if (DENY.test(candidate.name) || DENY.test(candidate.categoryLabel)) return true;
  if (NOT_A_STOP.test(candidate.categoryLabel) || NOT_A_STOP.test(categoryTagText(candidate.tags))) return true;
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
    /** Keep places that open within this many minutes of departure. Arrival hours are checked by fitsSequence. */
    windowMin?: number;
  },
): Scored[] {
  const drop = new Set(opts.dropIds);
  const kept: Candidate[] = [];
  const byAddress = new Map<string, Candidate>();

  for (const candidate of raw) {
    if (drop.has(candidate.entityId)) continue;
    if (candidate.isClosed) continue;
    if (denied(candidate)) continue;
    if (!openWithin(candidate.hours, opts.weekday, opts.departAt, opts.windowMin ?? 0)) continue;
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

export function plannedMinutes(
  start: LatLon,
  seq: { lat: number; lon: number; dwellMin: number }[],
  pace: Pace,
  terminus: LatLon | null,
): number {
  let minutes = 0;
  let prev: LatLon = start;
  for (const stop of seq) {
    minutes += walkMinutes(prev, stop, pace) + stop.dwellMin;
    prev = stop;
  }
  if (terminus && seq.length) minutes += walkMinutes(prev, terminus, pace);
  return minutes;
}

function routeMinutes(start: LatLon, seq: Scored[], pace: Pace, terminus: LatLon | null): number {
  return plannedMinutes(start, seq, pace, terminus);
}

function marginalWalk(
  start: LatLon,
  seq: Scored[],
  index: number,
  cand: Scored,
  pace: Pace,
  terminus: LatLon | null,
): number {
  const prev = index === 0 ? start : seq[index - 1];
  const next = seq[index] ?? terminus ?? undefined;
  const added = walkMinutes(prev, cand, pace) + (next ? walkMinutes(cand, next, pace) : 0);
  const removed = next ? walkMinutes(prev, next, pace) : 0;
  return added - removed;
}

function arrivalMinutes(start: LatLon, seq: Scored[], departAt: Date, pace: Pace): number[] {
  const minutes: number[] = [];
  let elapsed = 0;
  let prev: LatLon = start;
  for (const stop of seq) {
    elapsed += walkMinutes(prev, stop, pace);
    minutes.push(minuteOf(new Date(departAt.getTime() + elapsed * 60_000)));
    elapsed += stop.dwellMin;
    prev = stop;
  }
  return minutes;
}

function mealsOk(
  seq: Scored[],
  start: LatLon,
  opts: { departAt: Date; pace: Pace },
): boolean {
  const arrivals = arrivalMinutes(start, seq, opts.departAt, opts.pace);
  const meals: number[] = [];
  const windows = new Map<MealWindow, number>();
  seq.forEach((stop, index) => {
    if (!isFullMeal(stop)) return;
    const minute = arrivals[index] ?? 0;
    meals.push(minute);
    const window = mealWindow(minute);
    if (!window) return;
    windows.set(window, (windows.get(window) ?? 0) + 1);
  });
  for (const count of windows.values()) {
    if (count > 1) return false;
  }
  for (let i = 0; i < meals.length; i += 1) {
    for (let j = i + 1; j < meals.length; j += 1) {
      const gap = Math.abs(meals[i] - meals[j]);
      if (Math.min(gap, 1440 - gap) < MEAL_GAP_MIN) return false;
    }
  }
  return true;
}

function bearingRad(a: LatLon, b: LatLon): number {
  const φ1 = (a.lat * Math.PI) / 180;
  const φ2 = (b.lat * Math.PI) / 180;
  const Δλ = ((b.lon - a.lon) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return Math.atan2(y, x);
}

function angleDelta(a: number, b: number): number {
  let delta = (a - b) % (2 * Math.PI);
  if (delta > Math.PI) delta -= 2 * Math.PI;
  if (delta < -Math.PI) delta += 2 * Math.PI;
  return delta;
}

/** A return that walks back up the same street loses to a near-equal alternative. */
function retraceFactor(start: LatLon, seq: LatLon[], terminus: LatLon | null): number {
  const points = [start, ...seq, ...(terminus ? [terminus] : [])];
  const legs: { a: LatLon; b: LatLon }[] = [];
  for (let i = 1; i < points.length; i += 1) {
    if (haversineM(points[i - 1], points[i]) < 25) continue;
    legs.push({ a: points[i - 1], b: points[i] });
  }
  for (let i = 0; i < legs.length; i += 1) {
    for (let j = i + 1; j < legs.length; j += 1) {
      const reverse = Math.abs(angleDelta(bearingRad(legs[i].a, legs[i].b) + Math.PI, bearingRad(legs[j].a, legs[j].b)));
      if (reverse > (30 * Math.PI) / 180) continue;
      const midA = { lat: (legs[i].a.lat + legs[i].b.lat) / 2, lon: (legs[i].a.lon + legs[i].b.lon) / 2 };
      const midB = { lat: (legs[j].a.lat + legs[j].b.lat) / 2, lon: (legs[j].a.lon + legs[j].b.lon) / 2 };
      if (haversineM(midA, midB) <= 80) return 0.68;
    }
  }
  return 1;
}

function averageFit(seq: Scored[], start: LatLon, departAt: Date, pace: Pace, terminus: LatLon | null): number {
  if (!seq.length) return 1;
  const arrivals = arrivalMinutes(start, seq, departAt, pace);
  const total = seq.reduce((sum, stop, index) => {
    const last = index === seq.length - 1;
    const near = terminus ? haversineM(stop, terminus) < 450 : false;
    return sum + timeOfDayFit(stop.category, stop.tags, arrivals[index] ?? 0, { last, nearOrigin: near });
  }, 0);
  return total / seq.length;
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

export type ChosenStop = Scored & { ratio: number; orderNote?: string };

export type SelectOpts = {
  budgetMin: number;
  pace: Pace;
  mode: BudgetMode;
  departAt: Date;
  weekday: string;
  shape?: ShapeMode;
  end?: LatLon | null;
};

export function selectStops(pool: Scored[], start: LatLon, opts: SelectOpts): ChosenStop[] {
  const limit = opts.budgetMin - 5;
  const cap = stopCap(opts.mode);
  const shape = opts.shape ?? "loop";
  const terminus = terminusFor(start, shape, opts.end);
  // Places open on a direct walk from the start rank ahead of places that open
  // later, so a wide hours window never crowds open-now places out of the 40.
  const openSoon = (cand: Scored) =>
    isOpenAt(cand.hours, opts.weekday, new Date(opts.departAt.getTime() + walkMinutes(start, cand, opts.pace) * 60_000));
  const byScore = (a: Scored, b: Scored) => b.baseScore - a.baseScore;
  const ranked = [
    ...pool.filter(openSoon).sort(byScore),
    ...pool.filter((cand) => !openSoon(cand)).sort(byScore),
  ].slice(0, 40);
  let seq: Scored[] = [];

  while (seq.length < cap) {
    let best: { cand: Scored; index: number; ratio: number } | null = null;
    for (const cand of ranked) {
      if (seq.some((item) => item.entityId === cand.entityId)) continue;
      for (let index = 0; index <= seq.length; index += 1) {
        const next = [...seq.slice(0, index), cand, ...seq.slice(index)];
        if (!fitsSequence(next, start, opts, terminus, limit)) continue;
        const arrivals = arrivalMinutes(start, next, opts.departAt, opts.pace);
        const minute = arrivals[index] ?? 0;
        const last = index === next.length - 1;
        const near = terminus ? haversineM(cand, terminus) < 450 : false;
        const part = dayPart(cand.category, cand.tags);
        const fit = timeOfDayFit(cand.category, cand.tags, minute, { last, nearOrigin: near });
        if (part === "meal" && fit < 0.8) continue;
        if (part === "nightcap" && !(last && near)) continue;
        const deltaWalk = marginalWalk(start, seq, index, cand, opts.pace, terminus);
        const ratio =
          (cand.baseScore * diversity(seq, cand) * fit * retraceFactor(start, next, terminus)) /
          Math.max(deltaWalk + cand.dwellMin, 0.5);
        if (!best || ratio > best.ratio) best = { cand, index, ratio };
      }
    }
    if (!best) break;
    seq = [...seq.slice(0, best.index), best.cand, ...seq.slice(best.index)];
  }

  seq = terminus ? twoOptClosed(start, seq, opts, terminus, limit) : twoOpt(start, seq);
  seq = swapPass(ranked, start, seq, opts.pace, limit, opts, terminus);
  if (terminus) {
    seq = placeNightcaps(start, seq, opts, terminus, limit);
    seq = centerFarthest(start, seq, opts, terminus, limit);
  }

  const arrivals = arrivalMinutes(start, seq, opts.departAt, opts.pace);
  return seq.map((cand, index) => {
    const last = index === seq.length - 1;
    const near = terminus ? haversineM(cand, terminus) < 450 : false;
    return {
      ...cand,
      ratio: cand.baseScore / Math.max(walkMinutes(start, cand, opts.pace) + cand.dwellMin, 0.5),
      orderNote: orderNoteFor(cand.category, cand.tags, arrivals[index] ?? 0, { last, nearOrigin: near }),
    };
  });
}

function fitsSequence(
  seq: Scored[],
  start: LatLon,
  opts: SelectOpts,
  terminus: LatLon | null,
  limit: number,
): boolean {
  if (!openAlong(seq, start, opts)) return false;
  if (!mealsOk(seq, start, opts)) return false;
  if (!dayPartOk(seq, start, opts, terminus)) return false;
  return routeMinutes(start, seq, opts.pace, terminus) <= limit;
}

function dayPartOk(seq: Scored[], start: LatLon, opts: SelectOpts, terminus: LatLon | null): boolean {
  const arrivals = arrivalMinutes(start, seq, opts.departAt, opts.pace);
  return seq.every((stop, index) => {
    const part = dayPart(stop.category, stop.tags);
    const last = index === seq.length - 1;
    const near = terminus ? haversineM(stop, terminus) < 450 : false;
    const fit = timeOfDayFit(stop.category, stop.tags, arrivals[index] ?? 0, { last, nearOrigin: near });
    if (part === "meal" && fit < 0.8) return false;
    if (part === "nightcap" && !(last && near)) return false;
    return true;
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
    if (!openThrough(stop.hours, opts.weekday, eta, stop.dwellMin)) return false;
    elapsed += stop.dwellMin;
    prev = stop;
  }
  return true;
}

function twoOptClosed(
  start: LatLon,
  seq: Scored[],
  opts: SelectOpts,
  terminus: LatLon,
  limit: number,
): Scored[] {
  let route = seq;
  let guard = 0;
  let improved = true;
  while (improved && guard < 8) {
    improved = false;
    guard += 1;
    for (let i = 0; i < route.length - 1; i += 1) {
      for (let k = i + 1; k < route.length; k += 1) {
        const next = [...route.slice(0, i), ...route.slice(i, k + 1).reverse(), ...route.slice(k + 1)];
        const before = pathMeters(start, [...route, terminus]);
        const after = pathMeters(start, [...next, terminus]);
        if (after + 1e-6 >= before) continue;
        if (!fitsSequence(next, start, opts, terminus, limit)) continue;
        if (averageFit(next, start, opts.departAt, opts.pace, terminus) + 0.2 < averageFit(route, start, opts.departAt, opts.pace, terminus)) {
          continue;
        }
        route = next;
        improved = true;
      }
    }
  }
  return route;
}

function placeNightcaps(
  start: LatLon,
  seq: Scored[],
  opts: SelectOpts,
  terminus: LatLon,
  limit: number,
): Scored[] {
  const caps = seq.filter((stop) => dayPart(stop.category, stop.tags) === "nightcap" && haversineM(stop, terminus) < 450);
  if (!caps.length) return seq;
  let route = seq.filter((stop) => !caps.some((cap) => cap.entityId === stop.entityId));
  for (const cap of caps) {
    const next = [...route, cap];
    if (!fitsSequence(next, start, opts, terminus, limit)) continue;
    route = next;
  }
  return route.length ? route : seq;
}

function centerFarthest(
  start: LatLon,
  seq: Scored[],
  opts: SelectOpts,
  terminus: LatLon,
  limit: number,
): Scored[] {
  if (seq.length < 3) return seq;
  let far = 0;
  let farD = -1;
  seq.forEach((stop, index) => {
    const distance = haversineM(start, stop);
    if (distance > farD) {
      farD = distance;
      far = index;
    }
  });
  const fraction = far / Math.max(seq.length - 1, 1);
  if (fraction >= 0.35 && fraction <= 0.65) return seq;
  const item = seq[far];
  const rest = seq.filter((_, index) => index !== far);
  const insertAt = Math.min(rest.length, Math.round(rest.length / 2));
  const next = [...rest.slice(0, insertAt), item, ...rest.slice(insertAt)];
  const before = routeMinutes(start, seq, opts.pace, terminus);
  const after = routeMinutes(start, next, opts.pace, terminus);
  if (after > before * 1.15 || after > limit) return seq;
  if (!fitsSequence(next, start, opts, terminus, limit)) return seq;
  return next;
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
  opts: SelectOpts,
  terminus: LatLon | null,
): Scored[] {
  const rank = (candidate: Scored[]) =>
    scoreSum(candidate) * averageFit(candidate, start, opts.departAt, pace, terminus);
  let route = seq;
  let bestScore = rank(route);
  for (let index = 0; index < route.length; index += 1) {
    for (const cand of pool) {
      if (route.some((item) => item.entityId === cand.entityId)) continue;
      const next = [...route.slice(0, index), cand, ...route.slice(index + 1)];
      if (!fitsSequence(next, start, opts, terminus, limit)) continue;
      const score = rank(next);
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
