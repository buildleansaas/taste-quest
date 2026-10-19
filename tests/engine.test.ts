import { describe, expect, it } from "vitest";
import {
  dwellMinutes,
  haversineM,
  isOpenAt,
  prepareCandidates,
  radiusM,
  selectStops,
  shouldAutoReroute,
  twoOpt,
  type Scored,
} from "@/lib/engine/core";
import { SAMPLE_PLACES } from "@/lib/qloo/sample";
import { demoProfile, DEMO_START } from "@/lib/taste/curated";
import { buildWalk } from "@/lib/plan/build";
import type { Candidate } from "@/lib/types";

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
    let minutes = 0;
    let prev: { lat: number; lon: number } = DEMO_START;
    for (const stop of chosen) {
      minutes += (haversineM(prev, stop) * 1.3) / ((4 * 1000) / 60) + stop.dwellMin;
      prev = stop;
    }
    expect(minutes).toBeLessThanOrEqual(115.01);
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

function path(start: { lat: number; lon: number }, seq: { lat: number; lon: number }[]): number {
  let meters = 0;
  let prev = start;
  for (const point of seq) {
    meters += haversineM(prev, point);
    prev = point;
  }
  return meters;
}
