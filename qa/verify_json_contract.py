"""Offline, fail-closed validator for frontend-draft-2 and QA provenance.

Run: python -m qa.verify_json_contract DATASET --manifest MANIFEST
No network, package dependencies or execution of input content.
"""
import argparse
import csv
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import hashlib
import json
import math
from pathlib import Path
import re
from urllib.parse import urlsplit

from qa.science import ContractError, require, utc, intervals, intersection

ROOT = Path(__file__).resolve().parents[1]
LIMIT = 5 * 1024 * 1024
QUERY = {"CENTER": "coord@301", "COORD_TYPE": "GEODETIC", "QUANTITIES": "4",
         "APPARENT": "AIRLESS", "TIME_TYPE": "UT", "EPHEM_TYPE": "OBSERVER",
         "CSV_FORMAT": "YES", "CAL_FORMAT": "CAL", "TIME_DIGITS": "SECONDS"}


def read_bytes(path):
    with Path(path).open("rb") as handle:
        content = handle.read(LIMIT + 1)
    require(len(content) <= LIMIT, "file exceeds 5 MiB QA limit")
    return content


def sha(content):
    return hashlib.sha256(content).hexdigest()


def load(path, decimal=False):
    return parse_json(read_bytes(path), decimal)


def parse_json(content, decimal=False):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, f"duplicate JSON key: {key}")
            result[key] = value
        return result
    def invalid(value):
        raise ContractError(f"non-finite JSON constant: {value}")
    try:
        return json.loads(content, object_pairs_hook=pairs,
                          parse_float=Decimal if decimal else float, parse_constant=invalid)
    except (UnicodeError, ValueError, RecursionError) as exc:
        raise ContractError(f"invalid JSON: {exc}") from exc


def schema_check(value, schema, document, path="$", depth=0):
    """Only the frozen draft's schema vocabulary, not a general JSON Schema engine.

    Unknown validation keywords fail closed, so a changed draft cannot silently
    lose constraints. Local references only. Semantic checks are separate.
    """
    require(depth < 50, "schema recursion limit")
    supported = {"$ref", "type", "anyOf", "properties", "required", "additionalProperties",
                 "items", "maxItems", "minimum", "maximum", "exclusiveMaximum", "enum",
                 "pattern", "minLength", "maxLength", "format", "description", "title"}
    require(not (set(schema) - supported), f"unsupported schema keyword at {path}")
    if "$ref" in schema:
        ref = schema["$ref"]
        require(ref.startswith("#/components/schemas/"), "only local schema refs supported")
        schema_check(value, document["components"]["schemas"][ref.rsplit("/", 1)[1]], document, path, depth + 1)
    if "anyOf" in schema:
        for option in schema["anyOf"]:
            try:
                schema_check(value, option, document, path, depth + 1)
                break
            except ContractError:
                pass
        else:
            raise ContractError(f"{path}: no anyOf branch matches")
    actual = ("null" if value is None else "boolean" if type(value) is bool else
              "integer" if type(value) is int else "number" if type(value) is float else
              "string" if isinstance(value, str) else "array" if isinstance(value, list) else
              "object" if isinstance(value, dict) else "unsupported")
    if "type" in schema:
        types = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
        require(actual in types or actual == "integer" and "number" in types, f"{path}: wrong type")
    if "enum" in schema:
        require(value in schema["enum"], f"{path}: invalid enum")
    if actual in ("number", "integer"):
        require(math.isfinite(value), f"{path}: non-finite number")
        for key, predicate in (("minimum", lambda x: value >= x), ("maximum", lambda x: value <= x),
                               ("exclusiveMaximum", lambda x: value < x)):
            require(key not in schema or predicate(schema[key]), f"{path}: {key}")
    if actual == "string":
        require(schema.get("minLength", 0) <= len(value) <= schema.get("maxLength", LIMIT), f"{path}: length")
        require("pattern" not in schema or re.search(schema["pattern"], value), f"{path}: pattern")
        if schema.get("format") == "date-time":
            utc(value)
        elif schema.get("format") == "uri":
            url = urlsplit(value)
            require(url.scheme in ("https", "http") and url.hostname and not url.username and not url.password,
                    f"{path}: expected credential-free HTTP(S) URL")
        else:
            require("format" not in schema, "unsupported schema format")
    if actual == "array":
        require(len(value) <= schema.get("maxItems", 10000), f"{path}: too many items")
        for i, item in enumerate(value):
            schema_check(item, schema.get("items", {}), document, f"{path}[{i}]", depth + 1)
    if actual == "object":
        require(set(schema.get("required", [])) <= set(value), f"{path}: missing required fields")
        props = schema.get("properties", {})
        require(schema.get("additionalProperties", True) or set(value) <= set(props), f"{path}: extra fields")
        for key in value.keys() & props.keys():
            schema_check(value[key], props[key], document, f"{path}.{key}", depth + 1)


