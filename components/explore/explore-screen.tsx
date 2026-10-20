"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { DeviceChrome } from "@/components/chrome/device-chrome";
import { useMinWidth } from "@/components/chrome/use-wide";
import { TasteMap, type MapPin, type MapRoute } from "@/components/map/taste-map";
import { readUiStream } from "@/lib/client/stream";
import { formatMinutes } from "@/lib/format";
import { haversineM, shouldOfferRide } from "@/lib/engine/core";
import {
  EXPLORE_FRAME,
  EXPLORE_PAD,
  EXPLORE_ZOOM_OUT,
  REROUTE_FRAME,
  REROUTE_PAD,
  REROUTE_ZOOM_OUT,
} from "@/lib/map/austin-geometry";
import { DESIGN_POOL } from "@/lib/plan/design-walk";
import { useQuest } from "@/store/use-quest";
import type { Stop, Walk, WalkRoute } from "@/lib/types";

export function ExploreScreen() {
  const router = useRouter();
  const hydrate = useQuest((s) => s.hydrate);
  const hydrated = useQuest((s) => s.hydrated);
  const deviceId = useQuest((s) => s.deviceId);
  const profile = useQuest((s) => s.profile);
  const budget = useQuest((s) => s.budget);
  const start = useQuest((s) => s.start);
  const walk = useQuest((s) => s.walk);
  const needsPlan = useQuest((s) => s.needsPlan);
  const setWalk = useQuest((s) => s.setWalk);
  const setNeedsPlan = useQuest((s) => s.setNeedsPlan);
  const clearAll = useQuest((s) => s.clearAll);
  const [steps, setSteps] = useState<string[]>([]);
  const [planning, setPlanning] = useState(false);
  const [pill, setPill] = useState<string | null>(null);
  const [pillOn, setPillOn] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [undoWalk, setUndoWalk] = useState<Walk | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(tick);
  }, []);
  const [online, setOnline] = useState(true);
  const [fix, setFix] = useState<{ lat: number; lon: number } | null>(null);
  const [liveStops, setLiveStops] = useState<Stop[]>([]);
  const [liveRoute, setLiveRoute] = useState<WalkRoute | null>(null);
  const wide = useMinWidth(768);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (planning && steps.length > 0) {
      setPill(steps[steps.length - 1] ?? null);
      setPillOn(true);
      return;
    }
    setPillOn(false);
    const timer = window.setTimeout(() => setPill(null), 700);
    return () => window.clearTimeout(timer);
  }, [planning, steps]);

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
    if (!hydrated || !needsPlan || !profile || !budget || !start) return;
    const controller = new AbortController();
    setPlanning(true);
    setError(null);
    setNotice(null);
    setSteps([]);
    setLiveStops([]);
    setLiveRoute(null);
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    void fetch("/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json", "x-device-id": deviceId },
      body: JSON.stringify({
        profile,
        start,
        budgetMin: budget.minutes,
        pace: budget.pace,
        mode: budget.mode,
        shape: budget.shape ?? "loop",
        end: budget.end,
        demo: start.source === "demo",
        tz,
      }),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { message?: string } | null;
          throw new Error(body?.message ?? "Couldn’t build a route.");
        }
        await readUiStream(response, (part) => {
          if (part.type === "data-step") setSteps((current) => [...current, String((part.data as { text: string }).text)]);
          if (part.type === "data-stop") setLiveStops((current) => [...current, part.data as Stop]);
          if (part.type === "data-route") setLiveRoute(part.data as WalkRoute);
          if (part.type === "data-notice") setNotice((part.data as { message: string }).message);
          if (part.type === "data-walk") {
            setWalk(part.data as Walk);
            setNeedsPlan(false);
            setPlanning(false);
          }
        }, controller.signal);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Couldn’t build a route.");
        setNeedsPlan(false);
      })
      .finally(() => {
        if (!controller.signal.aborted) setPlanning(false);
      });
    return () => controller.abort();
  }, [hydrated, needsPlan, profile, budget, start, deviceId, setWalk, setNeedsPlan]);

  useEffect(() => {
    if (!start || !navigator.geolocation) return;
    const watch = navigator.geolocation.watchPosition(
      (pos) => setFix({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => undefined,
      { enableHighAccuracy: true },
    );
    let lock: { release: () => Promise<void> } | null = null;
    void navigator.wakeLock?.request("screen").then((sentinel) => {
      lock = sentinel;
    }).catch(() => undefined);
    // TODO(#8): call shouldAutoReroute() on consecutive off-route fixes (90s debounce).
    // TODO(#14): simulated walk scrubber along the polyline.
    return () => {
      navigator.geolocation.clearWatch(watch);
      void lock?.release();
    };
  }, [start]);

  const version = walk?.versions[walk.versions.length - 1];
  const stops = version?.stops ?? liveStops;
  const route = version?.route ?? liveRoute;
  const next = stops.find((stop) => stop.state === "next") ?? stops.find((stop) => stop.state === "todo");
  const done = stops.filter((stop) => stop.state === "visited").length;
  const user: [number, number] | undefined = fix
    ? [fix.lon, fix.lat]
    : start
      ? [start.lon, start.lat]
      : undefined;

  const shape = walk?.shape ?? budget?.shape ?? "loop";
  const origin = shape === "end-near" ? (walk?.end ?? budget?.end ?? start) : start;
  const returnMin = walk?.returnMin ?? 0;
  const showRide = Boolean(origin && returnMin > 0 && shouldOfferRide(returnMin, walk?.isDemo ? 19 : new Date().getHours()));
  const stopPins: MapPin[] = stops
    .filter((stop) => stop.state !== "visited" && stop.state !== "vetoed")
    .map((stop) => {
      if (stop.state === "skipped") {
        return { n: "–", ll: [stop.lon, stop.lat] as [number, number], cls: "skipped", label: "Skipped" };
      }
      const nextPin = stop.state === "next";
      const fresh = Boolean(stop.introduced && nextPin);
      return {
        n: stop.seq,
        ll: [stop.lon, stop.lat] as [number, number],
        cls: fresh ? "new next" : nextPin ? "next" : "",
        label: fresh ? "New" : nextPin ? shortName(stop.name) : undefined,
        color: fresh ? "#fa7850" : pinColor(stop),
      };
    });
  const routes: MapRoute[] = route
    ? [
        ...(route.ghost ? [{ coords: route.ghost.coordinates, ghost: true }] : []),
        { coords: route.geometry.coordinates, dashed: route.approximate, color: "#8c8cc8" },
      ]
    : [];
  const listed = stops.some((stop) => stop.state === "visited" || stop.state === "skipped");
  const design = walk?.poolKey === DESIGN_POOL;
  const routePts = route?.geometry.coordinates ?? [];
  const frame = wide && routePts.length > 1
    ? routePts
    : design
      ? (listed ? REROUTE_FRAME : EXPLORE_FRAME)
      : routePts.length > 1
        ? routePts
        : undefined;
  const pad = wide
    ? { top: 128, bottom: 72, left: 24 + 400 + 64, right: 96 }
    : listed
      ? REROUTE_PAD
      : EXPLORE_PAD;
  const zoomOut = wide ? 0.15 : listed ? REROUTE_ZOOM_OUT : EXPLORE_ZOOM_OUT;
  const cursor = walk?.cursor;
  const fixNearDesign =
    !design ||
    !cursor ||
    !fix ||
    (fix.lat - cursor.lat) ** 2 + (fix.lon - cursor.lon) ** 2 < 0.0004;
  const dot: [number, number] | undefined =
    fix && fixNearDesign
      ? [fix.lon, fix.lat]
      : cursor
        ? [cursor.lon, cursor.lat]
        : user;
  const homeAway = Boolean(origin && dot && haversineM({ lat: dot[1], lon: dot[0] }, origin) > 80);
  const pins: MapPin[] =
    origin && shape !== "one-way"
      ? [
          {
            n: "",
            ll: [origin.lon, origin.lat],
            cls: "home",
            label: homeAway ? (shape === "end-near" ? "End" : "Start") : undefined,
          },
          ...stopPins,
        ]
      : stopPins;

  async function skip() {
    if (!walk || !profile || !next || !online) return;
    const previous = walk;
    const here = fix ?? { lat: walk.start.lat, lon: walk.start.lon };
    const response = await fetch("/api/reroute", {
      method: "POST",
      headers: { "content-type": "application/json", "x-device-id": deviceId },
      body: JSON.stringify({ profile, walk, fix: here, reason: "skip", tz: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    });
    if (!response.ok) {
      setToast("Couldn't update. Your route is unchanged.");
      return;
    }
    const body = (await response.json()) as { walk: Walk; toast: string };
    setUndoWalk(previous);
    setWalk(body.walk);
    setToast(body.toast);
    window.setTimeout(() => setToast(null), 8000);
  }

  const center: [number, number] = user ?? [-97.743, 30.267];
  // Time left is the budget minus time since the walk was planned. remainingMin
  // is the planned length, so it only stands in for the scripted design walk
  // (the keyless Austin demo). A live demo walk counts down like any other.
  const elapsedMin = walk?.startedAt ? Math.max(0, (now - Date.parse(walk.startedAt)) / 60_000) : 0;
  const minutesLeft = walk?.headingBack
    ? (walk.returnMin ?? returnMin)
    : walk && design
      ? (walk.remainingMin ?? walk.budgetMin)
      : walk
        ? Math.max(0, walk.budgetMin - elapsedMin)
        : (budget?.minutes ?? 0);
  const leftLabel = formatMinutes(minutesLeft ?? 0);
  const sheetH = walk?.headingBack ? 248 : listed ? (returnMin > 0 ? 360 : 300) : planning && !next ? 220 : 316;

  return (
    <main className="screen map-screen" style={{ ["--sheet-h" as string]: `${sheetH}px` }}>
      <div className="map-stage">
        {hydrated ? (
          <TasteMap
            center={dot ?? center}
            routes={routes}
            pins={pins}
            user={dot}
            pitch={42}
            bearing={-18}
            frame={frame}
            pad={pad}
            zoomOut={zoomOut}
            fitPitch={wide}
            maxZoom={wide ? 16.2 : undefined}
          />
        ) : null}
      </div>
      <DeviceChrome />
      <div className={listed ? "map-fade tall" : "map-fade"} />
      <div className="hud" style={{ display: toast ? "none" : undefined }}>
        <button className="icon-btn" type="button" aria-label="Menu" onClick={() => setMenu(true)}>
          <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
            <path d="M3 6h14M3 10h14M3 14h14" stroke="#28323c" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
        <div className="hud-chips">
          <span className="geo-chip">
            <span className="dot" style={{ background: "var(--color-accent)" }} />
            {leftLabel} left
          </span>
          <span className="geo-chip">
            {done} of {stops.length || "–"} stops
          </span>
        </div>
        <span className="icon-btn" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 20 20">
            <path d="M10 2l2.5 8H7.5z" fill="#e35a3a" />
            <path d="M10 18l-2.5-8h5z" fill="#a0aab4" />
          </svg>
        </span>
      </div>

      {!online ? <p className="banner map-note">You’re offline. The saved route stays. New searches are paused.</p> : null}
      {route?.approximate ? <p className="approx-tag">approx.</p> : null}
      <div className="locate">
        <span className="icon-btn" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 20 20">
            <path d="M17 3L3 9l6 2 2 6z" fill="#6f6fba" />
          </svg>
        </span>
      </div>

      {pill ? (
        <div className={pillOn ? "status-pill on" : "status-pill"} aria-live="polite">
          <span className="geo-chip">{pill}</span>
        </div>
      ) : null}

      <section className="sheet explore-sheet">
        <div className="grabber" />
        <div style={{ padding: "14px 20px 0" }}>
          {error ? (
            <>
              <h2 className="display" style={{ fontSize: 24, margin: "8px 0" }}>
                Couldn’t plan that walk
              </h2>
              <p style={{ color: "var(--color-slate)" }}>{error}</p>
              <button className="btn btn-primary btn-block" type="button" style={{ marginTop: 16 }} onClick={() => setNeedsPlan(true)}>
                Retry
              </button>
            </>
          ) : notice && stops.length === 0 && !planning ? (
            <>
              <h2 className="display" style={{ fontSize: 24, margin: "8px 0" }}>
                Not enough taste matches within 2.5 km
              </h2>
              <p style={{ color: "var(--color-slate)" }}>{notice}</p>
              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                <button className="btn btn-cream" type="button" onClick={() => router.push("/onboarding")}>
                  Change tastes
                </button>
                <button className="btn btn-primary" type="button" style={{ flex: 1 }} onClick={() => router.push("/")}>
                  Try Austin demo
                </button>
              </div>
            </>
          ) : walk?.headingBack && origin ? (
            <HeadBack
              minutes={returnMin}
              label={origin.label ?? walk.start.label}
              ride={showRide ? <RideBack lat={origin.lat} lon={origin.lon} label={origin.label ?? walk.start.label ?? "Start"} /> : null}
            />
          ) : listed ? (
            <WalkList
              stops={stops}
              totals={version?.totals}
              closing={
                returnMin > 0
                  ? `${shape === "end-near" ? "End near" : "Back to start"} · ${returnMin} min`
                  : undefined
              }
              ride={
                showRide && origin ? (
                  <RideBack lat={origin.lat} lon={origin.lon} label={origin.label ?? "Start"} />
                ) : null
              }
            />
          ) : next && wide ? (
            <>
              <NextSheet
                stop={next}
                index={stops.filter((stop) => stop.state !== "skipped").findIndex((stop) => stop.entityId === next.entityId) + 1}
                total={stops.filter((stop) => stop.state !== "skipped").length}
                onSkip={() => void skip()}
                onOpen={() => router.push(`/stop/${encodeURIComponent(next.entityId)}`)}
              />
              <div className="sheet-list">
                <WalkList
                  stops={stops}
                  totals={version?.totals}
                  closing={
                    returnMin > 0
                      ? `${shape === "end-near" ? "End near" : "Back to start"} · ${returnMin} min`
                      : undefined
                  }
                  ride={
                    showRide && origin ? (
                      <RideBack lat={origin.lat} lon={origin.lon} label={origin.label ?? "Start"} />
                    ) : null
                  }
                />
              </div>
            </>
          ) : next ? (
            <NextSheet
              stop={next}
              index={stops.filter((stop) => stop.state !== "skipped").findIndex((stop) => stop.entityId === next.entityId) + 1}
              total={stops.filter((stop) => stop.state !== "skipped").length}
              onSkip={() => void skip()}
              onOpen={() => router.push(`/stop/${encodeURIComponent(next.entityId)}`)}
            />
          ) : (
            <>
              <div className="skel" style={{ width: "40%" }} />
              <div className="skel" style={{ width: "70%", marginTop: 12, height: 22 }} />
              <div className="skel" style={{ marginTop: 12 }} />
            </>
          )}
        </div>
      </section>

      {toast ? (
        <div className="route-toast">
          <div style={{ width: 32, height: 32, borderRadius: "50%", background: "#8c8cc833", flex: "none", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true">
              <path d="M4 10a6 6 0 0 1 10.2-4.3M16 10a6 6 0 0 1-10.2 4.3" fill="none" stroke="#b4aadc" strokeWidth="1.8" strokeLinecap="round" />
              <path d="M14.5 2.5v3.5H11M5.5 17.5V14H9" fill="none" stroke="#b4aadc" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 14, lineHeight: "20px" }}>Route updated</div>
            <div style={{ fontSize: 13, lineHeight: "19px", color: "#ffffffb3", marginTop: 2 }}>
              <ToastText text={toast} />
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              if (undoWalk) setWalk(undoWalk);
              setToast(null);
            }}
            style={{ background: "none", border: 0, color: "#b4aadc", fontWeight: 600, paddingTop: 1 }}
          >
            Undo
          </button>
        </div>
      ) : null}

      {menu ? (
        <div style={{ position: "absolute", inset: 0, zIndex: 40, background: "#28323c33" }} onClick={() => setMenu(false)}>
          <div className="card map-menu" onClick={(event) => event.stopPropagation()}>
            <MenuRow label="Edit tastes" onClick={() => router.push("/onboarding")} />
            <MenuRow label="Time and start" onClick={() => router.push("/start")} />
            <MenuRow
              label="Clear my data"
              onClick={() => {
                void clearAll().then(() => router.push("/"));
              }}
            />
          </div>
        </div>
      ) : null}
    </main>
  );
}

function NextSheet({
  stop,
  index,
  total,
  onSkip,
  onOpen,
}: {
  stop: Stop;
  index: number;
  total: number;
  onSkip: () => void;
  onOpen: () => void;
}) {
  const shares = stop.evidence.entityShares.slice(0, 2);
  const extra = stop.evidence.entityShares.length - shares.length;
  const placeLine = [
    stop.categoryLabel,
    stop.address ? shortAddress(stop.address) : "",
    hoursLabel(stop),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div className="eyebrow" style={{ color: "var(--color-accent-deep)" }}>
          Next stop · {stop.walkMin} min walk
        </div>
        <span style={{ fontSize: 12, color: "var(--color-slate-dim)" }}>
          {index} of {total}
        </span>
      </div>
      <button type="button" onClick={onOpen} style={{ display: "flex", width: "100%", justifyContent: "space-between", gap: 12, marginTop: 8, background: "none", border: 0, textAlign: "left", padding: 0 }}>
        <span>
          <span className="display" style={{ display: "block", fontSize: 24, lineHeight: "30px" }}>
            {stop.name}
          </span>
          <span style={{ fontSize: 13, color: "var(--color-slate-dim)" }}>{placeLine}</span>
        </span>
        <span style={{ textAlign: "right" }}>
          <span className="display" style={{ display: "block", fontSize: 24, lineHeight: "30px", fontWeight: 600, color: "var(--color-accent-deep)" }}>
            {stop.affinity.toFixed(2)}
          </span>
          <span style={{ fontSize: 11, color: "var(--color-slate-dim)" }}>taste match</span>
        </span>
      </button>
      <p style={{ marginTop: 12, fontSize: 14, lineHeight: "21px", color: "var(--color-plum)" }}>{stop.blurb}</p>
      <div style={{ display: "flex", gap: 6, marginTop: 12, overflow: "hidden" }}>
        {shares.map((share) => (
          <span key={share.entityId} className="chip" style={{ height: 30, fontSize: 13, background: "var(--cat-artists-wash)", color: "var(--cat-artists)", boxShadow: "none" }}>
            <span className="dot" style={{ background: "#7a4fd6" }} />
            {share.name}
            <span style={{ opacity: 0.7 }}>{Math.round(share.share * 100)}%</span>
          </span>
        ))}
        {extra > 0 ? (
          <span className="chip" style={{ height: 30, fontSize: 13, background: "var(--color-surface-alt)", boxShadow: "none", color: "var(--color-slate)" }}>
            +{extra}
          </span>
        ) : null}
      </div>
      <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
        <button className="btn btn-cream" type="button" style={{ flex: 1 }} onClick={onSkip}>
          Skip
        </button>
        <button className="btn btn-primary" type="button" style={{ flex: 2 }} onClick={onOpen}>
          Go · {stop.walkMin} min
        </button>
      </div>
    </>
  );
}

function MenuRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: 0, padding: "12px 12px", fontWeight: 500 }}>
      {label}
    </button>
  );
}

