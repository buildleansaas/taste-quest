"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { DeviceChrome } from "@/components/chrome/device-chrome";
import { DEMO_START } from "@/lib/taste/curated";
import { useQuest } from "@/store/use-quest";
import type { BudgetMode, Pace, ShapeMode } from "@/lib/types";

const Picker = dynamic(() => import("@/components/start/map-picker").then((mod) => mod.MapPicker), { ssr: false });

const CARDS: { mode: BudgetMode; title: string; hint: string; icon: "clock" | "moon" | "sun" }[] = [
  { mode: "1h", title: "1 hr", hint: "2–3 stops", icon: "clock" },
  { mode: "2h", title: "2 hrs", hint: "2–4 stops", icon: "clock" },
  { mode: "tonight", title: "Tonight", hint: "Until midnight", icon: "moon" },
  { mode: "allday", title: "All day", hint: "6–8 stops", icon: "sun" },
];

export function StartScreen() {
  const router = useRouter();
  const hydrate = useQuest((s) => s.hydrate);
  const hydrated = useQuest((s) => s.hydrated);
  const profile = useQuest((s) => s.profile);
  const setBudget = useQuest((s) => s.setBudget);
  const setStart = useQuest((s) => s.setStart);
  const setNeedsPlan = useQuest((s) => s.setNeedsPlan);
  const setWalk = useQuest((s) => s.setWalk);
  const [mode, setMode] = useState<BudgetMode>("2h");
  const [pace, setPace] = useState<Pace>("easy");
  const [shape, setShape] = useState<ShapeMode>("loop");
  const [near, setNear] = useState(true);
  const [label, setLabel] = useState("Finding you…");
  const [lat, setLat] = useState<number | null>(null);
  const [lon, setLon] = useState<number | null>(null);
  const [accuracy, setAccuracy] = useState<number | undefined>();
  const [gps, setGps] = useState<"prompt" | "granted" | "denied">("prompt");
  const [picking, setPicking] = useState(false);
  const [tonightNote, setTonightNote] = useState<string | null>(null);
  const [contextLine, setContextLine] = useState<string | null>(null);
  const [source, setSource] = useState<"gps" | "pin" | "demo">("gps");

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!hydrated) return;
    if (!profile) router.replace("/onboarding");
  }, [hydrated, profile, router]);

  useEffect(() => {
    if (!near || source === "demo") return;
    if (!navigator.geolocation) {
      setGps("denied");
      setNear(false);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGps("granted");
        setLat(pos.coords.latitude);
        setLon(pos.coords.longitude);
        setAccuracy(pos.coords.accuracy);
        setSource("gps");
        setLabel(`${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)}`);
      },
      () => {
        setGps("denied");
        setNear(false);
        setLabel("Location is off");
      },
      { enableHighAccuracy: true, timeout: 8000 },
    );
  }, [near, source]);

  useEffect(() => {
    if (lat == null || lon == null) return;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const demo = source === "demo" ? "&demo=1" : "";
    void fetch(`/api/context?lat=${lat}&lon=${lon}&tz=${encodeURIComponent(tz)}${demo}`)
      .then((res) => res.json())
      .then((body: { localTime?: string; weather?: { tempF: number }; weatherLabel?: string }) => {
        if (!body.weather || !body.localTime) {
          setContextLine(null);
          return;
        }
        const parts = body.localTime.split(",");
        const when = parts.length >= 2 ? `${parts[0]},${parts[1]}` : body.localTime;
        setContextLine(`${when.trim()} · ${body.weather.tempF}°F ${body.weatherLabel ?? ""}`.trim());
      })
      .catch(() => setContextLine(null));
  }, [lat, lon, source]);

  function minutesFor(next: BudgetMode): number {
    const now = new Date();
    if (next === "1h") return 60;
    if (next === "2h") return 120;
    if (next === "allday") return 480;
    if (now.getHours() >= 23) {
      setTonightNote("It’s after 11. Tonight is clamped to 60 minutes.");
      return 60;
    }
    setTonightNote(null);
    const end = new Date(now);
    end.setHours(24, 0, 0, 0);
    return Math.max(90, Math.round((end.getTime() - now.getTime()) / 60000));
  }

  function useDemoStart() {
    setLat(DEMO_START.lat);
    setLon(DEMO_START.lon);
    setLabel(DEMO_START.label);
    setSource("demo");
    setPicking(false);
    setNear(true);
    setGps("granted");
    setAccuracy(12);
  }

  if (!hydrated) return <main className="screen" />;

  return (
    <main className="screen flow">
      <DeviceChrome />
      <header className="page-header">
        <button className="icon-btn ghost" type="button" aria-label="Back" onClick={() => router.push("/onboarding")}>
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
            <path d="M12.5 4l-6 6 6 6" fill="none" stroke="#28323c" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
        <div style={{ flex: 1, height: 4, borderRadius: 2, background: "var(--color-cream)" }}>
          <div style={{ width: "100%", height: "100%", borderRadius: 2, background: "var(--color-accent)" }} />
        </div>
        <span style={{ fontSize: 13, color: "var(--color-slate-dim)", fontWeight: 500 }}>2 of 2</span>
      </header>
      <div className="flow-body start-body">
        <div className="flow-lead">
        <h1 className="display" style={{ fontSize: 30, lineHeight: "36px", margin: 0 }}>
          How long do you have?
        </h1>
        <p style={{ marginTop: 8, color: "var(--color-slate)", fontSize: 15, lineHeight: "22px" }}>
          We’ll fit the walk to it and re-plan as you go.
        </p>
        <div className="shape-toggle" role="group" aria-label="Route shape">
          <button type="button" aria-pressed={shape === "loop"} onClick={() => setShape("loop")}>
            Loop
          </button>
          <button type="button" aria-pressed={shape === "one-way"} onClick={() => setShape("one-way")}>
            One-way
          </button>
        </div>
        </div>
        <div className="budget-grid">
          {CARDS.map((card) => {
            const on = mode === card.mode;
            return (
              <button
                key={card.mode}
                type="button"
                onClick={() => setMode(card.mode)}
                aria-pressed={on}
                style={{
                  textAlign: "left",
                  background: "#fff",
                  boxShadow: on ? "inset 0 0 0 2px var(--color-accent), var(--shadow-card)" : "inset 0 0 0 1px var(--color-hairline)",
                  borderRadius: "var(--radius-panel)",
                  padding: 16,
                  height: 104,
                  border: 0,
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  position: "relative",
                }}
              >
                <span style={{ color: on ? "var(--color-accent-deep)" : "var(--color-slate-soft)" }}>{icon(card.icon)}</span>
                <span>
                  <span className="display" style={{ display: "block", fontSize: 20, lineHeight: "24px", fontWeight: on ? 600 : 500 }}>
                    {card.title}
                  </span>
                  <span style={{ fontSize: 12, color: "var(--color-slate-dim)" }}>{card.hint}</span>
                </span>
                {on ? (
                  <span style={{ position: "absolute", top: 14, right: 14, width: 20, height: 20, borderRadius: "50%", background: "var(--color-accent)", color: "#fff", display: "grid", placeItems: "center" }}>
                    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                      <path d="M2.5 6.2l2.3 2.3 4.7-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                    </svg>
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        {tonightNote && mode === "tonight" ? <p className="banner">{tonightNote}</p> : null}
        <div>
        <div className="eyebrow" style={{ marginTop: 28, marginBottom: 10 }}>
          Start from
        </div>
        <div className="card" style={{ borderRadius: "var(--radius-panel)", overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px" }}>
            <span style={{ width: 36, height: 36, borderRadius: "50%", background: "#8c8cc81f", display: "grid", placeItems: "center" }}>
              <span style={{ width: 12, height: 12, borderRadius: "50%", background: "var(--color-accent-deep)", border: "2.5px solid #fff", boxShadow: "0 0 0 5px #8c8cc84d" }} />
            </span>
            <span style={{ flex: 1 }}>
              <span style={{ display: "block", fontWeight: 600, fontSize: 15 }}>Near me</span>
              <span style={{ fontSize: 13, color: "var(--color-slate-dim)" }}>
                {gps === "denied" ? "Location is off" : source === "gps" && lat != null ? "Using your location" : source === "demo" ? DEMO_START.label : "Finding you…"}
                {accuracy && accuracy > 150 ? " · Location is fuzzy" : ""}
              </span>
            </span>
            <button
              type="button"
              aria-pressed={near}
              aria-label="Near me"
              onClick={() => {
                if (gps === "denied") return;
                setNear((value) => !value);
              }}
              style={{
                width: 44,
                height: 26,
                borderRadius: 13,
                border: 0,
                background: near ? "var(--color-accent)" : "var(--color-cream)",
                position: "relative",
              }}
            >
              <span style={{ position: "absolute", top: 3, left: near ? 21 : 3, width: 20, height: 20, borderRadius: "50%", background: "#fff", boxShadow: "var(--shadow-control-sm)" }} />
            </button>
          </div>
          <div className="hair" style={{ marginLeft: 64 }} />
          <button
            type="button"
            onClick={() => setPicking(true)}
            style={{ display: "flex", width: "100%", alignItems: "center", gap: 12, padding: "14px 16px", background: "transparent", border: 0, color: "var(--color-slate)", textAlign: "left" }}
          >
            <span style={{ width: 36, height: 36, borderRadius: "50%", background: "var(--color-surface-alt)", display: "grid", placeItems: "center" }}>
              <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true">
                <path d="M10 18s6-5.3 6-10a6 6 0 1 0-12 0c0 4.7 6 10 6 10z" fill="none" stroke="#78828c" strokeWidth="1.6" />
                <circle cx="10" cy="8" r="2" fill="#78828c" />
              </svg>
            </span>
            <span style={{ flex: 1 }}>
              <span style={{ display: "block", fontSize: 15, fontWeight: source === "pin" ? 600 : 400, color: source === "pin" ? "var(--color-ink)" : undefined }}>
                {source === "pin" ? "Starting at your pin" : "Pick a spot on the map"}
              </span>
              <span style={{ display: "block", fontSize: 13, color: "var(--color-slate-dim)" }}>
                {source === "pin" && lat != null && lon != null ? `${pinPlace(lat, lon)} · tap to move it` : "Tap the map to choose a start"}
              </span>
            </span>
            <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true">
              <path d="M7.5 4l6 6-6 6" fill="none" stroke="#a0aab4" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
          {(gps === "denied" || lat == null) && source !== "demo" ? (
            <>
              <div className="hair" style={{ marginLeft: 64 }} />
              <button
                type="button"
                onClick={useDemoStart}
                style={{ display: "flex", width: "100%", alignItems: "center", gap: 12, padding: "14px 16px", background: "transparent", border: 0, textAlign: "left" }}
              >
                <span style={{ width: 36, height: 36, borderRadius: "50%", background: "var(--cat-artists-wash)", display: "grid", placeItems: "center", color: "var(--cat-artists)", fontSize: 13, fontWeight: 700, fontFamily: "var(--font-display)" }}>
                  ATX
                </span>
                <span style={{ flex: 1 }}>
                  <span style={{ display: "block", fontSize: 15 }}>Start in downtown Austin</span>
                  <span style={{ fontSize: 13, color: "var(--color-slate-dim)" }}>{DEMO_START.label}</span>
                </span>
              </button>
            </>
          ) : null}
        </div>
        <div className="eyebrow" style={{ marginTop: 24, marginBottom: 10 }}>
          Pace
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {(
            [
              ["easy", "Easy stroll"],
              ["brisk", "Brisk"],
              ["stepfree", "Step-free"],
            ] as const
          ).map(([value, text]) => (
            <button
              key={value}
              type="button"
              className="chip"
              aria-pressed={pace === value}
              style={pace === value ? { background: "var(--color-ink)", color: "#fff", boxShadow: "none" } : undefined}
              onClick={() => setPace(value)}
            >
              {text}
            </button>
          ))}
        </div>
        {pace === "stepfree" ? (
          <p style={{ marginTop: 8, fontSize: 12, color: "var(--color-slate-dim)" }}>Step-free routes may include steps on this version.</p>
        ) : null}
        </div>
      </div>
      <div className="flow-dock">
        {lat == null || lon == null ? (
          <p style={{ margin: "0 0 10px", textAlign: "center", fontSize: 13, color: "var(--color-slate-dim)" }}>
            {gps === "prompt" ? "Finding you…" : "Pick a start to build your route."}
          </p>
        ) : null}
        {contextLine ? (
          <div style={{ display: "flex", justifyContent: "center", gap: 6, fontSize: 12, color: "var(--color-slate-dim)", marginBottom: 12 }}>
            {contextLine}
          </div>
        ) : null}
        <button
          className="btn btn-primary btn-block"
          type="button"
          disabled={lat == null || lon == null}
          onClick={() => {
            if (lat == null || lon == null) return;
            const minutes = minutesFor(mode);
            setBudget({ minutes, mode, pace, shape });
            setStart({ lat, lon, label, source, accuracyM: accuracy });
            // A new start replaces the old walk, so its line and pins never show over the new plan.
            setWalk(null);
            setNeedsPlan(true);
            router.push("/explore");
          }}
        >
          Build my route
        </button>
      </div>
      {picking ? (
        <Picker
          lat={lat ?? DEMO_START.lat}
          lon={lon ?? DEMO_START.lon}
          onClose={() => setPicking(false)}
          onConfirm={(nextLat, nextLon) => {
            setLat(nextLat);
            setLon(nextLon);
            setLabel(`${nextLat.toFixed(4)}, ${nextLon.toFixed(4)}`);
            setSource("pin");
            setNear(false);
            setPicking(false);
          }}
          onDemo={useDemoStart}
        />
      ) : null}
    </main>
  );
}

/** A dropped pin reads as a place, not as coordinates. */
function pinPlace(lat: number, lon: number): string {
  const km = Math.hypot((lat - DEMO_START.lat) * 111, (lon - DEMO_START.lon) * 96);
  return km < 2.5 ? "Downtown Austin" : `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
}

function icon(kind: "clock" | "moon" | "sun") {
  if (kind === "moon") {
    return (
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M16 12.5A6.5 6.5 0 0 1 7.5 4a6.5 6.5 0 1 0 8.5 8.5z" fill="none" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    );
  }
  if (kind === "sun") {
    return (
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M4.3 15.7l1.4-1.4M14.3 5.7l1.4-1.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M10 6v4l2.5 2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
