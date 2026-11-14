import test from "node:test";
import assert from "node:assert/strict";
import { skyPoint } from "../lib/local-sky.ts";

test("local sky projection preserves bearings, horizon, and elevation while orbiting", () => {
  const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-10, `${a} vs ${b}`);
  const north = skyPoint(0, 0, 0);
  const east = skyPoint(90, 0, 0);
  const south = skyPoint(180, 0, 0);
  near(north.x, 0);
  assert.ok(north.y < 0);
  near(south.y, -north.y);
  near(east.x, 1);
  near(east.y, 0);
  near(skyPoint(270, 0, 0).x, -1);
  near(skyPoint(90, 0, 90).y, north.y);
  near(skyPoint(359, 37, 0).x, skyPoint(0, 37, 1).x);
  for (const orbit of [0, 90, 230, 360]) {
    const zenith = skyPoint(76, 90, orbit);
    near(zenith.x, 0);
    assert.ok(zenith.y < north.y);
    near(skyPoint(0, -90, orbit).y, -zenith.y);
    const above = skyPoint(45, 20, orbit), below = skyPoint(45, -20, orbit);
    near(above.x, below.x);
    assert.ok(above.y < below.y);
  }
});
