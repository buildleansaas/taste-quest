import { getQuota, qlooConfigured } from "@/lib/qloo/client";
import { osrmConfigured } from "@/lib/routing/osrm";
import { jsonError } from "@/lib/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const token = process.env.ADMIN_TOKEN;
  const header = req.headers.get("authorization");
  if (!token || header !== `Bearer ${token}`) {
    return jsonError(401, "unauthorized", "Admin token required.");
  }
  const quota = await getQuota();
  let osrmOk = false;
  let osrmMs: number | null = null;
  const base = process.env.OSRM_BASE_URL?.replace(/\/$/, "");
  if (base) {
    const started = Date.now();
    try {
      const response = await fetch(
        `${base}/route/v1/foot/-97.74306,30.2672;-97.74039,30.26605?overview=false`,
        { signal: AbortSignal.timeout(2000), cache: "no-store" },
      );
      osrmOk = response.ok;
      osrmMs = Date.now() - started;
    } catch {
      osrmOk = false;
      osrmMs = Date.now() - started;
    }
  }
  return Response.json({
    qlooConfigured: qlooConfigured(),
    qlooMonthRemaining: quota.remaining,
    qlooSeenAt: quota.at,
    osrmConfigured: osrmConfigured(),
    osrmOk,
    osrmMs,
  });
}
