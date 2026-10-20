import { demoClock, readContext, weatherLabel } from "@/lib/weather/open-meteo";
import { jsonError } from "@/lib/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));
  const tz = url.searchParams.get("tz") ?? undefined;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return jsonError(400, "bad_coords", "lat and lon are required");
  }
  const context = url.searchParams.get("demo") === "1" ? demoClock() : await readContext(lat, lon, tz);
  return Response.json({
    ...context,
    weatherLabel: context.weather ? weatherLabel(context.weather.code) : undefined,
  });
}
