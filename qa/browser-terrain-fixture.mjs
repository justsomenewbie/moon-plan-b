// Invented partial coverage and zero visibility keep this regression independent of scientific data.
export function terrainFixture({ run, start, at, end }) {
  const sites = ["im1_odysseus", "im2_athena"];
  return {
    schema_version: "lunarnav-dataset-1", evidence: "computed-ephemeris", dataset_id: run + ".range", attribution: "Synthetic browser test",
    include: ["windows", "metrics", "series", "horizon", "criteria"], criteria_hours: [24, 72, 168],
    range: { start, end, requested_start: start, requested_end: end, step_s: 3600, n_samples: 4 },
    run: { run_id: run, label: "Test", provider: "test", dem: "test", horizon_method: "test", code_version: "test",
      run_timestamp_utc: start, observer_height_m: 2, min_earth_clearance_deg: 0, git_commit: null,
      manifest_sha256: "a".repeat(64), manifest_url: "/api/v1/runs/" + run + "/files/manifest.json" },
    model: { id: "lunarnav-terrain-horizon-v1", label: "Test", definition: "Test only", limits: ["Invented data"] },
    sources: [{ id: "fixture", title: "Fixture", url: "https://example.org/fixture", sha256: null }],
    sites: sites.map(id => ({ id, name: id, coverage: "partial", coverage_in_range: "partial", metrics: null,
      criteria: [24, 72, 168].map(minimum_hours => ({
        minimum_hours, metric: "longest_both_h", value_h: 0, value_clipped: false, result: "below", reason: "Invented test result",
      })),
      windows: { sun: [], earth: [], both: [] },
      horizon: { method: "test", dem_source: "test", step_deg: 180, source_step_deg: 180, az_deg: [0, 180, 360],
        el_deg: [0, 0, 0], min_el_deg: 0, max_el_deg: 0 },
      series: { t: [start, at], step_s: 7200, decimated: true, n_transitions: 0, sun_az_deg: [0, 0], earth_az_deg: [0, 0],
        sun_el_deg: [-1, -1], earth_el_deg: [-1, -1], sun_visible: [false, false], earth_visible: [false, false], both_visible: [false, false] },
    })),
  };
}
