"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CURATED, VIBE_SEEDS, type CuratedChip, type CuratedEntity } from "@/lib/taste/curated";
import { DeviceChrome } from "@/components/chrome/device-chrome";
import { useQuest } from "@/store/use-quest";
import type { TasteEntity, TasteTag } from "@/lib/types";

type Hit = { id: string; name: string; type: string; subtitle?: string };

const SECTIONS: { key: CuratedChip["section"]; label: string; color: string; wash: string; text: string }[] = [
  { key: "artists", label: "Artists", color: "#7a4fd6", wash: "var(--cat-artists-wash)", text: "var(--cat-artists)" },
  { key: "film", label: "Films & TV", color: "#e38b1f", wash: "var(--cat-film-wash)", text: "var(--cat-film)" },
  { key: "cuisine", label: "Cuisines", color: "#b8853a", wash: "var(--cat-cuisine-wash)", text: "var(--cat-cuisine)" },
  { key: "vibes", label: "Vibes", color: "#c08095", wash: "var(--cat-vibes-wash)", text: "var(--cat-vibes)" },
];

function entityFromChip(chip: CuratedEntity): TasteEntity {
  return { id: chip.id, name: chip.name, type: chip.type, subtitle: chip.subtitle };
}

export function OnboardingScreen() {
  const router = useRouter();
  const hydrate = useQuest((s) => s.hydrate);
  const hydrated = useQuest((s) => s.hydrated);
  const saved = useQuest((s) => s.profile);
  const deviceId = useQuest((s) => s.deviceId);
  const setProfile = useQuest((s) => s.setProfile);
  const [entities, setEntities] = useState<TasteEntity[]>([]);
  const [tags, setTags] = useState<TasteTag[]>([]);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [searching, setSearching] = useState(false);
  const [busySearch, setBusySearch] = useState(false);
  const [noMatch, setNoMatch] = useState(false);
  const [online, setOnline] = useState(true);
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (saved) {
      setEntities(saved.entities);
      setTags(saved.tags);
    }
  }, [saved]);

  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  useEffect(() => {
    if (query.trim().length < 2 || !online) {
      setHits([]);
      setSearching(false);
      setNoMatch(false);
      return;
    }
    const handle = window.setTimeout(() => {
      setSearching(true);
      setBusySearch(false);
      void fetch(`/api/taste/search?q=${encodeURIComponent(query.trim())}`, {
        headers: { "x-device-id": deviceId },
      })
        .then((res) => res.json())
        .then((body: { results?: Hit[]; busy?: boolean }) => {
          const results = body.results ?? [];
          setHits(results);
          setBusySearch(Boolean(body.busy));
          setNoMatch(results.length === 0 && !body.busy);
        })
        .catch(() => {
          setHits([]);
          setBusySearch(true);
        })
        .finally(() => setSearching(false));
    }, 250);
    return () => window.clearTimeout(handle);
  }, [query, online, deviceId]);

  const seeds = useMemo(() => {
    if (entities.length >= 2) return [] as TasteEntity[];
    const extra: TasteEntity[] = [];
    for (const tag of tags) {
      const name = VIBE_SEEDS[tag.name];
      const chip = CURATED.find((item) => item.kind === "entity" && item.name === name);
      if (!chip || chip.kind !== "entity") continue;
      if (entities.some((entity) => entity.id === chip.id) || extra.some((entity) => entity.id === chip.id)) continue;
      extra.push(entityFromChip(chip));
      if (entities.length + extra.length >= 2) break;
    }
    return extra;
  }, [entities, tags]);

  if (!hydrated) return <main className="screen" />;

  const curatedIds = new Set(CURATED.map((chip) => chip.id));
  const searched = entities.filter((entity) => !curatedIds.has(entity.id));
  const picked = entities.length + tags.length;
  const ready = entities.length + seeds.length >= 2 && picked + seeds.length >= 3;

  function toggleChip(chip: CuratedChip) {
    if (chip.kind === "entity") {
      setEntities((current) =>
        current.some((entity) => entity.id === chip.id)
          ? current.filter((entity) => entity.id !== chip.id)
          : [...current, entityFromChip(chip)],
      );
      return;
    }
    setTags((current) =>
      current.some((tag) => tag.id === chip.id)
        ? current.filter((tag) => tag.id !== chip.id)
        : [...current, { id: chip.id, name: chip.name, cat: chip.cat }],
    );
  }

  async function addAsVibe() {
    const res = await fetch(`/api/taste/tags?q=${encodeURIComponent(query.trim())}`, {
      headers: { "x-device-id": deviceId },
    });
    const body = (await res.json()) as { results?: { id: string; name: string; type: string }[] };
    const tag = body.results?.[0];
    if (!tag) return;
    const cat = /cuisine|dish|coffee|wine|taco|ramen|bbq/i.test(`${tag.type} ${tag.name}`) ? "cuisine" : "vibe";
    setTags((current) =>
      current.some((item) => item.id === tag.id) ? current : [...current, { id: tag.id, name: tag.name, cat }],
    );
    setQuery("");
    setNoMatch(false);
  }

  function continueNext() {
    const merged = [...entities];
    for (const seed of seeds) {
      if (!merged.some((entity) => entity.id === seed.id)) merged.push(seed);
    }
    setSeeded(seeds.length > 0);
    setProfile({ entities: merged, tags, updatedAt: new Date().toISOString() });
    router.push("/start");
  }

  const sectionCount = (key: CuratedChip["section"]) =>
    CURATED.filter((chip) => chip.section === key).filter((chip) =>
      chip.kind === "entity" ? entities.some((entity) => entity.id === chip.id) : tags.some((tag) => tag.id === chip.id),
    ).length;

  return (
    <main className="screen flow">
      <DeviceChrome />
      <header className="page-header">
        <button className="icon-btn ghost" type="button" aria-label="Back" onClick={() => router.push("/")}>
          <Chevron />
        </button>
        <div style={{ flex: 1, height: 4, borderRadius: 2, background: "var(--color-cream)" }}>
          <div style={{ width: "50%", height: "100%", borderRadius: 2, background: "var(--color-accent)" }} />
        </div>
        <span style={{ fontSize: 13, color: "var(--color-slate-dim)", fontWeight: 500 }}>1 of 2</span>
      </header>
      <div className="flow-body onboard-body">
        <div className="flow-lead">
        <h1 className="display" style={{ fontSize: 30, lineHeight: "36px", margin: 0 }}>
          What do you love?
        </h1>
        <p style={{ marginTop: 8, color: "var(--color-slate)", fontSize: 15, lineHeight: "22px" }}>
          Pick a few. Qloo connects them to places you’ve never heard of.
        </p>
        <div style={{ marginTop: 20, position: "relative" }}>
          <label className="field" style={{ opacity: online ? 1 : 0.55 }}>
            <SearchIcon />
            <input
              value={query}
              disabled={!online}
              placeholder={online ? "Search artists, films, places" : "Search needs a connection"}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search tastes"
            />
          </label>
          {searching ? (
            <div className="card" style={{ marginTop: 8, borderRadius: "var(--radius-panel)", padding: 12 }}>
              <div className="skel" />
              <div className="skel" style={{ marginTop: 8, width: "70%" }} />
            </div>
          ) : null}
          {hits.length > 0 ? (
            <div className="card" style={{ marginTop: 8, borderRadius: "var(--radius-panel)", padding: 6, boxShadow: "var(--shadow-pop)" }}>
              {hits.map((hit, index) => (
                <button
                  key={hit.id}
                  type="button"
                  onClick={() => {
                    const type = hit.type.includes("movie")
                      ? "movie"
                      : hit.type.includes("tv")
                        ? "tv_show"
                        : hit.type.includes("place")
                          ? "place"
                          : "artist";
                    setEntities((current) =>
                      current.some((entity) => entity.id === hit.id)
                        ? current
                        : [...current, { id: hit.id, name: hit.name, type, subtitle: hit.subtitle }],
                    );
                    setQuery("");
                    setHits([]);
                  }}
                  style={{
                    display: "flex",
                    width: "100%",
                    textAlign: "left",
                    alignItems: "center",
                    gap: 12,
                    padding: "8px 10px",
                    borderRadius: 10,
                    border: 0,
                    background: index === 0 ? "var(--color-surface-alt)" : "transparent",
                  }}
                >
                  <span
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: "50%",
                      background: "linear-gradient(135deg,#b4aadc,#774ab5)",
                      color: "#fff",
                      display: "grid",
                      placeItems: "center",
                      fontFamily: "var(--font-display)",
                      fontWeight: 600,
                    }}
                  >
                    {initials(hit.name)}
                  </span>
                  <span style={{ flex: 1 }}>
                    <span style={{ display: "block", fontWeight: 600, fontSize: 14 }}>{hit.name}</span>
                    <span style={{ fontSize: 12, color: "var(--color-slate-dim)" }}>{hit.subtitle}</span>
                  </span>
                  {index === 0 ? (
                    <span className="mono" style={{ color: "var(--cat-artists)", letterSpacing: "0.08em" }}>
                      Qloo matched
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
          {busySearch ? <p style={{ marginTop: 8, color: "var(--color-slate-dim)", fontSize: 13 }}>Search is busy, tap a suggestion.</p> : null}
          {noMatch ? (
            <button type="button" onClick={() => void addAsVibe()} style={{ marginTop: 8, background: "none", border: 0, color: "var(--color-plum)", padding: 0 }}>
              No exact match. Add as a vibe?
            </button>
          ) : null}
        </div>

        {searched.length > 0 ? (
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 12, color: "var(--color-slate-dim)", marginBottom: 8 }}>Your picks</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {searched.map((entity) => (
                <button
                  key={entity.id}
                  type="button"
                  className="chip on"
                  aria-label={`Remove ${entity.name}`}
                  style={{ background: "var(--cat-artists-wash)", color: "var(--cat-artists)" }}
                  onClick={() => setEntities((current) => current.filter((item) => item.id !== entity.id))}
                >
                  <Check />
                  {entity.name}
                  <span aria-hidden="true" style={{ marginLeft: 2, opacity: 0.6 }}>×</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {seeds.length > 0 ? (
          <p className="banner" style={{ margin: "16px 0 0" }}>
            Why this fits you will lean on your vibes. We’ll add {seeds.map((seed) => seed.name).join(" and ")} so the match can split.
          </p>
        ) : null}
        {seeded ? null : null}
        </div>
        <div>
        {SECTIONS.map((section) => (
          <section key={section.key} style={{ marginTop: 22 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600, fontSize: 14 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: section.color }} />
                {section.label}
              </div>
              <span style={{ fontSize: 12, color: "var(--color-slate-dim)" }}>{sectionCount(section.key)} picked</span>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {CURATED.filter((chip) => chip.section === section.key).map((chip) => {
                const on =
                  chip.kind === "entity"
                    ? entities.some((entity) => entity.id === chip.id)
                    : tags.some((tag) => tag.id === chip.id);
                return (
                  <button
                    key={chip.id}
                    type="button"
                    className={on ? "chip on" : "chip"}
                    style={on ? { background: section.wash, color: section.text } : { color: "var(--color-slate)" }}
                    onClick={() => toggleChip(chip)}
                    aria-pressed={on}
                  >
                    {on ? <Check /> : <Plus />}
                    {chip.name}
                  </button>
                );
              })}
            </div>
          </section>
        ))}
        </div>
      </div>
      <div className="flow-dock roomy">
        {!ready && picked > 0 ? (
          <p style={{ margin: "0 0 10px", textAlign: "center", fontSize: 13, color: "var(--color-slate-dim)" }}>
            {entities.length + seeds.length < 2
              ? `Add ${2 - entities.length - seeds.length === 1 ? "one more artist or film" : "two artists or films"} so Qloo can match your taste.`
              : "Pick one more to continue."}
          </p>
        ) : null}
        <button className="btn btn-primary btn-block" type="button" disabled={!ready} onClick={continueNext}>
          Continue · {picked + (entities.length >= 2 ? 0 : seeds.length)} picked
        </button>
      </div>
    </main>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function Chevron() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M12.5 4l-6 6 6 6" fill="none" stroke="#28323c" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function SearchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="9" cy="9" r="6" fill="none" stroke="#78828c" strokeWidth="1.8" />
      <path d="M13.5 13.5L17 17" stroke="#78828c" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
function Check() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M2.5 6.2l2.3 2.3 4.7-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function Plus() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true" style={{ color: "var(--color-slate-soft)" }}>
      <path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
