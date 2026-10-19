type Bucket = number[];

const windows = new Map<string, Bucket>();

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): { ok: boolean; remaining: number } {
  const now = Date.now();
  const prev = windows.get(key) ?? [];
  const fresh = prev.filter((t) => now - t < windowMs);
  if (fresh.length >= limit) {
    windows.set(key, fresh);
    return { ok: false, remaining: 0 };
  }
  fresh.push(now);
  windows.set(key, fresh);
  return { ok: true, remaining: limit - fresh.length };
}

export function clientKey(req: Request, bucket: string): string {
  const device = (req.headers.get("x-device-id") ?? "anon").slice(0, 80);
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "local";
  return `${bucket}:${device}:${ip}`;
}
