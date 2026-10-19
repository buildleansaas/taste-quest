import { DEMO_START } from "@/lib/taste/curated";
import {
  EXPLORE_ROUTE,
  EXPLORE_USER,
  REROUTE_GHOST,
  REROUTE_ROUTE,
  REROUTE_USER,
} from "@/lib/map/austin-geometry";
import { SAMPLE_PLACES } from "@/lib/qloo/sample";
import type { BudgetMode, Candidate, Pace, StartPoint, Stop, Walk, WalkRoute } from "@/lib/types";

type DesignInput = {
  mode: BudgetMode;
  budgetMin: number;
  pace: Pace;
  start: StartPoint;
};

export const DESIGN_POOL = "design:austin";

const BLURB: Record<string, string> = {
  "sample-place-antones":
    "Austin’s home of the blues since 1975. It sits right where your soul and psych-rock picks overlap.",
  "sample-place-swan-dive":
    "A small, loud Red River room with a stage you can walk right up to. Fans of warm, groove-led psych rock love it.",
};

const SHARES: Record<string, [string, string, number][]> = {
  "sample-place-antones": [
    ["sample-entity-leon-bridges", "Leon Bridges", 0.26],
    ["sample-entity-khruangbin", "Khruangbin", 0.25],
    ["sample-entity-tame-impala", "Tame Impala", 0.28],
    ["sample-entity-grand-budapest", "The Grand Budapest Hotel", 0.21],
  ],
  "sample-place-swan-dive": [
    ["sample-entity-tame-impala", "Tame Impala", 0.26],
    ["sample-entity-khruangbin", "Khruangbin", 0.26],
    ["sample-entity-grand-budapest", "The Grand Budapest Hotel", 0.21],
    ["sample-entity-leon-bridges", "Leon Bridges", 0.27],
  ],
};

const ORDER = [
  "sample-place-antones",
  "sample-place-midnight-cowboy",
  "sample-place-swan-dive",
  "sample-place-mohawk",
];

function place(id: string): Candidate {
  const found = SAMPLE_PLACES.find((item) => item.entityId === id);
  if (!found) throw new Error(`missing sample place ${id}`);
  return found;
}

function line(coords: [number, number][]): WalkRoute["geometry"] {
  return { type: "LineString", coordinates: coords };
}

function stopFrom(id: string, seq: number, state: Stop["state"], walkMin: number, extra: Partial<Stop> = {}): Stop {
  const source = place(id);
  const shares = SHARES[id] ?? source.entityShares.map((share) => [share.entityId, share.name, share.share] as [string, string, number]);
  return {
    seq,
    entityId: source.entityId,
    name: source.name,
    lat: source.lat,
    lon: source.lon,
    affinity: source.affinity,
    affinityRank: seq,
    etaMin: walkMin,
    walkMin,
    dwellMin: source.category === "live_music" ? 45 : source.category === "bar" ? 35 : 25,
    state,
    category: source.category,
    categoryLabel: source.categoryLabel,
    address: source.address,
    neighborhood: source.neighborhood,
    evidence: {
      entityShares: shares.map(([entityId, name, share]) => ({ entityId, name, share })),
      tagOverlap:
        id === "sample-place-swan-dive"
          ? [
              { id: "sample-tag-lively", name: "Lively" },
              { id: "sample-tag-stage", name: "Stage view" },
            ]
          : source.tags.slice(0, 2).map((tag) => ({ id: tag.id, name: tag.name })),
    },
    blurb: BLURB[id],
    hours: source.hours,
    imageUrl: source.imageUrl,
    sample: true,
    ...extra,
  };
}

/** The four-stop Austin scene from docs/design/screens/d-explore-map.html. */
export function designWalk(input: DesignInput): Walk {
  const minutes = [7, 4, 5, 6];
  const stops = ORDER.map((id, index) => stopFrom(id, index + 1, index === 0 ? "next" : "todo", minutes[index] ?? 5));
  return {
    id: crypto.randomUUID(),
    status: "active",
    mode: input.mode,
    budgetMin: input.budgetMin,
    pace: input.pace,
    start: { ...input.start, ...DEMO_START, source: "demo" },
    isDemo: true,
    mock: true,
    poolKey: DESIGN_POOL,
    pool: SAMPLE_PLACES,
    currentVersion: 1,
    remainingMin: 112,
    cursor: { lon: EXPLORE_USER[0], lat: EXPLORE_USER[1] },
    versions: [
      {
        version: 1,
        reason: "initial",
        createdAt: new Date().toISOString(),
        route: {
          geometry: line(EXPLORE_ROUTE),
          legs: [
            { minutes: 7, meters: 520 },
            { minutes: 4, meters: 280 },
            { minutes: 5, meters: 340 },
            { minutes: 6, meters: 400 },
          ],
          approximate: false,
        },
        totals: { walkMin: 22, dwellMin: stops.reduce((sum, stop) => sum + stop.dwellMin, 0), km: 1.5 },
        stops,
      },
    ],
    startedAt: new Date().toISOString(),
  };
}

/**
 * The re-route beat from docs/design/screens/f-reroute.html:
 * Antone’s visited, Midnight Cowboy skipped, Museum of the Weird added.
 */
export function designReroute(walk: Walk): { walk: Walk; toast: string } {
  const museum = stopFrom("sample-place-museum-weird", 2, "next", 4, {
    introduced: true,
    affinity: 0.86,
    neighborhood: "Sixth Street",
  });
  const stops: Stop[] = [
    stopFrom("sample-place-antones", 1, "visited", 7),
    stopFrom("sample-place-midnight-cowboy", 2, "skipped", 4),
    museum,
    stopFrom("sample-place-swan-dive", 3, "todo", 5),
    stopFrom("sample-place-mohawk", 4, "todo", 5),
  ];
  const next: Walk = {
    ...walk,
    currentVersion: walk.currentVersion + 1,
    remainingMin: 91,
    cursor: { lon: REROUTE_USER[0], lat: REROUTE_USER[1] },
    versions: [
      ...walk.versions,
      {
        version: walk.currentVersion + 1,
        reason: "skip",
        createdAt: new Date().toISOString(),
        route: {
          geometry: line(REROUTE_ROUTE),
          ghost: line(REROUTE_GHOST),
          legs: [
            { minutes: 4, meters: 220 },
            { minutes: 4, meters: 260 },
            { minutes: 5, meters: 340 },
          ],
          approximate: false,
        },
        totals: { walkMin: 13, dwellMin: 70, km: 0.9 },
        stops,
      },
    ],
  };
  return {
    walk: next,
    toast: "Skipped Midnight Cowboy. Added Museum of the Weird, a 0.86 match on the way. Still 1h 31m.",
  };
}
