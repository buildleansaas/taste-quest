import { describe, expect, it } from "vitest";
import {
  dwellMinutes,
  haversineM,
  isOpenAt,
  openThrough,
  orderNoteFor,
  plannedMinutes,
  prepareCandidates,
  radiusM,
  selectStops,
  shouldAutoReroute,
  shouldHeadBack,
  shouldOfferRide,
  twoOpt,
  type Scored,
} from "@/lib/engine/core";
import { SAMPLE_PLACES } from "@/lib/qloo/sample";
import { demoProfile, DEMO_START } from "@/lib/taste/curated";
import { buildWalk, rerouteWalk } from "@/lib/plan/build";
import { designReroute } from "@/lib/plan/design-walk";
import type { Candidate, Walk } from "@/lib/types";
import { formatMinutes } from "@/lib/format";

const saturday = "saturday";
const evening = new Date(Date.UTC(2026, 9, 24, 19, 0));

function scored(partial: Partial<Scored> & Pick<Scored, "entityId" | "lat" | "lon">): Scored {
  return {
    name: partial.entityId,
    affinity: 0.8,
    category: "cafe",
    categoryLabel: "Cafe",
    tags: [],
    entityShares: [],
    baseScore: 1,
    tagOverlap: [],
    dwellMin: 20,
    ...partial,
  };
}

describe("hours", () => {
  const overnight = { saturday: [{ opens: "T18:00:00", closes: "T02:00:00" }] };
  it("treats a close after midnight as still open", () => {
    expect(isOpenAt(overnight, "saturday", new Date(Date.UTC(2026, 9, 24, 23, 30)))).toBe(true);
    expect(isOpenAt(overnight, "saturday", new Date(Date.UTC(2026, 9, 25, 1, 0)))).toBe(true);
    expect(isOpenAt(overnight, "saturday", new Date(Date.UTC(2026, 9, 25, 3, 0)))).toBe(false);
    expect(isOpenAt(overnight, "saturday", new Date(Date.UTC(2026, 9, 24, 12, 0)))).toBe(false);
  });
  it("drops an empty day", () => {
    expect(isOpenAt({ sunday: [] }, "sunday", evening)).toBe(false);
  });
});

describe("prepare", () => {
  it("drops parking, closed places, and duplicate addresses", () => {
    const dup: Candidate = {
      ...SAMPLE_PLACES[0],
      entityId: "sample-dup",
      affinity: 0.1,
    };
    const prepared = prepareCandidates([...SAMPLE_PLACES, dup], {
      departAt: evening,
      weekday: saturday,
      pace: "easy",
      dropIds: [],
      userTags: demoProfile().tags,
      rainy: false,
      evening: true,
    });
    expect(prepared.some((place) => /parking/i.test(place.name))).toBe(false);
    expect(prepared.filter((place) => place.address === SAMPLE_PLACES[0].address)).toHaveLength(1);
    expect(prepared[0]?.affinity).toBeGreaterThanOrEqual(prepared.at(-1)?.affinity ?? 0);
  });

  it("penalizes outdoor places in the rain", () => {
    const park = SAMPLE_PLACES.find((place) => place.category === "park");
    expect(park).toBeTruthy();
    const dry = prepareCandidates([park!], {
      departAt: new Date(Date.UTC(2026, 9, 24, 12, 0)),
      weekday: saturday,
      pace: "easy",
      dropIds: [],
      userTags: [],
      rainy: false,
      evening: false,
    });
    const wet = prepareCandidates([park!], {
      departAt: new Date(Date.UTC(2026, 9, 24, 12, 0)),
      weekday: saturday,
      pace: "easy",
      dropIds: [],
      userTags: [],
      rainy: true,
      evening: false,
    });
    expect(wet[0].baseScore).toBeLessThan(dry[0].baseScore);
  });
});

