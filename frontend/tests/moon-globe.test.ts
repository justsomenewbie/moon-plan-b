import assert from "node:assert/strict";
import test from "node:test";
import { drawGlobe, globeCenter } from "../lib/moon-globe.ts";

// Red encodes longitude columns, green latitude rows. Angles are independent of fixture observations.
const texture = { width: 4, height: 2, data: new Uint8ClampedArray(
  [30, 210].flatMap(g => [20, 60, 100, 140].flatMap(r => [r, g, 0, 255]))) };
const frame = (size: number) => ({ width: size, height: size, data: new Uint8ClampedArray(size * size * 4) });

test("globe center samples the correct hemisphere, wraps the longitude seam and clamps at poles", () => {
  const image = frame(1);
  for (const [lon, lat, r, g] of [[0,0,80,120], [45,0,100,120], [-45,0,60,120], [180,0,80,120], [-180,0,80,120], [0,90,80,30], [0,-90,80,210]]) {
    drawGlobe(texture, image, lon, lat);
    assert.deepEqual([...image.data], [r, g, 0, 255]);
  }
  assert.deepEqual(globeCenter(210, 115), { longitude: -150, latitude: 90 });
  assert.deepEqual(globeCenter(-210, -115), { longitude: 150, latitude: -90 });
});

test("visible disk is north-up, east-right and clips pixels outside the sphere", () => {
  const image = frame(7);
  drawGlobe(texture, image, 0, 0);
  const pixel = (x: number, y: number, channel: number) => image.data[4 * (7 * y + x) + channel];
  assert.equal(pixel(0, 0, 3), 0);
  assert.equal(pixel(3, 3, 3), 255);
  assert.ok(pixel(1, 3, 0) < pixel(5, 3, 0));
  assert.ok(pixel(3, 1, 1) < pixel(3, 5, 1));
});
