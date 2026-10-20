import { describe, expect, it } from "vitest";
import { buildWalk, rerouteWalk } from "@/lib/plan/build";
import { SAMPLE_PLACES } from "@/lib/qloo/sample";
import { demoProfile, DEMO_START } from "@/lib/taste/curated";
import { arriveAt, finishWalk, nextStop, replanFrom } from "@/lib/walk/progress";
import type { Walk } from "@/lib/types";

async function demoWalk(): Promise<Walk> {
  return buildWalk({
    profile: demoProfile(),
    start: { ...DEMO_START, source: "demo" },
    budgetMin: 120,
    pace: "easy",
    mode: "2h",
    shape: "loop",
    demo: true,
    tz: "America/Chicago",
  });
}

const states = (walk: Walk) => walk.versions.at(-1)!.stops.map((stop) => stop.state);

describe("walk progress", () => {
  it("I'm here marks the stop visited and moves next on", async () => {
    const walk = await demoWalk();
    const first = nextStop(walk)!;
    const after = arriveAt(walk, first.entityId);
    expect(states(after)).toEqual(["visited", "next", "todo", "todo"]);
    expect(after.currentVersion).toBe(walk.currentVersion);
    expect(nextStop(after)!.name).toBe("Midnight Cowboy");
  });

  it("arriving at the last stop of a loop heads back, and finishing ends it", async () => {
    let walk = await demoWalk();
    for (let i = 0; i < 4; i += 1) walk = arriveAt(walk, nextStop(walk)!.entityId);
    expect(nextStop(walk)).toBeUndefined();
    expect(walk.headingBack).toBe(true);
    expect(walk.status).toBe("active");
    expect(finishWalk(walk).status).toBe("done");
  });

  it("a one-way walk is done at its last stop", async () => {
    let walk = { ...(await demoWalk()), shape: "one-way" as const, returnMin: 0 };
    for (let i = 0; i < 4; i += 1) walk = arriveAt(walk, nextStop(walk)!.entityId) as typeof walk;
    expect(walk.status).toBe("done");
  });

  it("ignores a stop that is already visited or skipped", async () => {
    const walk = await demoWalk();
    const first = nextStop(walk)!;
    const once = arriveAt(walk, first.entityId);
    expect(arriveAt(once, first.entityId)).toBe(once);
  });

  it("re-plans from the last visited stop when GPS is far away or missing", async () => {
    const walk = arriveAt(await demoWalk(), "sample-place-antones");
    const antones = walk.versions.at(-1)!.stops[0]!;
    expect(replanFrom(walk, null)).toEqual({ lat: antones.lat, lon: antones.lon });
    expect(replanFrom(walk, { lat: 40.7, lon: -74 })).toEqual({ lat: antones.lat, lon: antones.lon });
    const near = { lat: antones.lat + 0.001, lon: antones.lon };
    expect(replanFrom(walk, near)).toEqual(near);
  });
});

describe("demo skips", () => {
  const fix = { lat: DEMO_START.lat, lon: DEMO_START.lon };

  it("the first skip is still the scripted beat", async () => {
    const first = await rerouteWalk({ profile: demoProfile(), walk: await demoWalk(), fix, reason: "skip" });
    expect(nextStop(first.walk)?.entityId).toBe("sample-place-museum-weird");
    const stops = first.walk.versions.at(-1)!.stops;
    expect(stops.find((stop) => stop.name === "Midnight Cowboy")?.state).toBe("skipped");
  });

  it("I'm here at Antone's then skip still scripts; past Midnight Cowboy it re-plans", async () => {
    const atAntones = arriveAt(await demoWalk(), "sample-place-antones");
    const scripted = await rerouteWalk({ profile: demoProfile(), walk: atAntones, fix, reason: "skip" });
    expect(nextStop(scripted.walk)?.entityId).toBe("sample-place-museum-weird");
    const pastMidnight = arriveAt(atAntones, nextStop(atAntones)!.entityId);
    const replanned = await rerouteWalk({ profile: demoProfile(), walk: pastMidnight, fix, reason: "skip" });
    expect(replanned.walk.versions.at(-1)!.stops.find((stop) => stop.name === "Midnight Cowboy")?.state).toBe("visited");
  });

  it("a one-way walk whose last skip finds nothing new is done, not stuck", async () => {
    let walk: Walk = { ...(await demoWalk()), currentVersion: 2, shape: "one-way", returnMin: 0 };
    for (let i = 0; i < 3; i += 1) walk = arriveAt(walk, nextStop(walk)!.entityId);
    const ids = new Set(walk.versions.at(-1)!.stops.map((stop) => stop.entityId));
    const pool = SAMPLE_PLACES.filter((place) => ids.has(place.entityId));
    const result = await rerouteWalk({ profile: demoProfile(), walk, fix, reason: "skip", pool });
    expect(nextStop(result.walk)).toBeUndefined();
    expect(result.walk.status).toBe("done");
    expect(result.toast).toBe("That was your last stop. Walk complete.");
  });

  it("plays the scripted beat once, then a second skip moves on", async () => {
    const walk = await demoWalk();
    const fix = { lat: DEMO_START.lat, lon: DEMO_START.lon };
    const first = await rerouteWalk({ profile: demoProfile(), walk, fix, reason: "skip" });
    const firstNext = nextStop(first.walk)!.entityId;
    const second = await rerouteWalk({ profile: demoProfile(), walk: first.walk, fix, reason: "skip" });
    expect(second.walk.currentVersion).toBe(3);
    const secondStops = second.walk.versions.at(-1)!.stops;
    expect(secondStops.find((stop) => stop.entityId === firstNext)?.state).toBe("skipped");
    expect(nextStop(second.walk)?.entityId).not.toBe(firstNext);
  });
});
