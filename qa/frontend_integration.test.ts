// AI-assisted tests of the ACTUAL frontend importer/paths, not a copied implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateDataset, skyPath, chartPath, commonOffsets, sampleAt, utcMillis, alternatives } from '../frontend/lib/dataset.ts';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

for (const name of ['normal', 'crossing_wrap', 'partial', 'missing']) {
  test(`actual frontend accepts ${name} and preserves synthetic attribution`, () => {
    const d = validateDataset(fixture(name));
    assert.equal(d.evidence, 'synthetic-fixture');
    assert.match(d.attribution, /Synthetic/);
  });
}

test('north wrapping breaks both directions in the actual sky path', () => {
  const d = validateDataset(fixture('crossing_wrap'));
  assert.match(skyPath(d.scenarios[0], 'sun'), /L359,90 M1,89 M359,90/);
  assert.match(skyPath(d.scenarios[1], 'sun'), /L1,89.6 M359,89.4 M1,89.2/);
});

test('actual charts break nulls/gaps; missing never becomes a zero-valued row', () => {
  const d = validateDataset(fixture('partial'));
  for (const s of d.scenarios) {
    assert.equal((chartPath(s, 'sun').match(/M/g) ?? []).length, 2);
    assert.equal(s.metrics, null);
  }
  const missing = validateDataset(fixture('missing'));
  assert.equal(chartPath(missing.scenarios[0], 'sun'), '');
  assert.equal(sampleAt(missing.scenarios[0], 0), undefined);
});

test('same-time site candidates share exact UTC samples and keep zero values', () => {
  const d = validateDataset(fixture('crossing_wrap'));
  const a = d.scenarios[0], b = alternatives(d, a, 'sites')[0];
  assert.equal(b.siteId, 'basin');
  for (const offset of commonOffsets(a, b)) {
    assert.equal(utcMillis(sampleAt(a, offset)!.utc), utcMillis(sampleAt(b, offset)!.utc));
  }
  assert.equal(sampleAt(a, 3600000)!.sun!.elevationDeg, 0);
});

for (const name of ['azimuth_360', 'duplicate_utc', 'missing_timestamp', 'timezone_offset', 'corrupted_schema']) {
  test(`actual frontend rejects negative-control fixture ${name}`, () => {
    assert.throws(() => validateDataset(fixture(`invalid/${name}`)));
  });
}
