import { z } from "zod";

export const entitySchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  type: z.enum(["artist", "movie", "tv_show", "place"]),
  weight: z.number().positive().max(100).optional(),
  subtitle: z.string().max(160).optional(),
});

export const tagSchema = z.object({
  id: z.string().min(1).max(300),
  name: z.string().min(1).max(120),
  cat: z.enum(["cuisine", "vibe"]),
});

export const profileSchema = z.object({
  entities: z.array(entitySchema).max(20),
  tags: z.array(tagSchema).max(20),
  updatedAt: z.string().optional(),
});

export const planSchema = z.object({
  profile: profileSchema,
  start: z.object({
    lat: z.number().gte(-90).lte(90),
    lon: z.number().gte(-180).lte(180),
    label: z.string().max(160).optional(),
    source: z.enum(["gps", "pin", "demo"]).optional(),
    accuracyM: z.number().optional(),
  }),
  budgetMin: z.number().int().min(30).max(720),
  pace: z.enum(["easy", "brisk", "stepfree"]),
  mode: z.enum(["1h", "2h", "tonight", "allday"]),
  shape: z.enum(["loop", "one-way", "end-near"]).optional(),
  end: z
    .object({
      lat: z.number().gte(-90).lte(90),
      lon: z.number().gte(-180).lte(180),
      label: z.string().max(160).optional(),
    })
    .optional(),
  demo: z.boolean().optional(),
  widen: z.boolean().optional(),
  tz: z.string().max(80).optional(),
});

export const rerouteSchema = z.object({
  profile: profileSchema,
  walk: z.object({
    id: z.string().min(1),
    status: z.enum(["planning", "active", "done", "abandoned"]),
    mode: z.enum(["1h", "2h", "tonight", "allday"]),
    budgetMin: z.number(),
    pace: z.enum(["easy", "brisk", "stepfree"]),
    start: z.object({
      lat: z.number(),
      lon: z.number(),
      label: z.string().optional(),
      source: z.enum(["gps", "pin", "demo"]),
      accuracyM: z.number().optional(),
    }),
    isDemo: z.boolean(),
    mock: z.boolean(),
    poolKey: z.string(),
    pool: z.array(z.unknown()).optional(),
    currentVersion: z.number(),
    versions: z.array(z.unknown()),
    startedAt: z.string().optional(),
    endedAt: z.string().optional(),
    stepsNote: z.string().optional(),
    remainingMin: z.number().optional(),
    cursor: z.object({ lat: z.number(), lon: z.number() }).optional(),
    shape: z.enum(["loop", "one-way", "end-near"]).optional(),
    end: z
      .object({
        lat: z.number(),
        lon: z.number(),
        label: z.string().optional(),
      })
      .optional(),
    returnMin: z.number().optional(),
    headingBack: z.boolean().optional(),
  }),
  fix: z.object({ lat: z.number(), lon: z.number() }),
  reason: z.enum(["initial", "offroute", "skip", "veto", "late", "closed", "weather"]),
  tz: z.string().max(80).optional(),
});

export function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: code, message }, { status });
}
