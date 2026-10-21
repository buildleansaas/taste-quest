import { explainBlurbWithSource } from "@/lib/agent/blurb";
import { clientKey, rateLimit } from "@/lib/ratelimit";
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
  // Each call can reach the model, so it shares the plan route's guard rails.
  const limit = rateLimit(clientKey(req, "blurb"), 20, 60 * 60 * 1000);
  if (!limit.ok) return jsonError(429, "rate_limited", "Too many requests.");
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "invalid", "Missing stop.");
  const { blurb, source, error } = await explainBlurbWithSource({
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
  // The source header lets a deploy check prove the model is reached; the error
  // text is the provider message (no keys), trimmed.
  const headers: Record<string, string> = { "x-blurb-source": source };
  if (error && process.env.VERCEL_ENV !== "production") headers["x-blurb-error"] = encodeURIComponent(error);
  return Response.json({ blurb }, { headers });
}
