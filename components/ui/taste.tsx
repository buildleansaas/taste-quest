"use client";

import { useLayoutEffect, useRef, useState } from "react";

/** 0.834 → 83. Every score on screen reads as a whole percent. */
export function pct(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 100);
}

export function MatchScore({ value }: { value: number }) {
  return (
    <span className="match" aria-label={`${pct(value)}% taste match`}>
      <b>{pct(value)}%</b>
      <small>match</small>
    </span>
  );
}

/**
 * Drops a sentence Qloo cut off ("…versatile indoor/outdoor space..."), then
 * keeps whole sentences up to `max` characters. A first sentence longer than
 * that is cut at a word with an ellipsis, so text never stops mid-word.
 */
export function tidyBlurb(text: string | undefined, max = Infinity): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  // A sentence ends at . ! ? or … followed by a space and a capital (or the end),
  // so "4.5 stars" and "swandiveatx.com" stay whole.
  const sentences = clean.split(/(?<=[.!?…])\s+(?=[A-Z"“(])/).map((part) => part.trim()).filter(Boolean);
  const whole = sentences.filter((part, index) => !(index > 0 && /(\.\.\.|…)$/.test(part)));
  let out = "";
  for (const sentence of whole) {
    const next = out ? `${out} ${sentence}` : sentence;
    if (next.length > max) break;
    out = next;
  }
  if (out) return out;
  const first = whole[0] ?? clean;
  if (first.length <= max) return first;
  return `${first.slice(0, max).replace(/\s+\S*$/, "")}…`;
}

export type TasteTag = { id: string; name: string; share: number };

/**
 * One row of "because you like" tags. It shows as many whole tags as fit the
 * row's width and folds the rest into "+N", so a long name never gets clipped.
 */
export function TagRow({ tags }: { tags: TasteTag[] }) {
  const row = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(tags.length);

  useLayoutEffect(() => {
    const host = row.current;
    const probe = measure.current;
    if (!host || !probe) return;
    const sync = () => {
      const width = host.clientWidth;
      const items = Array.from(probe.children) as HTMLElement[];
      const chips = items.slice(0, tags.length).map((el) => el.offsetWidth);
      const more = items[tags.length]?.offsetWidth ?? 40;
      const gap = 6;
      let used = 0;
      let count = 0;
      for (let i = 0; i < chips.length; i += 1) {
        const rest = chips.length - (i + 1);
        const need = used + (i ? gap : 0) + chips[i] + (rest > 0 ? gap + more : 0);
        if (need > width) break;
        used += (i ? gap : 0) + chips[i];
        count += 1;
      }
      // Always show at least one tag; it truncates inside if the row is tiny.
      setFit(Math.max(1, count));
    };
    sync();
    // The probe resizes when web fonts swap in, the row when the sheet does.
    const observer = new ResizeObserver(sync);
    observer.observe(host);
    observer.observe(probe);
    void document.fonts?.ready.then(sync);
    return () => observer.disconnect();
  }, [tags]);

  if (tags.length === 0) return null;
  const shown = tags.slice(0, fit);
  const extra = tags.length - shown.length;
  return (
    <div ref={row} className="tag-row" style={{ position: "relative" }}>
      <div ref={measure} className="measure" aria-hidden="true">
        {tags.map((tag) => (
          <Tag key={tag.id} tag={tag} />
        ))}
        <span className="chip more">+{tags.length}</span>
      </div>
      {shown.map((tag) => (
        <Tag key={tag.id} tag={tag} />
      ))}
      {extra > 0 ? <span className="chip more">+{extra}</span> : null}
    </div>
  );
}

function Tag({ tag }: { tag: TasteTag }) {
  return (
    <span className="chip taste" title={`Because you like ${tag.name} (${pct(tag.share)}% of the match)`}>
      <span className="dot" style={{ background: "#7a4fd6" }} />
      <span className="name">{tag.name}</span>
    </span>
  );
}