describe("selection", () => {
  it("stays inside the time budget", () => {
    const profile = demoProfile();
    const prepared = prepareCandidates(SAMPLE_PLACES, {
      departAt: evening,
      weekday: saturday,
      pace: "easy",
      dropIds: [],
      userTags: profile.tags,
      rainy: false,
      evening: true,
    });
    const chosen = selectStops(prepared, DEMO_START, {
      budgetMin: 120,
      pace: "easy",
      mode: "2h",
      departAt: evening,
      weekday: saturday,
    });
    expect(chosen.length).toBeGreaterThan(0);
    expect(chosen.length).toBeLessThanOrEqual(4);
    const minutes = plannedMinutes(DEMO_START, chosen, "easy", DEMO_START);
    expect(minutes).toBeLessThanOrEqual(115.01);
    if (chosen.length) {
      const home = walkMinutesHome(chosen[chosen.length - 1], DEMO_START);
      expect(minutes).toBeGreaterThan(home);
    }
  });

  it("never lengthens the route in 2-opt", () => {
    const start = { lat: 30.27, lon: -97.75 };
    const seq = [
      scored({ entityId: "a", lat: 30.27, lon: -97.74 }),
      scored({ entityId: "b", lat: 30.28, lon: -97.73 }),
      scored({ entityId: "c", lat: 30.271, lon: -97.735 }),
      scored({ entityId: "d", lat: 30.275, lon: -97.72 }),
    ];
    const before = path(start, seq);
    const after = twoOpt(start, seq);
    expect(path(start, after)).toBeLessThanOrEqual(before + 1e-6);
  });
});

describe("triggers", () => {
  it("waits for two accurate off-route fixes and the debounce", () => {
    expect(
      shouldAutoReroute({ distanceM: 80, accuracyM: 12, consecutiveOffRoute: 2, sinceLastMs: 90_000 }),
    ).toBe(true);
    expect(
      shouldAutoReroute({ distanceM: 80, accuracyM: 12, consecutiveOffRoute: 1, sinceLastMs: 90_000 }),
    ).toBe(false);
    expect(
      shouldAutoReroute({ distanceM: 80, accuracyM: 80, consecutiveOffRoute: 2, sinceLastMs: 120_000 }),
    ).toBe(false);
  });
});

describe("demo plan", () => {
  it("builds a sample walk without live credentials", async () => {
    delete process.env.QLOO_API_KEY;
    delete process.env.OSRM_BASE_URL;
    const walk = await buildWalk({
      profile: demoProfile(),
      start: DEMO_START,
      budgetMin: 120,
      pace: "easy",
      mode: "2h",
      demo: true,
    });
    const version = walk.versions[0];
    expect(walk.mock).toBe(true);
    expect(walk.remainingMin).toBe(112);
    expect(version.stops.map((stop) => stop.name)).toEqual([
      "Antone’s Nightclub",
      "Midnight Cowboy",
      "Swan Dive",
      "Mohawk",
    ]);
    expect(version.route.approximate).toBe(false);
    expect(version.route.geometry.coordinates.length).toBeGreaterThan(50);
    const last = version.route.geometry.coordinates.at(-1);
    expect(last?.[0]).toBeCloseTo(DEMO_START.lon, 3);
    expect(last?.[1]).toBeCloseTo(DEMO_START.lat, 3);
    expect(walk.shape).toBe("loop");
    expect(walk.returnMin).toBe(14);
    const rerouted = designReroute(walk).walk.versions.at(-1);
    const rerouteEnd = rerouted?.route.geometry.coordinates.at(-1);
    expect(rerouteEnd?.[0]).toBeCloseTo(DEMO_START.lon, 3);
    expect(rerouteEnd?.[1]).toBeCloseTo(DEMO_START.lat, 3);
    expect(version.stops[0]?.blurb).toMatch(/blues since 1975/);
    for (const stop of version.stops) {
      const sum = stop.evidence.entityShares.reduce((total, share) => total + share.share, 0);
      expect(sum).toBeGreaterThan(0.97);
      expect(sum).toBeLessThan(1.03);
    }
  });
});

