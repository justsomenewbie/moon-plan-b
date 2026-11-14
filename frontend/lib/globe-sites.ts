import type { Dataset } from "./dataset.ts";

export type GlobeSite = Dataset["sites"][number];
export type MapPoint = { latitude: number; longitude: number };

type TerrainCoordinates = { id: string; lat_deg: number | null; lon_deg: number | null };
export type PairLocation = { id: string; name: string; reported?: MapPoint; location: { point: MapPoint } | { reason: string } };

export function pairLocation(row: { site_id: string; name: string }, catalog: readonly TerrainCoordinates[],
  included: readonly TerrainCoordinates[], conventions: { latitude: string | null; longitude: string | null }): PairLocation {
  const site = { id: row.site_id, name: row.name };
  const records = [included.find(s => s.id === site.id), catalog.find(s => s.id === site.id)];
  const located = records.find(s => s && s.lat_deg !== null && s.lon_deg !== null);
  if (!located || located.lat_deg === null || located.lon_deg === null)
    return { ...site, location: { reason: "This release supplies no coordinates for this site." } };
  const reported = { latitude: located.lat_deg, longitude: located.lon_deg };
  if (records.some(s => s && ((s.lat_deg !== null && s.lat_deg !== reported.latitude) ||
    (s.lon_deg !== null && s.lon_deg !== reported.longitude))))
    return { ...site, location: { reason: "The run catalog and dataset disagree on this location." } };
  // Only the producer's documented lunar mean-Earth, planetocentric, east-positive convention maps to this reference.
  if (conventions.latitude !== "deg planetocentric, [-90, 90]" || conventions.longitude !== "deg EAST, [0, 360), planetocentric, MOON_ME frame")
    return { ...site, reported, location: { reason: "The reported frame or latitude convention has no verified mapping to this globe." } };
  return { ...site, reported, location: { point: reported } };
}

export const missionSites = [
  { id: "im1_odysseus", name: "Odysseus · IM-1", latitude: -80.13, longitude: 1.44, source: "https://www.nasa.gov/missions/lro/nasas-lro-images-intuitive-machines-odysseus-lander/" },
  { id: "im2_athena", name: "Athena · IM-2", latitude: -84.7906, longitude: 29.1957, source: "https://lroc.im-ldi.com/featured_sites/im2/flip-book" },
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

// Aim between two sites using a spherical midpoint. Antipodes have no single visible shared face.
export function pairCenter(first: MapPoint, second?: MapPoint): MapPoint {
  if (!second) return first;
  const rad = Math.PI / 180;
  const lat1 = first.latitude * rad, lat2 = second.latitude * rad;
  const delta = (second.longitude - first.longitude) * rad;
  const x = Math.cos(lat1) + Math.cos(lat2) * Math.cos(delta);
  const y = Math.cos(lat2) * Math.sin(delta);
  const z = Math.sin(lat1) + Math.sin(lat2);
  if (Math.hypot(x, y, z) < 1e-10) return first;
  return { latitude: Math.atan2(z, Math.hypot(x, y)) / rad, longitude: ((first.longitude + Math.atan2(y, x) / rad + 540) % 360) - 180 };
}

// Forward projection paired with drawGlobe's inverse, in fractions of the disk radius.
export function diskPosition(site: MapPoint, center: MapPoint, zoom = 1) {
  const rad = Math.PI / 180;
  const lat = site.latitude * rad, viewLat = center.latitude * rad;
  const delta = (site.longitude - center.longitude) * rad;
  const north = Math.sin(lat), parallel = Math.cos(lat) * Math.cos(delta);
  const depth = north * Math.sin(viewLat) + parallel * Math.cos(viewLat);
  if (depth <= 1e-10) return null;
  const x = zoom * Math.cos(lat) * Math.sin(delta);
  const y = zoom * (-north * Math.cos(viewLat) + parallel * Math.sin(viewLat));
  return Math.hypot(x, y) <= 1 ? { x, y } : null;
}
