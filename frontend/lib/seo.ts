// Shared page metadata: one canonical origin, one social image. Next replaces (does not merge) nested
// objects such as openGraph, so every route builds its complete set here.
import type { Metadata } from "next";

export const siteUrl = "https://lunavigator.com";
export const siteName = "Moon Plan B";
export const siteDescription = "Compare lunar south-pole landing sites and dates by the hours the Sun and Earth are both above the local horizon, using NASA LRO terrain and JPL Horizons data.";
/** Routes listed in the sitemap, in menu order. */
export const publicRoutes = ["/", "/compare", "/plan", "/compare-dates", "/orbit", "/data", "/api-docs"] as const;

const socialImage = { url: "/brand/og-image.png", width: 1200, height: 630, alt: "Moon Plan B — Sun and Earth visibility for lunar landing sites" };

export function pageMetadata(path: string, description: string, title?: string): Metadata {
  const socialTitle = title ? `${title} — ${siteName}` : `${siteName} — Sun & Earth comparison`;
  return {
    ...(title ? { title } : {}),
    description,
    alternates: { canonical: path },
    openGraph: { type: "website", siteName, locale: "en_US", alternateLocale: ["vi_VN"], url: path, title: socialTitle, description, images: [socialImage] },
    twitter: { card: "summary_large_image", title: socialTitle, description, images: [socialImage] },
  };
}
