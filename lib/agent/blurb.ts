import { generateText } from "ai";
import { cacheGet, cacheSet, TTL } from "@/lib/cache";
import { sha } from "@/lib/hash";
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

function gatewayReady(): boolean {
  return Boolean(process.env.VERCEL_OIDC_TOKEN || process.env.AI_GATEWAY_API_KEY);
}

export async function explainBlurb(input: {
  place: string;
  evidence: Evidence;
  shortDescription?: string;
  profile: TasteProfile;
  entityId: string;
}): Promise<string> {
  const fallback = templateBlurb(input);
  const key = `blurb:${input.entityId}:${sha(input.profile.entities.map((e) => e.id).sort().join(","))}`;
  const cached = await cacheGet<string>(key);
  if (cached) return cached;
  if (!gatewayReady()) return fallback;

  // TODO(#7): replace this single-shot paragraph with the tool loop
  // (get_context, find_candidates, build_route, explain_stop) via streamText,
  // stopWhen stepCountIs(6), and a 20s timeout. The engine stays the source of stops.
  const names = input.profile.entities.map((entity) => entity.name);
  const shares = input.evidence.entityShares
    .map((share) => `${share.name} ${Math.round(share.share * 100)}%`)
    .join(", ");
  const tags = input.evidence.tagOverlap.map((tag) => tag.name).join(", ") || "none";
  const prompt = [
    "You are a local friend who knows the listener's taste.",
    "Write at most 2 concrete sentences about why this place fits.",
    "Only mention this place by its exact name. Do not invent hours, prices, awards, or history.",
    "Phrase taste as: people who love X tend to love this.",
    `Place: ${input.place}`,
    `Known description: ${input.shortDescription ?? "none"}`,
    `Entity shares: ${shares || "none"}`,
    `Tag overlap: ${tags}`,
    `Profile entities: ${names.join(", ")}`,
  ].join("\n");

  try {
    const primary = process.env.AI_MODEL || "openai/gpt-5-mini";
    const fallbackModel = process.env.AI_FALLBACK_MODEL || "google/gemini-2.5-flash";
    const result = await generateText({
      model: primary,
      prompt,
      maxOutputTokens: 160,
      providerOptions: {
        gateway: { models: [fallbackModel] },
      },
    });
    const text = result.text.trim();
    const guard = guardBlurb(text, input.place, names);
    const blurb = guard.ok && text ? text : fallback;
    if (!guard.ok) log("warn", "blurb-guard", { place: input.place, reason: guard.reason });
    await cacheSet(key, blurb, TTL.blurb, ["blurb"]);
    return blurb;
  } catch (error) {
    log("warn", "blurb-fallback", {
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback;
  }
}
