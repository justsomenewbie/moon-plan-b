import type { Metadata } from "next";
import { pageMetadata } from "../../lib/seo";

export const metadata: Metadata = pageMetadata("/orbit", "See where lunar landing sites sit on a rotating Moon globe and how the Sun and Earth move across each site’s sky.", "Orbit view");

export default function Layout({ children }: { children: React.ReactNode }) { return children; }
