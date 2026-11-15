import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { allows3D, particleCount } from "../app/three/gate.ts";

test("the 3D backdrop is skipped for reduced motion, Save-Data and low-memory devices", () => {
  assert.equal(allows3D({ reducedMotion: false }), true);
  assert.equal(allows3D({ reducedMotion: false, saveData: false, deviceMemory: 4 }), true);
  assert.equal(allows3D({ reducedMotion: true, deviceMemory: 8 }), false);
  assert.equal(allows3D({ reducedMotion: false, saveData: true }), false);
  assert.equal(allows3D({ reducedMotion: false, deviceMemory: 2 }), false);
  assert.equal(allows3D({ reducedMotion: false, deviceMemory: 0.5 }), false);
});

test("particle counts follow the viewport area within fixed bounds", () => {
  assert.equal(particleCount(375, 812, 1800, 220, 900), 220);
  assert.equal(particleCount(1280, 800, 1800, 220, 900), 569);
  assert.equal(particleCount(3840, 2160, 1800, 220, 900), 900);
});

test("Three.js is imported only by the lazily loaded scene", () => {
  const read = (name: string) => readFileSync(new URL(`../app/three/${name}`, import.meta.url), "utf8");
  assert.doesNotMatch(read("three-backdrop.tsx"), /from "three"|from "\.\/scene"/);
  assert.match(read("three-backdrop.tsx"), /dynamic\(\(\) => import\("\.\/three-canvas"\), \{ ssr: false \}\)/);
  assert.doesNotMatch(read("gate.ts"), /^import /m);
  assert.match(read("scene.ts"), /MAX_PIXEL_RATIO = 1\.5/);
});
