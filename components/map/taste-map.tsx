"use client";

import { useEffect, useRef, type MutableRefObject } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

export type MapPin = {
  n: string | number;
  ll: [number, number];
  cls?: string;
  label?: string;
  color?: string;
  /** Accessible name for a tappable pin. */
  title?: string;
  onClick?: () => void;
  /** Lets the user drag the pin; onDragEnd gets the new lat/lon. */
  onDragEnd?: (lat: number, lon: number) => void;
};

export type MapRoute = {
  coords: [number, number][];
  ghost?: boolean;
  dashed?: boolean;
  color?: string;
};

export type MapPad = { top: number; bottom: number; left: number; right: number };

type Props = {
  center: [number, number];
  zoom?: number;
  pitch?: number;
  bearing?: number;
  routes?: MapRoute[];
  pins?: MapPin[];
  user?: [number, number];
  interactive?: boolean;
  /** Points passed to cameraForBounds, matching docs/design/screens/map.js `fit`. */
  frame?: [number, number][];
  pad?: MapPad;
  zoomOut?: number;
  /** Fit the frame with the pitched camera, so desktop bounds stay on screen. */
  fitPitch?: boolean;
  maxZoom?: number;
  /**
   * When set, the camera fits the scene only when this key changes (a new
   * route, or a Recenter tap) or before the user has moved the map. Overlay
   * updates such as a new GPS fix then never pull the camera away from where
   * the user panned. When unset, every update moves the camera (legacy).
   */
  fitKey?: string;
  onPick?: (lat: number, lon: number) => void;
  className?: string;
};

const COLORS = {
  land: "#f8f4f0",
  park: "#cfdcc6",
  water: "#d7e1e8",
  building: "#e7e2dd",
  road: "#ffffff",
  minor: "#ffffff",
  casing: "#e8e3dd",
  label: "#505a64",
};

/**
 * OpenFreeMap Positron, recoloured the same way as docs/design/screens/map.js.
 * Layer ids, paint keys, and the 3D building insert are copied from that file.
 */
export function TasteMap({
  center,
  zoom = 15.2,
  pitch = 0,
  bearing = 0,
  routes = [],
  pins = [],
  user,
  interactive = false,
  frame,
  pad,
  zoomOut = 0.1,
  fitPitch = false,
  maxZoom,
  fitKey,
  onPick,
  className,
}: Props) {
  const node = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markers = useRef<maplibregl.Marker[]>([]);
  const pick = useRef(onPick);
  pick.current = onPick;
  // Markers are rebuilt on every paint, which would drop a pin mid-drag.
  // While a drag is on, paints are skipped and run once when it ends.
  const dragging = useRef(false);
  const fitted = useRef<string | undefined>(undefined);
  const userMoved = useRef(false);
  const fitKeyRef = useRef(fitKey);
  fitKeyRef.current = fitKey;
  const repaint = useRef<() => void>(() => undefined);
  const dragHooks = useRef({
    start: () => {
      dragging.current = true;
    },
    end: () => {
      dragging.current = false;
      repaint.current();
    },
  }).current;
  const shouldFit = () => {
    const key = fitKeyRef.current;
    if (key === undefined) return true;
    if (key !== fitted.current) {
      fitted.current = key;
      userMoved.current = false;
      return true;
    }
    return !userMoved.current;
  };
  const scene = useRef({ center, zoom, pitch, bearing, routes, pins, user, frame, pad, zoomOut, fitPitch, maxZoom });
  scene.current = { center, zoom, pitch, bearing, routes, pins, user, frame, pad, zoomOut, fitPitch, maxZoom };

  useEffect(() => {
    if (!node.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: node.current,
      style: "https://tiles.openfreemap.org/styles/positron",
      center,
      zoom,
      pitch,
      bearing,
      interactive,
      attributionControl: false,
      fadeDuration: 0,
      preserveDrawingBuffer: true,
    });
    const apply = () => {
      map.resize();
      // `style.load` means the stylesheet is ready. `isStyleLoaded()` stays
      // false until every tile source finishes, so it must not gate overlays.
      if (!map.getStyle()?.layers?.length) return;
      try {
        recolor(map);
        paint(map, scene.current, markers, shouldFit(), dragHooks);
      } catch (err) {
        console.warn("map paint", err);
      }
    };
    // Only gestures carry an originalEvent; our own jumpTo calls do not.
    const markMoved = (event: { originalEvent?: unknown }) => {
      if (event.originalEvent) userMoved.current = true;
    };
    map.on("dragstart", markMoved);
    map.on("zoomstart", markMoved);
    map.on("rotatestart", markMoved);
    map.on("pitchstart", markMoved);
    map.on("style.load", apply);
    map.on("error", (event) => {
      console.warn("map", event.error?.message ?? event);
      node.current?.classList.add("tiles-failed");
    });
    map.on("click", (event) => {
      pick.current?.(event.lngLat.lat, event.lngLat.lng);
    });
    const observer = new ResizeObserver(() => {
      if ((node.current?.clientHeight ?? 0) < 32) return;
      apply();
    });
    observer.observe(node.current);
    const onOrient = () => {
      window.setTimeout(() => apply(), 80);
    };
    window.addEventListener("orientationchange", onOrient);
    mapRef.current = map;
    return () => {
      observer.disconnect();
      window.removeEventListener("orientationchange", onOrient);
      map.off("style.load", apply);
      map.remove();
      mapRef.current = null;
    };
    // Created once. Later scene updates go through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  repaint.current = () => {
    const map = mapRef.current;
    if (!map?.getStyle()?.layers?.length) return;
    try {
      paint(map, scene.current, markers, false, dragHooks);
    } catch (err) {
      console.warn("map paint", err);
    }
  };

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getStyle()?.layers?.length) return;
    if (dragging.current) return;
    try {
      if (!map.getLayer("b3d")) recolor(map);
      paint(map, scene.current, markers, shouldFit(), dragHooks);
    } catch (err) {
      console.warn("map paint", err);
    }
    // shouldFit reads fitKey through a ref; fitKey is listed so a Recenter repaints.
  }, [routes, pins, user, center, zoom, pitch, bearing, frame, pad, zoomOut, fitPitch, maxZoom, fitKey, dragHooks]);

  return <div ref={node} className={className ?? "map-fill"} />;
}

