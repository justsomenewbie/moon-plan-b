"""Rebuild (--write) or check the four B2 surface observations against the public relay."""
import argparse
import hashlib
import json
import math
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1] / "frontend"
RUN = "B2_spice_pgda_bruteforce_2026_2030_fix676af9d"
BASE = "https://moon-plan-b.vercel.app/api/v1/"
SITES = ["im2_athena", "im1_odysseus"]
DAYS = ["2026-11-14", "2026-11-21"]
KINDS = ["sun", "earth"]
OUT = ROOT / "lib/orbit-sky-samples.json"


def fetch(path, **query):
    url = BASE + path + "?" + urlencode(query)
    with urlopen(url, timeout=20) as response:
        raw = response.read()
    return json.loads(raw), {"url": url, "sha256": hashlib.sha256(raw).hexdigest()}


def check_day(day):
    utc = day + "T00:00:00Z"
    end = day + "T01:00:00Z"
    dataset, source = fetch("dataset", run_id=RUN, site_ids=",".join(SITES), start=utc, end=end,
                            step_s=3600, horizon_step_deg=0.5, include="horizon,series")
    archive = json.loads((ROOT / "public/data/run-b2/visibility.json").read_text())
    assert archive["runId"] == dataset["run"]["run_id"] == RUN
    assert dataset["run"]["manifest_sha256"] == archive["manifestSha256"]
    assert (dataset["range"]["start"], dataset["range"]["end"], dataset["range"]["n_samples"]) == (utc, end, 1)
    assert dataset["run"]["observer_height_m"] == 2
    hour = int((datetime.fromisoformat(utc.replace("Z", "+00:00")) -
                datetime.fromisoformat(archive["start"].replace("Z", "+00:00"))).total_seconds() / 3600)
    assert {s["id"] for s in dataset["sites"]} == set(SITES)
    result, horizons = [], []
    for s in dataset["sites"]:
        site, h, series = s["id"], s["horizon"], s["series"]
        assert s["coverage_in_range"] == "complete" and h["method"] == "bruteforce" and h["dem_source"].startswith("pgda:")
        assert h["source_step_deg"] == h["step_deg"] == 0.5 and h["az_deg"] == [i / 2 for i in range(721)]
        elevation = h["el_deg"]
        assert len(elevation) == 721 and elevation[0] == elevation[-1] and all(-90 <= el <= 90 for el in elevation)
        horizons.append({"siteId": site, "elevationsDeg": elevation})
        assert series["step_s"] == 3600 and series["t"] == [utc]
        instant, instant_source = fetch(f"sites/{site}/instant", run_id=RUN, t=utc)
        assert (instant["run_id"], instant["site_id"], instant["sample_utc"], instant["t"]) == (RUN, site, utc, utc)
        sample = {"siteId": site, "weekUtc": utc, "instantSource": instant_source}
        for kind in KINDS:
            b = instant[kind]
            for field in ("az_deg", "el_deg", "visible"):
                assert series[f"{kind}_{field}"] == [b[field]]
            assert isinstance(b["visible"], bool) and 0 <= b["az_deg"] < 360 and -90 <= b["el_deg"] <= 90
            edges = archive["sites"][site][kind]
            assert b["visible"] == any(i <= hour < j for i, j in zip(edges[::2], edges[1::2]))
            idx = b["az_deg"] / h["step_deg"]
            i = math.floor(idx)
            local = elevation[i] + (idx - i) * (elevation[i + 1] - elevation[i])
            assert math.isclose(local, b["horizon_el_deg"], abs_tol=2e-5), (kind, local, b["horizon_el_deg"])
            sample[kind] = {k: b[k] for k in ("az_deg", "el_deg", "visible", "horizon_el_deg")}
        result.append(sample)
    return result, horizons, source, archive["manifestSha256"]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    with ThreadPoolExecutor(max_workers=2) as pool:
        first, second = pool.map(check_day, DAYS)
    assert first[1] == second[1] and first[3] == second[3]
    payload = {"runId": RUN, "manifestSha256": first[3], "azimuthStepDeg": 0.5,
               "provenance": "Team B2 SPICE/PGDA. Raw HTTP response SHA-256 for each query. OpenAI Codex assisted extraction, validation and display.",
               "datasetSources": [first[2], second[2]], "horizons": first[1], "samples": first[0] + second[0]}
    output = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
    if args.write:
        OUT.write_text(output)
    elif output != OUT.read_text():
        raise SystemExit("The archive differs from the checked producer responses.")
    print("Checked two native terrain profiles and four B2 UTC samples against independent instant and archived visibility results.")
