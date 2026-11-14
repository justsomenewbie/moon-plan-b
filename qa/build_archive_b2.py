"""Verify the producer's full B2 visibility windows and build the offline hour-index pairs.

Run with a directory containing run.json (GET /runs/{id}), catalog.json (GET /sites),
manifest.json, and windows-<site_id>.json from each manifest file URL. No network access.
"""
import argparse
from datetime import datetime, timedelta
import hashlib
import json
from pathlib import Path

RUN = "B2_spice_pgda_bruteforce_2026_2030_fix676af9d"
MANIFEST_SHA = "96ed56f42e6a49ce53e5c92aba6649d7e916cf4b37ae2e2eff7869c35bd1d0e7"
CATALOG_SHA = "a5e2bc19c57dbc414ded2ff6a6f80032ec5568b75ddd0f7eb837d5ce42bf9980"
DEST = Path(__file__).resolve().parents[1] / "frontend/public/data/run-b2"


def require(ok, reason):
    if not ok:
        raise ValueError(reason)


def parse(raw, digest, label):
    require(hashlib.sha256(raw).hexdigest() == digest, f"Checksum mismatch: {label}")
    return json.loads(raw)


def read_series(rows, label, stamps, samples):
    """A false state is darkness/occultation only if the producer explicitly supplied it."""
    positive = []
    previous = 0
    previous_state = None
    for row in rows:
        a, b, state = row["start_index"], row["end_index"], row["state"]
        require(type(a) is int and type(b) is int and previous == a < b <= samples, f"Gap/overlap in {label}")
        require(row["start"] == stamps[a] and row["end"] == stamps[b] and row["duration_h"] == b - a, f"Off-grid {label}")
        require(type(state) is bool and state != previous_state, f"Unknown/non-maximal state in {label}")
        if state:
            positive += [a, b]
        previous, previous_state = b, state
    require(previous == samples, f"Missing terminal coverage in {label}")
    return positive


def positives(edges, samples):
    states = bytearray(samples)
    for a, b in zip(edges[::2], edges[1::2]):
        states[a:b] = b"\1" * (b - a)
    return states


def build(source):
    manifest_raw = (source / "manifest.json").read_bytes()
    manifest = parse(manifest_raw, MANIFEST_SHA, "manifest")
    catalog_raw = (source / "catalog.json").read_bytes()
    catalog = parse(catalog_raw, CATALOG_SHA, "catalog")
    run = json.loads((source / "run.json").read_bytes())
    params = manifest["parameters"]
    ids = sorted(params["site_ids"])
    require(len(ids) == len(set(ids)) == 23 and sorted(run["site_ids"]) == ids == sorted(s["id"] for s in catalog["sites"]), "Catalog identity")
    require(run["run_id"] == catalog["run_id"] == RUN and run["status"] == "ready", "Run identity")
    require(manifest["files"] == {r["path"]: r["sha256"] for r in run["manifest"]["files"]}, "Manifest inventory")
    require(params["step_s"] == run["step_s"] == catalog["step_s"] == 3600, "Expected hourly model")
    start, end, samples = params["start_utc"], params["end_utc"], params["n_samples"]
    require((start, end, samples) == (run["start_utc"], run["end_utc"], run["n_samples"]), "Run range")
    t = datetime.fromisoformat(start.replace("Z", "+00:00"))
    stamps = [(t + timedelta(hours=i)).isoformat().replace("+00:00", "Z") for i in range(samples + 1)]
    require(stamps[-1] == end, "Exclusive end")
    sites = {s["id"]: s for s in catalog["sites"]}
    output = {}
    for sid in ids:
        digest = manifest["files"][f"sites/{sid}/windows.json"]
        w = parse((source / f"windows-{sid}.json").read_bytes(), digest, sid)
        require(w["site_id"] == w["site_record"]["id"] == sid and w["params_fingerprint"] == manifest["params_fingerprint"], f"Site identity: {sid}")
        require((w["range_start_utc"], w["range_end_utc"], w["n_samples"], w["step_s"]) == (start, end, samples, 3600), f"Site range: {sid}")
        require(all(w["site_record"][k] == sites[sid][k] for k in ("name", "group", "lat_deg", "lon_deg", "dem_source", "horizon_method")), f"Site metadata: {sid}")
        edges = {k: read_series(w[k], sid + "/" + k, stamps, samples) for k in ("sun", "earth", "both")}
        a, b, both = (positives(edges[k], samples) for k in ("sun", "earth", "both"))
        require(all((sun and earth) == overlap for sun, earth, overlap in zip(a, b, both)), f"Joint visibility: {sid}")
        for k, flags in (("sun", a), ("earth", b), ("both", both)):
            pct = sum(flags) * 100 / samples
            require(abs(pct - w["metrics"]["pct_" + k]) <= 0.00000051 and abs(pct - sites[sid]["pct_" + k]) <= 0.00000051, f"Totals: {sid}/{k}")
        output[sid] = edges
    archive = {"schema": "lunarnav-hourly-visibility-1", "runId": RUN, "manifestSha256": MANIFEST_SHA,
               "catalogSha256": CATALOG_SHA, "start": start, "end": end, "stepSeconds": 3600, "sampleCount": samples,
               "sites": output}
    return {"manifest.json": manifest_raw, "catalog.json": catalog_raw,
            "visibility.json": (json.dumps(archive, separators=(",", ":")) + "\n").encode()}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--verify", action="store_true", help="Verify the published files without writing")
    args = parser.parse_args()
    artifacts = build(args.source)
    if not args.verify:
        DEST.mkdir(parents=True, exist_ok=True)
    for filename, body in artifacts.items():
        if args.verify:
            require((DEST / filename).read_bytes() == body, f"Published bytes differ: {filename}")
        else:
            (DEST / filename).write_bytes(body)
        print(filename, len(body), hashlib.sha256(body).hexdigest())
