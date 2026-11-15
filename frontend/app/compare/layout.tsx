import type { Metadata } from "next";
import { pageMetadata } from "../../lib/seo";

export const metadata: Metadata = pageMetadata("/compare", "Compare two lunar landing sites or two dates side by side: hours of sunlight, Earth visibility and joint windows above the terrain horizon, with timelines and sky views.", "Comparison tool");

export default function Layout({ children }: { children: React.ReactNode }) { return children; }