function fitPad(pad: MapPad | undefined, width: number, height: number): MapPad | undefined {
  if (!pad) return undefined;
  const sy = (height - 48) / (pad.top + pad.bottom);
  const sx = (width - 32) / (pad.left + pad.right);
  const scale = Math.min(1, sy, sx);
  if (!Number.isFinite(scale) || scale >= 1) return pad;
  return {
    top: Math.max(8, pad.top * scale),
    bottom: Math.max(8, pad.bottom * scale),
    left: Math.max(8, pad.left * scale),
    right: Math.max(8, pad.right * scale),
  };
}

function recolor(map: maplibregl.Map) {
  const style = map.getStyle();
  for (const layer of style.layers ?? []) {
    const id = layer.id;
    try {
      if (layer.type === "background") map.setPaintProperty(id, "background-color", COLORS.land);
      else if (id === "park" || id === "landcover_wood") {
        map.setPaintProperty(id, "fill-color", COLORS.park);
        map.setPaintProperty(id, "fill-opacity", 1);
      } else if (id === "water") map.setPaintProperty(id, "fill-color", COLORS.water);
      else if (id === "waterway") map.setPaintProperty(id, "line-color", COLORS.water);
      else if (id === "landuse_residential") map.setPaintProperty(id, "fill-color", COLORS.land);
      else if (id === "building") map.setLayoutProperty(id, "visibility", "none");
      else if (layer.type === "line" && /casing/.test(id)) map.setPaintProperty(id, "line-color", COLORS.casing);
      else if (layer.type === "line" && /highway_(major|motorway)_(inner|subtle)/.test(id)) map.setPaintProperty(id, "line-color", COLORS.road);
      else if (layer.type === "line" && /highway_(minor|path)/.test(id)) map.setPaintProperty(id, "line-color", COLORS.road);
      else if (layer.type === "line" && /railway|boundary/.test(id)) map.setLayoutProperty(id, "visibility", "none");
      else if (layer.type === "symbol") {
        if (/shield|airport|label_country|label_state/.test(id)) map.setLayoutProperty(id, "visibility", "none");
        else {
          map.setPaintProperty(id, "text-color", COLORS.label);
          map.setPaintProperty(id, "text-halo-color", "#f8f4f0");
        }
      }
    } catch {
      /* some layers reject a paint key */
    }
  }
  if (!map.getLayer("b3d")) {
    const before = map.getLayer("highway-name-path") ? "highway-name-path" : undefined;
    map.addLayer(
      {
        id: "b3d",
        type: "fill-extrusion",
        source: "openmaptiles",
        "source-layer": "building",
        minzoom: 13,
        paint: {
          "fill-extrusion-color": COLORS.building,
          "fill-extrusion-height": ["*", 0.45, ["coalesce", ["get", "render_height"], 8]],
          "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
          "fill-extrusion-opacity": 0.75,
        },
      },
      before,
    );
  }
}

