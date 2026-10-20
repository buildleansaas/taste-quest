import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { guardBlurb, templateBlurb } from "@/lib/agent/blurb";
import { normalizeEntities, normalizeTags } from "@/lib/qloo/normalize";
import { quotaMode } from "@/lib/qloo/client";
import { pickBestTag, tagPriority } from "@/lib/taste/curated";

describe("normalizer", () => {
  it("reads a synthetic insights payload", () => {
    const payload = {
      results: {
        entities: [
          {
            entity_id: "sample-place-1",
            name: "Sample Listening Bar",
            location: { lat: 30.27, lon: -97.74 },
            popularity: 0.4,
            query: {
              affinity: 0.84,
              explainability: {
                "signal.interests.entities": [
                  { entity_id: "sample-entity-khruangbin", score: 0.6 },
                  { entity_id: "sample-entity-tame-impala", score: 0.4 },
                ],
              },
            },
            properties: {
              address: "1 Sample St",
              short_description: "A synthetic room.",
              hours: { saturday: [{ opens: "T16:00:00", closes: "T02:00:00" }] },
              is_closed: false,
            },
            tags: [{ id: "urn:tag:category:place:bar", name: "Bar", type: "urn:tag:category:place" }],
          },
        ],
      },
    };
    const [place] = normalizeEntities(
      payload,
      new Map([
        ["sample-entity-khruangbin", "Khruangbin"],
        ["sample-entity-tame-impala", "Tame Impala"],
      ]),
    );
    expect(place.affinity).toBe(0.84);
    expect(place.entityShares.map((share) => share.share).reduce((a, b) => a + b, 0)).toBe(1);
    expect(place.entityShares[0]?.name).toBe("Khruangbin");
    expect(place.hours?.saturday[0]?.opens).toBe("T16:00:00");
    expect(place.address).toBe("1 Sample St");
  });

  it("orders tags by the place-parent priority", () => {
    const tags = normalizeTags({
      results: [
        { id: "urn:tag:specialty_dish:place:tacos", name: "Tacos", type: "urn:tag:specialty_dish:place" },
        { id: "urn:tag:cuisine:qloo:natural_wine", name: "Natural wine", type: "urn:tag:cuisine:qloo" },
        { id: "urn:tag:category:place:live_music_venue", name: "Live music venue", type: "urn:tag:category:place" },
      ],
    });
    expect(pickBestTag(tags)?.id).toContain("category:place");
    expect(tagPriority("urn:tag:cuisine:qloo")).toBeLessThan(tagPriority("urn:tag:specialty_dish:place"));
  });
});

describe("quota", () => {
  it("degrades search, then plans", () => {
    expect(quotaMode(null)).toBe("normal");
    expect(quotaMode(4000)).toBe("normal");
    expect(quotaMode(1499)).toBe("curated-only");
    expect(quotaMode(499)).toBe("demo-or-cache");
  });
});

describe("blurb guard", () => {
  it("keeps a grounded template and rejects a stray place", () => {
    const blurb = templateBlurb({
      place: "Sample Listening Bar",
      evidence: {
        entityShares: [{ entityId: "a", name: "Khruangbin", share: 0.6 }],
        tagOverlap: [{ id: "t", name: "Live music" }],
      },
      shortDescription: "A small room with a stage.",
    });
    expect(guardBlurb(blurb, "Sample Listening Bar", ["Khruangbin"]).ok).toBe(true);
    expect(guardBlurb('People love "Invented Hall".', "Sample Listening Bar", ["Khruangbin"]).ok).toBe(false);
    expect(guardBlurb("People who love Unknown Band tend to love it.", "Sample Listening Bar", ["Khruangbin"]).ok).toBe(
      false,
    );
  });
});

describe("fixtures", () => {
  it("does not commit Qloo image hosts", () => {
    const sample = readFileSync(new URL("../lib/qloo/sample.ts", import.meta.url), "utf8");
    expect(sample).not.toContain("images.qloo.com");
    expect(sample).not.toContain("hackathon.api.qloo.com");
  });
});
