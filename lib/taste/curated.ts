import type { EntityType, TagCat } from "@/lib/types";

export type CuratedEntity = {
  kind: "entity";
  id: string;
  name: string;
  type: EntityType;
  subtitle: string;
  section: "artists" | "film";
};

export type CuratedTag = {
  kind: "tag";
  id: string;
  name: string;
  cat: TagCat;
  section: "cuisine" | "vibes";
  /** Real hackathon-API tag id verified Oct 19. Unverified chips resolve through /v2/tags. */
  verified: boolean;
};

export type CuratedChip = CuratedEntity | CuratedTag;

export const CURATED: CuratedChip[] = [
  { kind: "entity", id: "sample-entity-khruangbin", name: "Khruangbin", type: "artist", subtitle: "Artist · psych-funk trio", section: "artists" },
  { kind: "entity", id: "sample-entity-tame-impala", name: "Tame Impala", type: "artist", subtitle: "Artist · psychedelic rock", section: "artists" },
  { kind: "entity", id: "sample-entity-leon-bridges", name: "Leon Bridges", type: "artist", subtitle: "Artist · Soul, R&B", section: "artists" },
  { kind: "entity", id: "sample-entity-phoebe-bridgers", name: "Phoebe Bridgers", type: "artist", subtitle: "Artist · indie folk", section: "artists" },
  { kind: "entity", id: "sample-entity-bon-iver", name: "Bon Iver", type: "artist", subtitle: "Artist · indie folk", section: "artists" },
  { kind: "entity", id: "sample-entity-grand-budapest", name: "The Grand Budapest Hotel", type: "movie", subtitle: "Film · Wes Anderson", section: "film" },
  { kind: "entity", id: "sample-entity-lost-in-translation", name: "Lost in Translation", type: "movie", subtitle: "Film · Sofia Coppola", section: "film" },
  { kind: "entity", id: "sample-entity-the-bear", name: "The Bear", type: "tv_show", subtitle: "TV · kitchen drama", section: "film" },
  { kind: "tag", id: "urn:tag:specialty_dish:place:tacos", name: "Tacos", cat: "cuisine", section: "cuisine", verified: true },
  { kind: "tag", id: "urn:tag:cuisine:qloo:natural_wine", name: "Natural wine", cat: "cuisine", section: "cuisine", verified: true },
  { kind: "tag", id: "sample-tag-ramen", name: "Ramen", cat: "cuisine", section: "cuisine", verified: false },
  { kind: "tag", id: "sample-tag-coffee", name: "Coffee", cat: "cuisine", section: "cuisine", verified: false },
  { kind: "tag", id: "sample-tag-bbq", name: "BBQ", cat: "cuisine", section: "cuisine", verified: false },
  { kind: "tag", id: "urn:tag:good_for:qloo:live_music", name: "Live music", cat: "vibe", section: "vibes", verified: true },
  { kind: "tag", id: "urn:tag:decor:qloo:dive_bar", name: "Dive bars", cat: "vibe", section: "vibes", verified: true },
  { kind: "tag", id: "urn:tag:ambience:qloo:hidden_gem", name: "Hidden gems", cat: "vibe", section: "vibes", verified: true },
  { kind: "tag", id: "sample-tag-rooftops", name: "Rooftops", cat: "vibe", section: "vibes", verified: false },
];

export const VIBE_SEEDS: Record<string, string> = {
  "Live music": "Khruangbin",
  "Dive bars": "Leon Bridges",
  "Hidden gems": "The Grand Budapest Hotel",
  Rooftops: "Tame Impala",
};

const TAG_PRIORITY = [
  "category:place",
  "genre:place",
  "cuisine:qloo",
  "ambience:qloo",
  "specialty_dish",
];

export function tagPriority(type: string): number {
  const index = TAG_PRIORITY.findIndex((part) => type.includes(part));
  return index === -1 ? TAG_PRIORITY.length : index;
}

export function pickBestTag<T extends { type: string }>(tags: T[]): T | undefined {
  return [...tags].sort((a, b) => tagPriority(a.type) - tagPriority(b.type))[0];
}

export function demoProfile() {
  const names = new Set([
    "Khruangbin",
    "Tame Impala",
    "Leon Bridges",
    "The Grand Budapest Hotel",
    "Tacos",
    "Natural wine",
    "Live music",
    "Hidden gems",
  ]);
  const picked = CURATED.filter((chip) => names.has(chip.name));
  return {
    entities: picked
      .filter((chip): chip is CuratedEntity => chip.kind === "entity")
      .map((chip) => ({
        id: chip.id,
        name: chip.name,
        type: chip.type,
        subtitle: chip.subtitle,
      })),
    tags: picked
      .filter((chip): chip is CuratedTag => chip.kind === "tag")
      .map((chip) => ({ id: chip.id, name: chip.name, cat: chip.cat })),
    updatedAt: "2026-10-19T00:00:00.000Z",
  };
}

export const DEMO_START = {
  lat: 30.2684,
  lon: -97.7427,
  label: "Congress Ave & W 6th St, Austin",
  source: "demo" as const,
};
