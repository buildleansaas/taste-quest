"use client";

import { useEffect, useState } from "react";

/** True when the viewport is at least `px` CSS pixels wide. */
export function useMinWidth(px: number) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(`(min-width: ${px}px)`);
    const sync = () => setOn(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, [px]);
  return on;
}
