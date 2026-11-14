import assert from "node:assert/strict";
import test from "node:test";
import { usesSmoothSphere } from "../lib/site-horizon.ts";

test("the outside-coverage notice requires an explicitly flat fallback in the site record", () => {
  assert.equal(usesSmoothSphere({ horizonMethod: "flat", demSource: "none:outside-pgda-coverage" }), true);
  for (const site of [undefined, {}, { horizonMethod: "flat" }, { demSource: "none:outside-pgda-coverage" },
    { horizonMethod: "flat", demSource: "none" }, { horizonMethod: "bruteforce", demSource: "pgda" }]) {
    assert.equal(usesSmoothSphere(site), false);
  }
});