def validate_dataset(data):
    document = load(ROOT / "contracts/openapi.draft.json")
    schema_check(data, document["components"]["schemas"]["Dataset"], document)
    require(data["model"]["id"] == "ideal-horizon-center-v1" and data["model"]["limits"], "model/limits mismatch")
    criteria = data["criteriaHours"]
    require(criteria and len(criteria) == len(set(criteria)), "criteria must be nonempty and unique")
    catalogs = {}
    for key in ("sites", "sources", "scenarios"):
        ids = [v["id"] for v in data[key]]
        require(len(ids) == len(set(ids)), f"duplicate {key} IDs")
        catalogs[key] = {v["id"]: v for v in data[key]}
    real = data["evidence"] == "computed-ephemeris"
    for item in data["sites"] + data["scenarios"]:
        require(all(ref in catalogs["sources"] for ref in item["sourceIds"]), "unknown source reference")
        require(not real or item["sourceIds"], "computed data needs source references")
    for site in data["sites"]:
        require(not real or site["location"] is not None, "computed data needs location")
    for s in data["scenarios"]:
        require(s["siteId"] in catalogs["sites"], "unknown site")
        start, end = utc(s["startUtc"]), utc(s["endUtc"])
        require(start < end, "invalid scenario window")
        horizon = s["horizonCurve"]
        require(len(horizon) >= 2 and horizon[0]["azimuthDeg"] == 0 and horizon[-1]["azimuthDeg"] == 360,
                "horizon must cover 0..360")
        require(all(p["elevationDeg"] == 0 for p in horizon) and
                all(a["azimuthDeg"] < b["azimuthDeg"] for a, b in zip(horizon, horizon[1:])), "horizon must be ordered and flat")
        times = [utc(v["utc"]) for v in s["samples"]]
        require(all(start <= t <= end for t in times), "sample outside coverage")
        require(all(a < b for a, b in zip(times, times[1:])), "timestamps duplicate or unordered")
        require(all((t - start).total_seconds() % s["sampleStepSeconds"] == 0 for t in times), "sample not on UTC cadence")
        if real:
            require(s["evidenceUrl"] and any(catalogs["sources"][ref]["rawSha256"] for ref in s["sourceIds"]),
                    "computed data needs processing evidence and raw hash")
        complete = s["coverage"] == "complete"
        if not complete:
            require(s["metrics"] is None and s["intervals"] is None, "partial/missing metrics and intervals must be null")
            require(s["coverage"] != "missing" or not times, "missing coverage has samples")
        else:
            require(len(times) >= 2 and times[0] == start and times[-1] == end and
                    all((b - a).total_seconds() == s["sampleStepSeconds"] for a, b in zip(times, times[1:])) and
                    all(v[b] is not None for v in s["samples"] for b in ("sun", "earth")), "complete coverage has gaps/nulls/boundary loss")
            require(s["intervals"] is not None and s["metrics"] is not None, "complete data needs metrics/intervals")
            derived = {b: intervals(s["samples"], b, s["sampleStepSeconds"]) for b in ("sun", "earth")}
            derived["simultaneous"] = intersection(derived["sun"], derived["earth"])
            serialized = {}
            for body, expected in derived.items():
                actual = s["intervals"][body]
                serialized[body] = []
                require(len(actual) == len(expected), f"{s['id']} {body}: interval count differs from linear QA model")
                previous_end = start
                for item, (a, b) in zip(actual, expected):
                    actual_start, actual_end = utc(item["startUtc"]), utc(item["endUtc"])
                    require(start <= actual_start < actual_end <= end and actual_start >= previous_end,
                            "intervals must be ordered, disjoint, and within coverage")
                    require(not item["endClipped"] or actual_end == end, "clipped interval must end at coverage boundary")
                    previous_end = actual_end
                    serialized[body].append((actual_start, actual_end))
                    require(abs((utc(item["startUtc"]) - a).total_seconds()) <= 0.001 and
                            abs((utc(item["endUtc"]) - b).total_seconds()) <= 0.001,
                            f"{s['id']} {body}: incorrect interval boundaries")
                    require(utc(item["startUtc"]) < utc(item["endUtc"]), "zero/reversed interval")
                    end_above = all(s["samples"][-1][k]["elevationDeg"] > 0 for k in
                                    (("sun", "earth") if body == "simultaneous" else (body,)))
                    require(item["endClipped"] == (b == end and end_above), "incorrect clipped interval")
                durations = [(b - a).total_seconds() / 3600 for a, b in expected]
                metric = {"sun": "sunAboveHours", "earth": "earthAboveHours", "simultaneous": "simultaneousLongestHours"}[body]
                expected_metric = max(durations, default=0) if body == "simultaneous" else sum(durations)
                require(abs(s["metrics"][metric] - expected_metric) < 1e-6, "metrics differ from linear QA model")
            for body in ("sun", "earth"):
                spans = serialized[body]
                index = 0
                for first, last in serialized["simultaneous"]:
                    while index < len(spans) and spans[index][1] < last:
                        index += 1
                    require(index < len(spans) and spans[index][0] <= first,
                            "joint interval lies outside a supplied body interval")
        require(len(s["criteria"]) == len(criteria) and {c["minimumHours"] for c in s["criteria"]} == set(criteria), "criterion mismatch")
        for c in s["criteria"]:
            if not complete:
                require(c["result"] == "unknown", "incomplete data must remain unknown")
            elif c["result"] in ("meets", "below"):
                require((c["result"] == "meets") == (s["metrics"]["simultaneousLongestHours"] >= c["minimumHours"]), "criterion contradicts metric")
    return data


