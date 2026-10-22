import type { Candidate, EntityShare, PlaceHours, PlaceTag } from "@/lib/types";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" ? (value as UnknownRecord) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const CATEGORY_RULES: { category: string; label: string; test: RegExp }[] = [
  { category: "live_music", label: "Live music", test: /(?<![\p{L}\p{N}])(live music|music venue|concert hall|night ?club|jazz club|blues club)(?![\p{L}\p{N}])/u },
  { category: "museum", label: "Museum", test: /(?<![\p{L}\p{N}])(museum|museu|gallery|exhibit)(?![\p{L}\p{N}])/u },
  { category: "cafe", label: "Cafe", test: /(?<![\p{L}\p{N}])(cafe|café|coffee|coffeehouse|bakery|tea house)(?![\p{L}\p{N}])/u },
  { category: "cafe", label: "Cafe", test: /(?<![\p{L}\p{N}])(espresso bar|juice bar|tea room)(?![\p{L}\p{N}])/u },
  { category: "restaurant", label: "Restaurant", test: /(?<![\p{L}\p{N}])(sushi bar|oyster bar|tapas bar|raw bar|bar & grill|bar and grill)(?![\p{L}\p{N}])/u },
  { category: "bar", label: "Bar", test: /(?<![\p{L}\p{N}])(bar|pub|lounge|brewery|taproom|wine bar|cocktail|speakeasy|tavern)(?![\p{L}\p{N}])/u },
  { category: "restaurant", label: "Restaurant", test: /(?<![\p{L}\p{N}])(restaurant|kitchen|diner|eatery|bistro|taqueria|tacos?|pizzeria|steakhouse|bbq|barbecue)(?![\p{L}\p{N}])/u },
  { category: "park", label: "Park", test: /(?<![\p{L}\p{N}])(park|garden|gardens|trail|viewpoint|miradouro|plaza|square|lake)(?![\p{L}\p{N}])/u },
  { category: "shop", label: "Shop", test: /(?<![\p{L}\p{N}])(store|shop|boutique|market|bookstore|book store|record store)(?![\p{L}\p{N}])/u },
  { category: "sight", label: "Sight", test: /(?<![\p{L}\p{N}])(tourist attraction|landmark|monument|statue|cathedral|church|igreja|chapel|historical|memorial|library|cemetery|art center)(?![\p{L}\p{N}])/u },
];

function classify(text: string): { category: string; label: string } | undefined {
  const lower = text.toLowerCase();
  return CATEGORY_RULES.find((rule) => rule.test.test(lower));
}

function isCategoryTag(tag: PlaceTag): boolean {
  return Boolean(tag.type?.includes("category:place") || tag.id.includes("category:place"));
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// Qloo tags each place with explicit category tags (urn:tag:category:place:*),
// such as "Cathedral" or "Leather goods store". Those decide first, then the
// name, then other tag names. Whole words only: "parking" is not a park.
export function categoryFromTags(tags: PlaceTag[], name: string): { category: string; label: string } {
  const categoryTags = tags.filter(isCategoryTag);
  for (const tag of categoryTags) {
    const hit = classify(tag.name);
    if (hit) return { category: hit.category, label: titleCase(tag.name) };
  }
  const byName = classify(name);
  if (byName) return byName;
  const label = categoryTags[0] ? titleCase(categoryTags[0].name) : undefined;
  if (label) return { category: "default", label };
  const byTags = classify(tags.map((tag) => tag.name).join(" · "));
  if (byTags && byTags.category !== "park") return byTags;
  return { category: "default", label: "Place" };
}

function readHours(value: unknown): PlaceHours | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const hours: PlaceHours = {};
  for (const [day, raw] of Object.entries(record)) {
    if (!Array.isArray(raw)) continue;
    const intervals = raw
      .map((item) => {
        const row = asRecord(item);
        const opens = asString(row?.opens);
        const closes = asString(row?.closes);
        if (!opens || !closes) return null;
        return { opens, closes };
      })
      .filter((item): item is { opens: string; closes: string } => item != null);
    hours[day.toLowerCase()] = intervals;
  }
  // Qloo sends 00:00–00:00 on every day when it has no real hours (seen on
  // Austin venues that are not open around the clock). Read that as "not
  // listed" rather than "open 24 hours". One 00:00–00:00 day among real hours
  // is a genuine all-day opening and is kept.
  const spans = Object.values(hours).flat();
  if (spans.length > 0 && spans.every((span) => isMidnight(span.opens) && isMidnight(span.closes))) return undefined;
  return hours;
}

function isMidnight(value: string): boolean {
  return /(?:^|T)00:00(?::00)?$/.test(value.trim());
}

function readShares(entity: UnknownRecord, names: Map<string, string>): EntityShare[] {
  const query = asRecord(entity.query);
  const explain = asRecord(query?.explainability);
  const rows = explain?.["signal.interests.entities"];
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      const rec = asRecord(row);
      const entityId = asString(rec?.entity_id) ?? asString(rec?.id);
      const score = asNumber(rec?.score);
      if (!entityId || score == null) return null;
      return { entityId, name: names.get(entityId) ?? "Taste signal", share: score };
    })
    .filter((row): row is EntityShare => row != null);
}

