import assert from "node:assert/strict";
import test from "node:test";
import { comparisonLocation, diskPosition, missionSites } from "../lib/globe-sites.ts";
import type { GlobeSite } from "../lib/globe-sites.ts";
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


test("site marker follows the globe, crossing the seam and clipping the limb", () => {
  const center = { latitude: 0, longitude: 0 };
  assert.deepEqual(diskPosition(center, center), { x: 0, y: 0 });
  assert.equal(diskPosition({ latitude: 0, longitude: 90 }, center), null);
  assert.equal(diskPosition({ latitude: 0, longitude: 180 }, center), null);
  assert.ok(diskPosition({ latitude: 30, longitude: 0 }, center)!.y < 0);
  assert.ok(diskPosition({ latitude: 0, longitude: -179 }, { latitude: 0, longitude: 179 })!.x > 0);
  for (const target of [...missionSites, { latitude: 90, longitude: 120 }, { latitude: -90, longitude: -120 }]) {
    const projected = diskPosition(target, target)!;
    assert.ok(Math.hypot(projected.x, projected.y) < 1e-12);
  }
});

test("only a sourced, explicitly compatible comparison location can produce a map point", () => {
  const location = { latitudeDeg: 0, longitudeEastDeg: 0, elevationKm: 2, elevationDatum: "test", frame: "MOON_ME_DE421 (planetocentric)" };
  const site: GlobeSite = { id: "test", name: "test", location, sourceIds: ["test-source"] };
  const real = "computed-ephemeris";
  assert.deepEqual(comparisonLocation(site, real), { point: { latitude: 0, longitude: 0 } });
  assert.ok("point" in comparisonLocation({ ...site, location: { ...location, frame: "planetocentric; MOON_ME_DE421" } }, real));
  for (const frame of ["J2000", "MOON_PA_DE421", "MOON_ME_DE421", "MOON_ME_DE421 not planetocentric", "MOON_ME_DE421 planetographic"]) {
    assert.ok("reason" in comparisonLocation({ ...site, location: { ...location, frame } }, real));
  }
  assert.ok("reason" in comparisonLocation(site, "synthetic-fixture"));
  assert.ok("reason" in comparisonLocation({ ...site, sourceIds: [] }, real));
  assert.ok("reason" in comparisonLocation({ ...site, location: null }, real));
});

test("magnification keeps a site centered and clips zoomed points outside the circular viewport", () => {
  const view = { latitude: -58, longitude: 15 };
  const base = diskPosition(missionSites[0], view)!;
  const twice = diskPosition(missionSites[0], view, 2)!;
  assert.ok(Math.abs(twice.x - 2 * base.x) < 1e-12);
  assert.ok(Math.abs(twice.y - 2 * base.y) < 1e-12);
  assert.equal(diskPosition(missionSites[0], view, 4), null);
  assert.ok(Math.hypot(...Object.values(diskPosition(missionSites[1], missionSites[1], 4)!)) < 1e-12);
  const full = frame(7), close = frame(7);
  drawGlobe(texture, full, 15, -50);
  drawGlobe(texture, close, 15, -50, 4);
  assert.equal(full.data[3], 0);
  assert.equal(close.data[3], 255);
  assert.deepEqual(close.data.slice(96, 100), full.data.slice(96, 100));
});

test("dated sunlight maps the projected surface normal into the east-positive lunar frame", () => {
  const white = { width: 1, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255]) };
  const lit = (longitude: number, latitude: number, sunLongitude: number, sunLatitude: number, col = 2, row = 2) => {
    const view = frame(5);
    drawGlobe(white, view, longitude, latitude, 1, { longitude: sunLongitude, latitude: sunLatitude });
    return view.data[4 * (row * 5 + col)];
  };
  for (const [lon, lat] of [[126.617658, -1.557279], [41.450414, -1.541521], [-179, 60], [90, -90]]) {
    assert.equal(lit(lon, lat, lon, lat), 255);
    assert.equal(lit(lon + 180, -lat, lon, lat), 33);
  }
  assert.equal(lit(0, 0, 90, 0), 33); // Solar terminator crosses the central meridian.
  assert.ok(lit(0, 0, 90, 0, 4, 2) > lit(0, 0, 90, 0, 0, 2));
  assert.ok(lit(0, 0, 0, 90, 2, 0) > lit(0, 0, 0, 90, 2, 4));
  assert.equal(lit(150, 0, -180, 0), lit(150, 0, 180, 0));
});