function paint(
  map: maplibregl.Map,
  props: {
    routes: MapRoute[];
    pins: MapPin[];
    user?: [number, number];
    center: [number, number];
    zoom: number;
    pitch: number;
    bearing: number;
    frame?: [number, number][];
    pad?: MapPad;
    zoomOut: number;
    fitPitch?: boolean;
    maxZoom?: number;
  },
  markers: MutableRefObject<maplibregl.Marker[]>,
  moveCamera = true,
  drag?: { start: () => void; end: () => void },
) {
  markers.current.forEach((marker) => marker.remove());
  markers.current = [];
  // Remove every route layer from the last paint, including indices the new
  // scene no longer has, so an older walk's line never lingers.
  for (const layer of map.getStyle().layers ?? []) {
    if (/^r\d+c?$/.test(layer.id)) map.removeLayer(layer.id);
  }
  for (const source of Object.keys(map.getStyle().sources ?? {})) {
    if (/^r\d+$/.test(source)) map.removeSource(source);
  }
  props.routes.forEach((route, index) => {
    const id = `r${index}`;
    map.addSource(id, {
      type: "geojson",
      data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: route.coords } },
    });
    if (route.ghost) {
      map.addLayer({
        id,
        type: "line",
        source: id,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#a0aab4", "line-width": 4, "line-dasharray": [0.1, 2], "line-opacity": 0.8 },
      });
      return;
    }
    if (route.dashed) {
      map.addLayer({
        id,
        type: "line",
        source: id,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": route.color || "#8c8cc8",
          "line-width": 5,
          "line-dasharray": [1.2, 1.4],
          "line-opacity": 0.9,
        },
      });
      return;
    }
    map.addLayer({
      id: `${id}c`,
      type: "line",
      source: id,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#ffffff", "line-width": 10 },
    });
    map.addLayer({
      id,
      type: "line",
      source: id,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": route.color || "#8c8cc8", "line-width": 5.5 },
    });
  });

  // The user dot goes in first so pins stack above it: at the start of a loop
  // it sits on the start pin, which must stay grabbable.
  if (props.user) {
    const el = document.createElement("div");
    el.className = "user";
    el.innerHTML = '<div class="halo"></div><div class="cone"></div><div class="pulse"></div><div class="core"></div>';
    markers.current.push(new maplibregl.Marker({ element: el, pitchAlignment: "map" }).setLngLat(props.user).addTo(map));
  }
  for (const pin of props.pins) {
    const el = document.createElement("div");
    el.className = `pin ${pin.cls ?? ""}`;
    el.style.setProperty("--c", pin.color || "#8c8cc8");
    const mark = pin.cls?.split(" ").includes("home")
      ? `<svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 9.2 10 3.8l6.5 5.4V16.5H12v-4.2H8v4.2H3.5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`
      : pin.cls?.split(" ").includes("alt")
        ? `<svg width="12" height="12" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`
        : `${pin.n}`;
    el.innerHTML = `<div class="bubble"><i></i>${mark}</div><div class="stem"></div>${pin.label ? `<div class="label">${pin.label}</div>` : ""}`;
    if (pin.onClick) {
      const onClick = pin.onClick;
      el.setAttribute("role", "button");
      el.setAttribute("tabindex", "0");
      if (pin.title) el.setAttribute("aria-label", pin.title);
      el.addEventListener("click", (event) => {
        event.stopPropagation();
        onClick();
      });
      el.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      });
    }
    const marker = new maplibregl.Marker({
      element: el,
      anchor: "bottom",
      offset: [0, pin.label ? 22 : 0],
      draggable: Boolean(pin.onDragEnd),
    }).setLngLat(pin.ll);
    if (pin.onDragEnd) {
      const onDragEnd = pin.onDragEnd;
      if (pin.title) el.setAttribute("aria-label", pin.title);
      marker.on("dragstart", () => drag?.start());
      marker.on("dragend", () => {
        const at = marker.getLngLat();
        drag?.end();
        onDragEnd(at.lat, at.lng);
      });
    }
    markers.current.push(marker.addTo(map));
    // addTo() labels every marker "Map marker"; restore ours after it.
    if (pin.title) el.setAttribute("aria-label", pin.title);
  }

  if (!moveCamera) return;
  if (props.frame && props.frame.length > 1) {
    const bounds = new maplibregl.LngLatBounds();
    props.frame.forEach((point) => bounds.extend(point));
    const height = map.getContainer().clientHeight || 1;
    const width = map.getContainer().clientWidth || 1;
    const pad = fitPad(props.pad, width, height);
    const fittedZoom = props.maxZoom;
    // Omit maxZoom when unset. MapLibre copies the key even if the value is
    // undefined and then Math.min(zoom, undefined) is NaN, which skips the fit.
    const camera = map.cameraForBounds(bounds, {
      padding: pad,
      bearing: props.bearing || 0,
      ...(props.fitPitch ? { pitch: props.pitch || 0 } : {}),
      ...(fittedZoom != null ? { maxZoom: fittedZoom } : {}),
    });
    if (camera && camera.zoom != null && Number.isFinite(camera.zoom)) {
      const raw = camera.zoom - (props.zoomOut ?? 0.1);
      const zoom = fittedZoom != null ? Math.min(raw, fittedZoom) : raw;
      map.jumpTo({
        center: camera.center,
        zoom,
        bearing: props.bearing || 0,
        pitch: props.pitch || 0,
      });
      return;
    }
  }
  map.jumpTo({ center: props.center, zoom: props.zoom, pitch: props.pitch, bearing: props.bearing });
}