function pinColor(stop: Stop): string {
  if (stop.category === "live_music") return "#7a4fd6";
  if (stop.category === "bar" || stop.category === "restaurant") return "#c08095";
  if (stop.category === "park") return "#8ca082";
  return "#8c8cc8";
}

function ToastText({ text }: { text: string }) {
  const name = "Museum of the Weird";
  if (!text.includes(name)) return text;
  const [before, after] = text.split(name);
  return (
    <>
      {before}
      <span style={{ color: "#fff" }}>{name}</span>
      {after}
    </>
  );
}

function shortName(name: string): string {
  return name.split(" ")[0] ?? name;
}

function WalkList({
  stops,
  totals,
  closing,
  ride,
}: {
  stops: Stop[];
  totals?: { walkMin: number; km: number };
  closing?: string;
  ride?: ReactNode;
}) {
  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h2 className="display" style={{ fontSize: 20, lineHeight: "26px", margin: 0 }}>
          Your walk
        </h2>
        <span style={{ fontSize: 12, color: "var(--color-slate-dim)" }}>
          {totals ? `${totals.km} km left · ${totals.walkMin} min walking` : ""}
        </span>
      </div>
      <div style={{ marginTop: 6 }}>
        {stops.map((stop) => (
          <WalkRow key={`${stop.entityId}-${stop.state}`} stop={stop} />
        ))}
        {closing ? <WalkReturn label={closing} /> : null}
        {ride}
      </div>
    </>
  );
}

