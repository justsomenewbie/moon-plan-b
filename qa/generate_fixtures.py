"""Deterministic invented test data, NOT JPL output or landing-site predictions."""
from copy import deepcopy
from pathlib import Path
import json

from qa.verify_json_contract import QUERY, sha

FIXTURES = Path(__file__).parent / "fixtures"
ATTRIBUTION = "Synthetic QA fixture authored with OpenAI Codex assistance; invented angles and locations, not NASA/JPL measurements."


def stamp(hour):
    return f"2026-11-14T{hour:02}:00:00Z"


def encode(value):
    return (json.dumps(value, indent=2, ensure_ascii=True, allow_nan=False) + "\n").encode()


def scenario(identifier, site, sun, azimuths):
    # Explicit hand-calculated golden duration windows, independent of qa.science.
    crossing = sun == [-1, 0, 1, 0, -1]
    bounds = {"sun": [(1, 3)] if crossing else [(0, 4)], "earth": [(0, 4)],
              "simultaneous": [(1, 3)] if crossing else [(0, 4)]}
    duration = 2 if crossing else 4
    return {
        "id": identifier, "siteId": site, "startUtc": stamp(0), "endUtc": stamp(4),
        "coverage": "complete", "sampleStepSeconds": 3600,
        "horizonCurve": [{"azimuthDeg": 0, "elevationDeg": 0}, {"azimuthDeg": 360, "elevationDeg": 0}],
        "samples": [{"utc": stamp(i), "sun": {"azimuthDeg": azimuths[i], "elevationDeg": sun[i]},
                     "earth": {"azimuthDeg": 180 + i, "elevationDeg": 1}} for i in range(5)],
        "intervals": {b: [{"startUtc": stamp(a), "endUtc": stamp(z), "endClipped": z == 4} for a, z in spans]
                      for b, spans in bounds.items()},
        "metrics": {"sunAboveHours": duration, "earthAboveHours": 4, "simultaneousLongestHours": duration},
        "criteria": [{"minimumHours": 1, "result": "meets", "reason": "Hand-calculated synthetic duration exceeds one hour."}],
        "sourceIds": [], "evidenceUrl": None,
    }


def base_dataset():
    return {
        "schemaVersion": "frontend-draft-2", "datasetId": "qa-normal-v1", "evidence": "synthetic-fixture",
        "attribution": ATTRIBUTION,
        "model": {"id": "ideal-horizon-center-v1", "label": "Synthetic ideal-horizon QA",
                  "definition": "Body-center elevation > 0 degrees; exact zero is not visible.",
                  "limits": ["Invented values, no astronomical validity.", "No terrain/crater masking, usable power, validated radio link or landing safety.",
                             "Linear crossing times are estimates; cadence can hide events."]},
        "criteriaHours": [1], "sources": [],
        "sites": [{"id": k, "name": f"Synthetic south-pole {k}", "sourceIds": [],
                   "location": {"latitudeDeg": lat, "longitudeEastDeg": lon, "elevationKm": 0,
                                "frame": "IAU_MOON (synthetic test convention)",
                                "elevationDatum": "Synthetic zero-height surface; not surveyed"}}
                  for k, lat, lon in [("ridge", -89.5, 0), ("basin", -89.1, 45)]],
        "scenarios": [scenario("ridge-1", "ridge", [0.2, 0.4, 0.6, 0.8, 1], [100, 101, 102, 103, 104]),
                      scenario("basin-1", "basin", [1, 1.1, 1.2, 1.3, 1.4], [200, 201, 202, 203, 204])],
    }


