import { generateText } from "ai";
import { cacheGet, cacheSet, TTL } from "@/lib/cache";
import { sha } from "@/lib/hash";
import { budgetLeft, recordSpend } from "@/lib/agent/budget";
import { log } from "@/lib/log";
import type { Evidence, TasteProfile } from "@/lib/types";

const PLACE_RE = /"([^"]{2,80})"|'([^']{2,80})'/g;
const BECAUSE_RE = /(?:because you like|who love|fans of)\s+([^.]{2,80})/gi;

export function templateBlurb(input: {
  place: string;
  evidence: Evidence;
  shortDescription?: string;
  orderNote?: string;
}): string {
  const top = [...input.evidence.entityShares].sort((a, b) => b.share - a.share)[0];
  const tag = input.evidence.tagOverlap[0]?.name;
  const who = top?.name ?? "this taste";
  const and = tag ? ` and ${tag.toLowerCase()}` : "";
  const clause = input.shortDescription?.split(". ")[0];
  const lead = `People who love ${who}${and} tend to love ${input.place}.`;
  const body = clause ? `${lead} ${clause.replace(/\.$/, "")}.` : lead;
  if (!input.orderNote) return body;
  const note = `${input.orderNote.charAt(0).toUpperCase()}${input.orderNote.slice(1)}.`;
  return `${body} ${note}`;
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
  const key = `blurb:${input.entityId}:${sha(input.profile.entities.map((e) => e.id).sort().join(","))}`;
  const cached = await cacheGet<string>(key);
  if (cached) return { blurb: cached, source: "cache" };
  if (!gatewayReady()) return { blurb: fallback, source: "template:no-gateway" };
  if (!(await budgetLeft())) return { blurb: fallback, source: "template:budget" };

  // The stop page's blurb for a stop the agent didn't explain (lib/agent/planner.ts
  // writes the plan's reasons itself); one short call, guarded like the agent's.
  const names = input.profile.entities.map((entity) => entity.name);
  const shares = input.evidence.entityShares
    .map((share) => `${share.name} ${Math.round(share.share * 100)}%`)
    .join(", ");
  const tags = input.evidence.tagOverlap.map((tag) => tag.name).join(", ") || "none";
  const prompt = [
    "You are a local friend who knows the listener's taste.",
    "Write at most 2 concrete sentences about why this place fits.",
    "Only mention this place by its exact name, without quotation marks. Do not invent hours, prices, awards, or history.",
    "Phrase taste as: people who love X tend to love this.",
    `Place: ${input.place}`,
    `Known description: ${input.shortDescription ?? "none"}`,
    `Entity shares: ${shares || "none"}`,
    `Tag overlap: ${tags}`,
    `Profile entities: ${names.join(", ")}`,
  ].join("\n");

  try {
    const primary = process.env.AI_MODEL || "anthropic/claude-haiku-5.5";
    const fallbackModel = process.env.AI_FALLBACK_MODEL || "google/gemini-2.5-flash";
    const result = await generateText({
      model: primary,
      prompt,
      maxOutputTokens: 160,
      providerOptions: {
        gateway: { models: [fallbackModel] },
      },
    });
    await recordSpend(result.usage, "blurb");
    const text = result.text.trim();
    const guard = guardBlurb(text, input.place, names);
    const blurb = guard.ok && text ? text : fallback;
    if (!guard.ok) log("warn", "blurb-guard", { place: input.place, reason: guard.reason });
    await cacheSet(key, blurb, TTL.blurb, ["blurb"]);
    return { blurb, source: guard.ok && text ? "model" : "template:guard" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("warn", "blurb-fallback", { error: message });
    return { blurb: fallback, source: "template:error", error: message.slice(0, 160) };
  }
}
