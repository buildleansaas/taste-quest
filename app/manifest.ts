import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "taste quest",
    short_name: "taste quest",
    description: "Walk the city you’d love.",
    display: "standalone",
    background_color: "#f8f6f4",
    theme_color: "#f8f6f4",
    start_url: "/",
    icons: [{ src: "/brand/mark.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
