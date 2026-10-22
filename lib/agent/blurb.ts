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
  const first = input.shortDescription?.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/)[0];
  const clause = first && /[.!?]$/.test(first) && !/(\.\.\.|…)$/.test(first) ? first.replace(/[.!?]+$/, "") : undefined;
  const kind = input.kind && input.kind !== "Place" ? input.kind.toLowerCase() : undefined;
  const body = clause
    ? `${clause}. ${match}`
    : kind
      ? `${/^[aeiou]/.test(kind) ? "An" : "A"} ${kind}. ${match}`
      : match;
  if (!input.orderNote) return body;
  const note = `${input.orderNote.charAt(0).toUpperCase()}${input.orderNote.slice(1)}.`;
  return `${body} ${note}`;
}

/** Taste names compared loosely: case, a leading "The", quotes and hyphens. */
export function looseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[‘’`]/g, "'")
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
  const allowed = new Set([placeName.toLowerCase(), ...profileNames.map((name) => name.toLowerCase())]);
  for (const match of blurb.matchAll(PLACE_RE)) {
    const quoted = (match[1] || match[2] || "").toLowerCase();
    if (quoted && !allowed.has(quoted)) return { ok: false, reason: "quoted-name" };
  }
  for (const match of blurb.matchAll(BECAUSE_RE)) {
    const phrase = match[1]?.toLowerCase() ?? "";
    const known = profileNames.some((name) => phrase.includes(name.toLowerCase()));
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
    const guard = guardBlurb(text, input.place, names);
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
