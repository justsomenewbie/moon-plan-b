import assert from "node:assert/strict";
import { test } from "node:test";
import { boundaryTime, PGDA_LOLA_PRODUCT, runShortLabel, sourceLink } from "../lib/display-format.ts";

test("run ids give the short run label shown beside each number", () => {
  assert.equal(runShortLabel("B2_spice_pgda_bruteforce_2026_2030_fix676af9d"), "Run B2");
  assert.equal(runShortLabel("A2_horizons_trek_raymarch_2026_2030_fix676af9d"), "Run A2");
  assert.equal(runShortLabel("B_spice_pgda_bruteforce_2026_2030"), "Run B");
  for (const unknown of [null, undefined, "", "demo-dataset", "_x"]) assert.equal(runShortLabel(unknown), null);
});

test("interpolated boundary times are marked as estimates without milliseconds; sample times keep their form", () => {
  const format = (utc: string) => new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", timeZone: "UTC", hourCycle: "h23" }).format(new Date(utc)) + " UTC";
  assert.equal(boundaryTime("2026-11-16T03:37:01.411Z", false, format), "≈ 16 Nov 2026, 03:37 UTC");
  assert.doesNotMatch(boundaryTime("2026-11-16T03:37:01.411Z", false, format), /\.\d{3}|01\.411/);
  assert.equal(boundaryTime("2026-11-14T00:00:00.000Z", true, format), "2026-11-14T00:00:00Z");
  assert.equal(boundaryTime("2026-11-21T00:00:00Z", true, format), "2026-11-21T00:00:00Z");
});

test("PGDA home-page links go to the LOLA product page; other links are untouched", () => {
  assert.equal(PGDA_LOLA_PRODUCT, "https://pgda.gsfc.nasa.gov/products/90");
  for (const home of ["https://pgda.gsfc.nasa.gov/", "https://pgda.gsfc.nasa.gov"]) assert.equal(sourceLink(home), PGDA_LOLA_PRODUCT);
  for (const other of ["https://pgda.gsfc.nasa.gov/products/69", "https://ssd.jpl.nasa.gov/horizons/", "https://trek.nasa.gov/moon/", "not a url"]) {
    assert.equal(sourceLink(other), other);
  }
});
