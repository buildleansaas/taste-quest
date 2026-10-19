import { explainBlurb } from "@/lib/agent/blurb";
import { jsonError } from "@/lib/schemas";
import { z } from "zod";
import { profileSchema } from "@/lib/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const schema = z.object({
  profile: profileSchema,
  stop: z.object({
    entityId: z.string(),
    name: z.string(),
    evidence: z.object({
      entityShares: z.array(z.object({ entityId: z.string(), name: z.string(), share: z.number() })),
      tagOverlap: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
    shortDescription: z.string().optional(),
  }),
});

export async function POST(req: Request): Promise<Response> {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "invalid", "Missing stop.");
  const blurb = await explainBlurb({
    place: parsed.data.stop.name,
    entityId: parsed.data.stop.entityId,
    evidence: parsed.data.stop.evidence,
    shortDescription: parsed.data.stop.shortDescription,
    profile: {
      entities: parsed.data.profile.entities,
      tags: parsed.data.profile.tags,
      updatedAt: parsed.data.profile.updatedAt ?? new Date().toISOString(),
    },
  });
  return Response.json({ blurb });
}
