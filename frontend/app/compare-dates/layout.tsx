import type { Metadata } from "next";
import { pageMetadata } from "../../lib/seo";

export const metadata: Metadata = pageMetadata("/compare-dates", "Compare two date ranges at one lunar landing site to see which gives more hours with the Sun and Earth in view.", "Compare dates");

export default function Layout({ children }: { children: React.ReactNode }) { return children; }
