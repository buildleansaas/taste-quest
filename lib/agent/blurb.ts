import { generateText } from "ai";
import { cacheGet, cacheSet, TTL } from "@/lib/cache";
import { sha } from "@/lib/hash";
import { reserve } from "@/lib/agent/budget";
import { log } from "@/lib/log";
import type { Evidence, TasteProfile } from "@/lib/types";

// A quoted name: double quotes, or single quotes that aren't apostrophes
// inside a word ("the bar's rooftop and Austin's skyline" is not a quote).
const PLACE_RE = /"([^"]{2,80})"|(?<![\p{L}\p{N}])'([^']{2,80})'(?![\p{L}\p{N}])/gu;
const BECAUSE_RE = /(?:because you like|who love|fans of)\s+([^.]{2,80})/gi;

export function templateBlurb(input: {
  place: string;
  evidence: Evidence;
  shortDescription?: string;
  orderNote?: string;
  kind?: string;
  /** Built-in sample places: Qloo never ranked them, so don't credit it. */
  sample?: boolean;
}): string {
  const top = [...input.evidence.entityShares].sort((a, b) => b.share - a.share)[0];
  const tag = input.evidence.tagOverlap[0]?.name;
  const who = top?.name ? `${top.name}${top && tag ? ` and ${tag.toLowerCase()}` : ""} fans` : tag ? `${tag.toLowerCase()} fans` : undefined;
  const match = who ? (input.sample ? `A match for ${who}.` : `A Qloo match for ${who}.`) : "A fit for your picks.";
  // Qloo's own description is the concrete part, but only a whole sentence:
  // Qloo cuts long descriptions off with "...", and a fragment can't lead.
  const clause = firstSentence(input.shortDescription);
  const kind = input.kind && input.kind !== "Place" ? lowerKind(input.kind) : undefined;
  const body = clause ? `${clause} ${match}` : kind ? `${withArticle(kind)}. ${match}` : match;
  if (!input.orderNote) return body;
  const note = `${input.orderNote.charAt(0).toUpperCase()}${input.orderNote.slice(1)}.`;
  return `${body} ${note}`;
}

// Words a period follows without ending the sentence ("6th St. near the river").
const ABBREV = /(?:^|\s)(?:st|dr|mt|ave|blvd|rd|jr|sr|no|vs|mr|mrs|ms|e\.g|i\.e|etc)\.$/i;

/**
 * The description's first whole sentence, with its own end mark, or nothing:
 * Qloo cuts long descriptions off with "...", an abbreviation's period is not
 * a sentence end, and a fragment under four words can't lead a reason.
 */
