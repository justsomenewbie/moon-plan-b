"""Reconstruct the November 14–21 UTC Sun/Earth windows offline using JPL directions and B2 terrain.

Run with Python 3. An optional evidence directory must contain SHA256SUMS.txt, sources.json,
dataset.json, and the two sites' {site}-sun.json, {site}-earth.json and {site}-horizon.csv files.
The terrain horizon is shared with B2. Each hourly state covers [sample UTC, sample UTC + 1h).
"""

import argparse
import csv
import hashlib
import io
import json
import math
import re
from datetime import datetime, timedelta
from decimal import Decimal
from itertools import groupby
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from check_b2_horizons_angles import RUN_ID, residual, require

QA = Path(__file__).resolve().parent
ARCHIVE = QA.parent / "frontend/public/data/run-b2"
MANIFEST_HASH = "96ed56f42e6a49ce53e5c92aba6649d7e916cf4b37ae2e2eff7869c35bd1d0e7"
SITES = ("im1_odysseus", "im2_athena")
TARGETS = {"sun": ("Sun", "10"), "earth": ("Earth", "399")}
START = datetime(2026, 11, 14)
UTC = [(START + timedelta(hours=i)).strftime("%Y-%m-%dT%H:%M:%SZ") for i in range(169)]
SOLAR_RADIUS_KM = 695700.0


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def load_evidence(folder):
    files = {"dataset.json"} | {f"{site}-{suffix}" for site in SITES for suffix in ("sun.json", "earth.json", "horizon.csv")}
    hashes = {}
    for line in (folder / "SHA256SUMS.txt").read_text().splitlines():
        match = re.fullmatch(r"([a-f0-9]{64})  ([a-zA-Z0-9_.-]+)", line)
        require(match and match[2] in files and match[2] not in hashes, "Unexpected or duplicate checksum entry")
        hashes[match[2]] = match[1]
    urls = json.loads((folder / "sources.json").read_bytes())
    require(files == hashes.keys() == urls.keys(), "Evidence sources or hashes incomplete")
    blobs = {name: (folder / name).read_bytes() for name in files}
    for name, raw in blobs.items():
        require(digest(raw) == hashes[name], f"{name}: stored response checksum mismatch")
    return blobs, urls


def horizon_elevations(raw, step):
    rows = csv.DictReader(io.StringIO(raw.decode()))
    require(rows.fieldnames == ["az_deg", "el_deg", "covered_radius_km"], "Wrong native horizon columns")
    elevations = []
    for row in rows:
        el = float(row["el_deg"])
        require(float(row["az_deg"]) == step * len(elevations) and -90 <= el <= 90,
                "Horizon azimuth or elevation is invalid")
        elevations.append(el)
    require(len(elevations) * step == 360, "Native azimuth grid incomplete")
    return elevations


def local_horizon(elevations, azimuth):
    pos = (azimuth % 360) * len(elevations) / 360
    i = math.floor(pos)
    return elevations[i] + (pos - i) * (elevations[(i + 1) % len(elevations)] - elevations[i])


