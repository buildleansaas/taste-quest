import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from "ai";
import { buildWalk } from "@/lib/plan/build";
import { clientKey, rateLimit } from "@/lib/ratelimit";
import { jsonError, planSchema } from "@/lib/schemas";
import type { Stop, Walk, WalkRoute } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type PlanMessage = UIMessage<
  unknown,
  {
    step: { text: string };
    stop: Stop;
    route: WalkRoute;
    walk: Walk;
    notice: { code: string; message: string };
  }
>;

export async function POST(req: Request): Promise<Response> {
  const limit = rateLimit(clientKey(req, "plan"), 10, 60 * 60 * 1000);
  if (!limit.ok) return jsonError(429, "rate_limited", "Too many routes this hour. Try the Austin demo.");
  const body: unknown = await req.json().catch(() => null);
  const parsed = planSchema.safeParse(body);
  if (!parsed.success) return jsonError(400, "invalid", "Check your tastes and starting point.");
  if (parsed.data.profile.entities.length + parsed.data.profile.tags.length === 0) {
    return jsonError(400, "empty_profile", "Pick a few tastes first.");
  }

  const input = parsed.data;
  const stream = createUIMessageStream<PlanMessage>({
    execute: async ({ writer }) => {
      try {
        const walk = await buildWalk({
          profile: {
            entities: input.profile.entities,
            tags: input.profile.tags,
            updatedAt: input.profile.updatedAt ?? new Date().toISOString(),
          },
          start: {
            lat: input.start.lat,
            lon: input.start.lon,
            label: input.start.label,
            source: input.start.source ?? (input.demo ? "demo" : "gps"),
            accuracyM: input.start.accuracyM,
          },
          budgetMin: input.budgetMin,
          pace: input.pace,
          mode: input.mode,
          shape: input.shape ?? "loop",
          end: input.end,
          demo: input.demo,
          widen: input.widen,
          tz: input.tz,
          onStep: (text) => writer.write({ type: "data-step", data: { text } }),
        });
        const version = walk.versions[walk.versions.length - 1];
        if (!version || version.stops.length === 0) {
          writer.write({
            type: "data-notice",
            data: {
              code: "thin_coverage",
              message: "Not enough taste matches within 2.5 km.",
            },
          });
        }
        if (version) {
          writer.write({ type: "data-route", data: version.route });
          for (const stop of version.stops) writer.write({ type: "data-stop", data: stop });
        }
        writer.write({ type: "data-walk", data: walk });
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "plan_failed";
        const message =
          code === "quota"
            ? "Live plans are paused to protect the monthly Qloo quota. Try the Austin demo."
            : "Couldn’t build a route. Your last walk is unchanged.";
        writer.write({ type: "data-notice", data: { code, message } });
      }
    },
    onError: () => "Couldn’t build a route.",
  });

  return createUIMessageStreamResponse({ stream });
}
