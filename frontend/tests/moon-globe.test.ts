import assert from "node:assert/strict";
import test from "node:test";
import { comparisonLocation, diskPosition, missionSites, pairLocation, pairCenter } from "../lib/globe-sites.ts";
import type { GlobeSite } from "../lib/globe-sites.ts";
import { plannerSunAt, sunBearing } from "../lib/planner-sunlight.ts";
import { drawGlobe, globeCenter, globePointAt, globeCenterForAnchor } from "../lib/moon-globe.ts";

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

test("pointer zoom keeps the same lunar surface at an off-center pixel, including near the seam", () => {
  const pointer = { x: 0.43, y: -0.28 };
  for (const center of [{ longitude: 174, latitude: 18 }, { longitude: -35, latitude: -75 }]) {
    const anchor = globePointAt(center, 1, pointer)!;
    const projected = diskPosition(anchor, center)!;
    assert.ok(Math.hypot(projected.x - pointer.x, projected.y - pointer.y) < 1e-12);
    const closer = globeCenterForAnchor(anchor, pointer, 3, center);
    const after = diskPosition(anchor, closer, 3)!;
    assert.ok(Math.hypot(after.x - pointer.x, after.y - pointer.y) < 1e-12);
    const restored = globeCenterForAnchor(anchor, pointer, 1, closer);
    const back = diskPosition(anchor, restored)!;
    assert.ok(Math.hypot(back.x - pointer.x, back.y - pointer.y) < 1e-12);
    assert.ok(Math.abs(globeCenter(restored.longitude - center.longitude, 0).longitude) < 1e-10);
    assert.ok(Math.abs(restored.latitude - center.latitude) < 1e-10);
  }
});

test("a moving pinch midpoint carries a south-polar landmark and preserves its original projection branch", () => {
  const center = { longitude: 24, latitude: -84 };
  const landmark = { longitude: 176, latitude: -88 };
  const originalPixel = diskPosition(landmark, center)!;
  const anchor = globePointAt(center, 1, originalPixel)!;
  const same = globeCenterForAnchor(anchor, originalPixel, 1, center);
  assert.ok(Math.hypot(same.longitude - center.longitude, same.latitude - center.latitude) < 1e-10);
  const midpoint = { x: -0.036, y: -0.09 };
  const zoomed = globeCenterForAnchor(anchor, midpoint, 3, center);
  const after = diskPosition(landmark, zoomed, 3)!;
  assert.ok(Math.hypot(midpoint.x - after.x, midpoint.y - after.y) < 1e-12);
});

test("unreachable polar, off-disk and invalid anchors preserve the current view", () => {
  const center = { longitude: 135, latitude: -81 };
  const pole = { longitude: -144, latitude: -90 };
  assert.equal(globeCenterForAnchor(pole, { x: 0.2, y: 0 }, 1, center), center);
  const centered = globeCenterForAnchor(pole, { x: 0, y: 0 }, 3, center);
  assert.equal(centered.longitude, center.longitude);
  assert.equal(centered.latitude, -90);
  for (const point of [{ x: 0.9, y: 0.9 }, { x: NaN, y: 0 }]) {
    assert.equal(globePointAt(center, 3, point), null);
    assert.equal(globeCenterForAnchor(pole, point, 3, center), center);
  }
  assert.equal(globePointAt(center, 0, { x: 0, y: 0 }), null);
  const limb = globePointAt({ longitude: 0, latitude: 0 }, 1, { x: 1, y: 0 })!;
  assert.deepEqual(limb, { longitude: 90, latitude: 0 });
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

test("terrain pair pins use exact site IDs, agreeing coordinates and the run's lunar convention", () => {
  const conventions = { latitude: "deg planetocentric, [-90, 90]", longitude: "deg EAST, [0, 360), planetocentric, MOON_ME frame" };
  const sites = [{ id: "a", lat_deg: 0, lon_deg: 0 }, { id: "b", lat_deg: -86.752966, lon_deg: 336.328186 }];
  for (const order of [sites, sites.toReversed()]) {
    for (const site of order) {
      const row = { site_id: site.id, name: "Same display name" };
      const expected = { point: { latitude: site.lat_deg, longitude: site.lon_deg } };
      assert.deepEqual(pairLocation(row, sites, sites.toReversed(), conventions).location, expected);
      assert.deepEqual(pairLocation(row, sites, [], conventions).location, expected);
      assert.deepEqual(pairLocation(row, [], sites, conventions).location, expected);
      const foreign = pairLocation(row, sites, [], { ...conventions, longitude: "west-positive PA coordinates" });
      assert.ok("reason" in foreign.location);
      assert.deepEqual(foreign.reported, expected.point);
    }
  }
  const row = { site_id: "a", name: "A" };
  assert.ok("reason" in pairLocation(row, [], [], conventions).location);
  assert.ok("reason" in pairLocation(row, [{ ...sites[0], lon_deg: null }], [], conventions).location);
  assert.equal(pairLocation(row, [{ ...sites[0], lon_deg: 1 }], sites, conventions).reported, undefined);
  assert.equal(pairLocation(row, [{ ...sites[0], lon_deg: 1, lat_deg: null }], sites, conventions).reported, undefined);
});

test("the initial pair view shows both sides of the longitude seam and falls back at antipodes", () => {
  const a = { latitude: 1, longitude: 23 }, b = { latitude: -86.75, longitude: 336.33 };
  for (const [first, second] of [[a, b], [b, a], [{ latitude: 5, longitude: 179 }, { latitude: 7, longitude: -179 }]]) {
    const center = pairCenter(first, second);
    assert.ok(diskPosition(first, center) && diskPosition(second, center));
  }
  assert.deepEqual(pairCenter(a), a);
  assert.deepEqual(pairCenter(a, { latitude: -1, longitude: 203 }), a);
});

test("planner sunlight uses the exact UTC day, including leap day and published boundaries", () => {
  for (const [date, longitude, latitude] of [
    ["2026-01-01", 32.519634, -1.346422], ["2026-11-14", 126.617658, -1.557279],
    ["2026-11-21", 41.450414, -1.541521], ["2028-02-29", 135.637106, 0.965324],
    ["2030-12-31", 104.283504, 0.855214],
  ] as const) assert.deepEqual(plannerSunAt(date + "T00:00:00Z"), { longitude, latitude, utc: date + "T00:00:00Z" });
  for (const utc of ["2025-12-31T00:00:00Z", "2031-01-01T00:00:00Z", "2026-11-14T12:00:00Z"])
    assert.equal(plannerSunAt(utc), undefined);
});

test("solar azimuth uses local east and north, handles west longitude and omits undefined bearings", () => {
  const sun = plannerSunAt("2026-11-14T00:00:00Z")!;
  for (const [latitude, longitude, bearing] of [[-69.3734, 32.3198, 94.5704656], [-84.7906, 29.1957, 97.5318605]])
    assert.ok(Math.abs(sunBearing({ latitude, longitude }, sun)! - bearing) < 0.000001);
  for (const site of [sun, { latitude: -sun.latitude, longitude: sun.longitude - 180 }, { latitude: 90, longitude: 0 }])
    assert.equal(sunBearing(site, sun), undefined);
  assert.equal(sunBearing({ latitude: 0, longitude: -179 }, { latitude: 0, longitude: 179 }), 270);
});
