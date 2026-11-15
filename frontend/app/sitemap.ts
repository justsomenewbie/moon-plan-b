import type { MetadataRoute } from "next";
import { publicRoutes, siteUrl } from "../lib/seo";

export default function sitemap(): MetadataRoute.Sitemap {
  return publicRoutes.map(path => ({
    url: siteUrl + (path === "/" ? "/" : path),
    changeFrequency: path === "/data" || path === "/api-docs" ? "monthly" : "weekly",
    priority: path === "/" ? 1 : path === "/compare" || path === "/plan" ? 0.9 : 0.6,
  }));
}
