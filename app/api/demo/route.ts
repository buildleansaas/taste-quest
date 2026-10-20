import { DEMO_START, demoProfile } from "@/lib/taste/curated";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json({
    profile: demoProfile(),
    start: DEMO_START,
    budgetMin: 120,
    pace: "easy",
    mode: "2h",
    // TODO(#14): serve a warmed Runtime Cache payload (demo:v1) and a simulated GPS track.
    simulated: false,
    note: "Preset Austin profile. It plays the scripted Austin walk with its recorded street route.",
  });
}
