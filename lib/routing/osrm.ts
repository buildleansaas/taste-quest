import { cacheGet, cacheSet, TTL } from "@/lib/cache";
import { haversineM, paceFactor, paceKmh, walkMinutes } from "@/lib/engine/core";
import { sha } from "@/lib/hash";
import { log } from "@/lib/log";
import type { LatLon, Pace, WalkRoute } from "@/lib/types";

export type Routed = WalkRoute & { km: number; walkMin: number };

export function osrmConfigured(): boolean {
  return Boolean(process.env.OSRM_BASE_URL?.trim());
}

export function straightRoute(points: LatLon[], pace: Pace): Routed {
  const coordinates = points.map((point) => [point.lon, point.lat] as [number, number]);
  const legs = [];
  let meters = 0;
  let minutes = 0;
  for (let i = 1; i < points.length; i += 1) {
    const legMeters = haversineM(points[i - 1], points[i]) * 1.3;
    const legMinutes = walkMinutes(points[i - 1], points[i], pace);
    legs.push({ meters: legMeters, minutes: legMinutes });
    meters += legMeters;
    minutes += legMinutes;
  }
  return {
    geometry: { type: "LineString", coordinates },
    legs,
    approximate: true,
    km: meters / 1000,
    walkMin: minutes,
  };
}

type OsrmResponse = {
  code?: string;
  routes?: {
    distance?: number;
    duration?: number;
    geometry?: { type: "LineString"; coordinates: [number, number][] };
    legs?: { distance?: number; duration?: number }[];
  }[];
};

export async function routeFoot(points: LatLon[], pace: Pace): Promise<Routed> {
  if (points.length < 2) return straightRoute(points, pace);
  // Trim: a value pasted from the clipboard can carry a trailing newline.
  const base = process.env.OSRM_BASE_URL?.trim().replace(/\/$/, "");
  if (!base) return straightRoute(points, pace);

  const rounded = points.map((point) => `${point.lon.toFixed(5)},${point.lat.toFixed(5)}`).join(";");
  const key = `osrm:${sha(rounded)}:${pace}`;
  const cached = await cacheGet<Routed>(key);
  if (cached) return cached;

  const url = `${base}/route/v1/foot/${rounded}?overview=full&geometries=geojson&steps=false`;
  const started = Date.now();
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(2000),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`OSRM ${response.status}`);
    const payload = (await response.json()) as OsrmResponse;
    const route = payload.routes?.[0];
    if (!route?.geometry || payload.code !== "Ok") throw new Error("OSRM empty route");
    const factor = paceFactor(pace);
    const legs = (route.legs ?? []).map((leg) => ({
      meters: leg.distance ?? 0,
      minutes: ((leg.duration ?? 0) / 60) * factor,
    }));
    const routed: Routed = {
      geometry: route.geometry,
      legs,
      approximate: false,
      km: (route.distance ?? 0) / 1000,
      walkMin: legs.reduce((sum, leg) => sum + leg.minutes, 0),
    };
    log("info", "osrm", { latencyMs: Date.now() - started, km: routed.km });
    await cacheSet(key, routed, TTL.osrm, ["osrm"]);
    return routed;
  } catch (error) {
    log("warn", "osrm-fallback", {
      latencyMs: Date.now() - started,
      // The base URL carries the router's auth token, so never log it.
      error: (error instanceof Error ? error.message : String(error)).split(base).join("<OSRM_BASE_URL>"),
    });
    return straightRoute(points, pace);
  }
}

export function speedKmh(pace: Pace): number {
  return paceKmh(pace);
}