function readTags(value: unknown): PlaceTag[] {
  if (!Array.isArray(value)) return [];
  const tags: PlaceTag[] = [];
  for (const item of value) {
    const row = asRecord(item);
    const id = asString(row?.id) ?? asString(row?.tag_id);
    const name = asString(row?.name);
    if (!id || !name) continue;
    tags.push({ id, name, type: asString(row?.type) });
  }
  return tags;
}

function readImage(properties: UnknownRecord | null): string | undefined {
  const image = asRecord(properties?.image);
  const direct = asString(image?.url);
  if (direct) return direct;
  const images = properties?.images;
  if (!Array.isArray(images)) return undefined;
  for (const item of images) {
    const row = asRecord(item);
    const url = asString(row?.url) ?? asString(asRecord(row?.image)?.url);
    if (url) return url;
  }
  return undefined;
}

export function normalizeEntities(
  payload: unknown,
  names: Map<string, string>,
): Candidate[] {
  const root = asRecord(payload);
  const results = root?.results;
  const list = Array.isArray(results)
    ? results
    : Array.isArray(asRecord(results)?.entities)
      ? (asRecord(results)?.entities as unknown[])
      : [];

  const candidates: Candidate[] = [];
  for (const item of list) {
    const entity = asRecord(item);
    if (!entity) continue;
    const entityId = asString(entity.entity_id) ?? asString(entity.id);
    const name = asString(entity.name);
    const location = asRecord(entity.location);
    const lat = asNumber(location?.lat) ?? asNumber(asRecord(entity.properties)?.lat);
    const lon = asNumber(location?.lon) ?? asNumber(asRecord(entity.properties)?.lon);
    if (!entityId || !name || lat == null || lon == null) continue;
    const properties = asRecord(entity.properties);
    const query = asRecord(entity.query);
    const tags = readTags(entity.tags);
    const classified = categoryFromTags(tags, name);
    const affinity = asNumber(query?.affinity) ?? asNumber(entity.affinity) ?? asNumber(entity.popularity) ?? 0;
    candidates.push({
      entityId,
      name,
      lat,
      lon,
      affinity,
      address: asString(properties?.address),
      shortDescription: asString(properties?.short_description) ?? asString(properties?.description),
      category: classified.category,
      categoryLabel: classified.label,
      // Category tags first, so the engine's category-only checks still see
      // them after the 12-tag trim (Qloo often lists them after amenities).
      tags: [...tags.filter(isCategoryTag), ...tags.filter((tag) => !isCategoryTag(tag))].slice(0, 12),
      hours: readHours(properties?.hours),
      isClosed: properties?.is_closed === true,
      neighborhood: asString(properties?.neighborhood),
      imageUrl: readImage(properties),
      priceLevel: asNumber(properties?.price_level),
      entityShares: readShares(entity, names),
    });
  }
  return candidates;
}

export type SearchHit = {
  id: string;
  name: string;
  type: string;
  subtitle?: string;
  imageUrl?: string;
};

export function normalizeSearch(payload: unknown): SearchHit[] {
  const root = asRecord(payload);
  const list = Array.isArray(root?.results) ? root.results : [];
  const hits: SearchHit[] = [];
  for (const item of list) {
    const row = asRecord(item);
    const id = asString(row?.entity_id) ?? asString(row?.id);
    const name = asString(row?.name);
    if (!id || !name) continue;
    const types = Array.isArray(row?.types) ? row.types.filter((entry): entry is string => typeof entry === "string") : [];
    const type = types[0] ?? asString(row?.type) ?? "urn:entity";
    const properties = asRecord(row?.properties);
    const kind = type.replace("urn:entity:", "").replaceAll("_", " ");
    const described = asString(row?.disambiguation) ?? asString(properties?.short_description);
    // Qloo sometimes repeats the name as the description ("Radiohead / Radiohead").
    const subtitle = described && described.trim().toLowerCase() !== name.trim().toLowerCase() ? described : kind;
    hits.push({ id, name, type, subtitle, imageUrl: readImage(properties) });
  }
  return hits;
}

export type TagHit = { id: string; name: string; type: string };

export function normalizeTags(payload: unknown): TagHit[] {
  const root = asRecord(payload);
  const nested = asRecord(root?.results)?.tags;
  const list = Array.isArray(root?.results)
    ? root.results
    : Array.isArray(nested)
      ? nested
      : Array.isArray(root?.tags)
        ? root.tags
        : [];
  const tags: TagHit[] = [];
  for (const item of list) {
    const row = asRecord(item);
    const id = asString(row?.id) ?? asString(row?.tag_id);
    const name = asString(row?.name);
    const type = asString(row?.type) ?? "";
    if (!id || !name) continue;
    tags.push({ id, name, type });
  }
  return tags;
}