def horizons_table(raw, url, site, body):
    target, code = TARGETS[body]
    coords = [Decimal(str(site["lon_deg"])), Decimal(str(site["lat_deg"])),
              Decimal(str(site["observer_height_above_sphere_m"])) / 1000]
    endpoint = urlsplit(url)
    require(endpoint.scheme == "https" and endpoint.netloc == "ssd.jpl.nasa.gov" and
            endpoint.path == "/api/horizons.api", "Unexpected Horizons source URL")
    params = parse_qs(endpoint.query)
    expected = dict(COMMAND=code, CENTER="coord@301", COORD_TYPE="GEODETIC", QUANTITIES="4,13,20",
                    RANGE_UNITS="KM", ANG_FORMAT="DEG", APPARENT="AIRLESS", TIME_TYPE="UT", EPHEM_TYPE="OBSERVER",
                    START_TIME="2026-11-14 00:00", STOP_TIME="2026-11-20 23:00", STEP_SIZE="1 h")
    require(all(params.get(k) == [f"'{v}'"] for k, v in expected.items()), f"{body}: wrong query settings")
    require(len(params.get("SITE_COORD", [])) == 1 and
            list(map(Decimal, params["SITE_COORD"][0].strip("'").split(","))) == coords, "Wrong requested observer")

    envelope = json.loads(raw)
    require("error" not in envelope and envelope["signature"]["source"] == "NASA/JPL Horizons API", "Wrong JPL signature")
    before, table = envelope["result"].split("$$SOE")
    rows, after = table.split("$$EOE")
    fields = {}
    for line in before.splitlines():
        key, delimiter, value = line.partition(":")
        if delimiter:
            fields[key.strip()] = value.strip()
    require(fields["Target body name"].split("{")[0].strip() == f"{target} ({code})" and
            fields["Center body name"].split("{")[0].strip() == "Moon (301)" and
            fields["Center pole/equ"].startswith("MEAN_ME (high precision)") and
            "{East-longitude positive}" in fields["Center pole/equ"] and
            fields["Center radii"].split("km")[0].strip() == "1737.4, 1737.4, 1737.4" and
            fields["Atmos refraction"] == "NO (AIRLESS)" and fields["Step-size"] == "60 minutes" and
            fields["Start time"] == "A.D. 2026-Nov-14 00:00:00.0000 UT" and
            fields["Stop  time"] == "A.D. 2026-Nov-20 23:00:00.0000 UT",
            f"{body}: incompatible target, lunar frame, radius, atmosphere or step")
    if body == "sun":
        radii = [float(r) for r in fields["Target radii"].split("km")[0].split(",")]
        require(radii == [SOLAR_RADIUS_KM] * 3, "Unexpected solar radius")
    coord_line = fields["Center geodetic"]
    # Horizons prints the matching requested altitude to five decimal places in kilometres.
    echoed = list(map(Decimal, coord_line.split("{")[0].split(",")))
    require("{E-lon(deg),Lat(deg),Alt(km)}" in coord_line and echoed[:2] == coords[:2] and
            abs(echoed[2] - coords[2]) <= Decimal("0.000005"), f"{body}: wrong echoed observer")
    header = next(line for line in before.splitlines() if "Date__(UT)__" in line)
    require([item.strip() for item in next(csv.reader([header]))] ==
            ["Date__(UT)__HR:MN:SS", "", "", "Azimuth_(a-app)", "Elevation_(a-app)", "Ang-diam", "delta", "deldot", ""]
            and "Airless apparent azimuth and elevation of target center" in after and "Units: DEGREES" in after and
            "Units: KM and KM/S" in after and "Units: ARCSECONDS" in after, f"{body}: unexpected quantities/units")
    observations = []
    for i, row in enumerate(csv.reader(rows.strip().splitlines())):
        require(i < 168 and len(row) == 9 and row[-1].strip() == "", f"{body}: invalid table length")
        time = datetime.strptime(row[0].strip(), "%Y-%b-%d %H:%M:%S").strftime("%Y-%m-%dT%H:%M:%SZ")
        az, el, diameter, distance = map(float, row[3:7])
        require(time == UTC[i] and 0 <= az < 360 and -90 <= el <= 90 and math.isfinite(distance) and
                distance > 0 and 0 < diameter < 180 * 3600, f"{body}: invalid sample {i}")
        if body == "sun":
            # Q13 is printed to 0.001 arcsec. Q20 range must reproduce that printed angular diameter.
            full_diameter = 7200 * math.degrees(math.asin(SOLAR_RADIUS_KM / distance))
            require(round(full_diameter, 3) == diameter, f"Sun: Q13 diameter and Q20 range disagree at {time}")
        observations.append((az, el, distance))
    require(len(observations) == 168, f"{body}: incomplete Horizons week")
    return observations


def intervals(states):
    result = []
    offset = 0
    for visible, group in groupby(states):
        duration = sum(1 for _ in group)
        if visible:
            result.append((UTC[offset], UTC[offset + duration], duration))
        offset += duration
    return result


