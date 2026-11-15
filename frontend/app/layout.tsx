import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";
import "./night-sky.css";
import "./mobile.css";
import Providers from "./providers";
import { pageMetadata, siteDescription, siteName, siteUrl } from "../lib/seo";
import ThreeBackdrop from "./three/three-backdrop";

export const metadata: Metadata = {
  title: { default: "Moon Plan B — Sun & Earth comparison", template: "%s — Moon Plan B" },
  metadataBase: new URL(siteUrl),
  applicationName: siteName,
  // The home page's canonical, Open Graph and Twitter tags; every route layout replaces them with its own.
  ...pageMetadata("/", siteDescription),
  keywords: ["Moon", "lunar south pole", "landing site", "Sun visibility", "Earth visibility", "LRO", "JPL Horizons", "NASA Space Apps"],
  robots: { index: true, follow: true },
  icons: {
    icon: [
      { url: "/brand/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/brand/logo-256.png", sizes: "256x256", type: "image/png" },
    ],
    apple: "/brand/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  // One tag; theme-control.tsx keeps its content in step with the applied theme.
  themeColor: "#0B0F1A",
};

// `subsets` only chooses which files are preloaded; every subset stays in the CSS and loads on demand by unicode-range
// (Vietnamese text fetches its file when it first appears). Preload the Latin body and heading faces that paint the hero;
// the mono face labels small print and loads without a preload.
const body = Inter({ subsets: ["latin"], variable: "--font-body", display: "swap" });
const heading = Space_Grotesk({ subsets: ["latin"], weight: ["600"], variable: "--font-heading", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap", preload: false });

// After the load event, data-sky lets night-sky.css fetch the decorative star map.
// Set the appearance before first paint with the same rule as lib/theme.ts: a stored choice, else light from 06:00 to 18:00 local time.
const themeScript = `(function(){var t=null;try{t=localStorage.getItem("moon-plan-b-theme")}catch(e){}var h=new Date().getHours();document.documentElement.dataset.theme=t==="light"||t==="dark"?t:h>=6&&h<18?"light":"dark";addEventListener("load",function(){document.documentElement.dataset.sky="1"})})()`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en" className={`${body.variable} ${heading.variable} ${mono.variable}`} suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head><body><Providers>{children}</Providers><ThreeBackdrop /></body></html>;
}
