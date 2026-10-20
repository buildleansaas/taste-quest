import { cacheGet, cacheSet, TTL } from "@/lib/cache";
import { log } from "@/lib/log";
import { samplePlacesNear, sampleSearch, sampleTags } from "@/lib/qloo/sample";
import { normalizeEntities, normalizeSearch, normalizeTags, type SearchHit, type TagHit } from "@/lib/qloo/normalize";
import type { Candidate, TasteEntity, TasteTag } from "@/lib/types";

const QLOO_URL = process.env.QLOO_API_URL ?? "https://hackathon.api.qloo.com";

export function qlooConfigured(): boolean {
  return Boolean(process.env.QLOO_API_KEY);
}

export type QuotaMode = "normal" | "curated-only" | "demo-or-cache";

export function quotaMode(remaining: number | null): QuotaMode {
  if (remaining == null) return "normal";
  if (remaining < 500) return "demo-or-cache";
  if (remaining < 1500) return "curated-only";
  return "normal";
}

export class QlooBusyError extends Error {
  constructor() {
    super("Qloo is busy");
    this.name = "QlooBusyError";
  }
}

export class QlooQuotaError extends Error {
  constructor() {
    super("Qloo monthly quota is in the degraded band");
    this.name = "QlooQuotaError";
  }
}

type Slot = () => void;
const recent: number[] = [];
let inFlight = 0;
const waiters: Slot[] = [];

function pump(): void {
  const now = Date.now();
  while (recent.length && now - recent[0] >= 1000) recent.shift();
  while (waiters.length && inFlight < 3 && recent.length < 4) {
    const next = waiters.shift();
    if (!next) return;
    recent.push(Date.now());
    inFlight += 1;
    next();
  }
}

export function acquireQlooSlot(): Promise<void> {
  return new Promise((resolve) => {
    waiters.push(resolve);
    pump();
  });
}

export function releaseQlooSlot(): void {
  inFlight = Math.max(0, inFlight - 1);
  pump();
}

export async function getQuota(): Promise<{ remaining: number | null; at: string | null }> {
  const saved = await cacheGet<{ remaining: number; at: string }>("qloo:quota");
  return { remaining: saved?.remaining ?? null, at: saved?.at ?? null };
}

async function rememberQuota(headers: Headers): Promise<void> {
  const raw = headers.get("x-month-ratelimit-remaining");
  if (!raw) return;
  const remaining = Number(raw);
  if (!Number.isFinite(remaining)) return;
  const at = new Date().toISOString();
  await cacheSet("qloo:quota", { remaining, at }, TTL.quota, ["qloo"]);
  if (remaining < 2000) {
    log("warn", "qloo-quota-low", { remaining, at });
  }
}

function resetDelay(headers: Headers, fallbackMs: number): number {
  const raw = headers.get("x-second-ratelimit-reset");
  const value = raw ? Number(raw) : NaN;
  if (!Number.isFinite(value)) return fallbackMs;
  if (value > 1_000_000_000) return Math.min(2000, Math.max(0, value * 1000 - Date.now()));
  return Math.min(2000, Math.max(0, value * 1000));
}

async function qlooFetch(
  path: string,
  params: URLSearchParams,
  init?: { method?: "GET" | "POST"; body?: unknown },
): Promise<unknown> {
  const key = process.env.QLOO_API_KEY;
  if (!key) throw new Error("QLOO_API_KEY is not set");
  const method = init?.method ?? "GET";
  const url = `${QLOO_URL}${path}${method === "GET" && params.size ? `?${params}` : ""}`;
  const waits = [250, 500, 1000];
  let lastStatus = 0;

  for (let attempt = 0; attempt <= waits.length; attempt += 1) {
    await acquireQlooSlot();
    const started = Date.now();
    try {
      const response = await fetch(url, {
        method,
        headers: {
          "X-Api-Key": key,
          accept: "application/json",
          ...(init?.body ? { "content-type": "application/json" } : {}),
        },
        body: init?.body ? JSON.stringify(init.body) : undefined,
        cache: "no-store",
      });
      await rememberQuota(response.headers);
      const requestId = response.headers.get("x-qloo-request-id");
      log("info", "qloo", {
        path,
        status: response.status,
        latencyMs: Date.now() - started,
        requestId,
      });
      if (response.status === 429) {
        lastStatus = 429;
        const delay = resetDelay(response.headers, waits[attempt] ?? 1000);
        const jitter = Math.floor(Math.random() * 80);
        if (attempt === waits.length) break;
        await new Promise((resolve) => setTimeout(resolve, delay + jitter));
        continue;
      }
      if (!response.ok) {
        throw new Error(`Qloo ${response.status}`);
      }
      return response.json();
    } finally {
      releaseQlooSlot();
    }
  }
  if (lastStatus === 429) throw new QlooBusyError();
  throw new Error("Qloo request failed");
}

const EXCLUDE = [
  "urn:tag:category:place:parking",
  "urn:tag:category:place:hotel",
  "urn:tag:category:place:lodging",
  "urn:tag:category:place:nail_salon",
  "urn:tag:category:place:gas_station",
].join(",");

