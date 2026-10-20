"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Mark, QlooCredit } from "@/components/brand/qloo-credit";
import { DeviceChrome } from "@/components/chrome/device-chrome";
import { useQuest } from "@/store/use-quest";

const CHIPS = [
  { label: "Khruangbin", color: "#7a4fd6", opacity: 1 },
  { label: "Wes Anderson films", color: "#e38b1f", opacity: 1 },
  { label: "Natural wine", color: "#c08095", opacity: 0.75 },
  { label: "Record stores", color: "#1e90b8", opacity: 0.55 },
];

export function WelcomeScreen() {
  const router = useRouter();
  const hydrated = useQuest((s) => s.hydrated);
  const hydrate = useQuest((s) => s.hydrate);
  const profile = useQuest((s) => s.profile);
  const walk = useQuest((s) => s.walk);
  const storage = useQuest((s) => s.storage);
  const startDemo = useQuest((s) => s.startDemo);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!hydrated || !walk || walk.status === "done" || walk.status === "abandoned") return;
    router.replace("/explore");
  }, [hydrated, walk, router]);

  if (!hydrated) return <main className="screen" />;

  return (
    <main className="screen welcome">
      <DeviceChrome />
      <section className="welcome-hero">
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(60% 55% at 78% 22%, #5f8a98cc 0%, transparent 70%), radial-gradient(45% 50% at 62% 38%, #2b4a5a 0%, transparent 70%), radial-gradient(55% 45% at 85% 95%, #6b4a8acc 0%, transparent 70%), radial-gradient(50% 40% at 25% 105%, #3b2d5a 0%, transparent 70%), radial-gradient(40% 60% at 10% 10%, #0b1622 0%, transparent 70%)",
            filter: "blur(6px)",
          }}
        />
        <div style={{ position: "absolute", left: 24, top: 28, display: "flex", alignItems: "center", gap: 9 }}>
          <Mark />
          <span className="display" style={{ fontSize: 19, fontWeight: 600, letterSpacing: "-0.02em" }}>
            taste quest
          </span>
        </div>
        <div style={{ position: "absolute", left: 24, right: 20, top: 84, display: "flex", flexWrap: "wrap", gap: 8 }}>
          {CHIPS.map((chip, index) => (
            <span key={chip.label} className="geo-chip drift" style={{ opacity: chip.opacity, animationDelay: `${index * 0.8}s` }}>
              <span className="dot" style={{ background: chip.color }} />
              {chip.label}
            </span>
          ))}
        </div>
        <div style={{ position: "absolute", left: 24, right: 24, bottom: 32 }}>
          <div className="eyebrow" style={{ color: "#ffffffa6", marginBottom: 14 }}>
            Austin · 4 stops near you
          </div>
          <h1 className="display" style={{ fontSize: 40, lineHeight: "46px", fontWeight: 500, margin: 0 }}>
            Walk the city
            <br />
            you’d love.
          </h1>
          <p style={{ marginTop: 14, fontSize: 15, lineHeight: "23px", color: "#ffffffbf", maxWidth: 300 }}>
            Pick a few things you love. We’ll route a walk through places that fit you, and tell you why each one does.
          </p>
        </div>
      </section>

      <div className="welcome-side">
      {storage === "memory" ? (
        <p className="banner">Your walk won’t be saved on this device.</p>
      ) : null}

      <div className="welcome-actions">
        <button
          className="btn btn-primary btn-block"
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            startDemo();
            router.push("/explore");
          }}
        >
          {busy ? "Setting the demo…" : "Try the Austin demo"}
        </button>
        <button
          className="btn btn-cream btn-block"
          type="button"
          onClick={() => router.push(profile ? "/start" : "/onboarding")}
        >
          Start exploring
        </button>
        {profile ? (
          <button
            type="button"
            onClick={() => router.push("/onboarding")}
            style={{
              background: "transparent",
              border: 0,
              color: "var(--color-slate)",
              height: 40,
            }}
          >
            Edit tastes
          </button>
        ) : null}
      </div>
      <div className="welcome-credit">
        <QlooCredit />
      </div>
      </div>
    </main>
  );
}
