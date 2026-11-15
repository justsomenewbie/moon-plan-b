import type { Metadata } from "next";

export const metadata: Metadata = { title: { default: "Plan a lunar visit", template: "%s — Moon Plan B" } };

export default function Layout({ children }: { children: React.ReactNode }) { return children; }
