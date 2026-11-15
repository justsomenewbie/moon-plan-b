import type { MapPoint } from "./globe-sites";

type Raster = { width: number; height: number; data: Uint8ClampedArray };

export function globeCenter(longitude: number, latitude: number) {
  return { longitude: ((longitude + 180) % 360 + 360) % 360 - 180, latitude: Math.max(-90, Math.min(90, latitude)) };
}

type DiskPoint = { x: number; y: number };
const radians = Math.PI / 180;
const tolerance = 1e-12;

// Screen coordinates run right and down in viewport radii, independent of magnification.
function surfaceNormal(position: DiskPoint, zoom: number) {
  if (!Number.isFinite(zoom) || zoom <= 0 || !(Math.hypot(position.x, position.y) <= 1 + tolerance)) return null;
  const east = position.x / zoom, north = -position.y / zoom;
  const depthSquared = 1 - east * east - north * north;
  if (depthSquared < -tolerance) return null;
  return { east, north, depth: Math.sqrt(Math.max(0, depthSquared)) };
}

export function globePointAt(center: MapPoint, zoom: number, position: DiskPoint): MapPoint | null {
  const normal = surfaceNormal(position, zoom);
  if (!normal || !Number.isFinite(center.longitude) || !(Math.abs(center.latitude) <= 90)) return null;
  const { east, north, depth } = normal;
  const latitude = center.latitude * radians;
  const cos = Math.cos(latitude), sin = Math.sin(latitude);
  const polar = north * cos + depth * sin;
  const parallel = depth * cos - north * sin;
  return globeCenter(center.longitude + Math.atan2(east, parallel) / radians,
    Math.atan2(polar, Math.hypot(east, parallel)) / radians);
}

export function globeCenterForAnchor(anchor: MapPoint, position: DiskPoint, zoom: number, previousCenter: MapPoint): MapPoint {
  const normal = surfaceNormal(position, zoom);
  if (!normal || !Number.isFinite(anchor.longitude) || !(Math.abs(anchor.latitude) <= 90)) return previousCenter;
  const { east, north, depth } = normal;
  const latitude = anchor.latitude * radians;
  const polar = Math.sin(latitude), radius = Math.cos(latitude);
  // A near-polar landmark cannot reach every horizontal pixel in a north-up projection.
  if (Math.abs(east) > radius + tolerance) return previousCenter;
  const meridianLength = Math.sqrt(Math.max(0, (radius - east) * (radius + east)));
  let nearest = previousCenter, leastTurn = Infinity;
  // Both sides of the central meridian can solve the same north-up projection near a pole.
  for (const parallel of [meridianLength, -meridianLength]) {
    const tilt = Math.hypot(north, depth) < tolerance ? previousCenter.latitude :
      Math.atan2(depth * polar - north * parallel, depth * parallel + north * polar) / radians;
    if (Math.abs(tilt) > 90 + tolerance) continue;
    const longitude = radius < tolerance ? previousCenter.longitude : anchor.longitude - Math.atan2(east, parallel) / radians;
    const candidate = globeCenter(longitude, tilt);
    const turn = Math.hypot(globeCenter(candidate.longitude - previousCenter.longitude, 0).longitude,
      candidate.latitude - previousCenter.latitude);
    if (turn < leastTurn) { nearest = candidate; leastTurn = turn; }
  }
  return nearest;
}

// The subsolar normal in camera east, north and forward axes, or undefined for the fixed reference lighting.
export function sunDirection(longitude: number, latitude: number, subsolar?: MapPoint): [number, number, number] | undefined {
  if (!subsolar) return undefined;
  const lat = latitude * Math.PI / 180, sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  const phi = subsolar.latitude * Math.PI / 180, delta = subsolar.longitude * Math.PI / 180 - longitude * Math.PI / 180;
  const projected = Math.cos(phi) * Math.cos(delta);
  return [Math.cos(phi) * Math.sin(delta), Math.sin(phi) * cosLat - projected * sinLat, Math.sin(phi) * sinLat + projected * cosLat];
}

// Inverse orthographic projection of a north-up, zero-meridian-centered color map.
// The WebGL renderer in moon-globe-gl.ts ports this function; keep the two in step.
export function drawGlobe(texture: Raster, frame: Raster, longitude: number, latitude: number, zoom = 1, subsolar?: MapPoint) {
  const lon = longitude * Math.PI / 180, lat = latitude * Math.PI / 180;
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  // Transform the subsolar normal to camera east, north and forward axes once per frame.
  const [sunX, sunY, sunZ] = sunDirection(longitude, latitude, subsolar) ?? [0, 0, 0];
  const { width: w, height: h, data: pixels } = texture;
  const radius = zoom * Math.min(frame.width, frame.height) / 2;
  for (let row = 0; row < frame.height; row++) {
    const y = (frame.height / 2 - row - 0.5) / radius;
    for (let col = 0; col < frame.width; col++) {
      const x = (col + 0.5 - frame.width / 2) / radius;
      const depth = 1 - x * x - y * y;
      const output = 4 * (row * frame.width + col);
      if (depth < 0) { frame.data[output + 3] = 0; continue; }
      const z = Math.sqrt(depth);
      const u = 0.5 + (lon + Math.atan2(x, z * cosLat - y * sinLat)) / (2 * Math.PI);
      const v = 0.5 - Math.asin(Math.max(-1, Math.min(1, y * cosLat + z * sinLat))) / Math.PI;
      const tx = (u - Math.floor(u)) * w - 0.5;
      const ty = Math.max(0, Math.min(h - 1, v * h - 0.5));
      const x0 = (Math.floor(tx) + w) % w, x1 = (x0 + 1) % w;
      const y0 = Math.floor(ty), y1 = Math.min(y0 + 1, h - 1);
      const fx = tx - Math.floor(tx), fy = ty - y0;
      // The small map floor keeps the night side legible; it does not represent measured irradiance.
      const shade = subsolar ? 0.13 + 0.87 * Math.max(0, x * sunX + y * sunY + z * sunZ) : 0.64 + 0.36 * z;
      for (let channel = 0; channel < 3; channel++) {
        const top = pixels[4 * (y0 * w + x0) + channel] * (1 - fx) + pixels[4 * (y0 * w + x1) + channel] * fx;
        const bottom = pixels[4 * (y1 * w + x0) + channel] * (1 - fx) + pixels[4 * (y1 * w + x1) + channel] * fx;
        frame.data[output + channel] = (top * (1 - fy) + bottom * fy) * shade;
      }
      frame.data[output + 3] = 255;
    }
  }
}