def parse_raw(content, target):
    """Read a Q4 observer table returned as Horizons text or an API JSON response."""
    text = content.decode("utf-8")
    if text.lstrip().startswith("{"):
        response = parse_json(text)
        signature = response.get("signature")
        require(isinstance(signature, dict) and signature.get("source") == "NASA/JPL Horizons API"
                and "error" not in response and isinstance(response.get("result"), str),
                "expected successful Horizons JSON response")
        text = response["result"]
    require(text.count("$$SOE") == 1 and text.count("$$EOE") == 1, "raw response needs unique SOE/EOE")
    head, rest = text.split("$$SOE")
    rows, _ = rest.split("$$EOE")
    require(re.search(rf"Target body name:.*\({target}\)", head), "raw target mismatch")
    require(re.search(r"Center body name:.*\(301\)", head), "raw center must be Moon (301)")
    require(re.search(r"^\s*Date_+\(UT\)_+HR:MN:SS[ ,\t]*"
                      r"(?:Azi_+\(a-app\)[_, \t]+Elev(?:_+\(a-app\))?|"
                      r"Azimuth_\(a-app\)[ ,\t]+Elevation_\(a-app\))\s*,?\s*$",
                      head, re.MULTILINE | re.ASCII),
            "unsupported raw header: require UT seconds and airless Q4")
    result = []
    for line in rows.strip().splitlines():
        require(line.strip(), "blank raw record")
        match = re.match(r"\s*(\d{4})-([A-Z][a-z]{2})-(\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)", line)
        require(match is not None, "unsupported raw timestamp")
        year, month, day, time = match.groups()
        months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()
        require(month in months, "invalid raw month")
        stamp = datetime.fromisoformat(f"{year}-{months.index(month)+1:02}-{day}T{time}+00:00")
        require(stamp.year >= 1962, "UT-to-UTC mapping unsupported before 1962")
        tail = line[match.end():]
        fields = [v.strip() for v in next(csv.reader([tail]))] if "," in tail else tail.split()
        fields = [f for f in fields if f]
        require(len(fields) >= 2, "raw row missing angles")
        # Presence/visibility flags may precede Q4, but no extra numeric columns.
        require(all(re.fullmatch(r"[A-Za-z*+/\-]+", f) for f in fields[:-2]), "unexpected raw columns")
        try:
            az, el = map(Decimal, fields[-2:])
        except InvalidOperation as exc:
            raise ContractError("raw angles must be numeric") from exc
        require(az.is_finite() and el.is_finite() and 0 <= az < 360 and -90 <= el <= 90, "invalid raw angles")
        require(not result or result[-1][0] < stamp, "raw UTC duplicate/unordered")
        result.append((stamp, az, el))
    require(result, "empty raw response")
    return head, result


