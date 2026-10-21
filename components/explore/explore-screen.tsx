"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
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
import { ARRIVE_GAP_MS, ARRIVE_M, arriveAt, finishWalk, replanFrom } from "@/lib/walk/progress";
import { MatchScore, TagRow, pct, tidyBlurb } from "@/components/ui/taste";
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
  const [recenter, setRecenter] = useState(0);
  const [skipping, setSkipping] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(tick);
  }, []);
  const [online, setOnline] = useState(true);
  const [fix, setFix] = useState<{ lat: number; lon: number; accuracy: number; at: number } | null>(null);
  const usedFix = useRef(0);
  // When the current next stop became next. GPS check-in waits ARRIVE_GAP_MS
  // after it, so venues in one block never chain-arrive on back-to-back fixes.
  const arrivedAt = useRef(0);
  const [liveStops, setLiveStops] = useState<Stop[]>([]);
  const [liveRoute, setLiveRoute] = useState<WalkRoute | null>(null);
  const wide = useMinWidth(1024);
  const tabletUp = useMinWidth(768);

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
      (pos) => setFix({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy, at: pos.timestamp }),
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

  // Walking up to the next stop checks you in. Each GPS fix is used once, so
  // two venues in one block never chain-arrive, and a fuzzy indoor fix
  // (accuracy worse than ARRIVE_M) never counts. Paused while a skip is in flight.
  useEffect(() => {
    if (!walk || !fix || !next || walk.status === "done" || skipping) return;
    if (fix.at === usedFix.current || fix.accuracy > ARRIVE_M) return;
    if (Date.now() - arrivedAt.current < ARRIVE_GAP_MS) return;
    if (haversineM(fix, next) > ARRIVE_M) return;
    usedFix.current = fix.at;
    arrivedAt.current = Date.now();
    const after = arriveAt(walk, next.entityId);
    if (after.headingBack || after.status === "done") setToast(null);
    setWalk(after);
  }, [fix, next, walk, setWalk, skipping]);

  // The stop page sends Skip and "I'm here" back here as ?do=skip|arrive&id=…
  // so both run the same code as the map's buttons.
  const [pending, setPending] = useState<{ action: string; id: string } | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const action = params.get("do");
    const id = params.get("id");
    if (!action || !id) return;
    window.history.replaceState(null, "", "/explore");
    setPending({ action, id });
  }, []);
  useEffect(() => {
    if (!pending || !hydrated || !walk) return;
    setPending(null);
    if (!next || next.entityId !== pending.id) return;
    if (pending.action === "arrive") arrive(next.entityId);
    if (pending.action === "skip") void skip();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, hydrated, walk, next]);
  const user: [number, number] | undefined = fix
    ? [fix.lon, fix.lat]
    : start
      ? [start.lon, start.lat]
      : undefined;

  const shape = walk?.shape ?? budget?.shape ?? "loop";
  const origin = shape === "end-near" ? (walk?.end ?? budget?.end ?? start) : start;
  const returnMin = walk?.returnMin ?? 0;
  const showRide = Boolean(origin && returnMin > 0 && shouldOfferRide(returnMin, walk?.isDemo ? 19 : new Date().getHours()));
  // Skipped stops leave the map (the faded old line shows the change); visited
  // ones stay as small check marks, so the map reads as the walk so far.
  const stopPins: MapPin[] = stops
    .filter((stop) => stop.state !== "skipped" && stop.state !== "vetoed")
    .map((stop) => {
      if (stop.state === "visited") {
        return { n: "✓", ll: [stop.lon, stop.lat] as [number, number], cls: "visited" };
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
  // The hand-tuned demo frames fit the first plan and the scripted skip only;
  // any later re-plan frames its own route.
  // They are tuned for a phone screen, so wider screens frame the real route.
  const scripted = design && !tabletUp && (walk?.currentVersion ?? 1) <= 2;
  const frame = wide && routePts.length > 1
    ? routePts
    : scripted
      ? (listed ? REROUTE_FRAME : EXPLORE_FRAME)
      : routePts.length > 1
        ? routePts
        : undefined;
  const pad = wide
    ? { top: 96, bottom: 72, left: 24 + 380 + 64, right: 88 }
    : !scripted && routePts.length > 1
      ? { top: 150, bottom: 360, left: 48, right: 48 }
      : listed
      ? REROUTE_PAD
      : EXPLORE_PAD;
  const zoomOut = wide ? 0.15 : !scripted && routePts.length > 1 ? 0.1 : listed ? REROUTE_ZOOM_OUT : EXPLORE_ZOOM_OUT;
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
    if (!walk || !profile || !next || skipping) return;
    if (!online) {
      setUndoWalk(null);
      setToast("You’re offline. Your route is unchanged.");
      window.setTimeout(() => setToast(null), 5000);
      return;
    }
    const previous = walk;
    const here = replanFrom(walk, fix);
    setSkipping(true);
    const response = await fetch("/api/reroute", {
      method: "POST",
      headers: { "content-type": "application/json", "x-device-id": deviceId },
      // Only the latest versions travel: the server reads the last one, and the
      // schema caps the list, so a long walk never starts failing every skip.
      body: JSON.stringify({ profile, walk: { ...walk, versions: walk.versions.slice(-10) }, fix: here, reason: "skip", tz: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    }).catch(() => null);
    // Stays "skipping" until the new walk is in the store, so I'm here and
    // GPS check-in can't land on the old walk and then be overwritten.
    const body = response?.ok ? ((await response.json().catch(() => null)) as { walk: Walk; toast: string } | null) : null;
    if (!body?.walk) {
      setSkipping(false);
      setUndoWalk(null);
      setToast("Couldn't update. Your route is unchanged.");
      window.setTimeout(() => setToast(null), 5000);
      return;
    }
    setUndoWalk(previous);
    setWalk(body.walk);
    setSkipping(false);
    arrivedAt.current = Date.now();
    setToast(body.toast);
    window.setTimeout(() => setToast(null), 8000);
  }

  function arrive(entityId: string) {
    if (!walk || skipping) return;
    arrivedAt.current = Date.now();
    const after = arriveAt(walk, entityId);
    // An older route popup would cover the head-back or finish sheet; a skip's
    // own popup (with its Undo) is left alone, since that path never runs here.
    if (after.headingBack || after.status === "done") setToast(null);
    setWalk(after);
  }

  function endWalk() {
    if (!walk) return;
    setMenu(false);
    setToast(null);
    setWalk(finishWalk(walk));
  }

  // The popup describes a route change; once the sheet moves on to heading
  // back or the finish, the sheet says it better, so the popup goes.
  const center: [number, number] = user ?? [-97.743, 30.267];
  // Time left is the budget minus time since the walk was planned. remainingMin
  // is the planned length, so it only stands in for the scripted design walk
  // (the Austin demo). Every other walk counts down.
  const elapsedMin = walk?.startedAt ? Math.max(0, (now - Date.parse(walk.startedAt)) / 60_000) : 0;
  const minutesLeft = walk?.headingBack
    ? (walk.returnMin ?? returnMin)
    : walk && design
      ? (walk.remainingMin ?? walk.budgetMin)
      : walk
        ? Math.max(0, walk.budgetMin - elapsedMin)
        : (budget?.minutes ?? 0);
  const leftLabel = formatMinutes(minutesLeft ?? 0);
  const finished = walk?.status === "done";
  const sheetH = finished ? 340 : walk?.headingBack ? 300 : listed && !next ? (returnMin > 0 ? 360 : 300) : planning && !next ? 220 : 316;

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
            interactive
            fitKey={`${walk?.id ?? "none"}:${walk?.currentVersion ?? 0}:${wide ? "w" : "n"}:${recenter}`}
          />
        ) : null}
      </div>
      <DeviceChrome />
      <div className={listed ? "map-fade tall" : "map-fade"} />
      <div className="hud">
        <button className="icon-btn" type="button" aria-label="Menu" onClick={() => setMenu(true)}>
          <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
            <path d="M3 6h14M3 10h14M3 14h14" stroke="#28323c" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
        <div className="hud-chips">
          {finished ? (
            <span className="geo-chip">
              <span className="dot" style={{ background: "var(--color-open)" }} />
              Walk complete
            </span>
          ) : (
            <>
              <span className="geo-chip">
                <span className="dot" style={{ background: "var(--color-accent)" }} />
                {walk?.headingBack ? `${leftLabel} home` : `${leftLabel} left`}
              </span>
              {stops.length > 0 ? (
                <span className="geo-chip">
                  {`${done} of ${stops.filter((stop) => stop.state !== "skipped" && stop.state !== "vetoed").length} stops`}
                </span>
              ) : null}
            </>
          )}
        </div>
        <button className="icon-btn" type="button" aria-label="Reset view" onClick={() => setRecenter((n) => n + 1)}>
          <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
            <path d="M10 2l2.5 8H7.5z" fill="#e35a3a" />
            <path d="M10 18l-2.5-8h5z" fill="#a0aab4" />
          </svg>
        </button>
      </div>

      {!online ? <p className="banner map-note">You’re offline. The saved route stays. New searches are paused.</p> : null}
      {route?.approximate ? <p className="approx-tag">approx.</p> : null}
      <div className="locate">
        <button className="icon-btn" type="button" aria-label="Recenter on route" onClick={() => setRecenter((n) => n + 1)}>
          <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
            <path d="M17 3L3 9l6 2 2 6z" fill="#6f6fba" />
          </svg>
        </button>
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
          ) : finished && walk ? (
            <DoneSheet
              stops={stops}
              km={version?.totals?.km}
              minutes={walk.startedAt && elapsedMin <= walk.budgetMin * 1.5 ? Math.round(elapsedMin) : undefined}
              onAgain={() => {
                setWalk(null);
                router.push("/start");
              }}
              onTastes={() => router.push("/onboarding")}
            />
          ) : walk?.headingBack && origin ? (
            <HeadBack
              minutes={returnMin}
              label={placeLabel(origin.label ?? walk.start.label)}
              ride={showRide ? <RideBack lat={origin.lat} lon={origin.lon} label={origin.label ?? walk.start.label ?? "Start"} /> : null}
              onFinish={endWalk}
            />
          ) : listed && !next ? (
            <>
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
            {walk ? (
              <button className="btn btn-primary btn-block" type="button" style={{ marginTop: 12 }} onClick={endWalk}>
                Finish walk
              </button>
            ) : null}
            </>
          ) : next && wide ? (
            <>
              <NextSheet
                stop={next}
                index={stops.filter((stop) => stop.state !== "skipped").findIndex((stop) => stop.entityId === next.entityId) + 1}
                total={stops.filter((stop) => stop.state !== "skipped").length}
                onSkip={() => void skip()}
                onArrive={() => arrive(next.entityId)}
                skipping={skipping}
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
              onArrive={() => arrive(next.entityId)}
              skipping={skipping}
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
          {undoWalk ? (
          <button
            type="button"
            onClick={() => {
              setWalk(undoWalk);
              setUndoWalk(null);
              setToast(null);
            }}
            style={{ background: "none", border: 0, color: "#b4aadc", fontWeight: 600, paddingTop: 1 }}
          >
            Undo
          </button>
          ) : null}
        </div>
      ) : null}

      {menu ? (
        <div style={{ position: "absolute", inset: 0, zIndex: 40, background: "#28323c33" }} onClick={() => { setMenu(false); setConfirmClear(false); }}>
          <div className="card map-menu" role="dialog" aria-label="Menu" onClick={(event) => event.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 4px 4px 12px" }}>
              <span className="eyebrow">Menu</span>
              <button className="icon-btn ghost" type="button" aria-label="Close menu" style={{ width: 36, height: 36 }} onClick={() => { setMenu(false); setConfirmClear(false); }}>
                <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M5 5l10 10M15 5L5 15" stroke="#28323c" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <MenuRow label="Edit tastes" onClick={() => router.push("/onboarding")} />
            <MenuRow label="Time and start" onClick={() => router.push("/start")} />
            {walk && !finished ? <MenuRow label="End walk" onClick={endWalk} /> : null}
            <div className="hair" style={{ margin: "4px 12px" }} />
            {confirmClear ? (
              <div style={{ padding: "8px 12px 10px" }}>
                <div style={{ fontSize: 14, lineHeight: "20px", color: "var(--color-slate)" }}>Clear your tastes and walk from this device?</div>
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <button className="btn btn-cream" type="button" style={{ height: 38, flex: 1 }} onClick={() => setConfirmClear(false)}>
                    Keep
                  </button>
                  <button
                    className="btn"
                    type="button"
                    style={{ height: 38, flex: 1, background: "var(--color-error)", color: "#fff" }}
                    onClick={() => {
                      void clearAll().then(() => router.push("/"));
                    }}
                  >
                    Clear
                  </button>
                </div>
              </div>
            ) : (
              <MenuRow label="Clear my data" danger onClick={() => setConfirmClear(true)} />
            )}
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
  onArrive,
  skipping,
  onOpen,
}: {
  stop: Stop;
  index: number;
  total: number;
  onSkip: () => void;
  onArrive: () => void;
  skipping: boolean;
  onOpen: () => void;
}) {
  const tags = stop.evidence.entityShares.map((share) => ({ id: share.entityId, name: share.name, share: share.share }));
  // Hours lead: "Open till 2am" is what you act on; the street is on the map.
  const placeLine = [hoursLabel(stop), stop.categoryLabel, stop.address ? shortAddress(stop.address) : ""]
    .filter(Boolean)
    .join(" · ");
  const blurb = tidyBlurb(stop.blurb, 150) || fallbackBlurb(stop);
  const maps = `https://www.google.com/maps/dir/?api=1&destination=${stop.lat},${stop.lon}&travelmode=walking`;
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
      <button type="button" className="next-head" onClick={onOpen}>
        <span>
          <span className="display" style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 24, lineHeight: "30px" }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{stop.name}</span>
            <span className="sr-only">Details:</span>
            <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true" style={{ flex: "none", marginTop: 2 }}>
              <path d="M7.5 4l6 6-6 6" fill="none" stroke="#a0aab4" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </span>
          <span className="next-place" style={{ fontSize: 13, color: "var(--color-slate-dim)" }}>{placeLine}</span>
        </span>
        <MatchScore value={stop.affinity} />
      </button>
      <p className="next-blurb" style={{ marginTop: 12, fontSize: 14, lineHeight: "21px", color: "var(--color-plum)", minHeight: 42 }}>{blurb}</p>
      <TagRow tags={tags} />
      <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
        <button className="btn btn-cream" type="button" style={{ flex: 1 }} onClick={onSkip} disabled={skipping}>
          {skipping ? "Re-routing…" : "Skip"}
        </button>
        <button className="btn btn-cream" type="button" style={{ flex: 1 }} onClick={onArrive} disabled={skipping}>
          I’m here
        </button>
        <a className="btn btn-primary" style={{ flex: 1.4, textDecoration: "none" }} href={maps} target="_blank" rel="noreferrer">
          Go · {stop.walkMin} min
        </a>
      </div>
    </>
  );
}

