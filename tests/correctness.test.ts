import { describe, expect, it } from "vitest";
import { templateBlurb } from "@/lib/agent/blurb";
import { listNames, reasonProblem } from "@/lib/agent/planner";
import { isOpenAt } from "@/lib/engine/core";
import { normalizeEntities } from "@/lib/qloo/normalize";

const place = (hours: Record<string, { opens: string; closes: string }[]>) =>
  normalizeEntities(
    { results: { entities: [{ entity_id: "p1", name: "Brazos Hall", location: { lat: 30.266, lon: -97.742 }, properties: { hours } }] } },
    new Map(),
  )[0]!;

const allWeek = (span: { opens: string; closes: string }) =>
  Object.fromEntries(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((day) => [day, [span]]));

describe("opening hours", () => {
  it("reads 00:00–00:00 on every day as 'not listed', not open 24 hours", () => {
    // What Qloo sent for Brazos Hall, The Sunset Room and Tau Ceti (2026-10-22).
    expect(place(allWeek({ opens: "T00:00:00", closes: "T00:00:00" })).hours).toBeUndefined();
  });

  it("reads other midnight spellings the same way", () => {
    for (const t of ["T00:00:00Z", "00:00", "0000", "T00:00:00.000"]) expect(place(allWeek({ opens: t, closes: t })).hours).toBeUndefined();
  });

  it("keeps a real all-day opening among real hours", () => {
    const hours = { ...allWeek({ opens: "T17:00:00", closes: "T02:00:00" }), saturday: [{ opens: "T00:00:00", closes: "T00:00:00" }] };
    const kept = place(hours).hours!;
    expect(kept.saturday).toEqual([{ opens: "T00:00:00", closes: "T00:00:00" }]);
    expect(kept.monday).toEqual([{ opens: "T17:00:00", closes: "T02:00:00" }]);
  });

  it("treats a place with no listed hours as possibly open", () => {
    expect(isOpenAt(undefined, "monday", new Date("2026-10-26T15:00:00Z"))).toBe(true);
  });
});

describe("why-you'll-like-it reasons", () => {
  const tastes = ["Khruangbin", "The Grand Budapest Hotel", "Natural wine"];

  it("rejects a bare description that names no taste", () => {
    expect(reasonProblem("This is a concert hall.", "Brazos Hall", tastes)).toMatch(/^name one of the walker's tastes/);
  });

  it("rejects a reason that is too short to say anything", () => {
    expect(reasonProblem("Khruangbin fans love it.", "Brazos Hall", tastes)).toMatch(/too short/);
  });

  it("rejects invented hours and prices", () => {
    expect(reasonProblem("A rooftop bar Khruangbin fans love, open till 2am most nights.", "The Sunset Room", tastes)).toMatch(/no hours/);
  });

  it("accepts a natural reason with a taste and a concrete detail", () => {
    expect(reasonProblem("A rooftop lounge with a skyline view, an easy yes for Khruangbin fans.", "The Sunset Room", tastes)).toBeNull();
  });

  it("falls back to Qloo's description, never a stock 'People who love' line", () => {
    const blurb = templateBlurb({
      place: "The Sunset Room",
      evidence: { entityShares: [{ entityId: "k", name: "Khruangbin", share: 0.51 }], tagOverlap: [] },
      shortDescription: "Rooftop cocktail lounge with a panoramic downtown skyline view. Private events too.",
    });
    expect(blurb).toBe("Rooftop cocktail lounge with a panoramic downtown skyline view. A Qloo match for Khruangbin fans.");
    expect(blurb).not.toMatch(/People who love/);
  });

  it("without a description, says what kind of place it is", () => {
    const blurb = templateBlurb({
      place: "Brazos Hall",
      evidence: { entityShares: [{ entityId: "k", name: "Khruangbin", share: 0.53 }], tagOverlap: [] },
      kind: "Concert hall",
    });
    expect(blurb).toBe("A concert hall. A Qloo match for Khruangbin fans.");
  });

  it("never leads with a description Qloo cut off", () => {
    // Brazos Hall's real description (tests/polish.test.ts).
    const blurb = templateBlurb({
      place: "Brazos Hall",
      evidence: { entityShares: [{ entityId: "l", name: "Leon Bridges", share: 0.6 }], tagOverlap: [] },
      shortDescription: "Stylish downtown venue with a rooftop deck, skyline views, and versatile...",
      kind: "Event venue",
    });
    expect(blurb).toBe("An event venue. A Qloo match for Leon Bridges fans.");
  });

  it("doesn't credit Qloo on sample places, and reads well with no evidence", () => {
    const evidence = { entityShares: [{ entityId: "k", name: "Khruangbin", share: 1 }], tagOverlap: [] };
    expect(templateBlurb({ place: "P", evidence, kind: "Cafe", sample: true })).toBe("A cafe. A match for Khruangbin fans.");
    expect(templateBlurb({ place: "P", evidence: { entityShares: [], tagOverlap: [] } })).toBe("A fit for your picks.");
  });

  it("accepts possessives and a title without its leading 'The'", () => {
    expect(reasonProblem("Khruangbin fans will love the bar's rooftop and Austin's best skyline view.", "The Sunset Room", tastes)).toBeNull();
    expect(reasonProblem("A pastel lobby café with old-world charm, an easy yes for Grand Budapest Hotel fans.", "X", tastes)).toBeNull();
    expect(reasonProblem("A natural-wine bar with a quiet patio for Khruangbin nights.", "X", tastes)).toBeNull();
  });

  it("still rejects a quoted other place", () => {
    expect(reasonProblem("Like 'Mohawk Austin', a room Khruangbin fans love for late shows.", "Brazos Hall", tastes)).toMatch(/quotation marks/);
  });
});

describe("the agent's search step", () => {
  it("names every pick, tags included", () => {
    expect(listNames(["Khruangbin", "The Grand Budapest Hotel", "natural wine"], 3)).toBe("Khruangbin, The Grand Budapest Hotel and natural wine");
    expect(listNames(["A", "B", "C", "D", "E"], 3)).toBe("A, B, C and 2 more");
    expect(listNames(["Khruangbin"], 3)).toBe("Khruangbin");
  });
});
