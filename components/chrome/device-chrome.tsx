"use client";

import { usePathname } from "next/navigation";

/**
 * Fake 9:41 status bar and home indicator from the design screens.
 * Shown only when `?frame=1` (or `?shot=1`) sets `html[data-frame]`, so parity
 * shots still line up. Real phones, including an installed PWA, use the system chrome.
 */
export function DeviceChrome() {
  const path = usePathname();
  const light = path === "/";
  const color = light ? "#fff" : "currentColor";
  return (
    <>
      <div className={light ? "status light" : "status"} aria-hidden="true">
        <span>9:41</span>
        <span className="icons">
          <svg width="18" height="12" viewBox="0 0 18 12">
            <g fill={color}>
              <rect x="0" y="8" width="3" height="4" rx="1" />
              <rect x="5" y="5.5" width="3" height="6.5" rx="1" />
              <rect x="10" y="3" width="3" height="9" rx="1" />
              <rect x="15" y="0" width="3" height="12" rx="1" />
            </g>
          </svg>
          <svg width="17" height="12" viewBox="0 0 17 12">
            <path fill={color} d="M8.5 2.2c2.3 0 4.4.9 6 2.4l1.2-1.2C13.8 1.5 11.3.4 8.5.4S3.2 1.5 1.3 3.4l1.2 1.2c1.6-1.5 3.7-2.4 6-2.4zm0 3.5c1.4 0 2.6.5 3.6 1.4l1.2-1.2C12 4.7 10.3 4 8.5 4S5 4.7 3.7 5.9l1.2 1.2c1-.9 2.2-1.4 3.6-1.4zm0 3.4c.5 0 1 .2 1.3.5L8.5 11 7.2 9.6c.3-.3.8-.5 1.3-.5z" />
          </svg>
          <svg width="27" height="13" viewBox="0 0 27 13">
            <rect x=".5" y=".5" width="23" height="12" rx="3.5" fill="none" stroke={color} opacity=".4" />
            <rect x="2" y="2" width="18" height="9" rx="2" fill={color} />
            <path d="M25 4.5v4c.8-.3 1.3-1.1 1.3-2s-.5-1.7-1.3-2z" fill={color} opacity=".5" />
          </svg>
        </span>
      </div>
      <div className={light ? "home-ind light" : "home-ind"} aria-hidden="true" />
    </>
  );
}