/** A stop with no "why" text still says why, from its top taste matches. */
function fallbackBlurb(stop: Stop): string {
  const names = stop.evidence.entityShares.slice(0, 2).map((share) => share.name);
  if (names.length === 0) return `A ${pct(stop.affinity)}% match for your taste.`;
  return `Picked for your taste in ${names.join(" and ")}.`;
}

function MenuRow({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick} style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: 0, padding: "12px 12px", fontWeight: 500, borderRadius: 10, color: danger ? "var(--color-error)" : undefined }}>
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
  const match = /Added (.+?), an? \d+% match/.exec(text);
  const name = match?.[1];
  if (!match || !name) return text;
  const at = match.index + "Added ".length;
  const before = text.slice(0, at);
  const after = text.slice(at + name.length);
  return (
    <>
      {before}
      <span style={{ color: "#fff" }}>{name}</span>
      {after}
    </>
  );
}

function shortName(name: string): string {
  // "The Sunset Room" labels as "Sunset", not "The".
  return name.replace(/^The\s+/i, "").split(" ")[0] ?? name;
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

function HeadBack({ minutes, label, ride, onFinish }: { minutes: number; label?: string; ride?: ReactNode; onFinish: () => void }) {
  return (
    <>
      <div className="eyebrow" style={{ color: "var(--color-accent-deep)" }}>
        Heading back
      </div>
      <h2 className="display" style={{ fontSize: 24, lineHeight: "30px", margin: "8px 0 0" }}>
        Time to head back · {Math.max(1, Math.round(minutes))} min
      </h2>
      <p style={{ marginTop: 8, color: "var(--color-slate)", fontSize: 14, lineHeight: "21px" }}>
        {label ? `The walk closes at ${label}.` : "The walk closes where you started."}
      </p>
      {ride}
      <button className="btn btn-primary btn-block" type="button" style={{ marginTop: 16 }} onClick={onFinish}>
        I’m back · finish walk
      </button>
    </>
  );
}

function DoneSheet({
  stops,
  km,
  minutes,
  onAgain,
  onTastes,
}: {
  stops: Stop[];
  km?: number;
  minutes?: number;
  onAgain: () => void;
  onTastes: () => void;
}) {
  const visited = stops.filter((stop) => stop.state === "visited");
  const best = [...visited].sort((a, b) => b.affinity - a.affinity)[0];
  const stats = [
    visited.length === 1 ? "1 stop" : `${visited.length} stops`,
    km ? `${km} km` : "",
    minutes && minutes >= 1 ? formatMinutes(minutes) : "",
  ].filter(Boolean);
  return (
    <>
      <div className="eyebrow" style={{ color: "var(--color-open)" }}>
        Walk complete
      </div>
      <h2 className="display" style={{ fontSize: 24, lineHeight: "30px", margin: "8px 0 0" }}>
        {stats.join(" · ")}
      </h2>
      {best ? (
        <p style={{ margin: "6px 0 0", fontSize: 14, lineHeight: "21px", color: "var(--color-plum)" }}>
          Best match: {best.name}, {pct(best.affinity)}%.
        </p>
      ) : null}
      <div style={{ marginTop: 6 }}>
        {(visited.length ? visited : stops).slice(0, 4).map((stop) => (
          <WalkRow key={`${stop.entityId}-${stop.state}`} stop={stop} />
        ))}
      </div>
      <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
        <button className="btn btn-cream" type="button" style={{ flex: 1 }} onClick={onTastes}>
          Change tastes
        </button>
        <button className="btn btn-primary" type="button" style={{ flex: 2 }} onClick={onAgain}>
          Plan another walk
        </button>
      </div>
    </>
  );
}

function WalkRow({ stop }: { stop: Stop }) {
  const skipped = stop.state === "skipped";
  const visited = stop.state === "visited";
  const fresh = Boolean(stop.introduced) && !skipped && !visited;
  const mark = visited ? "✓" : skipped ? "–" : String(stop.seq);
  const bubble = visited
    ? { background: "#3d8a5a", color: "#fff" }
    : fresh
      ? { background: "var(--color-flare)", color: "#fff" }
      : skipped
        ? { background: "var(--color-cream)", color: "var(--color-slate-dim)", boxShadow: "inset 0 0 0 1.5px var(--color-hairline)" }
        : { background: "#fff", color: "var(--color-slate-dim)", boxShadow: "inset 0 0 0 1.5px var(--color-hairline)" };
  const time = visited ? `${pct(stop.affinity)}%` : skipped ? "skipped" : fresh ? `${stop.walkMin} min` : `+${stop.walkMin} min`;
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

/** A pin's label is its coordinates, which read badly in a sentence. */
function placeLabel(label?: string): string | undefined {
  if (!label || /^-?\d+\.\d+,\s*-?\d+\.\d+$/.test(label.trim())) return undefined;
  return label;
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
