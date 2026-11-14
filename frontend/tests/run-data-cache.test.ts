import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { runDataCache } from "../lib/api/run-data-cache.ts";

test("an inactive precomputed result stays available for one hour per query key", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: 5 * 60_000 } } });
  t.after(() => client.clear());
  let reads = 0;
  const read = (id: string) => client.fetchQuery({
    queryKey: ["terrain-date-sites", id], queryFn: () => ++reads, ...runDataCache(id),
  });
  assert.equal(await read("release-1"), 1);
  t.mock.timers.tick(3_599_999);
  assert.equal(await read("release-1"), 1);
  assert.equal(await read("release-2"), 2);
  t.mock.timers.tick(1);
  assert.equal(client.getQueryData(["terrain-date-sites", "release-1"]), undefined);
  assert.equal(await read("release-1"), 3);
  assert.equal(await read("release-2"), 2);
  // A retained entry must also revalidate at its freshness deadline, even before GC runs.
  t.mock.timers.setTime(Date.now() + 3_600_000);
  assert.equal(client.getQueryData(["terrain-date-sites", "release-2"]), 2);
  assert.equal(await read("release-2"), 4);
});

test("default and job data become stale after a minute, and explicit refresh re-reads a fresh pin", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const client = new QueryClient();
  t.after(() => client.clear());
  const calls = new Map<string | undefined, number>();
  const read = (id?: string, force = false) => client.fetchQuery({
    queryKey: ["dataset", id], ...runDataCache(id, force),
    queryFn: () => {
      const n = (calls.get(id) ?? 0) + 1;
      calls.set(id, n);
      return n;
    },
  });
  const ids = [undefined, "job_123", "release-1"];
  for (const id of ids) assert.equal(await read(id), 1);
  t.mock.timers.tick(59_999);
  for (const id of ids) assert.equal(await read(id), 1);
  t.mock.timers.tick(1);
  assert.equal(await read(undefined), 2);
  assert.equal(await read("job_123"), 2);
  assert.equal(await read("release-1"), 1);
  assert.equal(await read("release-1", true), 2);
  assert.equal(await read("release-1"), 2);
});
