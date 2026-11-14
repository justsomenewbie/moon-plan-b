import type { Dataset } from "./dataset.ts";

export type GlobeSite = Dataset["sites"][number];
export type MapPoint = { latitude: number; longitude: number };

export const missionSites = [
  { name: "Odysseus · IM-1", latitude: -80.13, longitude: 1.44, source: "https://www.nasa.gov/missions/lro/nasas-lro-images-intuitive-machines-odysseus-lander/" },
  { name: "Athena · IM-2", latitude: -84.7906, longitude: 29.1957, source: "https://lroc.im-ldi.com/featured_sites/im2/flip-book" },
] as const;

export function comparisonLocation(site: GlobeSite, evidence: Dataset["evidence"]): { point: MapPoint } | { reason: string } {
  if (!site.location) return { reason: "This release supplies no coordinates for this site." };
  if (evidence === "synthetic-fixture") return { reason: "This release contains fictional sites." };
  if (!site.sourceIds.length) return { reason: "This site has no coordinate source." };
  // The draft carries free text. Only accept explicit frame and latitude conventions.
  const frame = site.location.frame.trim().toUpperCase();
  const terms = frame.split(/[\s,;:()]+/).filter(Boolean);
  if (terms.length !== 2 || !terms.includes("MOON_ME_DE421") || !terms.includes("PLANETOCENTRIC")) {
    return { reason: "The reported frame or latitude convention has no verified mapping to this globe." };
  }
  return { point: { latitude: site.location.latitudeDeg, longitude: site.location.longitudeEastDeg } };
}

// Forward projection paired with drawGlobe's inverse, in fractions of the disk radius.
export function diskPosition(site: MapPoint, center: MapPoint) {
  const rad = Math.PI / 180;
  const lat = site.latitude * rad, viewLat = center.latitude * rad;
  const delta = (site.longitude - center.longitude) * rad;
  const north = Math.sin(lat), parallel = Math.cos(lat) * Math.cos(delta);
  const depth = north * Math.sin(viewLat) + parallel * Math.cos(viewLat);
  if (depth <= 1e-10) return null;
  return {
    x: Math.cos(lat) * Math.sin(delta),
    y: -north * Math.cos(viewLat) + parallel * Math.sin(viewLat),
  };
}
