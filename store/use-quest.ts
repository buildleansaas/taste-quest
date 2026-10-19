"use client";

import { get, set, del } from "idb-keyval";
import { create } from "zustand";
import { DEMO_START, demoProfile } from "@/lib/taste/curated";
import type { Budget, StartPoint, TasteProfile, Walk } from "@/lib/types";

const LS_KEY = "tq:v1:snapshot";

export type Snapshot = {
  deviceId: string;
  profile: TasteProfile | null;
  budget: Budget | null;
  start: StartPoint | null;
  walk: Walk | null;
  needsPlan: boolean;
  storage: "local" | "memory";
};

type QuestState = Snapshot & {
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setProfile: (profile: TasteProfile) => void;
  setBudget: (budget: Budget) => void;
  setStart: (start: StartPoint) => void;
  setWalk: (walk: Walk | null) => void;
  setNeedsPlan: (needsPlan: boolean) => void;
  startDemo: () => void;
  clearAll: () => Promise<void>;
};

function blank(deviceId = ""): Snapshot {
  return {
    deviceId,
    profile: null,
    budget: null,
    start: null,
    walk: null,
    needsPlan: false,
    storage: "local",
  };
}

function persist(snapshot: Snapshot): Snapshot {
  const next = { ...snapshot };
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(snapshot));
    localStorage.setItem("tq:v1:active-walk", snapshot.walk?.id ?? "");
    next.storage = "local";
  } catch {
    next.storage = "memory";
  }
  void set("tq:v1:profile", snapshot.profile).catch(() => undefined);
  void set("tq:v1:walk:" + (snapshot.walk?.id ?? "none"), snapshot.walk).catch(() => undefined);
  void set("tq:v1:device", { deviceId: snapshot.deviceId, createdAt: new Date().toISOString() }).catch(
    () => undefined,
  );
  return next;
}

export const useQuest = create<QuestState>((setState, getState) => ({
  ...blank(),
  hydrated: false,
  hydrate: async () => {
    if (getState().hydrated) return;
    let snapshot = blank(crypto.randomUUID());
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) snapshot = { ...snapshot, ...(JSON.parse(raw) as Snapshot), storage: "local" };
    } catch {
      snapshot.storage = "memory";
    }
    if (!snapshot.profile) {
      try {
        const profile = (await get("tq:v1:profile")) as TasteProfile | undefined;
        if (profile) snapshot.profile = profile;
      } catch {
        snapshot.storage = "memory";
      }
    }
    if (!snapshot.deviceId) snapshot.deviceId = crypto.randomUUID();
    setState({ ...snapshot, hydrated: true });
  },
  setProfile: (profile) => setState(persist({ ...getState(), profile })),
  setBudget: (budget) => setState(persist({ ...getState(), budget })),
  setStart: (start) => setState(persist({ ...getState(), start })),
  setWalk: (walk) => setState(persist({ ...getState(), walk, needsPlan: false })),
  setNeedsPlan: (needsPlan) => setState(persist({ ...getState(), needsPlan })),
  startDemo: () => {
    const profile = demoProfile();
    setState(
      persist({
        ...getState(),
        profile,
        budget: { minutes: 120, mode: "2h", pace: "easy" },
        start: DEMO_START,
        walk: null,
        needsPlan: true,
      }),
    );
  },
  clearAll: async () => {
    const deviceId = getState().deviceId;
    try {
      localStorage.removeItem(LS_KEY);
      localStorage.removeItem("tq:v1:active-walk");
    } catch {
      /* private mode */
    }
    await del("tq:v1:profile").catch(() => undefined);
    setState({ ...blank(deviceId), hydrated: true, storage: getState().storage });
  },
}));
