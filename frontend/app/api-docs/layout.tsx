import type { Metadata } from "next";
import { pageMetadata } from "../../lib/seo";

export const metadata: Metadata = pageMetadata("/api-docs", "Interactive OpenAPI documentation for the Moon Plan B visibility API: datasets, terrain windows and site rankings.", "API explorer");

export default function Layout({ children }: { children: React.ReactNode }) { return children; }