describe("radius and dwell", () => {
  it("clamps the catchment", () => {
    expect(radiusM("easy", 30)).toBe(700);
    expect(radiusM("easy", 10)).toBe(600);
    expect(radiusM("brisk", 480)).toBe(2500);
  });
  it("adds ten percent dwell on an easy pace", () => {
    expect(dwellMinutes("bar", "easy")).toBeCloseTo(38.5);
    expect(dwellMinutes("bar", "brisk")).toBe(35);
  });
});

describe("loop and order", () => {
  const start = { lat: 30.27, lon: -97.74 };

  it("puts the farthest stop near the middle and closes the loop", () => {
    const pool = [
      scored({ entityId: "near-e", lat: 30.272, lon: -97.732, category: "cafe", baseScore: 1.1, dwellMin: 20 }),
      scored({ entityId: "far-n", lat: 30.286, lon: -97.74, category: "museum", baseScore: 1.2, dwellMin: 50 }),
      scored({ entityId: "near-w", lat: 30.272, lon: -97.748, category: "park", baseScore: 1.1, dwellMin: 15 }),
      scored({ entityId: "near-s", lat: 30.262, lon: -97.74, category: "shop", baseScore: 1, dwellMin: 20 }),
    ];
    const chosen = selectStops(pool, start, {
      budgetMin: 240,
      pace: "brisk",
      mode: "allday",
      departAt: new Date(Date.UTC(2026, 9, 24, 10, 0)),
      weekday: saturday,
      shape: "loop",
    });
    expect(chosen.length).toBeGreaterThanOrEqual(3);
    let far = 0;
    let farD = -1;
    chosen.forEach((stop, index) => {
      const distance = haversineM(start, stop);
      if (distance > farD) {
        farD = distance;
        far = index;
      }
    });
    const fraction = far / Math.max(chosen.length - 1, 1);
    expect(fraction).toBeGreaterThanOrEqual(0.3);
    expect(fraction).toBeLessThanOrEqual(0.7);
    const total = plannedMinutes(start, chosen, "brisk", start);
    const open = plannedMinutes(start, chosen, "brisk", null);
    expect(total).toBeGreaterThan(open);
    expect(total).toBeLessThanOrEqual(235.01);
  });

  it("does not schedule dinner at breakfast and keeps one meal per window", () => {
    const cafe = scored({ entityId: "cafe", lat: 30.271, lon: -97.739, category: "cafe", baseScore: 1, dwellMin: 20 });
    const dinner = scored({ entityId: "dinner", lat: 30.272, lon: -97.738, category: "restaurant", baseScore: 2, dwellMin: 60 });
    const museum = scored({ entityId: "museum", lat: 30.273, lon: -97.737, category: "museum", baseScore: 1, dwellMin: 40 });
    const morning = selectStops([cafe, dinner, museum], start, {
      budgetMin: 180,
      pace: "easy",
      mode: "2h",
      departAt: new Date(Date.UTC(2026, 9, 24, 8, 0)),
      weekday: saturday,
      shape: "one-way",
    });
    expect(morning[0]?.entityId).toBe("cafe");
    expect(morning.some((stop) => stop.entityId === "dinner")).toBe(false);
    expect(morning[0]?.orderNote).toMatch(/coffee/);

    const mesa = scored({ entityId: "mesa", lat: 30.271, lon: -97.739, category: "restaurant", baseScore: 1.2, dwellMin: 60 });
    const lana = scored({ entityId: "lana", lat: 30.273, lon: -97.736, category: "restaurant", baseScore: 1.5, dwellMin: 60 });
    const bar = scored({ entityId: "bar", lat: 30.274, lon: -97.734, category: "bar", baseScore: 1, dwellMin: 35 });
    const night = selectStops([mesa, lana, bar], start, {
      budgetMin: 240,
      pace: "easy",
      mode: "tonight",
      departAt: new Date(Date.UTC(2026, 9, 24, 18, 0)),
      weekday: saturday,
      shape: "loop",
    });
    const meals = night.filter((stop) => stop.category === "restaurant");
    expect(meals).toHaveLength(1);
    expect(meals[0]?.orderNote).toBe("dinner while kitchens are open");
    expect(orderNoteFor("restaurant", [], 18 * 60 + 30)).toBe("dinner while kitchens are open");
  });

  it("rejects a stop that closes during the dwell", () => {
    expect(
      openThrough(
        { saturday: [{ opens: "T17:00:00", closes: "T19:20:00" }] },
        saturday,
        new Date(Date.UTC(2026, 9, 24, 19, 0)),
        60,
      ),
    ).toBe(false);
    const closing = scored({
      entityId: "early",
      lat: 30.271,
      lon: -97.739,
      category: "restaurant",
      dwellMin: 60,
      hours: { saturday: [{ opens: "T17:00:00", closes: "T19:20:00" }] },
      baseScore: 3,
    });
    const late = scored({
      entityId: "late",
      lat: 30.272,
      lon: -97.738,
      category: "bar",
      dwellMin: 35,
      hours: { saturday: [{ opens: "T17:00:00", closes: "T02:00:00" }] },
      baseScore: 1,
    });
    const chosen = selectStops([closing, late], start, {
      budgetMin: 180,
      pace: "brisk",
      mode: "2h",
      departAt: new Date(Date.UTC(2026, 9, 24, 19, 0)),
      weekday: saturday,
      shape: "one-way",
    });
    expect(chosen.some((stop) => stop.entityId === "early")).toBe(false);
    expect(chosen.some((stop) => stop.entityId === "late")).toBe(true);
  });

  it("includes the walk home on a loop and leaves a one-way open", () => {
    const far = scored({ entityId: "far", lat: 30.29, lon: -97.74, category: "park", dwellMin: 15, baseScore: 2 });
    const opts = {
      budgetMin: 80,
      pace: "easy" as const,
      mode: "1h" as const,
      departAt: new Date(Date.UTC(2026, 9, 24, 12, 0)),
      weekday: saturday,
    };
    expect(selectStops([far], start, { ...opts, shape: "one-way" }).map((stop) => stop.entityId)).toContain("far");
    expect(selectStops([far], start, { ...opts, shape: "loop" }).map((stop) => stop.entityId)).not.toContain("far");
  });

  it("keeps a nightcap last and close to the origin", () => {
    const gelato = scored({
      entityId: "gelato",
      lat: 30.271,
      lon: -97.7396,
      category: "cafe",
      tags: [{ id: "dessert", name: "Dessert" }],
      baseScore: 1.4,
      dwellMin: 20,
    });
    const room = scored({ entityId: "room", lat: 30.278, lon: -97.735, category: "bar", baseScore: 1.1, dwellMin: 35 });
    const stage = scored({ entityId: "stage", lat: 30.276, lon: -97.732, category: "live_music", baseScore: 1.1, dwellMin: 45 });
    const chosen = selectStops([gelato, room, stage], start, {
      budgetMin: 240,
      pace: "easy",
      mode: "tonight",
      departAt: new Date(Date.UTC(2026, 9, 24, 20, 30)),
      weekday: saturday,
      shape: "loop",
    });
    const index = chosen.findIndex((stop) => stop.entityId === "gelato");
    expect(index).toBe(chosen.length - 1);
    expect(chosen[index]?.orderNote).toMatch(/nightcap/);
  });

  it("heads back when the remaining time is the walk home", () => {
    expect(shouldHeadBack(18, 14)).toBe(true);
    expect(shouldHeadBack(40, 14)).toBe(false);
    expect(shouldOfferRide(14, 19)).toBe(false);
    expect(shouldOfferRide(14, 21)).toBe(true);
    expect(shouldOfferRide(24, 18)).toBe(true);
  });

  it("recomputes a closed return on re-route", async () => {
    const seeded = await buildWalk({
      profile: demoProfile(),
      start: DEMO_START,
      budgetMin: 120,
      pace: "easy",
      mode: "2h",
      shape: "loop",
      demo: true,
    });
    const base: Walk = {
      ...seeded,
      poolKey: "test-pool",
      mock: true,
      isDemo: true,
      startedAt: new Date(Date.now() - 100 * 60_000).toISOString(),
      returnMin: 14,
      shape: "loop",
    };
    const result = await rerouteWalk({
      profile: demoProfile(),
      walk: base,
      fix: { lat: DEMO_START.lat + 0.01, lon: DEMO_START.lon },
      reason: "late",
      pool: seeded.pool,
    });
    const line = result.walk.versions.at(-1)?.route.geometry.coordinates ?? [];
    const end = line.at(-1);
    expect(result.walk.headingBack).toBe(true);
    expect(result.toast).toMatch(/^Time to head back · \d+ min$/);
    expect(end?.[0]).toBeCloseTo(DEMO_START.lon, 3);
    expect(end?.[1]).toBeCloseTo(DEMO_START.lat, 3);
  });
});

