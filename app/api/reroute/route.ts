import { rerouteWalk } from "@/lib/plan/build";
import { clientKey, rateLimit } from "@/lib/ratelimit";
import { jsonError, rerouteSchema } from "@/lib/schemas";
import type { Candidate, Walk, WalkVersion } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  const limit = rateLimit(clientKey(req, "reroute"), 60, 60 * 60 * 1000);
  if (!limit.ok) return jsonError(429, "rate_limited", "Couldn't update. Your route is unchanged.");
  const body: unknown = await req.json().catch(() => null);
  const parsed = rerouteSchema.safeParse(body);
  if (!parsed.success) return jsonError(400, "invalid", "Couldn't update. Your route is unchanged.");
  const walk = parsed.data.walk as unknown as Walk;
  walk.versions = parsed.data.walk.versions as WalkVersion[];
  walk.pool = parsed.data.walk.pool as Candidate[] | undefined;
  try {
    const result = await rerouteWalk({
      profile: {
        entities: parsed.data.profile.entities,
        tags: parsed.data.profile.tags,
        updatedAt: parsed.data.profile.updatedAt ?? new Date().toISOString(),
      },
      walk,
      fix: parsed.data.fix,
      reason: parsed.data.reason,
      pool: walk.pool,
      tz: parsed.data.tz,
    });
    return Response.json({
      diff: result.diff,
      stops: result.walk.versions[result.walk.versions.length - 1]?.stops ?? [],
      route: result.walk.versions[result.walk.versions.length - 1]?.route,
      toast: result.toast,
      walk: result.walk,
    });
  } catch {
    return jsonError(502, "reroute_failed", "Couldn't update. Your route is unchanged.");
  }
}
