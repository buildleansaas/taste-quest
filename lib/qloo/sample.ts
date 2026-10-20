import { haversineM } from "@/lib/engine/core";
import type { Candidate, EntityShare, PlaceHours, TasteProfile } from "@/lib/types";

/**
 * Synthetic catalog for mock mode. These are not Qloo responses.
 * Ids are prefixed `sample-`. Descriptions say they are sample places.
 * Coordinates are illustrative downtown Austin points from the design mockups.
 */

const OPEN_LATE: PlaceHours = {
  monday: [{ opens: "T16:00:00", closes: "T02:00:00" }],
  tuesday: [{ opens: "T16:00:00", closes: "T02:00:00" }],
  wednesday: [{ opens: "T16:00:00", closes: "T02:00:00" }],
  thursday: [{ opens: "T16:00:00", closes: "T02:00:00" }],
  friday: [{ opens: "T16:00:00", closes: "T02:00:00" }],
  saturday: [{ opens: "T12:00:00", closes: "T02:00:00" }],
  sunday: [{ opens: "T12:00:00", closes: "T00:00:00" }],
};

const DAYTIME: PlaceHours = {
  monday: [{ opens: "T08:00:00", closes: "T18:00:00" }],
  tuesday: [{ opens: "T08:00:00", closes: "T18:00:00" }],
  wednesday: [{ opens: "T08:00:00", closes: "T18:00:00" }],
  thursday: [{ opens: "T08:00:00", closes: "T18:00:00" }],
  friday: [{ opens: "T08:00:00", closes: "T18:00:00" }],
  saturday: [{ opens: "T09:00:00", closes: "T17:00:00" }],
  sunday: [{ opens: "T09:00:00", closes: "T16:00:00" }],
};

function shares(parts: [string, string, number][]): EntityShare[] {
  return parts.map(([entityId, name, share]) => ({ entityId, name, share }));
}

const MUSIC = shares([
  ["sample-entity-leon-bridges", "Leon Bridges", 0.26],
  ["sample-entity-khruangbin", "Khruangbin", 0.25],
  ["sample-entity-tame-impala", "Tame Impala", 0.28],
  ["sample-entity-grand-budapest", "The Grand Budapest Hotel", 0.21],
]);

const WINE = shares([
  ["sample-entity-grand-budapest", "The Grand Budapest Hotel", 0.34],
  ["sample-entity-khruangbin", "Khruangbin", 0.27],
  ["sample-entity-tame-impala", "Tame Impala", 0.22],
  ["sample-entity-leon-bridges", "Leon Bridges", 0.17],
]);