export function firstSentence(text?: string): string | undefined {
  const clean = text?.replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  let end = -1;
  for (const match of clean.matchAll(/[.!?](?=\s+[\p{Lu}\p{N}"“'‘(]|$)/gu)) {
    const upTo = clean.slice(0, match.index! + 1);
    // "J. R. R. Tolkien", "the U.S. Capitol": a single letter before the period.
    if (match[0] === "." && (ABBREV.test(upTo) || /\.\.$/.test(upTo) || /(?:^|[\s.])\p{L}\.$/u.test(upTo))) continue;
    end = match.index! + 1;
    break;
  }
  if (end < 0) return undefined;
  const sentence = clean.slice(0, end);
  if (/(\.\.\.|…)$/.test(sentence) || sentence.split(" ").length < 4) return undefined;
  return sentence;
}

/** "a cafe", "an arcade", "a unique venue"; plural kinds ("Tacos") stand alone. */
function withArticle(kind: string): string {
  if (/[^s]s$/.test(kind) && !/(ss|us|is)$/.test(kind)) return kind.charAt(0).toUpperCase() + kind.slice(1);
  const lower = kind.toLowerCase();
  // Sound, not spelling: "an hour", "a unique", "a ukulele", "a one-off".
  const an = (/^[aeiou]/.test(lower) && !/^(uni|use|usu|uti|uk|ufo|eu|one|once)/.test(lower)) || /^(hour|honest|honou?r|heir)/.test(lower);
  return `${an ? "An" : "A"} ${kind}`;
}

// Nationalities and other proper adjectives stay capitalised ("A Mexican restaurant").
const PROPER = /^(?:[A-Z][a-z]+(?:an|ian|ean|ese|ish|ic|i|ch|ss)|Thai|French|Dutch|Greek|Swiss|Tex-Mex|Cajun|Creole|Southern)\b/;

function lowerKind(kind: string): string {
  return PROPER.test(kind) ? kind : kind.charAt(0).toLowerCase() + kind.slice(1);
}

/** True when `text` names `name` as a whole word or phrase, compared loosely. */
export function namesTaste(text: string, name: string): boolean {
  const want = looseName(name);
  if (!want) return false;
  const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u").test(looseName(text));
}

/** Taste names compared loosely: case, a leading "The", quotes and hyphens. */
export function looseName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(/\s*(?:&|\+)\s*/g, " and ")
    .replace(/[-–—_]/g, " ")
    .replace(/^the\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function guardBlurb(
  blurb: string,
  placeName: string,
  profileNames: string[],
): { ok: boolean; reason?: string } {
  // Typographic quotes count as quotes too (models emit them); an apostrophe
  // inside a word (Austin’s) still isn't one.
  const text = blurb.replace(/[“”„«»″`]/g, '"').replace(/[‘’‚‹›′]/g, "'");
  const allowed = new Set([placeName, ...profileNames].map(looseName));
  for (const match of text.matchAll(PLACE_RE)) {
    const quoted = looseName(match[1] || match[2] || "");
    if (quoted && !allowed.has(quoted)) return { ok: false, reason: "quoted-name" };
  }
  for (const match of text.matchAll(BECAUSE_RE)) {
    // "fans of Mohawk and Khruangbin": every name in the list must be a taste,
    // not just one of them. The list ends at the first verb-ish break.
    const list = (match[1] ?? "").split(/\s+(?:will|would|can|could|should|might|may|love|loves|tend|get|find|are|is|who|that)\b/i)[0] ?? "";
    const items = list.split(/\s*(?:,|\band\b|&|\+|\bor\b)\s*/i).map((item) => item.trim()).filter((item) => item.length > 1);
    const known = items.length > 0 && items.every((item) => profileNames.some((name) => namesTaste(item, name)));
    if (!known) return { ok: false, reason: "because-entity" };
  }
  return { ok: true };
}

/**
 * Gateway fallback plus per-provider settings. Gemini 2.5 Flash thinks by
 * default and its thinking tokens count against maxOutputTokens, which cut
 * answers to one word; a short grounded sentence needs no thinking.
 */
export function modelOptions(fallback?: string) {
  return {
    ...(fallback ? { gateway: { models: [fallback] } } : {}),
    google: { thinkingConfig: { thinkingBudget: 0 } },
  };
}

export function gatewayReady(): boolean {
  // On Vercel the gateway authenticates with the request's OIDC token (a header,
  // not an env var), so running on Vercel is enough.
  return Boolean(process.env.VERCEL || process.env.VERCEL_OIDC_TOKEN || process.env.AI_GATEWAY_API_KEY);
}

export async function explainBlurb(input: {
  place: string;
  evidence: Evidence;
  shortDescription?: string;
  profile: TasteProfile;
  entityId: string;
}): Promise<string> {
  return (await explainBlurbWithSource(input)).blurb;
}

export type BlurbSource = "model" | "cache" | "template:no-gateway" | "template:budget" | "template:guard" | "template:error";

/** The blurb and where it came from, so a deploy can prove the model is reached. */
export async function explainBlurbWithSource(input: {
  place: string;
  evidence: Evidence;
  shortDescription?: string;
  profile: TasteProfile;
  entityId: string;
  sample?: boolean;
}): Promise<{ blurb: string; source: BlurbSource; error?: string }> {
  const fallback = templateBlurb(input);
  const key = `blurb:v3:${input.entityId}:${sha(input.profile.entities.map((e) => e.id).sort().join(","))}`;
  const cached = await cacheGet<string>(key);
  if (cached) return { blurb: cached, source: "cache" };
  if (!gatewayReady()) return { blurb: fallback, source: "template:no-gateway" };


  // The stop page's blurb for a stop the agent didn't explain (lib/agent/planner.ts
  // writes the plan's reasons itself); one short call, checked by guardBlurb.
  const names = input.profile.entities.map((entity) => entity.name);
  const shares = input.evidence.entityShares
    .map((share) => `${share.name} ${Math.round(share.share * 100)}%`)
    .join(", ");
  const tags = input.evidence.tagOverlap.map((tag) => tag.name).join(", ") || "none";
  const prompt = [
    "You are a local friend who knows the listener's taste.",
    "Write at most 2 concrete sentences about why this place fits.",
    "Only mention this place by its exact name, without quotation marks. Do not invent hours, prices, awards, or history.",
    "Name one of the listener's tastes and one concrete detail from the description or tags. Sound natural; don't open with 'People who love'.",
    `Place: ${input.place}`,
    `Known description: ${input.shortDescription ?? "none"}`,
    `Entity shares: ${shares || "none"}`,
    `Tag overlap: ${tags}`,
    `Profile entities: ${names.join(", ")}`,
  ].join("\n");

  const primary = process.env.AI_MODEL || "google/gemini-2.5-flash";
  const fallbackModel = process.env.AI_FALLBACK_MODEL || "google/gemini-2.5-flash-lite";
  // The hold follows the prompt's real size (about 3 characters a token, rounded up).
  const budget = await reserve("blurb", [primary, fallbackModel], { inputTokens: Math.ceil(prompt.length / 3) + 50, outputTokens: 160 });
  if (!budget) return { blurb: fallback, source: "template:budget" };
  try {
    const result = await generateText({
      model: primary,
      prompt,
      maxOutputTokens: 160,
      maxRetries: 1,
      providerOptions: modelOptions(fallbackModel),
    });
    await budget.step(result.usage);
    await budget.settle(false);
    const text = result.text.trim();
    const guarded = guardBlurb(text, input.place, names);
    // Like the planner's reasons, a stop-page blurb must name one of the tastes.
    const tasteNames = [...names, ...input.profile.tags.map((tag) => tag.name)];
    const guard = guarded.ok && !tasteNames.some((name) => namesTaste(text, name)) ? { ok: false, reason: "no-taste" } : guarded;
    const blurb = guard.ok && text ? text : fallback;
    if (!guard.ok) log("warn", "blurb-guard", { place: input.place, reason: guard.reason });
    // Only a model blurb is cached; a guard failure retries next time.
    if (guard.ok && text) await cacheSet(key, blurb, TTL.blurb, ["blurb"]);
    return { blurb, source: guard.ok && text ? "model" : "template:guard" };
  } catch (error) {
    await budget.settle(true);
    const message = error instanceof Error ? error.message : String(error);
    log("warn", "blurb-fallback", { error: message });
    return { blurb: fallback, source: "template:error", error: message.slice(0, 160) };
  }
}
