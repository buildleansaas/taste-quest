import { getCache } from "@vercel/functions";

const memory = new Map<string, { value: unknown; exp: number }>();

const remote = (() => {
  try {
    return getCache({ namespace: "tq", namespaceSeparator: ":" });
  } catch (error) {
    console.log(
      JSON.stringify({
        level: "warn",
        msg: "runtime-cache-unavailable",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
})();

function readMemory<T>(key: string): T | null {
  const hit = memory.get(key);
  if (!hit) return null;
  if (hit.exp < Date.now()) {
    memory.delete(key);
    return null;
  }
  return hit.value as T;
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  if (remote) {
    try {
      const value = await remote.get(key);
      if (value != null) return value as T;
    } catch (error) {
      console.log(
        JSON.stringify({
          level: "warn",
          msg: "cache-get",
          key,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  return readMemory<T>(key);
}

export async function cacheSet(
  key: string,
  value: unknown,
  ttlSeconds: number,
  tags?: string[],
): Promise<void> {
  memory.set(key, { value, exp: Date.now() + ttlSeconds * 1000 });
  if (!remote) return;
  try {
    await remote.set(key, value, { ttl: ttlSeconds, tags, name: key });
  } catch (error) {
    console.log(
      JSON.stringify({
        level: "warn",
        msg: "cache-set",
        key,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

export const TTL = {
  search: 60 * 60 * 24 * 7,
  tags: 60 * 60 * 24 * 14,
  pool: 60 * 60 * 24,
  osrm: 60 * 60 * 24 * 7,
  weather: 60 * 30,
  blurb: 60 * 60 * 24 * 7,
  demo: 60 * 60 * 24 * 30,
  quota: 60 * 60,
} as const;
