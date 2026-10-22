"use client";

import dynamic from "next/dynamic";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { DeviceChrome } from "@/components/chrome/device-chrome";
import { useMinWidth } from "@/components/chrome/use-wide";
import { STOP_FRAME, STOP_PAD, STOP_ZOOM_OUT } from "@/lib/map/austin-geometry";
import { nextStop } from "@/lib/walk/progress";
import { tidyBlurb } from "@/components/ui/taste";
import { useQuest } from "@/store/use-quest";

const TasteMap = dynamic(() => import("@/components/map/taste-map").then((mod) => mod.TasteMap), { ssr: false });

const CAT: Record<string, { wash: string; text: string; bar: string }> = {
  artist: { wash: "var(--cat-artists-wash)", text: "var(--cat-artists)", bar: "#7a4fd6" },
  movie: { wash: "var(--cat-film-wash)", text: "var(--cat-film)", bar: "#e38b1f" },
  tv_show: { wash: "var(--cat-film-wash)", text: "var(--cat-film)", bar: "#e38b1f" },
  place: { wash: "var(--cat-places-wash)", text: "var(--cat-places)", bar: "#486a75" },
};

export function StopDetailScreen({ entityId }: { entityId: string }) {
  const router = useRouter();
  const hydrate = useQuest((s) => s.hydrate);
  const hydrated = useQuest((s) => s.hydrated);
  const walk = useQuest((s) => s.walk);
  const profile = useQuest((s) => s.profile);
  const setWalk = useQuest((s) => s.setWalk);
  const deviceId = useQuest((s) => s.deviceId);
  const wide = useMinWidth(1024);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const version = walk?.versions[walk.versions.length - 1];
  const stop = version?.stops.find((item) => item.entityId === entityId);
  const single = (profile?.entities.length ?? 0) < 2;
  const isNext = Boolean(walk && stop && nextStop(walk)?.entityId === stop.entityId && walk.status !== "done");

  useEffect(() => {
    if (!stop || stop.blurb || !profile || !walk) return;
    void fetch("/api/blurb", {
      method: "POST",
      headers: { "content-type": "application/json", "x-device-id": deviceId },
      body: JSON.stringify({
        profile,
        stop: { entityId: stop.entityId, name: stop.name, evidence: stop.evidence },
      }),
    })
      .then((res) => res.json())
      .then((body: { blurb?: string }) => {
        if (!body.blurb) return;
        // Write into the walk as it is now, not the one captured when the fetch
        // started: Skip or I'm here may have changed it while the blurb loaded.
        const current = useQuest.getState().walk;
        if (!current || current.id !== walk.id) return;
        const versions = current.versions.map((item, index) =>
          index === current.versions.length - 1
            ? {
                ...item,
                stops: item.stops.map((row) => (row.entityId === stop.entityId ? { ...row, blurb: body.blurb } : row)),
              }
            : item,
        );
        setWalk({ ...current, versions });
      })
      .catch(() => undefined);
  }, [stop, profile, walk, deviceId, setWalk]);

  if (!hydrated) return <main className="screen" />;
  if (!stop || !version) {
    return (
      <main className="screen" style={{ padding: 24 }}>
        <button className="btn btn-cream" type="button" onClick={() => router.push("/explore")}>
          Back to the map
        </button>
      </main>
    );
  }

  const maps = `https://www.google.com/maps/dir/?api=1&destination=${stop.lat},${stop.lon}`;
  const shares = [...stop.evidence.entityShares].sort((a, b) => b.share - a.share).slice(0, 3);
  const topShare = shares[0]?.share || 1;
  const blurb = tidyBlurb(stop.blurb);
  const week = weekHours(stop);
  const tags = stop.evidence.tagOverlap.slice(0, 6);
  const swan = stop.entityId === "sample-place-swan-dive";
  const pins = swan
    ? version.stops
        .filter((item) => item.seq > 1 && item.state !== "skipped" && item.state !== "visited")
        .map((item) => ({
          n: item.seq,
          ll: [item.lon, item.lat] as [number, number],
          cls: item.entityId === stop.entityId ? "next" : "",
          label: item.entityId === stop.entityId ? item.name : undefined,
          color: item.category === "live_music" ? "#7a4fd6" : "#c08095",
        }))
    : [{ n: stop.seq, ll: [stop.lon, stop.lat] as [number, number], cls: "next", label: shortName(stop.name), color: "#8c8cc8" }];

  return (
    <main className="screen stop">
      <DeviceChrome />
      <div className="stop-map">
        <TasteMap
          className="map-fill"
          center={swan ? [-97.7364559, 30.2655328] : [stop.lon, stop.lat]}
          zoom={swan ? 16.4 : 16.2}
          pitch={40}
          bearing={-18}
          frame={swan ? (wide ? version.route.geometry.coordinates : STOP_FRAME) : undefined}
          pad={swan ? (wide ? { top: 88, bottom: 72, left: 72, right: 72 } : STOP_PAD) : undefined}
          zoomOut={swan ? (wide ? 0.2 : STOP_ZOOM_OUT) : 0.1}
          fitPitch={wide && swan}
          maxZoom={wide ? 15.6 : undefined}
          routes={[{ coords: version.route.geometry.coordinates, dashed: version.route.approximate }]}
          pins={pins}
        />
        <div className="stop-map-controls">
          <button className="icon-btn" type="button" aria-label="Back" onClick={() => router.push("/explore")}>
            <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
              <path d="M12.5 4l-6 6 6 6" fill="none" stroke="#28323c" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>
      <section className="sheet stop-sheet">
        <div className="grabber" />
        <div className="stop-sheet-body">
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
            <div>
              <div className="eyebrow">
                Stop {stop.seq}
                {stop.neighborhood ? ` · ${stop.neighborhood}` : ""}
              </div>
              <h1 className="display" style={{ fontSize: 30, lineHeight: "36px", margin: "6px 0 0" }}>
                {stop.name}
              </h1>
              <div style={{ fontSize: 13, color: "var(--color-slate-dim)", marginTop: 2 }}>
                {stop.categoryLabel}
                {stop.address ? ` · ${stop.address.split(",")[0]}` : ""}
              </div>
            </div>
            <MatchRing value={stop.affinity} />
          </div>
          <div style={{ display: "flex", gap: 16, marginTop: 14, fontSize: 13, color: "var(--color-slate)", flexWrap: "wrap" }}>
            <span>
              {stop.closedNow ? (
                <b style={{ color: "var(--color-error)" }}>Closed now</b>
              ) : week.length === 0 ? (
                <span>Hours not listed</span>
              ) : (
                <>
                  <b style={{ color: "var(--color-open)" }}>Open</b>
                  {` till ${closesLabel(stop) || "late"}`}
                </>
              )}
            </span>
            <span>{stop.walkMin} min walk</span>
          </div>
          <div className="hair" style={{ margin: "16px 0" }} />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div className="eyebrow" style={{ color: "var(--color-plum)" }}>
              Why you’ll like it
            </div>
            <span style={{ fontSize: 11, color: "var(--color-slate-dim)" }}>
              {single ? "Matched on your vibes" : "From Qloo"}
            </span>
          </div>
          <p className="display" style={{ marginTop: 8, fontSize: 17, lineHeight: "25px", color: "var(--color-plum)", fontWeight: 400 }}>
            {blurb}
          </p>
          {single ? (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
              {stop.evidence.tagOverlap.map((tag) => (
                <span key={tag.id} className="chip" style={{ background: "var(--cat-vibes-wash)", color: "var(--cat-vibes)", boxShadow: "none" }}>
                  {tag.name}
                </span>
              ))}
            </div>
          ) : (
            <>
              <div style={{ marginTop: 10, fontSize: 12, color: "var(--color-slate-dim)" }}>Because you like · share of the match</div>
              {shares.map((share) => {
                const kind = profile?.entities.find((entity) => entity.id === share.entityId)?.type ?? "artist";
                const colors = CAT[kind] ?? CAT.artist;
                return (
                  <div key={share.entityId} style={{ display: "flex", alignItems: "center", gap: 12, height: 48 }}>
                    <div style={{ width: 32, height: 32, borderRadius: "50%", background: colors.wash, color: colors.text, display: "grid", placeItems: "center", fontWeight: 600, fontSize: 12, fontFamily: "var(--font-display)", flex: "none" }}>
                      {mark(share.name)}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{share.name}</div>
                      <div style={{ fontSize: 12, lineHeight: "16px", color: "var(--color-slate-dim)" }}>
                        {profile?.entities.find((entity) => entity.id === share.entityId)?.subtitle ?? kind.replace("_", " ")}
                      </div>
                    </div>
                    <div style={{ width: 56 }}>
                      <div style={{ height: 4, borderRadius: 2, background: "var(--color-cream)" }}>
                        <div style={{ height: "100%", width: `${Math.round((share.share / topShare) * 100)}%`, borderRadius: 2, background: colors.bar }} />
                      </div>
                    </div>
                    <div style={{ width: 34, textAlign: "right", fontSize: 13, fontWeight: 600, color: colors.text }}>{Math.round(share.share * 100)}%</div>
                  </div>
                );
              })}
            </>
          )}
          {!single && tags.length > 0 ? (
            <>
              <div className="hair" style={{ margin: "16px 0" }} />
              <div className="eyebrow" style={{ marginBottom: 10 }}>Known for</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {tags.map((tag) => (
                  <span key={tag.id} className="chip" style={{ height: 30, fontSize: 13, background: "var(--cat-vibes-wash)", color: "var(--cat-vibes)", boxShadow: "none" }}>
                    {tag.name}
                  </span>
                ))}
              </div>
            </>
          ) : null}
          <div className="hair" style={{ margin: "16px 0" }} />
          <div className="eyebrow" style={{ marginBottom: 8 }}>Hours</div>
          {week.length === 0 ? (
            <p style={{ margin: 0, fontSize: 13, color: "var(--color-slate)" }}>Qloo doesn’t list hours for this place. Check before you go.</p>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 16px", fontSize: 13 }}>
                {week.map((row) => (
                  <div key={row.day} style={{ display: "contents", fontWeight: row.today ? 600 : 400, color: row.today ? "var(--color-ink)" : "var(--color-slate)" }}>
                    <span>{row.day}</span>
                    <span>{row.text}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="stop-actions">
          {isNext ? (
            <>
              <button
                className="btn btn-cream"
                type="button"
                style={{ flex: 1, boxShadow: stop.closedNow ? "inset 0 0 0 2px var(--color-accent)" : undefined }}
                onClick={() => router.push(`/explore?do=skip&id=${encodeURIComponent(stop.entityId)}`)}
              >
                Skip
              </button>
              <button
                className="btn btn-cream"
                type="button"
                style={{ flex: 1 }}
                onClick={() => router.push(`/explore?do=arrive&id=${encodeURIComponent(stop.entityId)}`)}
              >
                I’m here
              </button>
            </>
          ) : (
            <button className="btn btn-cream" type="button" style={{ flex: 1 }} onClick={() => router.push("/explore")}>
              Back to walk
            </button>
          )}
          <a className="btn btn-primary" style={{ flex: 1.4 }} href={maps} target="_blank" rel="noreferrer">
            Go · {stop.walkMin} min
          </a>
        </div>
      </section>
    </main>
  );
}

function shortName(name: string): string {
  return name.replace(/^The\s+/i, "").split(" ")[0] ?? name;
}

function mark(name: string): string {
  const words = name.replace(/^the\s+/i, "").split(/\s+/).filter(Boolean);
  if (words.length < 2) return (words[0]?.[0] ?? "").toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function closesLabel(stop: { hours?: Record<string, { opens: string; closes: string }[]> }): string {
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const closes = stop.hours?.[days[new Date().getDay()]]?.[0]?.closes;
  const match = closes ? /(\d{2}):(\d{2})/.exec(closes) : null;
  if (!match) return "";
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const suffix = hour >= 12 ? "pm" : "am";
  hour = hour % 12 || 12;
  return minute ? `${hour}:${String(minute).padStart(2, "0")}${suffix}` : `${hour}${suffix}`;
}

function weekHours(stop: { hours?: Record<string, { opens: string; closes: string }[]> }) {
  if (!stop.hours || Object.keys(stop.hours).length === 0) return [];
  const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  const today = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][new Date().getDay()];
  return days.map((day) => {
    const spans = stop.hours?.[day] ?? [];
    const text = spans.length ? spans.map((span) => `${clock(span.opens)}–${clock(span.closes)}`).join(", ") : "Closed";
    return { day: day.slice(0, 1).toUpperCase() + day.slice(1, 3), text, today: day === today };
  });
}

function clock(value: string): string {
  const match = /(\d{2}):(\d{2})/.exec(value);
  if (!match) return value;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const suffix = hour >= 12 && hour < 24 ? "pm" : "am";
  hour = hour % 12 || 12;
  return minute ? `${hour}:${String(minute).padStart(2, "0")}${suffix}` : `${hour}${suffix}`;
}

function MatchRing({ value }: { value: number }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div style={{ width: 64, height: 64, borderRadius: "50%", background: `conic-gradient(var(--color-accent-deep) 0 ${pct}%, var(--color-cream) ${pct}% 100%)`, display: "grid", placeItems: "center", flex: "none" }}>
      <div style={{ width: 52, height: 52, borderRadius: "50%", background: "var(--color-surface-raised)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <span className="display" style={{ fontSize: 17, fontWeight: 600, lineHeight: "18px" }}>{pct}%</span>
        <span style={{ fontSize: 9, color: "var(--color-slate-dim)" }}>match</span>
      </div>
    </div>
  );
}
