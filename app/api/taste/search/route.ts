import { QlooBusyError, quotaMode, getQuota, qlooConfigured, searchTaste } from "@/lib/qloo/client";
import { CURATED } from "@/lib/taste/curated";
import { clientKey, rateLimit } from "@/lib/ratelimit";
import { jsonError } from "@/lib/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const limit = rateLimit(clientKey(req, "search"), 60, 60_000);
  if (!limit.ok) return jsonError(429, "rate_limited", "Search is busy, tap a suggestion");
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const cat = url.searchParams.get("cat") ?? undefined;
  if (q.length < 2) return Response.json({ results: [], mock: !qlooConfigured() });

  const mode = quotaMode((await getQuota()).remaining);
  if (qlooConfigured() && mode !== "normal") {
    const curated = CURATED.filter(
      (chip) => chip.kind === "entity" && chip.name.toLowerCase().includes(q.toLowerCase()),
    ).map((chip) =>
      chip.kind === "entity"
        ? { id: chip.id, name: chip.name, type: `urn:entity:${chip.type}`, subtitle: chip.subtitle }
        : null,
    );
    return Response.json({
      results: curated.filter(Boolean),
      mock: false,
      curatedOnly: true,
      message: "Search is limited to suggestions while the monthly quota is low.",
    });
  }

  try {
    const results = await searchTaste(q, cat);
    return Response.json({ results, mock: !qlooConfigured() });
  } catch (error) {
    if (error instanceof QlooBusyError) {
      return Response.json({
        results: [],
        busy: true,
        message: "Search is busy, tap a suggestion",
        mock: false,
      });
    }
    return jsonError(502, "search_failed", "Search is busy, tap a suggestion");
  }
}
