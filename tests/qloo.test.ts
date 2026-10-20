import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { guardBlurb, templateBlurb } from "@/lib/agent/blurb";
import { categoryFromTags, normalizeEntities, normalizeTags } from "@/lib/qloo/normalize";
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

describe("categoryFromTags", () => {
  const cat = (name: string) => ({ id: `urn:tag:category:place:${name.toLowerCase().replace(/ /g, "_")}`, name, type: "urn:tag:category:place" });
  const tag = (kind: string, name: string) => ({ id: `urn:tag:${kind}:qloo:${name.toLowerCase().replace(/ /g, "_")}`, name, type: `urn:tag:${kind}:qloo` });

  it("uses Qloo's category tag before loose tag text", () => {
    expect(categoryFromTags([tag("amenity", "Parking lot"), cat("Cathedral")], "Saint Mary Catholic Cathedral")).toEqual({ category: "sight", label: "Cathedral" });
    expect(categoryFromTags([cat("Bar"), tag("setting", "Garden")], "Bacchanal").category).toBe("bar");
    expect(categoryFromTags([cat("Art museum")], "Puppet Museum")).toEqual({ category: "museum", label: "Art museum" });
  });

  it("never calls a place a park because of parking or a rooftop", () => {
    const ember = [tag("offerings", "Coffee"), tag("amenity", "Full bar"), tag("amenity", "Parking")];
    expect(categoryFromTags(ember, "Ember Kitchen").category).toBe("restaurant");
    expect(categoryFromTags([tag("amenity", "Rooftop deck"), tag("amenity", "Free parking")], "Brazos Hall")).toEqual({ category: "default", label: "Place" });
  });

  it("reads the name when there is no category tag", () => {
    expect(categoryFromTags([], "Antikuario Cafe").category).toBe("cafe");
    expect(categoryFromTags([], "Miradouro de Santa Catarina").category).toBe("park");
  });
});

describe("Qloo slot limiter", () => {
  it("lets a 5th call through after the 1-second window, with nothing in flight", async () => {
    const { acquireQlooSlot, releaseQlooSlot } = await import("@/lib/qloo/client");
    for (let i = 0; i < 4; i += 1) {
      await acquireQlooSlot();
      releaseQlooSlot();
    }
    const started = Date.now();
    await acquireQlooSlot();
    releaseQlooSlot();
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe("review round 1 (PR #23)", () => {
  it("matches accented words and bar-named cafes and restaurants", () => {
    expect(categoryFromTags([], "Café Tortoni").category).toBe("cafe");
    expect(categoryFromTags([{ id: "urn:tag:category:place:sushi_bar", name: "Sushi bar", type: "urn:tag:category:place" }], "Uchi").category).toBe("restaurant");
    expect(categoryFromTags([{ id: "urn:tag:category:place:espresso_bar", name: "Espresso bar", type: "urn:tag:category:place" }], "Houndstooth").category).toBe("cafe");
  });

  it("keeps category tags after the 12-tag trim", () => {
    const context = Array.from({ length: 20 }, (_, i) => ({ id: `urn:tag:amenity:qloo:a${i}`, name: `Amenity ${i}`, type: "urn:tag:amenity:qloo" }));
    const payload = {
      results: {
        entities: [
          {
            entity_id: "e1",
            name: "Some Place",
            query: { affinity: 0.8 },
            location: { lat: 30.27, lon: -97.74 },
            tags: [...context, { id: "urn:tag:category:place:coworking_space", name: "Coworking space", type: "urn:tag:category:place" }],
          },
        ],
      },
    };
    const [place] = normalizeEntities(payload, new Map());
    expect(place?.tags.some((tag) => tag.id.includes("category:place"))).toBe(true);
  });
});
