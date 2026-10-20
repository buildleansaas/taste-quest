import { cacheGet, cacheSet, TTL } from "@/lib/cache";
import { geohash } from "@/lib/geohash";
import { log } from "@/lib/log";
import type { ContextSnap, WeatherSnap } from "@/lib/types";

type Meteo = {
  timezone?: string;
  current?: {
    time?: string;
    temperature_2m?: number;
    weather_code?: number;
    precipitation_probability?: number;
  };
  hourly?: { precipitation_probability?: number[]; time?: string[] };
};

export async function readContext(lat: number, lon: number, tzHint?: string): Promise<ContextSnap> {
  const hash = geohash(lat, lon, 5);
  const key = `wx:${hash}`;
  const cached = await cacheGet<ContextSnap>(key);
  if (cached) return cached;

  try {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", lat.toFixed(3));
    url.searchParams.set("longitude", lon.toFixed(3));
    url.searchParams.set("current", "temperature_2m,weather_code,precipitation_probability");
    url.searchParams.set("hourly", "precipitation_probability");
    url.searchParams.set("forecast_days", "1");
    url.searchParams.set("temperature_unit", "fahrenheit");
    url.searchParams.set("timezone", "auto");
    const response = await fetch(url, { signal: AbortSignal.timeout(2500), cache: "no-store" });
    if (!response.ok) throw new Error(`meteo ${response.status}`);
    const payload = (await response.json()) as Meteo;
    const tz = payload.timezone || tzHint || "UTC";
    const hourly = payload.hourly?.precipitation_probability?.slice(0, 3) ?? [];
    const precip = hourly.length ? Math.max(...hourly) : payload.current?.precipitation_probability ?? 0;
    const weather: WeatherSnap = {
      tempF: Math.round(payload.current?.temperature_2m ?? 0),
      code: payload.current?.weather_code ?? 0,
      precipProbNext3h: precip,
      isRainy: precip >= 60 || [51, 53, 55, 61, 63, 65, 80, 81, 82, 95].includes(payload.current?.weather_code ?? -1),
    };
    const snap = contextFrom(tz, weather);
    await cacheSet(key, snap, TTL.weather, ["weather"]);
    return snap;
  } catch (error) {
    log("warn", "weather-failed", { error: error instanceof Error ? error.message : String(error) });
    return contextFrom(tzHint || "UTC");
  }
}

export function contextFrom(tz: string, weather?: WeatherSnap, at = new Date()): ContextSnap {
  let weekday = "saturday";
  let localTime = at.toISOString();
  try {
    weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: tz })
      .format(at)
      .toLowerCase();
    localTime = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "2-digit",
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(at);
  } catch {
    tz = "UTC";
  }
  return { localTime, weekday, tz, weather };
}

export function demoClock(): ContextSnap {
  return {
    localTime: "Sat, Oct 24, 7:00 PM",
    weekday: "saturday",
    tz: "America/Chicago",
    weather: { tempF: 72, code: 0, precipProbNext3h: 0, isRainy: false },
  };
}

export function weatherLabel(code: number): string {
  if (code === 0) return "clear";
  if (code <= 3) return "cloudy";
  if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) return "rain";
  if ([71, 73, 75, 85, 86].includes(code)) return "snow";
  if (code >= 95) return "storms";
  return "mixed";
}
