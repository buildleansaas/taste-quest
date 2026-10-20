import { jsonError } from "@/lib/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// TODO(#14): warm the demo:v1 Runtime Cache entry with a few Qloo calls, gated by CRON_SECRET.
export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const header = req.headers.get("authorization");
  if (!secret || header !== `Bearer ${secret}`) return jsonError(401, "unauthorized", "Cron secret required.");
  return Response.json({ ok: false, todo: "warm-demo is not implemented in this slice" });
}