function WalkReturn({ label }: { label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, height: 44 }}>
      <div style={{ width: 26, height: 26, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", flex: "none", background: "var(--color-ink)", color: "#fff" }}>
        <svg width="13" height="13" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M3.5 9.2 10 3.8l6.5 5.4V16.5H12v-4.2H8v4.2H3.5z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        </svg>
      </div>
      <div style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>{label}</div>
    </div>
  );
}

function RideBack({ lat, lon, label }: { lat: number; lon: number; label: string }) {
  const nick = encodeURIComponent(label || "Start");
  const uber = `https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff[latitude]=${lat}&dropoff[longitude]=${lon}&dropoff[nickname]=${nick}`;
  const lyft = `https://lyft.com/ride?id=lyft&destination[latitude]=${lat}&destination[longitude]=${lon}`;
  return (
    <div className="ride-row">
      <span style={{ fontSize: 12, color: "var(--color-slate-dim)", alignSelf: "center" }}>Ride back</span>
      <a href={uber} target="_blank" rel="noreferrer">
        Uber
      </a>
      <a href={lyft} target="_blank" rel="noreferrer">
        Lyft
      </a>
    </div>
  );
}

function HeadBack({ minutes, label, ride }: { minutes: number; label?: string; ride?: ReactNode }) {
  return (
    <>
      <div className="eyebrow" style={{ color: "var(--color-accent-deep)" }}>
        Loop
      </div>
      <h2 className="display" style={{ fontSize: 24, lineHeight: "30px", margin: "8px 0 0" }}>
        Time to head back · {Math.max(1, Math.round(minutes))} min
      </h2>
      <p style={{ marginTop: 8, color: "var(--color-slate)", fontSize: 14, lineHeight: "21px" }}>
        {label ? `The walk closes at ${label}.` : "The walk closes where you started."}
      </p>
      {ride}
    </>
  );
}

