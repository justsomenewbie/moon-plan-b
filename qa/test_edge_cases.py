"""Independent expected examples and adversarial mutations for Minh's QA gate."""
from copy import deepcopy
from datetime import timedelta
import json
from pathlib import Path
import tempfile
import unittest

from qa.science import (ContractError, compare_at, contains, interpolate_azimuth,
                        intersection, intervals, utc, visible)
from qa.generate_fixtures import build_files, base_dataset, encode, stamp
from qa.verify_json_contract import (check_geodetic, load, parse_raw, schema_check, sha,
                                     validate_dataset, verify_manifest, ROOT)

FIXTURES = ROOT / "qa/fixtures"


def series(values, azimuth=20):
    return [{"utc": stamp(i), "sun": None if v is None else {"azimuthDeg": azimuth, "elevationDeg": v},
             "earth": {"azimuthDeg": 100, "elevationDeg": 2}} for i, v in enumerate(values)]


class ScientificEdges(unittest.TestCase):
    def spans(self, values):
        origin = utc(stamp(0))
        return [((a-origin).total_seconds()/3600, (b-origin).total_seconds()/3600)
                for a, b in intervals(series(values), "sun", 3600)]

    def test_zero_signed_zero_and_unknown(self):
        for value in (-1, 0.0, -0.0):
            self.assertFalse(visible(value))
        self.assertTrue(visible(1e-12))
        self.assertIsNone(visible(None))
        for value in (True, "1", float("nan"), float("inf"), -91, 91):
            with self.subTest(value=value), self.assertRaises(ContractError):
                visible(value)

    def test_rise_and_set_between_samples(self):
        self.assertEqual(self.spans([-1, 1, -1]), [(0.5, 1.5)])
        self.assertEqual(self.spans([-3, 1]), [(0.75, 1)])
        self.assertEqual(self.spans([3, -1]), [(0, 0.75)])

    def test_exact_zero_crossings_plateaus_and_touches(self):
        self.assertEqual(self.spans([-1, 0, 1, 0, -1]), [(1, 3)])
        self.assertEqual(self.spans([1, 0, 1]), [(0, 1), (1, 2)])
        self.assertEqual(self.spans([1, 0, 0, 1]), [(0, 1), (2, 3)])
        self.assertEqual(self.spans([0, 0, 0]), [])
        self.assertEqual(self.spans([-1, -2]), [])
        self.assertEqual(self.spans([1, 2, 3]), [(0, 2)])

    def test_half_open_accounting_not_point_visibility(self):
        span = (utc(stamp(1)), utc(stamp(3)))
        self.assertTrue(contains(span, utc(stamp(1))))
        self.assertFalse(visible(0))  # The rising boundary is not instantaneously above.
        self.assertTrue(contains(span, utc(stamp(3)) - timedelta(milliseconds=1)))
        self.assertFalse(contains(span, utc(stamp(3))))

    def test_missing_and_gap_are_not_bridged(self):
        self.assertEqual(self.spans([1, None, 1, 1]), [(2, 3)])
        rows = series([1, 1, 1, 1])
        rows.pop(1)
        self.assertEqual(intervals(rows, "sun", 3600), [(utc(stamp(2)), utc(stamp(3)))])

    def test_wrap_both_directions(self):
        self.assertEqual(interpolate_azimuth(359, 1, 0.5), 0)
        self.assertEqual(interpolate_azimuth(1, 359, 0.5), 0)
        self.assertEqual(interpolate_azimuth(359, 1, 0.25), 359.5)
        self.assertEqual(interpolate_azimuth(1, 359, 0.25), 0.5)
        for args in ((0, 180, 0.5), (360, 1, 0.5), (0, 1, -1)):
            with self.assertRaises(ContractError):
                interpolate_azimuth(*args)

    def test_intersection_and_touching_endpoints(self):
        t = [utc(stamp(i)) for i in range(5)]
        self.assertEqual(intersection([(t[0], t[2])], [(t[2], t[4])]), [])
        self.assertEqual(intersection([(t[0], t[3])], [(t[1], t[4])]), [(t[1], t[3])])

    def test_strict_utc_and_equivalent_z_instants(self):
        self.assertEqual(utc(stamp(0)), utc(stamp(0).replace("Z", ".000Z")))
        for value in ("2026-02-30T00:00:00Z", "2026-11-14", "2026-11-14T00:00:00",
                      "2026-11-14T07:00:00+07:00", "2026-11-14T00:00:60Z", "2026-11-14T00:00:00.1Z"):
            with self.subTest(value=value), self.assertRaises(ContractError):
                utc(value)

    def test_multisite_uses_absolute_same_utc(self):
        data = base_dataset()
        selected = compare_at(data["scenarios"], stamp(1))
        self.assertEqual({r["utc"] for r in selected.values()}, {stamp(1)})
        data["scenarios"][1]["samples"].pop(1)
        self.assertIsNone(compare_at(data["scenarios"], stamp(1))["basin"])
        with self.assertRaises(ContractError):
            compare_at(data["scenarios"], stamp(4))
        with self.assertRaises(ContractError):
            compare_at([data["scenarios"][0]] * 2, stamp(1))


