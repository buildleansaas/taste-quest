/**
 * Manual contract probe. Not part of CI.
 * Uses about six live calls. Run before a deploy day:
 *   QLOO_API_KEY=... node --experimental-strip-types scripts/probe-qloo.ts
 */
export {};

const base = process.env.QLOO_API_URL ?? "https://hackathon.api.qloo.com";
const key = process.env.QLOO_API_KEY;
if (!key) {
  console.error("Set QLOO_API_KEY. This script is not for mock mode.");
  process.exit(1);
}

async function get(path: string): Promise<void> {
  const started = Date.now();
  const response = await fetch(`${base}${path}`, { headers: { "X-Api-Key": key! } });
  const remaining = response.headers.get("x-month-ratelimit-remaining");
  const requestId = response.headers.get("x-qloo-request-id");
  console.log(
    JSON.stringify({
      path: path.split("?")[0],
      status: response.status,
      ms: Date.now() - started,
      remaining,
      requestId,
    }),
  );
  if (!response.ok) process.exitCode = 1;
}

await get("/search?query=Khruangbin&types=urn:entity:artist&take=2");
await get("/v2/tags?filter.query=natural%20wine&filter.parents.types=urn:entity:place&take=4");
await get(
  "/v2/insights?filter.type=urn:entity:place&filter.location=POINT(-97.743%2030.267)&filter.location.radius=800&take=5&feature.explainability=true&bias.quality=low",
);