def verify_site(site, record, params, files, urls, manifest):
    name = site["id"]
    require(all(site[k] == record[k] for k in ("lon_deg", "lat_deg", "surface_height_m")) and
            record["observer_height_m"] == params["observer_height_m"] and
            Decimal(str(record["surface_height_m"])) + Decimal(str(record["observer_height_m"])) ==
            Decimal(str(record["observer_height_above_sphere_m"])), f"{name}: observer differs from original")
    series = site["series"]
    require(site["coverage_in_range"] == "complete" and series["t"] == UTC[:-1] and series["step_s"] == 3600 and
            series["decimated"] is False, f"{name}: incomplete B2 series")
    native = files[f"{name}-horizon.csv"]
    require(digest(native) == manifest["files"][record["files"]["horizon"]], f"{name}: original horizon SHA mismatch")
    profile = horizon_elevations(native, params["az_step_deg"])
    states, directions = {}, {}
    for body in TARGETS:
        filename = f"{name}-{body}.json"
        observations = horizons_table(files[filename], urls[filename], record, body)
        azimuth = series[f"{body}_az_deg"]
        elevation = series[f"{body}_el_deg"]
        require(len(azimuth) == len(elevation) == 168 and all(0 <= a < 360 for a in azimuth) and
                all(-90 <= e <= 90 for e in elevation), f"{name}: invalid B2 {body} angles")
        directions[body] = max(residual(a, e, az, el)[2] for a, e, (az, el, _) in zip(azimuth, elevation, observations))
        states[body] = []
        for az, el, distance in observations:
            horizon = local_horizon(profile, az)
            if body == "sun":
                visible = el + math.degrees(math.asin(SOLAR_RADIUS_KM / distance)) > horizon
            else:
                visible = el > horizon + params["min_earth_clearance_deg"]
            states[body].append(visible)
    states["both"] = [sun and earth for sun, earth in zip(states["sun"], states["earth"])]
    require(site["metrics"]["duration_h"] == 168, f"{name}: wrong metric duration")
    for kind, values in states.items():
        flags = series[f"{kind}_visible"]
        require(len(flags) == 168 and all(type(flag) is bool for flag in flags), f"{name}: invalid {kind} flags")
        mismatches = [UTC[i] for i, (a, b) in enumerate(zip(values, flags)) if a != b]
        require(not mismatches, f"{name}: {kind} disagrees at {mismatches}")
        derived = intervals(values)
        reported = [(w["start"], w["end"], w["duration_h"]) for w in site["windows"][kind]]
        require(reported == derived, f"{name}: {kind} windows differ: JPL {derived}, B2 {reported}")
        metrics = site["metrics"]
        require(metrics[f"{kind}_hours"] == sum(values) and metrics[f"longest_{kind}_h"] == max((v[2] for v in derived), default=0)
                and metrics[f"pct_{kind}"] == round(100 * sum(values) / 168, 6), f"{name}: {kind} visibility metrics differ")
    for kind, metric in [("sun", "longest_dark_h"), ("earth", "longest_comms_gap_h")]:
        hidden = intervals(not flag for flag in states[kind])
        require(site["metrics"][metric] == max((w[2] for w in hidden), default=0), f"{name}: {metric} differs")
    return {"sun_hours": sum(states["sun"]), "earth_hours": sum(states["earth"]),
            "joint_windows_utc": intervals(states["both"]), "max_sky_separation_arcsec": directions}


def verify(folder):
    files, urls = load_evidence(folder)
    raw = (ARCHIVE / "manifest.json").read_bytes()
    require(digest(raw) == MANIFEST_HASH, "Unexpected B2 manifest")
    manifest = json.loads(raw)
    sites = (ARCHIVE / "sites.json").read_bytes()
    require(digest(sites) == manifest["files"]["sites.json"], "Original site records changed")
    records = {s["id"]: s for s in json.loads(sites)["sites"]}
    dataset = json.loads(files["dataset.json"])
    run, params = dataset["run"], manifest["parameters"]
    require(dataset["schema_version"] == "lunarnav-dataset-1" and dataset["evidence"] == "computed-ephemeris" and
            run["run_id"] == RUN_ID and run["manifest_sha256"] == MANIFEST_HASH and run["git_commit"] == manifest["git_commit"] and
            all(run[k] == params[k] for k in ("observer_height_m", "min_earth_clearance_deg", "provider", "dem", "horizon_method")),
            "Dataset is not from the pinned B2 computation")
    limits = dataset["range"]
    require(limits["start"] == limits["requested_start"] == UTC[0] and limits["end"] == limits["requested_end"] == UTC[-1]
            and limits["step_s"] == 3600 and limits["n_samples"] == 168 and
            [s["id"] for s in dataset["sites"]] == list(SITES), "Dataset site selection or UTC range differs")
    return {s["id"]: verify_site(s, records[s["id"]], params, files, urls, manifest) for s in dataset["sites"]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path, nargs="?", default=QA / "evidence/b2-horizons-week")
    print(json.dumps(verify(parser.parse_args().directory), indent=2))