def package(name, data):
    dataset_bytes = encode(data)
    output = {f"{name}.json": dataset_bytes}
    manifest = {"schemaVersion": "qa-provenance-1", "datasetId": data["datasetId"],
                "datasetSha256": sha(dataset_bytes), "generatedAtUtc": "2026-11-14T05:00:00Z",
                "evidence": "synthetic-fixture", "generatorVersion": "qa-fixtures-1", "attribution": ATTRIBUTION,
                "timeScale": "UTC", "intervalMethod": "linear-center-crossing-v1", "requests": []}
    sites = {s["id"]: s for s in data["sites"]}
    for s in data["scenarios"]:
        loc = sites[s["siteId"]]["location"]
        coordinates = ",".join(str(loc[k]) for k in ("longitudeEastDeg", "latitudeDeg", "elevationKm"))
        for body, target in (("sun", "10"), ("earth", "399")):
            rows = [r for r in s["samples"] if r[body] is not None]
            if not rows:
                continue
            raw_name = f"raw/{name}-{s['id']}-{body}.txt"
            raw = ("SYNTHETIC FIXTURE - NOT A JPL RESPONSE\n" + ATTRIBUTION + "\n"
                   f"Target body name: {body.title()} ({target})\nCenter body name: Moon (301)\n"
                   f"Center geodetic : {coordinates}\nDate__(UT)__HR:MN:SS, , , Azi_(a-app), Elev_(a-app),\n$$SOE\n")
            for row in rows:
                raw += f" {row['utc'].replace('2026-11-', '2026-Nov-').replace('T', ' ').removesuffix('Z')}, , , {row[body]['azimuthDeg']}, {row[body]['elevationDeg']},\n"
            raw += "$$EOE\nSYNTHETIC END\n"
            raw_bytes = raw.encode()
            output[raw_name] = raw_bytes
            manifest["requests"].append({"scenarioId": s["id"], "body": body, "targetId": target,
                "parameters": {**QUERY, "COMMAND": target, "SITE_COORD": coordinates,
                               "START_TIME": s["startUtc"], "STOP_TIME": s["endUtc"], "STEP_SIZE": "1 h"},
                "rawFile": raw_name, "rawSha256": sha(raw_bytes), "retrievedAtUtc": "2026-11-14T05:00:00Z",
                "parserVersion": "qa-q4-1", "frame": loc["frame"], "elevationDatum": loc["elevationDatum"]})
    output[f"{name}.manifest.json"] = encode(manifest)
    return output


def build_files():
    normal = base_dataset()
    crossing = base_dataset()
    crossing["datasetId"] = "qa-crossing-wrap-v1"
    crossing["scenarios"] = [scenario("ridge-1", "ridge", [-1, 0, 1, 0, -1], [358, 359, 1, 359, 358]),
                             scenario("basin-1", "basin", [0.2, 0.4, 0.6, 0.8, 1], [2, 1, 359, 1, 2])]
    partial = deepcopy(crossing)
    partial["datasetId"] = "qa-partial-v1"
    for s in partial["scenarios"]:
        s["coverage"] = "partial"
        s["metrics"] = s["intervals"] = None
        s["criteria"][0].update(result="unknown", reason="Missing data is unknown, not darkness.")
    partial["scenarios"][0]["samples"][2]["sun"] = None
    partial["scenarios"][1]["samples"].pop(2)
    missing = deepcopy(partial)
    missing["datasetId"] = "qa-missing-v1"
    for s in missing["scenarios"]:
        s.update(coverage="missing", samples=[])
    output = {}
    for name, data in (("normal", normal), ("crossing_wrap", crossing), ("partial", partial), ("missing", missing)):
        output.update(package(name, data))
    for name, mutate in (
        ("azimuth_360", lambda d: d["scenarios"][0]["samples"][0]["sun"].update(azimuthDeg=360)),
        ("duplicate_utc", lambda d: d["scenarios"][0]["samples"][1].update(utc=stamp(0))),
        ("missing_timestamp", lambda d: d["scenarios"][0]["samples"].pop(2)),
        ("timezone_offset", lambda d: d["scenarios"][0]["samples"][0].update(utc="2026-11-14T07:00:00+07:00")),
        ("corrupted_schema", lambda d: d.pop("model")),
    ):
        data = deepcopy(normal)
        mutate(data)
        output[f"invalid/{name}.json"] = encode(data)
    return output


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Read-only byte-for-byte reproducibility check")
    args = parser.parse_args()
    files = build_files()
    for name, content in files.items():
        path = FIXTURES / name
        if args.check:
            if not path.is_file() or path.read_bytes() != content:
                raise SystemExit(f"Fixture differs: {name}")
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
    print(f"{'Verified' if args.check else 'Generated'} {len(files)} synthetic fixture files.")


if __name__ == "__main__":
    main()
