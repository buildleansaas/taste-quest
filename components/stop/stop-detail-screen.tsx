"use client";

import dynamic from "next/dynamic";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { DeviceChrome } from "@/components/chrome/device-chrome";
import { STOP_FRAME, STOP_PAD, STOP_ZOOM_OUT } from "@/lib/map/austin-geometry";
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

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const version = walk?.versions[walk.versions.length - 1];
  const stop = version?.stops.find((item) => item.entityId === entityId);
  const single = (profile?.entities.length ?? 0) < 2;

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
        const versions = walk.versions.map((item, index) =>
          index === walk.versions.length - 1
            ? {
                ...item,
                stops: item.stops.map((row) => (row.entityId === stop.entityId ? { ...row, blurb: body.blurb } : row)),
              }
            : item,
        );
        setWalk({ ...walk, versions });
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
  const shares = stop.evidence.entityShares.slice(0, 3);
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
    <main className="screen" style={{ minHeight: "100dvh", background: "var(--color-surface-raised)", overflow: "hidden" }}>
      <DeviceChrome />
      <div style={{ height: 290, position: "relative" }}>
        <TasteMap
          className="map-stage"
          center={swan ? [-97.7364559, 30.2655328] : [stop.lon, stop.lat]}
          zoom={swan ? 16.4 : 16.2}
          pitch={40}
          bearing={-18}
          frame={swan ? STOP_FRAME : undefined}
          pad={swan ? STOP_PAD : undefined}
          zoomOut={swan ? STOP_ZOOM_OUT : 0.1}
          routes={[{ coords: version.route.geometry.coordinates, dashed: version.route.approximate }]}
          pins={pins}
        />
        <div style={{ position: "absolute", top: 58, left: 16, right: 16, display: "flex", justifyContent: "space-between", zIndex: 5 }}>
          <button className="icon-btn" type="button" aria-label="Back" onClick={() => router.push("/explore")}>
            <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
              <path d="M12.5 4l-6 6 6 6" fill="none" stroke="#28323c" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
          <a className="icon-btn" href={maps} target="_blank" rel="noreferrer" aria-label="Open in Google Maps">
            <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
              <path d="M10 16.5s-6-3.7-6-8.2A3.3 3.3 0 0 1 10 6.3a3.3 3.3 0 0 1 6 2c0 4.5-6 8.2-6 8.2z" fill="none" stroke="#28323c" strokeWidth="1.6" />
            </svg>
          </a>
        </div>
      </div>
      <section className="sheet" style={{ top: 250, bottom: 0 }}>
        <div className="grabber" />
        <div style={{ padding: "14px 22px 120px" }}>
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
              ) : (
                <>
                  <b style={{ color: "var(--color-open)" }}>Open</b>
                  {` till ${closesLabel(stop) || "late"}`}
                </>
              )}
            </span>
            <span>{stop.walkMin} min walk</span>
            <span>{stop.evidence.tagOverlap.slice(0, 2).map((tag) => tag.name).join(" · ") || stop.categoryLabel}</span>
          </div>
          <div className="hair" style={{ margin: "16px 0" }} />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div className="eyebrow" style={{ color: "var(--color-plum-soft)" }}>
              Why this fits you
            </div>
            <span className="mono" style={{ fontSize: 9, letterSpacing: "0.08em" }}>
              {single ? "Matched on your vibes" : "Qloo explainability"}
            </span>
          </div>
          <p className="display" style={{ marginTop: 8, fontSize: 17, lineHeight: "25px", color: "var(--color-plum)", fontWeight: 400, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
            {stop.blurb}
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
              <div style={{ marginTop: 10, fontSize: 12, color: "var(--color-slate-dim)" }}>Because you like</div>
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
                        <div style={{ height: "100%", width: `${Math.min(100, share.share * 360)}%`, borderRadius: 2, background: colors.bar }} />
                      </div>
                    </div>
                    <div style={{ width: 34, textAlign: "right", fontSize: 13, fontWeight: 600, color: colors.text }}>{Math.round(share.share * 100)}%</div>
                  </div>
                );
              })}
            </>
          )}
        </div>
        <div style={{ position: "absolute", left: 22, right: 22, bottom: 42, display: "flex", gap: 10 }}>
          <button
            className="btn btn-cream"
            type="button"
            style={{ flex: 1, boxShadow: stop.closedNow ? "inset 0 0 0 2px var(--color-accent)" : undefined }}
            onClick={() => router.push("/explore")}
          >
            Skip
          </button>
          <a className="btn btn-primary" style={{ flex: 2 }} href={maps} target="_blank" rel="noreferrer">
            Go · {stop.walkMin} min
          </a>
        </div>
      </section>
    </main>
  );
}

function shortName(name: string): string {
  return name.split(" ")[0] ?? name;
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

function MatchRing({ value }: { value: number }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div style={{ width: 64, height: 64, borderRadius: "50%", background: `conic-gradient(var(--color-accent) 0 ${pct}%, var(--color-cream) ${pct}% 100%)`, display: "grid", placeItems: "center", flex: "none" }}>
      <div style={{ width: 52, height: 52, borderRadius: "50%", background: "var(--color-surface-raised)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <span className="display" style={{ fontSize: 17, fontWeight: 600, lineHeight: "18px" }}>{value.toFixed(2)}</span>
        <span style={{ fontSize: 9, color: "var(--color-slate-dim)" }}>match</span>
      </div>
    </div>
  );
}