function WalkRow({ stop }: { stop: Stop }) {
  const skipped = stop.state === "skipped";
  const visited = stop.state === "visited";
  const fresh = Boolean(stop.introduced);
  const mark = visited ? "✓" : skipped ? "–" : String(stop.seq);
  const bubble = visited
    ? { background: "#3d8a5a", color: "#fff" }
    : fresh
      ? { background: "var(--color-flare)", color: "#fff" }
      : skipped
        ? { background: "var(--color-cream)", color: "var(--color-slate-dim)", boxShadow: "inset 0 0 0 1.5px var(--color-hairline)" }
        : { background: "#fff", color: "var(--color-slate-dim)", boxShadow: "inset 0 0 0 1.5px var(--color-hairline)" };
  const time = visited ? "visited" : skipped ? "skipped" : fresh ? `${stop.walkMin} min` : `+${stop.walkMin} min`;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, height: 44 }}>
      <div style={{ width: 26, height: 26, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 600, fontFamily: "var(--font-display)", flex: "none", ...bubble }}>
        {mark}
      </div>
      <div style={{ flex: 1, fontSize: 14, fontWeight: fresh ? 600 : 500, color: skipped ? "var(--color-slate-soft)" : "var(--color-ink)", textDecoration: skipped ? "line-through" : "none" }}>
        {stop.name}
        {fresh ? (
          <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 600, color: "var(--color-flare)", background: "#fa785019", padding: "2px 6px", borderRadius: 999, letterSpacing: "0.04em" }}>
            NEW
          </span>
        ) : null}
      </div>
      <div style={{ fontSize: 12, color: "var(--color-slate-dim)", fontVariantNumeric: "tabular-nums" }}>{time}</div>
    </div>
  );
}

function shortAddress(address: string): string {
  return address.split(",")[0] ?? address;
}

function hoursLabel(stop: Stop): string {
  if (stop.closedNow) return "Closed now";
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const today = stop.hours?.[days[new Date().getDay()]];
  const closes = today?.[0]?.closes ?? Object.values(stop.hours ?? {})[0]?.[0]?.closes;
  if (!closes) return stop.closingSoon ? "Closing soon" : "";
  const match = /(\d{2}):(\d{2})/.exec(closes);
  if (!match) return "";
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const suffix = hour >= 12 ? "pm" : "am";
  hour = hour % 12 || 12;
  const clock = minute ? `${hour}:${String(minute).padStart(2, "0")}${suffix}` : `${hour}${suffix}`;
  return stop.closingSoon ? `Closing soon · till ${clock}` : `Open till ${clock}`;
}
