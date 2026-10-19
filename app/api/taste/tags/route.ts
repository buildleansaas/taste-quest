import { getQuota, QlooBusyError, qlooConfigured, quotaMode, searchTags } from "@/lib/qloo/client";
import { pickBestTag } from "@/lib/taste/curated";
import { clientKey, rateLimit } from "@/lib/ratelimit";
import { jsonError } from "@/lib/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const limit = rateLimit(clientKey(req, "tags"), 60, 60_000);
  if (!limit.ok) return jsonError(429, "rate_limited", "Search is busy, tap a suggestion");
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (q.length < 2) return Response.json({ results: [], mock: !qlooConfigured() });
  const mode = quotaMode((await getQuota()).remaining);
  if (qlooConfigured() && mode !== "normal") {
    return Response.json({ results: [], curatedOnly: true, mock: false });
  }
  try {
    const results = await searchTags(q);
    const best = pickBestTag(results);
    return Response.json({
      results: best ? [best, ...results.filter((tag) => tag.id !== best.id)] : results,
      mock: !qlooConfigured(),
    });
  } catch (error) {
    if (error instanceof QlooBusyError) {
      return Response.json({ results: [], busy: true, message: "Search is busy, tap a suggestion" });
    }
    return jsonError(502, "tags_failed", "Search is busy, tap a suggestion");
  }
}
