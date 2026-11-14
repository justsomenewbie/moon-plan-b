"""Compare five hourly B2 body-center directions to four archived Horizons tables.

Run with Python 3. Use --live to reread the same bounded public dataset. The
default uses its exact captured response. This compares configurations with
different observer heights and does not validate terrain or visibility.
"""

import argparse
import csv
import hashlib
import json
import math
from datetime import datetime
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen

QA = Path(__file__).resolve().parent
EVIDENCE = QA / "evidence"
RUN_ID = "B2_spice_pgda_bruteforce_2026_2030_fix676af9d"
SITES = {
    "im1_odysseus": ("odysseus-hour-gap", "jpl"),
    "im2_athena": ("odysseus-athena-hour-gap", "athena"),
}
TIMES = [f"2026-01-07T{hour:02}:00:00Z" for hour in range(5)]
QUERY = urlencode({
    "run_id": RUN_ID, "site_ids": ",".join(SITES), "start": TIMES[0],
    "end": "2026-01-07T05:00:00Z", "step_s": 3600, "max_points": 16, "include": "series",
})
URL = "https://moon-plan-b.vercel.app/api/v1/dataset?" + QUERY


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_table(folder, body, checksum):
    raw = (folder / f"{body}-response.json").read_bytes()
    require(hashlib.sha256(raw).hexdigest() == checksum, f"Horizons checksum mismatch for {folder.name}/{body}")
    report = json.loads(raw)["result"]
    coordinate_line = next(line for line in report.splitlines() if line.startswith("Center geodetic"))
    lon, lat, height_km = map(float, coordinate_line.split(":")[1].split("{")[0].split(","))
    contents = report.split("$$SOE")[1].split("$$EOE")[0].strip().splitlines()
    samples = []
    for row in csv.reader(contents):
        time = datetime.strptime(row[0].strip(), "%Y-%b-%d %H:%M:%S").strftime("%Y-%m-%dT%H:%M:%SZ")
        samples.append((time, float(row[3]), float(row[4])))
    require([time for time, _, _ in samples] == TIMES, "Unexpected Horizons sample grid")
    return lon, lat, height_km * 1000, samples


def residual(az_deg, el_deg, ref_az, ref_el):
    delta_az = (az_deg - ref_az + 180) % 360 - 180
    delta_el = el_deg - ref_el
    hav = (math.sin(math.radians(delta_el) / 2) ** 2
           + math.cos(math.radians(el_deg)) * math.cos(math.radians(ref_el))
           * math.sin(math.radians(delta_az) / 2) ** 2)
    separation = math.degrees(2 * math.asin(math.sqrt(min(1, hav))))
    return abs(delta_az) * 3600, abs(delta_el) * 3600, separation * 3600


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="read from the public app's pinned dataset route")
    args = parser.parse_args()
    if args.live:
        with urlopen(URL, timeout=25) as response:
            raw = response.read(100_001)
        require(len(raw) <= 100_000, "Unexpected response size")
    else:
        raw = (EVIDENCE / "b2-jan7-angles" / "dataset.json").read_bytes()
        require(hashlib.sha256(raw).hexdigest() == "3a1af06028c1c7d020db7240618f607c584b30798222819f8ccc51a81fd4087a",
                "Saved dataset checksum mismatch")
    dataset = json.loads(raw)
    manifest = (QA.parent / "frontend/public/data/run-b2/manifest.json").read_bytes()
    run = dataset["run"]
    require(run["run_id"] == RUN_ID and run["manifest_sha256"] == hashlib.sha256(manifest).hexdigest(),
            "Dataset and archived run manifest identities differ")
    require(run["observer_height_m"] == json.loads(manifest)["parameters"]["observer_height_m"],
            "Observer offset differs between dataset and manifest")
    require([site["id"] for site in dataset["sites"]] == list(SITES), "Unexpected site selection")
    print("site,body,n,B2_minus_Horizons_height_m,max_abs_az_arcsec,max_abs_el_arcsec,max_sky_separation_arcsec")
    for site in dataset["sites"]:
        name, prefix = SITES[site["id"]]
        folder = EVIDENCE / name
        sources = {item["id"]: item for item in json.loads((folder / "control.json").read_bytes())["sources"]}
        series = site["series"]
        require(series["t"] == TIMES and series["step_s"] == 3600 and series["decimated"] is False,
                "Unexpected B2 sample grid")
        for body in ("sun", "earth"):
            lon, lat, height_m, samples = read_table(folder, body, sources[f"{prefix}-{body}"]["rawSha256"])
            require((lon, lat) == (site["lon_deg"], site["lat_deg"]), "Horizontal observer coordinates differ")
            height_delta = site["surface_height_m"] + run["observer_height_m"] - height_m
            azimuths, elevations = series[f"{body}_az_deg"], series[f"{body}_el_deg"]
            require(len(azimuths) == len(elevations) == len(samples), "Missing angle sample")
            rows = [residual(azimuths[i], elevations[i], az, el) for i, (_, az, el) in enumerate(samples)]
            maxima = ",".join(f"{max(axis):.5f}" for axis in zip(*rows))
            print(f"{site['id']},{body},{len(rows)},{height_delta:.3f},{maxima}")


if __name__ == "__main__":
    main()
