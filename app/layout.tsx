import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  title: "taste quest",
  description: "Walk the city you’d love. A taste-ranked walking route, explained.",
  applicationName: "taste quest",
  appleWebApp: { capable: true, title: "taste quest", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f8f6f4",
};

const frameBoot = `(function(){try{var q=new URLSearchParams(location.search);if(q.get("frame")==="0"){sessionStorage.removeItem("tq:frame");}else if(q.get("frame")==="1"||q.get("shot")==="1"){sessionStorage.setItem("tq:frame","1");}if(sessionStorage.getItem("tq:frame")==="1"){document.documentElement.dataset.frame="1";}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Script id="tq-frame" strategy="beforeInteractive">
          {frameBoot}
        </Script>
        {children}
      </body>
    </html>
  );
}
