"use client";

import { useState } from "react";
import { TasteMap } from "@/components/map/taste-map";

export function MapPicker({
  lat,
  lon,
  onClose,
  onConfirm,
  onDemo,
}: {
  lat: number;
  lon: number;
  onClose: () => void;
  onConfirm: (lat: number, lon: number) => void;
  onDemo: () => void;
}) {
  const [point, setPoint] = useState({ lat, lon });
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 40, background: "var(--color-surface)" }}>
      <div style={{ position: "absolute", inset: 0 }}>
        <TasteMap
          center={[point.lon, point.lat]}
          interactive
          zoom={14}
          pitch={0}
          bearing={0}
          onPick={(nextLat, nextLon) => setPoint({ lat: nextLat, lon: nextLon })}
          pins={[{ n: "", ll: [point.lon, point.lat], cls: "next", color: "#8c8cc8" }]}
        />
      </div>
      <div className="sheet" style={{ height: "calc(206px + var(--sab))" }}>
        <div className="grabber" />
        <div style={{ padding: 20 }}>
          <div style={{ fontWeight: 600 }}>Drop a pin</div>
          <div style={{ fontSize: 13, color: "var(--color-slate-dim)", marginTop: 4 }}>
            Tap the map where you want to start · {point.lat.toFixed(4)}, {point.lon.toFixed(4)}
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
            <button className="btn btn-cream" type="button" style={{ flex: 1 }} onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" type="button" style={{ flex: 2 }} onClick={() => onConfirm(point.lat, point.lon)}>
              Start here
            </button>
          </div>
          <button type="button" onClick={onDemo} style={{ marginTop: 10, height: 36, background: "none", border: 0, color: "var(--color-slate)", width: "100%" }}>
            Use Austin demo start
          </button>
        </div>
      </div>
    </div>
  );
}
