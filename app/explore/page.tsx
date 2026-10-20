"use client";

import dynamic from "next/dynamic";

const ExploreScreen = dynamic(() => import("@/components/explore/explore-screen").then((mod) => mod.ExploreScreen), {
  ssr: false,
});

export default function Page() {
  return <ExploreScreen />;
}