export async function searchTaste(query: string, cat?: string): Promise<SearchHit[]> {
  const cacheKey = `qs:${cat ?? "all"}:${query.toLowerCase()}`;
  const cached = await cacheGet<SearchHit[]>(cacheKey);
  if (cached) return cached;
  if (!qlooConfigured()) {
    const sample = sampleSearch(query, cat).map((hit) => ({
      id: hit.id,
      name: hit.name,
      type: `urn:entity:${hit.type}`,
      subtitle: hit.subtitle,
    }));
    return sample;
  }
  const mode = quotaMode((await getQuota()).remaining);
  if (mode !== "normal") return [];

  const types =
    cat === "artists"
      ? "urn:entity:artist"
      : cat === "film"
        ? "urn:entity:movie,urn:entity:tv_show"
        : cat === "places"
          ? "urn:entity:place"
          : "urn:entity:artist,urn:entity:movie,urn:entity:tv_show";
  const params = new URLSearchParams({ query, types, take: "5" });
  const payload = await qlooFetch("/search", params);
  const hits = normalizeSearch(payload).slice(0, 5);
  await cacheSet(cacheKey, hits, TTL.search, ["qloo", "search"]);
  return hits;
}

export async function searchTags(query: string): Promise<TagHit[]> {
  const cacheKey = `qt:${query.toLowerCase()}`;
  const cached = await cacheGet<TagHit[]>(cacheKey);
  if (cached) return cached;
  if (!qlooConfigured()) return sampleTags(query);
  const mode = quotaMode((await getQuota()).remaining);
  if (mode !== "normal") return [];
  const params = new URLSearchParams({
    "filter.query": query,
    "filter.parents.types": "urn:entity:place",
    take: "8",
  });
  const payload = await qlooFetch("/v2/tags", params);
  const tags = normalizeTags(payload).slice(0, 8);
  await cacheSet(cacheKey, tags, TTL.tags, ["qloo", "tags"]);
  return tags;
}

function weighted(entities: TasteEntity[], tags: TasteTag[]): boolean {
  const weights = [...entities.map((e) => e.weight), ...tags.map((t) => t.weight)].filter(
    (w): w is number => typeof w === "number",
  );
  if (weights.length === 0) return false;
  return new Set(weights).size > 1;
}

export async function placesNear(input: {
  lat: number;
  lon: number;
  radius: number;
  weekday: string;
  entities: TasteEntity[];
  tags: TasteTag[];
  offset?: number;
  allowLive: boolean;
}): Promise<Candidate[]> {
  if (qlooConfigured() && input.allowLive) {
    // Curated chips that never resolved to a real Qloo id keep a "sample-" id.
    // Qloo rejects them, so drop them rather than fail the whole plan.
    input = {
      ...input,
      entities: input.entities.filter((entity) => !entity.id.startsWith("sample-")),
      tags: input.tags.filter((tag) => !tag.id.startsWith("sample-")),
    };
  }
  if (!qlooConfigured() || !input.allowLive) {
    return samplePlacesNear(input.lat, input.lon, {
      entities: input.entities,
      tags: input.tags,
      updatedAt: "",
    });
  }
  const names = new Map(input.entities.map((entity) => [entity.id, entity.name]));
  const usePost = weighted(input.entities, input.tags);
  if (usePost) {
    const body: Record<string, unknown> = {
      "filter.type": "urn:entity:place",
      "filter.location": `POINT(${input.lon} ${input.lat})`,
      "filter.location.radius": input.radius,
      "filter.hours": input.weekday,
      "filter.exclude.tags": EXCLUDE,
      "signal.interests.entities": input.entities.map((entity) => ({
        id: entity.id,
        weight: entity.weight ?? 1,
      })),
      "feature.explainability": true,
      "bias.quality": "low",
      take: 50,
      offset: input.offset ?? 0,
    };
    if (input.tags.length) {
      body["signal.interests.tags"] = input.tags.map((tag) => ({
        tag: tag.id,
        weight: tag.weight ?? 1,
      }));
    }
    const payload = await qlooFetch("/v2/insights", new URLSearchParams(), {
      method: "POST",
      body,
    });
    return normalizeEntities(payload, names);
  }

  const params = new URLSearchParams({
    "filter.type": "urn:entity:place",
    "filter.location": `POINT(${input.lon} ${input.lat})`,
    "filter.location.radius": String(input.radius),
    "filter.hours": input.weekday,
    "filter.exclude.tags": EXCLUDE,
    "feature.explainability": "true",
    "bias.quality": "low",
    take: "50",
  });
  if (input.entities.length) {
    params.set("signal.interests.entities", input.entities.map((entity) => entity.id).join(","));
  }
  if (input.tags.length) {
    params.set("signal.interests.tags", input.tags.map((tag) => tag.id).join(","));
  }
  if (input.offset) params.set("offset", String(input.offset));
  const payload = await qlooFetch("/v2/insights", params);
  return normalizeEntities(payload, names);
}

export async function resolveSampleIds(entities: TasteEntity[], tags: TasteTag[]): Promise<{
  entities: TasteEntity[];
  tags: TasteTag[];
}> {
  if (!qlooConfigured()) return { entities, tags };
  const resolvedEntities = await Promise.all(
    entities.map(async (entity) => {
      if (!entity.id.startsWith("sample-")) return entity;
      try {
        const cat = entity.type === "artist" ? "artists" : entity.type === "place" ? "places" : "film";
        const hits = await searchTaste(entity.name, cat);
        const hit =
          hits.find((item) => item.name.toLowerCase() === entity.name.toLowerCase()) ?? hits[0];
        return hit ? { ...entity, id: hit.id } : entity;
      } catch {
        return entity;
      }
    }),
  );
  const resolvedTags = await Promise.all(
    tags.map(async (tag) => {
      if (!tag.id.startsWith("sample-")) return tag;
      try {
        const hits = await searchTags(tag.name);
        return hits[0] ? { ...tag, id: hits[0].id, name: hits[0].name } : tag;
      } catch {
        return tag;
      }
    }),
  );
  return { entities: resolvedEntities, tags: resolvedTags };
}
