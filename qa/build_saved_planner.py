"""Rebuild the public selection from original team API response files. See docs/SAVED_PLANNER.md."""
import argparse
import hashlib
import json
from datetime import datetime, timedelta
from pathlib import Path

METRICS = ("sun", "earth", "both")
RUN = "B_spice_pgda_bruteforce_2026_2030"
MANIFEST = "35601268e464e2e610e3cf33cf7e7b8588e59e23877857708799f29a8ac615a4"
PAIR = ("im1_odysseus", "im2_athena")
OUTPUT = Path(__file__).resolve().parents[1] / "frontend/lib/saved-planner-data.json"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def time(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def iso(t):
    return t.isoformat().replace("+00:00", "Z")


def build(root):
    receipts = []
    def read(path, route):
        data = (root / path).read_bytes()
        receipts.append({"request": route, "sha256": hashlib.sha256(data).hexdigest()})
        return json.loads(data)
    def counts(row, n):
        pct = [row["pct_" + m] for m in METRICS]
        result = [round(p * n / 100) for p in pct]
        require(all(0 <= p <= 100 and abs(p - h * 100 / n) <= 0.000000501 for p, h in zip(pct, result)), "percentage differs from native hourly grid")
        require(max(0, result[0] + result[1] - n) <= result[2] <= min(result[:2]), "joint bounds")
        return result

    manifest = read("live-aggregate-weekly/run-manifest.json", f"GET /runs/{RUN}/files/manifest.json")
    require(receipts[0]["sha256"] == MANIFEST, "unexpected source manifest")
    run = read("site-coordinate-provenance/run-record.json", f"GET /runs/{RUN}")
    catalog = read("site-coordinate-provenance/catalog.json", f"GET /sites?run_id={RUN}&format=json")
    ids = sorted(run["site_ids"])
    require(run["run_id"] == catalog["run_id"] == RUN and len(set(ids)) == len(ids) == 23 and run["n_sites"] == 23, "catalog identity")
    require(sorted(manifest["parameters"]["site_ids"]) == ids and run["step_s"] == catalog["step_s"] == 3600, "run grid")
    require({r["path"]: r["sha256"] for r in run["manifest"]["files"]} == manifest["files"], "run file identity")
    require(time(run["end_utc"]) - time(run["start_utc"]) == timedelta(hours=run["n_samples"]), "run range")
    by_id = {s["id"]: s for s in catalog["sites"]}
    require(len(catalog["sites"]) == len(ids) and sorted(by_id) == ids, "site identity")
    require(receipts[-1]["sha256"] == "da758fd0453cc2319b719c3101804959ff96fa099f9f770eca4ab95edba71ace", "unexpected source catalog")

    full = {"from": run["start_utc"], "to": run["end_utc"], "samples": run["n_samples"],
            "counts": [counts(by_id[id], run["n_samples"]) for id in ids]}
    for id in sorted((*PAIR, "apollo11", "a3_haworth")):
        detail = read(f"site-coordinate-provenance/detail-{id}.json", f"GET /sites/{id}?run_id={RUN}")
        require(detail["run_id"] == RUN and detail["site"]["id"] == id and detail["range"]["start"] == full["from"]
                and detail["range"]["end"] == full["to"], "individual site run")
        require(counts(detail["metrics"], full["samples"]) == counts(by_id[id], full["samples"]), "individual full-run metrics")
    saved = [full]
    for month, bounds in [("nov", ("2026-11-14", "2026-11-15")), ("dec", ("2026-12-01", "2026-12-04"))]:
        start, end = [day + "T00:00:00Z" for day in bounds]
        params = f"run_id={RUN}&start={start}&end={end}"
        same = None
        for label, weights in [("default", "pct_sun:0.4,pct_earth:0.3,pct_both:0.3"), ("earth", "pct_sun:0,pct_earth:1,pct_both:0")]:
            directory = "catalog-ranking-source-QCMwte/"
            ranking = read(directory + f"{month}-{label}-ranking.json", f"GET /ranking?{params}&weights={weights}")
            selected = json.loads((root / directory / f"{month}-{label}-pair.json").read_bytes())["sites"]
            pair = read(directory + f"{month}-{label}-pair.json", f"POST /compare (same UTC range and weights, sites {','.join(sorted(selected))})")
            expected_weights = {k: float(v) for k, v in (term.split(":") for term in weights.split(","))}
            require(ranking["run_id"] == pair["run_id"] == RUN and ranking["source"] == "computed"
                    and ranking["weights"] == pair["weights"] == expected_weights, "rank source")
            r = ranking["range"]
            require(r == pair["range"] and (r["start"], r["end"], r["step_s"]) == (start, end, 3600), "rank range")
            n = r["n_samples"]
            require(time(end) - time(start) == timedelta(hours=n), "rank grid")
            rows = {s["site_id"]: s for s in ranking["ranking"]}
            require(len(ranking["ranking"]) == len(ids) and sorted(rows) == ids and all(rows[id]["name"] == by_id[id]["name"] for id in ids), "rank sites")
            h = [counts(rows[id], n) for id in ids]
            require(all(counts(s["metrics"], n) == counts(rows[id], n) for id, s in selected.items()), "pair/cross-catalog mismatch")
            require(same is None or h == same, "weights altered visibility")
            same = h
        saved.append({"from": start, "to": end, "samples": n, "counts": same})

    intervals = {id: {m: [] for m in METRICS} for id in PAIR}
    for day in (14, 21):
        start, end = f"2026-11-{day}T00:00:00Z", f"2026-11-{day+7}T00:00:00Z"
        req = f"run_id={RUN}&start={start}&end={end}"
        agg = read(f"live-aggregate-weekly/{day}-aggregate.json", f"GET /dataset?{req}&site_ids={','.join(PAIR)} (hourly series, windows and metrics)")
        require(agg["run"]["run_id"] == RUN and agg["run"]["manifest_sha256"] == MANIFEST and agg["range"]["start"] == start and agg["range"]["end"] == end, "weekly identity")
        require(sorted(s["id"] for s in agg["sites"]) == sorted(PAIR), "weekly sites")
        times = [iso(time(start) + timedelta(hours=i)) for i in range(168)]
        for s in agg["sites"]:
            id = s["id"]
            prefix = f"live-aggregate-weekly/{day}-{id}-"
            series = read(prefix + "series.json", f"GET /sites/{id}/series?{req} (hourly visibility)")
            windows = read(prefix + "windows.json", f"GET /sites/{id}/windows?{req}&kinds=sun,earth,both")
            require(s["coverage"] == s["coverage_in_range"] == "complete" and s["series"]["t"] == times, "incomplete native series")
            for response in (series, windows):
                require(response["run_id"] == RUN and response["site_id"] == id and response["start"] == start and response["end"] == end and response["step_s"] == 3600, "site series/window identity")
            require(all(b == (u and v) for b, u, v in zip(*[s["series"][m + "_visible"] for m in ("both", "sun", "earth")])), "joint flag")
            for m in METRICS:
                flags = series["fields"][m + "_visible"]
                valid = [x for x in windows[m] if x["state"]]
                real = [[x["start"], x["end"]] for x in valid]
                require(real == [[x["start"], x["end"]] for x in s["windows"][m]], "standalone vs aggregate intervals")
                require(len(flags) == 168 and all(type(v) is bool for v in flags) and flags == s["series"][m + "_visible"], "standalone vs aggregate flags")
                require(flags == [any(a <= t < b for a, b in real) for t in times] and sum(flags) == s["metrics"][m + "_hours"], "intervals/metrics disagree with native flags")
                for a, b in real:
                    spans = intervals[id][m]
                    if spans and spans[-1][1] == a:
                        spans[-1][1] = b
                    else:
                        spans.append([a, b])
    return {"runId": RUN, "manifestSha256": MANIFEST, "stepSeconds": 3600, "siteIds": ids, "catalogWindows": saved,
            "pairWindow": {"from": "2026-11-14T00:00:00Z", "to": "2026-11-28T00:00:00Z", "intervals": intervals}, "responses": receipts}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_directory", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    result = json.dumps(build(args.source_directory), indent=2, ensure_ascii=False) + "\n"
    if args.check:
        require(result.encode() == OUTPUT.read_bytes(), "saved planner data differs")
    else:
        OUTPUT.write_text(result)