def check_geodetic(head, coordinates):
    # Horizons prints finite precision and may report numerical roundoff for
    # zero altitude. Longitudes can be reported modulo 360 degrees.
    token = r"([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)"
    pattern = r"^Center geodetic\s*:\s*" + r"\s*,\s*".join([token] * 3) + r"(?=\s|$)"
    match = re.search(pattern, head, re.MULTILINE)
    require(match, "raw geodetic coordinates missing")
    lon, lat, height = map(Decimal, match.groups())
    dlon = abs(lon - coordinates[0]) % 360
    require(min(dlon, 360 - dlon) <= Decimal("0.00001") and
            abs(lat - coordinates[1]) <= Decimal("0.00001") and
            abs(height - coordinates[2]) <= Decimal("0.000001"), "raw geodetic coordinates mismatch")


def object_keys(value, keys, label):
    require(isinstance(value, dict) and set(value) == set(keys.split()), f"{label}: missing/extra fields")


def verify_manifest(dataset_path, manifest_path, release=False):
    data = validate_dataset(load(dataset_path))
    exact = load(dataset_path, decimal=True)
    m = load(manifest_path)
    object_keys(m, "schemaVersion datasetId datasetSha256 generatedAtUtc evidence generatorVersion attribution timeScale intervalMethod requests", "manifest")
    require(m["schemaVersion"] == "qa-provenance-1" and m["datasetId"] == data["datasetId"], "manifest identity mismatch")
    require(m["datasetSha256"] == sha(read_bytes(dataset_path)), "dataset SHA-256 mismatch")
    utc(m["generatedAtUtc"])
    require(m["evidence"] == data["evidence"] and m["timeScale"] == "UTC", "evidence/timeScale mismatch")
    require(m["intervalMethod"] == "linear-center-crossing-v1", "unsupported interval method")
    require(all(isinstance(m[k], str) and m[k].strip() for k in ("generatorVersion", "attribution")), "missing generator/attribution")
    require(not release or data["evidence"] == "computed-ephemeris", "release gate rejects synthetic fixtures")
    require(isinstance(m["requests"], list), "requests must be a list")
    scenarios = {s["id"]: s for s in exact["scenarios"]}
    sites = {s["id"]: s for s in exact["sites"]}
    expected = {(s["id"], b) for s in exact["scenarios"] for b in ("sun", "earth") if any(row[b] is not None for row in s["samples"])}
    seen = set()
    for req in m["requests"]:
        object_keys(req, "scenarioId body targetId parameters rawFile rawSha256 retrievedAtUtc parserVersion frame elevationDatum", "request")
        key = (req["scenarioId"], req["body"])
        require(key in expected and key not in seen, "unknown/duplicate raw request")
        seen.add(key)
        target = {"sun": "10", "earth": "399"}[req["body"]]
        require(req["targetId"] == target, "target ID mismatch")
        p = req["parameters"]
        object_keys(p, " ".join([*QUERY, "COMMAND", "SITE_COORD", "START_TIME", "STOP_TIME", "STEP_SIZE"]), "parameters")
        require(all(p[k] == v for k, v in QUERY.items()) and p["COMMAND"] == target, "Horizons query mismatch")
        s = scenarios[req["scenarioId"]]
        loc = sites[s["siteId"]]["location"]
        require(loc is not None, "traceability requires explicit location, even for synthetic fixtures")
        coordinates = [Decimal(str(loc[k])) for k in ("longitudeEastDeg", "latitudeDeg", "elevationKm")]
        require(isinstance(p["SITE_COORD"], str) and [Decimal(v) for v in p["SITE_COORD"].split(",")] == coordinates, "SITE_COORD mismatch")
        require(req["frame"] == loc["frame"] and req["elevationDatum"] == loc["elevationDatum"], "frame/datum mismatch")
        step = re.fullmatch(r"([1-9]\d*)\s*(m|min|minutes?|h|hours?|d|days?)", str(p["STEP_SIZE"]), re.I)
        require(step is not None, "unsupported Horizons STEP_SIZE; use fixed minutes, hours or days")
        seconds = int(step[1]) * {"m": 60, "h": 3600, "d": 86400}[step[2][0].lower()]
        require(p["START_TIME"] == s["startUtc"] and p["STOP_TIME"] == s["endUtc"] and
                seconds == s["sampleStepSeconds"], "query coverage mismatch")
        require(req["parserVersion"] == "qa-q4-1", "unsupported parser version")
        require(utc(req["retrievedAtUtc"]) <= utc(m["generatedAtUtc"]), "retrieval follows generation")
        base = Path(manifest_path).resolve().parent
        require(isinstance(req["rawFile"], str) and not Path(req["rawFile"]).is_absolute(), "raw path must be relative")
        raw_path = (base / req["rawFile"]).resolve()
        require(raw_path.is_relative_to(base), "raw path escapes evidence package")
        content = read_bytes(raw_path)
        require(sha(content) == req["rawSha256"], "raw SHA-256 mismatch")
        require(not release or b"SYNTHETIC" not in content, "release gate rejects synthetic raw")
        head, raw = parse_raw(content, target)
        check_geodetic(head, coordinates)
        processed = [(utc(row["utc"]), Decimal(str(row[req["body"]]["azimuthDeg"])),
                      Decimal(str(row[req["body"]]["elevationDeg"]))) for row in s["samples"] if row[req["body"]] is not None]
        require(raw == processed, "raw/JSON records differ (UTC/order/count/angles)")
        if release:
            sources = {v["id"]: v for v in exact["sources"]}
            require(any(sources[ref]["rawSha256"] == req["rawSha256"] for ref in s["sourceIds"]), "raw source reference/hash mismatch")
    require(seen == expected, "missing raw request for scenario/body")
    require(not release or expected, "release gate requires nonempty source data")
    return {"status": "PASS", "datasetId": data["datasetId"], "evidence": data["evidence"],
            "rawRequests": len(seen), "scope": "artifact consistency; not scientific/release approval"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--release", action="store_true", help="Require computed evidence, never synthetic")
    args = parser.parse_args()
    try:
        print(json.dumps(verify_manifest(args.dataset, args.manifest, args.release)))
        return 0
    except (OSError, ValueError, TypeError, KeyError, InvalidOperation, OverflowError, RecursionError) as exc:
        print(json.dumps({"status": "FAIL", "error": str(exc)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
