import daily from "./horizons-daily-sunlight.json" with { type: "json" };
import type { MapPoint } from "./globe-sites";

export function plannerSunAt(utc: string): (MapPoint & { utc: string }) | undefined {
  const days = (Date.parse(utc) - Date.parse(daily.startUtc)) / 86400000;
  if (!Number.isInteger(days)) return;
  const sample = daily.days[days];
  if (sample) return { utc, longitude: sample[0] > 180 ? sample[0] - 360 : sample[0], latitude: sample[1] };
}

export const plannerSunSource = daily.query;

export function sunBearing(site: MapPoint, sun: MapPoint): number | undefined {
  const rad = Math.PI / 180;
  const lat = site.latitude * rad, solarLat = sun.latitude * rad;
  const delta = (sun.longitude - site.longitude) * rad;
  const east = Math.cos(solarLat) * Math.sin(delta);
  const north = Math.cos(lat) * Math.sin(solarLat) - Math.sin(lat) * Math.cos(solarLat) * Math.cos(delta);
  // Azimuth has no unique direction at a pole, zenith or nadir.
  if (Math.abs(site.latitude) === 90 || Math.hypot(east, north) < 1e-10) return;
  return (Math.atan2(east, north) / rad + 360) % 360;
}
