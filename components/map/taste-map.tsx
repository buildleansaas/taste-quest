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
  onPick,
  className,
}: Props) {
  const node = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markers = useRef<maplibregl.Marker[]>([]);
  const pick = useRef(onPick);
  pick.current = onPick;
  const scene = useRef({ center, zoom, pitch, bearing, routes, pins, user, frame, pad, zoomOut });
  scene.current = { center, zoom, pitch, bearing, routes, pins, user, frame, pad, zoomOut };

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
    map.on("style.load", () => {
      recolor(map);
      paint(map, scene.current, markers);
    });
    map.on("error", () => node.current?.classList.add("tiles-failed"));
    map.on("click", (event) => {
      pick.current?.(event.lngLat.lat, event.lngLat.lng);
    });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // Created once. Later scene updates go through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const draw = () => paint(map, scene.current, markers);
    if (map.isStyleLoaded() && map.getLayer("b3d")) draw();
    else map.once("idle", draw);
  }, [routes, pins, user, center, zoom, pitch, bearing, frame, pad, zoomOut]);

  return <div ref={node} className={className ?? "map-stage"} />;
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
  },
  markers: MutableRefObject<maplibregl.Marker[]>,
) {
  markers.current.forEach((marker) => marker.remove());
  markers.current = [];
  props.routes.forEach((route, index) => {
    const id = `r${index}`;
    if (map.getLayer(`${id}c`)) map.removeLayer(`${id}c`);
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
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

  for (const pin of props.pins) {
    const el = document.createElement("div");
    el.className = `pin ${pin.cls ?? ""}`;
    el.style.setProperty("--c", pin.color || "#8c8cc8");
    el.innerHTML = `<div class="bubble"><i></i>${pin.n}</div><div class="stem"></div>${pin.label ? `<div class="label">${pin.label}</div>` : ""}`;
    markers.current.push(
      new maplibregl.Marker({ element: el, anchor: "bottom", offset: [0, pin.label ? 22 : 0] }).setLngLat(pin.ll).addTo(map),
    );
  }
  if (props.user) {
    const el = document.createElement("div");
    el.className = "user";
    el.innerHTML = '<div class="halo"></div><div class="cone"></div><div class="pulse"></div><div class="core"></div>';
    markers.current.push(new maplibregl.Marker({ element: el, pitchAlignment: "map" }).setLngLat(props.user).addTo(map));
  }

  if (props.frame && props.frame.length > 1) {
    const bounds = new maplibregl.LngLatBounds();
    props.frame.forEach((point) => bounds.extend(point));
    const camera = map.cameraForBounds(bounds, { padding: props.pad, bearing: props.bearing || 0 });
    if (camera && camera.zoom != null) {
      map.jumpTo({
        center: camera.center,
        zoom: camera.zoom - (props.zoomOut ?? 0.1),
        bearing: props.bearing || 0,
        pitch: props.pitch || 0,
      });
      return;
    }
  }
  map.jumpTo({ center: props.center, zoom: props.zoom, pitch: props.pitch, bearing: props.bearing });
}