class ContractTests(unittest.TestCase):
    def test_golden_packages_and_reproducibility(self):
        for name in ("normal", "crossing_wrap", "partial", "missing"):
            with self.subTest(name=name):
                result = verify_manifest(FIXTURES / f"{name}.json", FIXTURES / f"{name}.manifest.json")
                self.assertEqual(result["status"], "PASS")
        for name, content in build_files().items():
            self.assertEqual((FIXTURES / name).read_bytes(), content, name)

    def test_invalid_fixtures_rejected(self):
        for file in (FIXTURES / "invalid").glob("*.json"):
            with self.subTest(file=file.name), self.assertRaises(ContractError):
                validate_dataset(load(file))

    def test_schema_rejects_extra_fields_types_and_boundaries(self):
        for field, value in (("azimuthDeg", True), ("azimuthDeg", -0.1), ("azimuthDeg", 360),
                             ("elevationDeg", 90.1), ("elevationDeg", -90.1), ("elevationDeg", float("inf"))):
            data = base_dataset()
            data["scenarios"][0]["samples"][0]["sun"][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ContractError):
                validate_dataset(data)
        data = base_dataset(); data["unexpected"] = 1
        with self.assertRaises(ContractError):
            validate_dataset(data)
        data = base_dataset(); data["datasetId"] = "not a valid id"
        with self.assertRaises(ContractError):
            validate_dataset(data)

    def test_duplicate_equivalent_timestamp_and_off_cadence(self):
        for value in (stamp(0).replace("Z", ".000Z"), "2026-11-14T00:30:00Z"):
            data = base_dataset(); data["scenarios"][0]["samples"][1]["utc"] = value
            with self.assertRaises(ContractError):
                validate_dataset(data)

    def test_interval_corruption_including_matching_fake_metrics(self):
        data = base_dataset()
        s = data["scenarios"][0]
        s["intervals"]["sun"][0]["endUtc"] = stamp(3)
        s["intervals"]["sun"][0]["endClipped"] = False
        s["metrics"]["sunAboveHours"] = 3
        with self.assertRaisesRegex(ContractError, "boundaries"):
            validate_dataset(data)

    def test_clipping(self):
        data = base_dataset(); data["scenarios"][0]["intervals"]["sun"][0]["endClipped"] = False
        with self.assertRaisesRegex(ContractError, "clipped"):
            validate_dataset(data)

    def test_interval_tolerance_never_permits_out_of_bounds_or_overlap(self):
        data = base_dataset()
        data["scenarios"][0]["intervals"]["sun"][0]["endUtc"] = "2026-11-14T04:00:00.001Z"
        with self.assertRaisesRegex(ContractError, "within coverage"):
            validate_dataset(data)
        data = base_dataset(); s = data["scenarios"][0]
        s["samples"][2]["sun"]["elevationDeg"] = 0
        spans = [{"startUtc": stamp(0), "endUtc": stamp(2), "endClipped": False},
                 {"startUtc": "2026-11-14T01:59:59.999Z", "endUtc": stamp(4), "endClipped": True}]
        s["intervals"]["sun"] = deepcopy(spans)
        s["intervals"]["simultaneous"] = deepcopy(spans)
        s["metrics"]["simultaneousLongestHours"] = 2
        with self.assertRaisesRegex(ContractError, "disjoint"):
            validate_dataset(data)
    def test_unknown_metrics(self):
        data = load(FIXTURES / "partial.json"); data["scenarios"][0]["metrics"] = base_dataset()["scenarios"][0]["metrics"]
        with self.assertRaisesRegex(ContractError, "must be null"):
            validate_dataset(data)

    def test_joint_cannot_start_before_serialized_sun(self):
        data = load(FIXTURES / "crossing_wrap.json")
        data["scenarios"][0]["intervals"]["sun"][0]["startUtc"] = "2026-11-14T01:00:00.001Z"
        with self.assertRaisesRegex(ContractError, "joint interval"):
            validate_dataset(data)

    def test_duplicate_keys_nonfinite_json_and_size_limit(self):
        with tempfile.TemporaryDirectory() as folder:
            p = Path(folder) / "bad.json"
            for content in ('{"x":1,"x":2}', '{"x":NaN}', '{"x":Infinity}', '{"x":', '"' + "a" * (5*1024*1024) + '"'):
                p.write_text(content)
                with self.assertRaises(ContractError):
                    load(p)

    def test_schema_evolution_fails_closed(self):
        with self.assertRaisesRegex(ContractError, "unsupported schema"):
            schema_check("x", {"type": "string", "unknownKeyword": 1}, {})


class TraceabilityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        for name, content in build_files().items():
            path = self.base / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        self.dataset = self.base / "normal.json"
        self.manifest = self.base / "normal.manifest.json"

    def write_manifest(self, manifest):
        self.manifest.write_bytes(encode(manifest))

    def test_hash_tamper(self):
        self.dataset.write_bytes(self.dataset.read_bytes() + b" ")
        with self.assertRaisesRegex(ContractError, "dataset SHA"):
            verify_manifest(self.dataset, self.manifest)

    def test_raw_hash_tamper(self):
        m = load(self.manifest)
        raw = self.base / m["requests"][0]["rawFile"]
        raw.write_bytes(raw.read_bytes() + b"tampered")
        with self.assertRaisesRegex(ContractError, "raw SHA"):
            verify_manifest(self.dataset, self.manifest)

    def test_raw_numeric_corruption_even_with_updated_hash(self):
        m = load(self.manifest); req = m["requests"][0]
        raw = self.base / req["rawFile"]
        content = raw.read_bytes().replace(b"100, 0.2", b"100, 0.200000000000000001")
        raw.write_bytes(content); req["rawSha256"] = sha(content); self.write_manifest(m)
        with self.assertRaisesRegex(ContractError, "raw/JSON records differ"):
            verify_manifest(self.dataset, self.manifest)

    def test_metadata_missing_or_wrong(self):
        original = load(self.manifest)
        mutations = [lambda m: m.pop("generatedAtUtc"), lambda m: m.update(timeScale="TDB"),
                     lambda m: m["requests"][0]["parameters"].update(CENTER="500@399"),
                     lambda m: m["requests"][0]["parameters"].update(APPARENT="REFRACTED"),
                     lambda m: m["requests"][0]["parameters"].update(TIME_TYPE="UTC"),
                     lambda m: m["requests"][0]["parameters"].update(STEP_SIZE="3600 s"),
                     lambda m: m["requests"][0]["parameters"].update(SITE_COORD="0,-89.5,1"),
                     lambda m: m["requests"][0].update(targetId="399"),
                     lambda m: m["requests"].pop(), lambda m: m["requests"].append(deepcopy(m["requests"][0]))]
        for mutate in mutations:
            m = deepcopy(original); mutate(m); self.write_manifest(m)
            with self.subTest(mutation=mutate), self.assertRaises(ContractError):
                verify_manifest(self.dataset, self.manifest)

    def test_raw_traversal_and_absolute_path_rejected(self):
        for name in ("../outside.txt", str(self.dataset.resolve())):
            m = load(self.manifest); m["requests"][0]["rawFile"] = name; self.write_manifest(m)
            with self.assertRaisesRegex(ContractError, "path"):
                verify_manifest(self.dataset, self.manifest)

    def test_synthetic_cannot_pass_release_gate(self):
        with self.assertRaisesRegex(ContractError, "synthetic"):
            verify_manifest(self.dataset, self.manifest, release=True)

    def test_raw_parser_invalid_headers_and_rows(self):
        req = load(self.manifest)["requests"][0]
        content = (self.base / req["rawFile"]).read_bytes()
        for bad in (content.replace(b"$$EOE", b""), content.replace(b"(10)", b"(399)"),
                    content.replace(b"(301)", b"(399)"), content.replace(b"(UT)", b"(TT)"),
                    content.replace(b"(a-app)", b"(r-app)"),
                    content.replace(b"Azi_(a-app), Elev", b"Elev, Azi_(a-app)"),
                    content.replace(b"01:00:00", b"00:00:00"), content.replace(b"0.2,", b"n.a.,")):
            with self.assertRaises((ContractError, ValueError)):
                parse_raw(bad, "10")

    def test_archived_horizons_q4(self):
        evidence = ROOT / "qa/evidence"
        control = load(evidence / "odysseus-athena-hour-gap/control.json", decimal=True)
        sources = {source["id"]: source for source in control["sources"]}
        for scenario, directory, prefix in zip(control["scenarios"],
                ("odysseus-hour-gap", "odysseus-athena-hour-gap"), ("jpl", "athena"), strict=True):
            site = next(site for site in control["sites"] if site["id"] == scenario["siteId"])
            coordinates = [site["location"][k] for k in ("longitudeEastDeg", "latitudeDeg", "elevationKm")]
            for body, target in (("sun", "10"), ("earth", "399")):
                with self.subTest(scenario=scenario["id"], body=body):
                    raw = (evidence / directory / f"{body}-response.json").read_bytes()
                    self.assertEqual(sha(raw), sources[f"{prefix}-{body}"]["rawSha256"])
                    head, rows = parse_raw(raw, target)
                    check_geodetic(head, coordinates)
                    self.assertEqual(rows, [(utc(s["utc"]), s[body]["azimuthDeg"], s[body]["elevationDeg"])
                                            for s in scenario["samples"]])

    def test_horizons_json_rejects_errors_and_ambiguous_responses(self):
        source = ROOT / "qa/evidence/odysseus-hour-gap/sun-response.json"
        response = load(source)
        for bad in ({**response, "error": "No ephemeris"}, {**response, "signature": {}},
                    {**response, "result": None},
                    {**response, "result": response["result"].replace("Azimuth_(a-app)", "Azimuth_(r-app)")},
                    {**response, "result": response["result"].replace("Elevation_(a-app)", "Elevation")},
                    {**response, "result": response["result"].replace("Elevation_(a-app),", "Elevation_(a-app), Range,")}):
            with self.assertRaises(ContractError):
                parse_raw(json.dumps(bad).encode(), "10")
        duplicate = b'{"result":"discarded",' + source.read_bytes().lstrip()[1:]
        with self.assertRaisesRegex(ContractError, "duplicate JSON key"):
            parse_raw(duplicate, "10")

    def test_raw_whitespace_format(self):
        raw = b"Target body name: Sun (10)\nCenter body name: Moon (301)\nDate__(UT)__HR:MN:SS Azi____(a-app)___Elev\n$$SOE\n2026-Nov-14 00:00:00 * 359.0 -0.0\n$$EOE\n"
        _, records = parse_raw(raw, "10")
        self.assertEqual(records[0][0], utc(stamp(0)))
        self.assertEqual(records[0][1], 359)
        self.assertEqual(records[0][2], 0)

    def test_geodetic_source_precision(self):
        from decimal import Decimal
        check_geodetic("Center geodetic : 315.0, -89.1, 3.85804E-13    {E-lon(deg),Lat(deg),Alt(km)}",
                       [Decimal("-45"), Decimal("-89.1"), Decimal("0")])
        with self.assertRaisesRegex(ContractError, "coordinates mismatch"):
            check_geodetic("Center geodetic : 45,-89.1,1E-2", [Decimal(45), Decimal("-89.1"), Decimal(0)])


if __name__ == "__main__":
    unittest.main(verbosity=2)
