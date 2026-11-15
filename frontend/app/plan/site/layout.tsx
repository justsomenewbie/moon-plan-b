import type { Metadata } from "next";
import { pageMetadata } from "../../../lib/seo";

export const metadata: Metadata = pageMetadata("/plan/site", "Sun and Earth visibility details for one lunar landing site: hours in view, joint windows and the local sky over your dates.", "Site details");

export default function Layout({ children }: { children: React.ReactNode }) { return children; }
