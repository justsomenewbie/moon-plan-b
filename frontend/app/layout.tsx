import type { Metadata } from "next";
import "./globals.css";
import "./night-sky.css";
import Providers from "./providers";

export const metadata: Metadata = {
  title: "Moon Plan B — Sun & Earth comparison",
  description: "Explore versioned Sun and Earth observations above a lunar horizon. Compare landing sites and dates using the archived terrain model or explore labeled practice data.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body><Providers>{children}</Providers></body></html>;
}