function walkMinutesHome(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  return (haversineM(a, b) * 1.3) / ((4 * 1000) / 60);
}

function path(start: { lat: number; lon: number }, seq: { lat: number; lon: number }[]): number {
  let meters = 0;
  let prev = start;
  for (const point of seq) {
    meters += haversineM(prev, point);
    prev = point;
  }
  return meters;
}

describe("review fixes", () => {
  const bar: Candidate = {
    entityId: "bar-opens-4",
    name: "Opens at four",
    lat: 30.267,
    lon: -97.74,
    affinity: 0.9,
    category: "bar",
    categoryLabel: "Bar",
    tags: [],
    entityShares: [],
    hours: { saturday: [{ opens: "T16:00:00", closes: "T23:00:00" }] },
  };
  const base = { weekday: "saturday", pace: "easy" as const, dropIds: [], userTags: [], rainy: false, evening: false };
  const half3 = new Date(Date.UTC(2026, 9, 24, 15, 30));

  it("keeps a place that opens during the walk window", () => {
    expect(prepareCandidates([bar], { ...base, departAt: half3 })).toHaveLength(0);
    expect(prepareCandidates([bar], { ...base, departAt: half3, windowMin: 120 })).toHaveLength(1);
  });

  it("keeps open-now places in the running when many open later", () => {
    const late = { saturday: [{ opens: "T21:00:00", closes: "T23:59:00" }] };
    const now = { saturday: [{ opens: "T09:00:00", closes: "T23:00:00" }] };
    const pool: Scored[] = [
      ...Array.from({ length: 40 }, (_, i) =>
        scored({ entityId: `late-${i}`, lat: 30.268 + i * 1e-4, lon: -97.742, baseScore: 2, category: "bar", hours: late }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        scored({ entityId: `now-${i}`, lat: 30.267 + i * 3e-4, lon: -97.743, baseScore: 1, hours: now }),
      ),
    ];
    const chosen = selectStops(pool, { lat: 30.2684, lon: -97.7427 }, {
      budgetMin: 120,
      pace: "easy",
      mode: "2h",
      departAt: new Date(Date.UTC(2026, 9, 24, 15, 0)),
      weekday: saturday,
    });
    expect(chosen.length).toBeGreaterThan(0);
    expect(chosen.every((stop) => stop.entityId.startsWith("now-"))).toBe(true);
  });

  it("never prints 60 minutes", () => {
    expect(formatMinutes(119.6)).toBe("2h 00m");
    expect(formatMinutes(59.7)).toBe("1h 00m");
    expect(formatMinutes(91)).toBe("1h 31m");
    expect(formatMinutes(27)).toBe("27m");
  });
});
