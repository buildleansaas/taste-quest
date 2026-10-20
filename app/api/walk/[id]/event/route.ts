import { log } from "@/lib/log";
import { jsonError } from "@/lib/schemas";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  type: z.enum(["arrive", "skip", "go"]),
  entityId: z.string().optional(),
});

export async function POST(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "invalid", "Unknown event.");
  log("info", "walk-event", { walkId: id, type: parsed.data.type });
  return Response.json({ ok: true });
}