export const SAMPLE_PLACES: Candidate[] = [
  {
    entityId: "sample-place-antones",
    name: "Antone’s Nightclub",
    lat: 30.2660457,
    lon: -97.7403947,
    affinity: 0.84,
    address: "305 E 5th St, Austin",
    shortDescription: "Sample blues room. Austin’s home of the blues since 1975, in this synthetic catalog only.",
    category: "bar",
    categoryLabel: "Blues club",
    neighborhood: "Downtown",
    hours: OPEN_LATE,
    tags: [
      { id: "urn:tag:good_for:qloo:live_music", name: "Live music", type: "urn:tag:good_for:qloo" },
      { id: "urn:tag:ambience:qloo:hidden_gem", name: "Hidden gems", type: "urn:tag:ambience:qloo" },
      { id: "sample-tag-soul", name: "Soul", type: "urn:tag:genre:place" },
    ],
    entityShares: MUSIC,
    sample: true,
  },
  {
    entityId: "sample-place-midnight-cowboy",
    name: "Midnight Cowboy",
    lat: 30.267086,
    lon: -97.7399698,
    affinity: 0.83,
    address: "313 E 6th St, Austin",
    shortDescription: "Sample cocktail closet with a velvet door. Not a live listing.",
    category: "bar",
    categoryLabel: "Cocktail bar",
    neighborhood: "Downtown",
    hours: OPEN_LATE,
    tags: [
      { id: "urn:tag:cuisine:qloo:natural_wine", name: "Natural wine", type: "urn:tag:cuisine:qloo" },
      { id: "urn:tag:ambience:qloo:hidden_gem", name: "Hidden gems", type: "urn:tag:ambience:qloo" },
    ],
    entityShares: WINE,
    sample: true,
  },
  {
    entityId: "sample-place-swan-dive",
    name: "Swan Dive",
    lat: 30.2671328,
    lon: -97.7366559,
    affinity: 0.86,
    address: "615 Red River St, Austin",
    shortDescription: "A small, loud Red River room with a stage you can walk right up to.",
    category: "live_music",
    categoryLabel: "Live music venue",
    neighborhood: "Red River District",
    hours: OPEN_LATE,
    tags: [
      { id: "urn:tag:good_for:qloo:live_music", name: "Live music", type: "urn:tag:good_for:qloo" },
      { id: "urn:tag:category:place:live_music_venue", name: "Live music", type: "urn:tag:category:place" },
      { id: "sample-tag-stage", name: "Stage view", type: "urn:tag:amenity:place" },
    ],
    entityShares: shares([
      ["sample-entity-tame-impala", "Tame Impala", 0.31],
      ["sample-entity-khruangbin", "Khruangbin", 0.27],
      ["sample-entity-grand-budapest", "The Grand Budapest Hotel", 0.22],
      ["sample-entity-leon-bridges", "Leon Bridges", 0.2],
    ]),
    sample: true,
  },
  {
    entityId: "sample-place-mohawk",
    name: "Mohawk",
    lat: 30.270053,
    lon: -97.7361188,
    affinity: 0.82,
    address: "912 Red River St, Austin",
    shortDescription: "Sample indoor-outdoor stage on Red River. Synthetic pin for the demo walk.",
    category: "live_music",
    categoryLabel: "Live music venue",
    neighborhood: "Red River District",
    hours: OPEN_LATE,
    tags: [
      { id: "urn:tag:good_for:qloo:live_music", name: "Live music", type: "urn:tag:good_for:qloo" },
      { id: "sample-tag-rooftops", name: "Rooftops", type: "urn:tag:ambience:qloo" },
    ],
    entityShares: MUSIC,
    sample: true,
  },
  {
    entityId: "sample-place-museum-weird",
    name: "Museum of the Weird",
    lat: 30.2671674,
    lon: -97.73867,
    affinity: 0.8,
    address: "412 E 6th St, Austin",
    shortDescription: "Sample cabinet of curiosities. A short indoor stop when the walk needs a swap.",
    category: "museum",
    categoryLabel: "Museum",
    neighborhood: "Sixth Street",
    hours: DAYTIME,
    tags: [
      { id: "urn:tag:ambience:qloo:hidden_gem", name: "Hidden gems", type: "urn:tag:ambience:qloo" },
      { id: "sample-tag-oddities", name: "Oddities", type: "urn:tag:genre:place" },
    ],
    entityShares: WINE,
    sample: true,
  },
  {
    entityId: "sample-place-paper-coffee",
    name: "Paper Shade Coffee",
    lat: 30.2694,
    lon: -97.7422,
    affinity: 0.79,
    address: "501 Congress Ave, Austin",
    shortDescription: "Sample morning counter. Quiet, paper menus, no real queue.",
    category: "cafe",
    categoryLabel: "Cafe",
    neighborhood: "Congress Ave",
    hours: DAYTIME,
    tags: [
      { id: "sample-tag-coffee", name: "Coffee", type: "urn:tag:cuisine:qloo" },
      { id: "urn:tag:ambience:qloo:hidden_gem", name: "Hidden gems", type: "urn:tag:ambience:qloo" },
    ],
    entityShares: WINE,
    sample: true,
  },
  {
    entityId: "sample-place-ladybird",
    name: "Ladybird Lawn",
    lat: 30.2642,
    lon: -97.7468,
    affinity: 0.7,
    address: "100 Auditorium Shores, Austin",
    shortDescription: "Sample lawn by the river. Outdoor, so rain should push it down.",
    category: "park",
    categoryLabel: "Park",
    neighborhood: "Auditorium Shores",
    hours: {
      saturday: [{ opens: "T06:00:00", closes: "T22:00:00" }],
      sunday: [{ opens: "T06:00:00", closes: "T22:00:00" }],
    },
    tags: [
      { id: "sample-tag-park", name: "Park", type: "urn:tag:category:place" },
      { id: "sample-tag-outdoor", name: "Outdoor", type: "urn:tag:ambience:qloo" },
    ],
    entityShares: MUSIC,
    sample: true,
  },
  {
    entityId: "sample-place-red-tacos",
    name: "Red River Tacos",
    lat: 30.2687,
    lon: -97.7374,
    affinity: 0.81,
    address: "700 Red River St, Austin",
    shortDescription: "Sample taco window. Two salsas, no real address.",
    category: "restaurant",
    categoryLabel: "Tacos",
    neighborhood: "Red River District",
    hours: OPEN_LATE,
    tags: [
      { id: "urn:tag:specialty_dish:place:tacos", name: "Tacos", type: "urn:tag:specialty_dish:place" },
      { id: "urn:tag:good_for:qloo:live_music", name: "Live music", type: "urn:tag:good_for:qloo" },
    ],
    entityShares: shares([
      ["sample-entity-leon-bridges", "Leon Bridges", 0.4],
      ["sample-entity-khruangbin", "Khruangbin", 0.35],
      ["sample-entity-tame-impala", "Tame Impala", 0.25],
    ]),
    sample: true,
  },
  {
    entityId: "sample-place-hotel-parking",
    name: "Sample Hotel Parking",
    lat: 30.2681,
    lon: -97.7415,
    affinity: 0.9,
    address: "1 Parking Way, Austin",
    shortDescription: "Should be filtered. A parking garage is not a taste stop.",
    category: "default",
    categoryLabel: "Parking",
    tags: [{ id: "urn:tag:category:place:parking", name: "Parking", type: "urn:tag:category:place" }],
    entityShares: MUSIC,
    sample: true,
  },
];

