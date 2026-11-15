import type { Metadata } from "next";
import { pageMetadata } from "../../lib/seo";

export const metadata: Metadata = {
  ...pageMetadata("/plan", "Plan a lunar visit: rank south-pole landing sites for your dates, or find the best dates for a site, by hours of sunlight and Earth visibility.", "Plan a lunar visit"),
  title: { default: "Plan a lunar visit", template: "%s — Moon Plan B" },
};

export default function Layout({ children }: { children: React.ReactNode }) { return children; }
