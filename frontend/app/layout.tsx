import type { Metadata } from "next";
import "./globals.css";
import Providers from "./providers";

export const metadata: Metadata = {
  title: "Moon Plan B — Sun & Earth comparison",
  description: "Explore versioned Sun and Earth observations above a lunar horizon. The included demonstration is synthetic, not lunar data.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body><Providers>{children}</Providers></body></html>;
}
