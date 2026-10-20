import { haversineM } from "@/lib/engine/core";
import type { LatLon, Stop, Walk } from "@/lib/types";

/** Within this distance of the next stop, a GPS fix counts as arriving. */
export const ARRIVE_M = 40;

function latest(walk: Walk) {
  return walk.versions[walk.versions.length - 1];
}

export function nextStop(walk: Walk | null): Stop | undefined {
  const stops = walk ? (latest(walk)?.stops ?? []) : [];
  return stops.find((stop) => stop.state === "next") ?? stops.find((stop) => stop.state === "todo");
}

/**
 * Marks a stop visited in the current version and moves "next" on. With no
 * stops left, a loop (or end-near) walk heads back and a one-way walk is done.
 * Arriving changes no route, so it stays on the client and keeps the version.
 */
export function arriveAt(walk: Walk, entityId: string): Walk {
  const version = latest(walk);
  if (!version) return walk;
  const target = version.stops.find((stop) => stop.entityId === entityId);
  if (!target || target.state === "visited" || target.state === "skipped" || target.state === "vetoed") return walk;
  let promoted = false;
  const stops = version.stops.map((stop): Stop => {
    if (stop.entityId === entityId) return { ...stop, state: "visited" };
    if (stop.state === "next") return { ...stop, state: "todo" };
    return stop;
  }).map((stop): Stop => {
    if (promoted || stop.state !== "todo") return stop;
    promoted = true;
    return { ...stop, state: "next" };
  });
  const versions = [...walk.versions.slice(0, -1), { ...version, stops }];
  if (promoted) return { ...walk, versions };
  const loop = (walk.shape ?? "loop") !== "one-way" && (walk.returnMin ?? 0) > 0;
  return loop
    ? { ...walk, versions, headingBack: true }
    : { ...walk, versions, status: "done", headingBack: false };
}

export function finishWalk(walk: Walk): Walk {
  return { ...walk, status: "done", headingBack: false };
}

/**
 * Where a re-plan starts. A real GPS fix near the walk wins. Otherwise (a judge
 * at a desk, or GPS far away) it starts at the last stop marked visited, so a
 * skip after "I'm here" never routes back through the start.
 */
export function replanFrom(walk: Walk, fix: LatLon | null, nearM = 3000): LatLon {
  const stops = latest(walk)?.stops ?? [];
  const lastVisited = [...stops].reverse().find((stop) => stop.state === "visited");
  const anchor = lastVisited ?? walk.start;
  if (fix && haversineM(fix, anchor) < nearM) return fix;
  return { lat: anchor.lat, lon: anchor.lon };
}
