import { describe, expect, it } from "vitest";
import { pct, tidyBlurb } from "@/components/ui/taste";
import { rerouteWalk, buildWalk } from "@/lib/plan/build";
import { demoProfile, DEMO_START } from "@/lib/taste/curated";

describe("display text", () => {
  it("scores read as whole percents", () => {
    expect(pct(0.834)).toBe(83);
    expect(pct(1.2)).toBe(100);
  });

  it("drops a sentence Qloo cut off and keeps whole sentences", () => {
    const text = "People who love Leon Bridges tend to love Brazos Hall. Stylish downtown venue with a rooftop deck, skyline views, and versatile...";
    expect(tidyBlurb(text)).toBe("People who love Leon Bridges tend to love Brazos Hall.");
    expect(tidyBlurb("One. Two three four.", 6)).toBe("One.");
    expect(tidyBlurb("A very long first sentence with no stop", 12)).toBe("A very long…");
  });

  it("the skip popup names the skipped stop and uses percents", async () => {
    const walk = await buildWalk({ profile: demoProfile(), start: { ...DEMO_START, source: "demo" }, budgetMin: 120, pace: "easy", mode: "2h", shape: "loop", demo: true, tz: "America/Chicago" });
    const fix = { lat: DEMO_START.lat, lon: DEMO_START.lon };
    const first = await rerouteWalk({ profile: demoProfile(), walk, fix, reason: "skip" });
    expect(first.toast).toBe("Skipped Midnight Cowboy. Added Museum of the Weird, an 86% match on the way. 1h 31m left.");
    const second = await rerouteWalk({ profile: demoProfile(), walk: first.walk, fix, reason: "skip" });
    expect(second.toast).toMatch(/^Skipped Museum of the Weird\. (Added .+, an? \d+% match\. )?.+ left\.$/);
    expect(second.toast).not.toMatch(/0\.\d\d/);
  });
});

describe("review fixes", () => {
  it("keeps decimals and web addresses whole", () => {
    expect(tidyBlurb("Rated 4.5 stars by locals. Great tacos.")).toBe("Rated 4.5 stars by locals. Great tacos.");
    expect(tidyBlurb("Visit swandiveatx.com for tickets. Open late.", 40)).toBe("Visit swandiveatx.com for tickets.");
  });

  it("a re-plan that is not a skip never says a stop was skipped", async () => {
    const walk = await buildWalk({ profile: demoProfile(), start: { ...DEMO_START, source: "demo" }, budgetMin: 120, pace: "easy", mode: "2h", shape: "loop", demo: true, tz: "America/Chicago" });
    const result = await rerouteWalk({ profile: demoProfile(), walk, fix: { lat: DEMO_START.lat, lon: DEMO_START.lon }, reason: "offroute" });
    expect(result.toast).not.toMatch(/Skipped/);
  });
});

describe("cut-off sentences", () => {
  it("drops a cut-off sentence that starts with a digit or an accented capital", () => {
    expect(tidyBlurb("Great spot. 3 rooftop bars and a versatile space...")).toBe("Great spot.");
    expect(tidyBlurb("Great spot. Ótimo bar com vista...")).toBe("Great spot.");
  });
});

describe("agent steps survive a re-plan", () => {
  it("rerouteSchema keeps walk.agent", async () => {
    const { rerouteSchema } = await import("@/lib/schemas");
    const walk = await buildWalk({ profile: demoProfile(), start: { ...DEMO_START, source: "demo" }, budgetMin: 120, pace: "easy", mode: "2h", shape: "loop", demo: true, tz: "America/Chicago" });
    const parsed = rerouteSchema.safeParse({ profile: demoProfile(), walk, fix: { lat: DEMO_START.lat, lon: DEMO_START.lon }, reason: "skip" });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.walk.agent?.recorded).toBe(true);
  });
});
