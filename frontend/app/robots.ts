import type { MetadataRoute } from "next";
import { siteUrl } from "../lib/seo";

export default function robots(): MetadataRoute.Robots {
  // The API relay and chat endpoint return JSON for the app, not pages.
  return { rules: [{ userAgent: "*", allow: "/", disallow: ["/api/", "/guide/"] }], sitemap: `${siteUrl}/sitemap.xml`, host: siteUrl };
}
