import type { Metadata } from "next";
import { pageMetadata } from "../../lib/seo";

export const metadata: Metadata = pageMetadata("/data", "Browse the datasets behind Moon Plan B: saved model runs, site catalog, terrain sources from NASA LRO and ephemerides from JPL Horizons, with downloads.", "Data catalog");

export default function Layout({ children }: { children: React.ReactNode }) { return children; }