const SEARCH_ENTITIES = [
  { id: "sample-entity-khruangbin", name: "Khruangbin", type: "artist", subtitle: "Artist · psych-funk trio" },
  { id: "sample-entity-tame-impala", name: "Tame Impala", type: "artist", subtitle: "Artist · psychedelic rock" },
  { id: "sample-entity-leon-bridges", name: "Leon Bridges", type: "artist", subtitle: "Artist · Soul, R&B" },
  { id: "sample-entity-khruangbin-leon", name: "Khruangbin & Leon Bridges", type: "artist", subtitle: "Artist · Collaboration" },
  { id: "sample-entity-phoebe-bridgers", name: "Phoebe Bridgers", type: "artist", subtitle: "Artist · indie folk" },
  { id: "sample-entity-bon-iver", name: "Bon Iver", type: "artist", subtitle: "Artist · indie folk" },
  { id: "sample-entity-grand-budapest", name: "The Grand Budapest Hotel", type: "movie", subtitle: "Film · Wes Anderson" },
  { id: "sample-entity-lost-in-translation", name: "Lost in Translation", type: "movie", subtitle: "Film · Sofia Coppola" },
  { id: "sample-entity-the-bear", name: "The Bear", type: "tv_show", subtitle: "TV · kitchen drama" },
];

export function sampleSearch(query: string, cat?: string) {
  const q = query.trim().toLowerCase();
  return SEARCH_ENTITIES.filter((item) => {
    if (cat === "artists" && item.type !== "artist") return false;
    if (cat === "film" && item.type !== "movie" && item.type !== "tv_show") return false;
    if (cat === "places") return false;
    return item.name.toLowerCase().includes(q);
  }).slice(0, 5);
}

const SAMPLE_TAGS = [
  { id: "urn:tag:cuisine:qloo:natural_wine", name: "Natural wine", type: "urn:tag:cuisine:qloo" },
  { id: "urn:tag:specialty_dish:place:tacos", name: "Tacos", type: "urn:tag:specialty_dish:place" },
  { id: "urn:tag:good_for:qloo:live_music", name: "Live music", type: "urn:tag:good_for:qloo" },
  { id: "urn:tag:category:place:live_music_venue", name: "Live music venue", type: "urn:tag:category:place" },
  { id: "urn:tag:ambience:qloo:hidden_gem", name: "Hidden gem", type: "urn:tag:ambience:qloo" },
  { id: "urn:tag:decor:qloo:dive_bar", name: "Dive bar", type: "urn:tag:decor:qloo" },
  { id: "sample-tag-ramen", name: "Ramen", type: "urn:tag:cuisine:qloo" },
  { id: "sample-tag-coffee", name: "Coffee", type: "urn:tag:cuisine:qloo" },
  { id: "sample-tag-bbq", name: "BBQ", type: "urn:tag:specialty_dish:place" },
  { id: "sample-tag-rooftops", name: "Rooftops", type: "urn:tag:ambience:qloo" },
];

export function sampleTags(query: string) {
  const q = query.trim().toLowerCase();
  return SAMPLE_TAGS.filter((tag) => tag.name.toLowerCase().includes(q)).slice(0, 8);
}

function sharesFor(profile: TasteProfile): EntityShare[] {
  const entities = profile.entities.slice(0, 4);
  if (entities.length === 0) return [];
  const even = 1 / entities.length;
  return entities.map((entity) => ({
    entityId: entity.id,
    name: entity.name,
    share: Math.round(even * 1000) / 1000,
  }));
}

export function samplePlacesNear(lat: number, lon: number, profile: TasteProfile): Candidate[] {
  const nearby = SAMPLE_PLACES.filter((place) => haversineM(place, { lat, lon }) < 4000);
  if (nearby.length >= 6) return nearby;
  const made = sharesFor(profile);
  const ring: Candidate[] = [
    ["Sample Listening Bar", "bar", "Cocktail bar", 0.0004, 0.0006],
    ["Sample Clay Cafe", "cafe", "Cafe", -0.0012, 0.0008],
    ["Sample Night Window", "live_music", "Live music venue", 0.0015, -0.001],
    ["Sample Paper Garden", "park", "Park", -0.002, -0.0014],
    ["Sample Taco Stoop", "restaurant", "Tacos", 0.0008, -0.0016],
    ["Sample Record Nook", "default", "Record store", -0.0006, 0.0018],
  ].map(([name, category, label, dLat, dLon], index) => ({
    entityId: `sample-place-ring-${index}`,
    name: String(name),
    lat: lat + Number(dLat),
    lon: lon + Number(dLon),
    affinity: 0.78 - index * 0.02,
    address: "Sample street, not a real venue",
    shortDescription: "Synthetic sample place generated because this map point is outside the Austin sample set.",
    category: String(category),
    categoryLabel: String(label),
    tags: profile.tags.slice(0, 2).map((tag) => ({ id: tag.id, name: tag.name })),
    entityShares: made,
    sample: true,
    hours: OPEN_LATE,
  }));
  return ring;
}
