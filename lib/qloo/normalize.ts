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

function categoryFromTags(tags: PlaceTag[], name: string): { category: string; label: string } {
  const blob = `${name} ${tags.map((tag) => `${tag.id} ${tag.name}`).join(" ")}`.toLowerCase();
  if (/live_music|nightclub|music venue/.test(blob)) return { category: "live_music", label: "Live music" };
  if (/museum|gallery/.test(blob)) return { category: "museum", label: "Museum" };
  if (/park|trail|garden/.test(blob)) return { category: "park", label: "Park" };
  if (/cafe|coffee/.test(blob)) return { category: "cafe", label: "Cafe" };
  if (/taco|restaurant|dining/.test(blob)) return { category: "restaurant", label: "Restaurant" };
  if (/bar|wine|cocktail/.test(blob)) return { category: "bar", label: "Bar" };
  const categoryTag = tags.find((tag) => tag.type?.includes("category:place") || tag.id.includes("category:place"));
  return { category: "default", label: categoryTag?.name ?? "Place" };
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
  return hours;
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
      tags: tags.slice(0, 12),
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
    const subtitle =
      asString(row?.disambiguation) ??
      asString(properties?.short_description) ??
      type.replace("urn:entity:", "").replaceAll("_", " ");
    hits.push({ id, name, type, subtitle, imageUrl: readImage(properties) });
  }
  return hits;
}

export type TagHit = { id: string; name: string; type: string };

export function normalizeTags(payload: unknown): TagHit[] {
  const root = asRecord(payload);
  const list = Array.isArray(root?.results) ? root.results : Array.isArray(root?.tags) ? root.tags : [];
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
