import type { Metadata } from "next";
import "./globals.css";
import "./night-sky.css";
import Providers from "./providers";

export const metadata: Metadata = {
  title: "Moon Plan B — Sun & Earth comparison",
  description: "Explore versioned Sun and Earth observations above a lunar horizon. Compare landing sites and dates using the archived terrain model or explore labeled practice data.",
  robots: { index: false, follow: false },
};

// Set the stored or device appearance before first paint; theme-control.tsx keeps it in sync afterwards.
const themeScript = `try{var t=localStorage.getItem("moon-plan-b-theme");document.documentElement.dataset.theme=t==="light"||t==="dark"?t:matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head><body><Providers>{children}</Providers></body></html>;
}
