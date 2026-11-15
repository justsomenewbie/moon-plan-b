import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";
import "./night-sky.css";
import Providers from "./providers";

export const metadata: Metadata = {
  title: { default: "Moon Plan B — Sun & Earth comparison", template: "%s — Moon Plan B" },
  description: "Explore versioned Sun and Earth observations above a lunar horizon. Compare landing sites and dates using the archived terrain model or explore labeled practice data.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F6F7FA" },
    { media: "(prefers-color-scheme: dark)", color: "#0B0F1A" },
  ],
};

const body = Inter({ subsets: ["latin", "vietnamese"], variable: "--font-body", display: "swap" });
const heading = Space_Grotesk({ subsets: ["latin", "vietnamese"], weight: ["600"], variable: "--font-heading", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin", "vietnamese"], variable: "--font-mono", display: "swap" });

// Set the appearance before first paint with the same rule as lib/theme.ts: a stored choice, else light from 06:00 to 18:00 local time.
const themeScript = `(function(){var t=null;try{t=localStorage.getItem("moon-plan-b-theme")}catch(e){}var h=new Date().getHours();document.documentElement.dataset.theme=t==="light"||t==="dark"?t:h>=6&&h<18?"light":"dark"})()`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en" className={`${body.variable} ${heading.variable} ${mono.variable}`} suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head><body><Providers>{children}</Providers></body></html>;
}
