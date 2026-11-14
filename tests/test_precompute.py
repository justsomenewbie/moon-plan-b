"""End-to-end tests of the precompute pipeline, the output checker and the CLI.

Uses the SyntheticProvider (toy geometry with realistic amplitudes) and fake terrain masks, so
no network or DEM is needed. check_output must return [] for a correct run and must catch
deliberately corrupted outputs.
"""
from __future__ import annotations

import gzip
import json
import shutil
from pathlib import Path

import numpy as np
import pytest

from lunarnav import precompute as pc
from lunarnav.cli import main, parse_custom_site
from lunarnav.precompute import (
    SyntheticProvider,
    bearing_deg,
    check_output,
    make_horizon_fn,
    read_table,
    run_precompute,
)
from lunarnav.types import HorizonMask, Site
from lunarnav.visibility import flat_horizon_mask

START, END = "2026-01-01T00:00:00", "2026-03-01T00:00:00"  # 59 days, hourly -> 1416 samples
TS = "2026-11-13T12:00:00Z"
SITES = [
    Site("sp", "South pole rim", -89.5, 0.0, group="south_pole"),
    Site("sp45", "Polar 85S 45E", -85.0, 45.0, group="south_pole", height_m=1200.0),
    Site("eq", "Equator near side", 0.0, 0.0),
    Site("far", "Far side", 0.0, 180.0),
    Site("mid", "Mid latitude", 45.0, 300.0),
]


def fake_horizon(site: Site) -> HorizonMask:
    """Terrain-like masks for the polar sites (ridges up to +1.5 deg), flat elsewhere."""
    if site.lat_deg > -80:
        return flat_horizon_mask(site.id, 2.0, site.height_m or 0.0)
    az = np.arange(0.0, 360.0, 0.5)
    el = 0.4 + 1.1 * np.sin(np.radians(3 * az)) * np.cos(np.radians(az))
    return HorizonMask(site.id, az, el, "fake", "test:sinusoid", 50.0, 2.0, 1500.0, meta={
        "data_sources": [{"name": "fake DEM", "url": None, "sha256": "0" * 64}],
    })


def _run(out: Path, **kw) -> Path:
    return run_precompute(SITES, START, END, 60, SyntheticProvider(), fake_horizon, out, TS,
                          dem_name="none", horizon_method=None, **kw)


@pytest.fixture(scope="module")
def outdir(tmp_path_factory) -> Path:
    return _run(tmp_path_factory.mktemp("pre") / "run")


def _copy(outdir: Path, tmp_path: Path) -> Path:
    d = tmp_path / "copy"
    shutil.copytree(outdir, d)
    return d


def _rewrite_vis(d: Path, site: str, fn) -> None:
    p = d / "sites" / site / "visibility.csv.gz"
    cols = read_table(p)
    fn(cols)
    pc._write_bytes(p, pc._table_bytes(cols, pc.VIS_FILE_COLUMNS), gz=True)


def _has(v: list[str], text: str) -> bool:
    return any(text in x for x in v)


# ------------------------------------------------------------------------------------------
class TestCorrectOutput:
    def test_check_output_clean(self, outdir):
        assert check_output(outdir) == []

    def test_layout_and_manifest(self, outdir):
        man = json.loads((outdir / "manifest.json").read_text())
        assert man["run_timestamp_utc"] == TS
        assert man["parameters"]["n_samples"] == 59 * 24
        assert man["parameters"]["step_s"] == 3600
        assert man["git_commit"] is None or len(man["git_commit"]) == 40
        names = {s["name"] for s in man["data_sources"]}
        assert "fake DEM" in names and any("Synthetic" in n for n in names)
        for s in SITES:
            sd = outdir / "sites" / s.id
            for f in ("visibility.csv.gz", "windows.json", "ephemeris_synthetic.csv.gz"):
                assert (sd / f).is_file()
            assert len(list(sd.glob("horizon_*.csv"))) == 1
            assert f"sites/{s.id}/visibility.csv.gz" in man["files"]
        hdr = gzip.open(outdir / "sites" / "sp" / "visibility.csv.gz", "rt").readline().strip().split(",")
        assert tuple(hdr) == pc.VIS_FILE_COLUMNS

    def test_physics_of_output(self, outdir):
        # Earth from a near-pole site lies along the bearing to the sub-Earth point (~0N 0E):
        # deviation = longitude libration (<= 7.9 deg in the synthetic model)
        sp = read_table(outdir / "sites" / "sp" / "visibility.csv.gz")
        b = bearing_deg(-89.5, 0.0, 0.0, 0.0)
        assert b == pytest.approx(0.0, abs=1e-9)
        dev = np.abs((sp["earth_az_deg"] - b + 180) % 360 - 180)
        assert dev.max() <= 8.5
        # Sun within colatitude (0.5) + 1.543 deg of the horizon plane
        assert np.abs(sp["sun_el_deg"]).max() <= 0.5 + 1.543 + 1e-3
        far = read_table(outdir / "sites" / "far" / "visibility.csv.gz")
        assert not far["earth_visible"].any() and far["earth_el_deg"].max() < -70
        eq = read_table(outdir / "sites" / "eq" / "visibility.csv.gz")
        assert eq["earth_visible"].all()
        # sun_visible <=> upper limb above horizon, in the written file
        up = eq["sun_el_deg"] + eq["sun_semidiam_deg"] - eq["horizon_el_sun_deg"]
        assert np.all(eq["sun_visible"] == (up > 0))

    def test_summary(self, outdir):
        rows = pc.read_summary(outdir / "summary.csv")
        assert set(rows) == {s.id for s in SITES}
        assert float(rows["far"]["pct_earth"]) == 0.0 and float(rows["eq"]["pct_earth"]) == 100.0
        ranks = sorted(int(r["rank"]) for r in rows.values())
        assert ranks == [1, 2, 3, 4, 5]

    def test_deterministic(self, outdir, tmp_path):
        d2 = _run(tmp_path / "again")
        files = sorted(p.relative_to(outdir) for p in outdir.rglob("*") if p.is_file())
        assert files == sorted(p.relative_to(d2) for p in d2.rglob("*") if p.is_file())
        for f in files:
            assert (outdir / f).read_bytes() == (d2 / f).read_bytes(), f

    def test_resume_reuses_sites(self, outdir, tmp_path):
        d = _copy(outdir, tmp_path)
        msgs: list[str] = []
        _run(d, resume=True, progress=msgs.append)
        assert sum("reused" in m for m in msgs) == len(SITES)
        for f in ("manifest.json", "summary.csv", "sites.json"):
            assert (d / f).read_bytes() == (outdir / f).read_bytes()
        assert check_output(d) == []


# ------------------------------------------------------------------------------------------
class TestCorruptionsAreCaught:
    def test_flipped_sun_flag(self, outdir, tmp_path):
        d = _copy(outdir, tmp_path)

        def flip(c):
            i = int(np.flatnonzero(c["sun_visible"])[3])
            c["sun_visible"][i] = False

        _rewrite_vis(d, "eq", flip)
        v = check_output(d)
        assert _has(v, "checksum mismatch: sites/eq/visibility.csv.gz")
        assert _has(v, "sun not visible but upper limb above horizon")
        assert _has(v, "state disagrees with the visibility series")

    def test_window_removed(self, outdir, tmp_path):
        d = _copy(outdir, tmp_path)
        p = d / "sites" / "eq" / "windows.json"
        w = json.loads(p.read_text())
        del w["sun"][1]
        p.write_text(json.dumps(w))
        assert _has(check_output(d), "do not tile")

    def test_pct_out_of_range(self, outdir, tmp_path):
        d = _copy(outdir, tmp_path)
        p = d / "sites" / "mid" / "windows.json"
        w = json.loads(p.read_text())
        w["metrics"]["pct_sun"] = 120.0
        p.write_text(json.dumps(w))
        assert _has(check_output(d), "metric pct_sun missing or outside [0, 100]")

    def test_far_side_earth(self, outdir, tmp_path):
        d = _copy(outdir, tmp_path)

        def bad(c):
            c["earth_el_deg"][:5] = 3.0  # Earth above the horizon from the far side: impossible

        _rewrite_vis(d, "far", bad)
        v = check_output(d)
        assert _has(v, "far-side site but Earth elevation >= 0")

    def test_far_side_earth_visible_flag(self, outdir, tmp_path):
        d = _copy(outdir, tmp_path)
        _rewrite_vis(d, "far", lambda c: c["earth_visible"].__setitem__(slice(0, 3), True))
        v = check_output(d)
        assert _has(v, "far-side site but Earth visible")
        assert _has(v, "earth_visible inconsistent with clearance")

    def test_polar_sun_too_high(self, outdir, tmp_path):
        d = _copy(outdir, tmp_path)
        _rewrite_vis(d, "sp", lambda c: c["sun_el_deg"].__setitem__(10, 3.0))
        assert _has(check_output(d), "polar site: |sun_el| exceeds")

    def test_polar_earth_azimuth(self, outdir, tmp_path):
        d = _copy(outdir, tmp_path)
        _rewrite_vis(d, "sp", lambda c: c["earth_az_deg"].__setitem__(slice(0, 24), 90.0))
        assert _has(check_output(d), "earth_az deviates")

    def test_fraction_formula(self, outdir, tmp_path):
        d = _copy(outdir, tmp_path)

        def bad(c):
            i = int(np.flatnonzero((c["sun_fraction"] > 0.1) & (c["sun_fraction"] < 0.9))[0])
            c["sun_fraction"][i] += 0.05

        _rewrite_vis(d, "sp", bad)
        assert _has(check_output(d), "sun_fraction inconsistent with the circular-segment formula")

    def test_missing_file_and_summary_edit(self, outdir, tmp_path):
        d = _copy(outdir, tmp_path)
        (d / "sites" / "mid" / "ephemeris_synthetic.csv.gz").unlink()
        txt = (d / "summary.csv").read_text().splitlines()
        hdr = txt[0].split(",")
        k = hdr.index("pct_sun")
        j = next(i for i, ln in enumerate(txt) if ln.split(",")[1] == "eq")  # a site with intact files
        row = txt[j].split(",")
        row[k] = str(float(row[k]) - 1.0)
        txt[j] = ",".join(row)
        (d / "summary.csv").write_text("\n".join(txt) + "\n")
        v = check_output(d)
        assert _has(v, "listed file missing: sites/mid/ephemeris_synthetic.csv.gz")
        assert _has(v, "summary.csv pct_sun != windows.json metrics")

    def test_dropped_time_row(self, outdir, tmp_path):
        d = _copy(outdir, tmp_path)
        p = d / "sites" / "eq" / "visibility.csv.gz"
        lines = gzip.open(p, "rt").read().splitlines()
        del lines[100]
        pc._write_bytes(p, ("\n".join(lines) + "\n").encode(), gz=True)
        v = check_output(d)
        assert _has(v, "time axis not uniform") and _has(v, "n_samples")

    def test_null_metrics_reported_not_crashing(self, outdir, tmp_path):
        d = _copy(outdir, tmp_path)
        p = d / "sites" / "eq" / "windows.json"
        w = json.loads(p.read_text())
        w["metrics"] = {k: None for k in w["metrics"]}
        p.write_text(json.dumps(w))
        v = check_output(d)
        assert any(x.startswith("site eq:") for x in v)
        assert not any(x.startswith("site sp:") for x in v)  # other sites still checked and clean

    def test_unreadable_manifest(self, tmp_path):
        assert _has(check_output(tmp_path), "manifest.json unreadable")


# ------------------------------------------------------------------------------------------
class TestCli:
    def test_parse_custom_site(self):
        s = parse_custom_site("SR:-89.45:-137.31:1800")
        assert s.lon_deg == pytest.approx(222.69) and s.height_m == 1800.0 and s.origin == "custom"
        with pytest.raises(Exception):
            parse_custom_site("bad id:0:0")
        with pytest.raises(Exception):
            parse_custom_site("X:95:0")

    def test_precompute_check_analyse_altdates(self, tmp_path, capsys):
        out = tmp_path / "cli"
        common = ["--custom-site", "SP:-89.5:0", "--custom-site", "EQ:0:0", "--provider", "synthetic",
                  "--dem", "none"]
        rc = main(["precompute", *common, "--start", "2026-01-01", "--end", "2026-01-15", "--step-min", "60",
                   "--out", str(out), "--run-timestamp", TS])
        assert rc == 0
        assert "check_output: 0 violation(s)" in capsys.readouterr().out
        assert main(["check", str(out)]) == 0
        man = json.loads((out / "manifest.json").read_text())
        assert man["parameters"]["horizon_method"] == "flat" and man["parameters"]["n_samples"] == 14 * 24

        js = tmp_path / "rank.json"
        assert main(["analyse", *common, "--start", "2026-01-01", "--end", "2026-01-08", "--json", str(js)]) == 0
        ranking = json.loads(js.read_text())["ranking"]
        assert {r["site_id"] for r in ranking} == {"SP", "EQ"}

        js2 = tmp_path / "alt.json"
        rc = main(["alt-dates", "--custom-site", "EQ:0:0", "--provider", "synthetic", "--earliest", "2026-01-01",
                   "--latest", "2026-02-01", "--mission-h", "72", "--min-sun-pct", "100",
                   "--require-earth-at-landing", "--json", str(js2)])
        assert rc == 0
        alt = json.loads(js2.read_text())
        assert alt["candidates"] and all(c["sun_pct"] == 100.0 and c["earth_at_landing"] for c in alt["candidates"])

    def test_check_fails_on_corruption(self, outdir, tmp_path, capsys):
        d = _copy(outdir, tmp_path)
        (d / "sites.json").write_text("{}")
        assert main(["check", str(d)]) == 1
        assert "VIOLATION" in capsys.readouterr().out

    def test_unknown_provider_and_horizon_fn(self):
        with pytest.raises(ValueError):
            pc.get_provider("nope")
        fn = make_horizon_fn("none", "raymarch", observer_height_m=3.0)
        m = fn(Site("x", "x", -89.0, 10.0))
        assert m.method == "flat" and m.observer_height_m == 3.0


# ------------------------------------------------------------------------------------------
class _HillDem:
    """Fake DemSource: smooth sphere + one Gaussian hill (2000 m, sigma 1.5 km) at (lat0, lon0)."""

    name = "fake-hill"
    resolution_m = 100.0

    def __init__(self, lat0: float, lon0: float):
        self.lat0, self.lon0 = lat0, lon0

    def height_at(self, lat_deg, lon_deg):
        from lunarnav.precompute import _unit

        u = _unit(np.asarray(lat_deg, float), np.asarray(lon_deg, float))
        c = _unit(self.lat0, self.lon0)
        d_m = np.arccos(np.clip(u @ c, -1, 1)) * 1737.4e3
        return 2000.0 * np.exp(-0.5 * (d_m / 1500.0) ** 2)

    def patch(self, lat_deg, lon_deg, half_size_m):
        from lunarnav import horizon as hz
        from lunarnav.types import DemPatch

        proj = hz.SOUTH_POLAR
        xs, ys = proj.latlon_to_xy(lat_deg, lon_deg)
        g = np.arange(-half_size_m, half_size_m + 1, self.resolution_m)
        x, y = float(xs) + g, float(ys) + g
        X, Y = np.meshgrid(x, y)
        la, lo = proj.xy_to_latlon(X, Y)
        return DemPatch(x, y, self.height_at(la, lo), hz.moon_polar_stereo_wkt(-1), "fake", self.resolution_m)


@pytest.mark.parametrize("method", ["raymarch", "bruteforce"])
def test_terrain_horizon_path(monkeypatch, method):
    pytest.importorskip("lunarnav.horizon")
    # site at 89.5S 0E; hill 20 km due local north (towards the equator along lon 0):
    # 20 km / (1737.4 km * pi/180 per deg) = 0.6596 deg of latitude.
    site = Site("hill", "hill", -89.5, 0.0, height_m=0.0)
    dem = _HillDem(-89.5 + 20.0 / (1737.4 * np.pi / 180), 0.0)
    monkeypatch.setattr(pc, "get_dem", lambda name, s, label=None, path=None: dem)
    fn = make_horizon_fn("pgda", method, radius_km=40.0, az_step_deg=1.0, observer_height_m=2.0)
    m = fn(site)
    # Exact elevation of the summit seen from a 2 m mast on the sphere, distance theta = 20 km / R:
    # atan2((R+h) cos(theta) - (R+2), (R+h) sin(theta)) = 5.372 deg. Grid / bin quantisation and
    # the slightly higher shoulder of the Gaussian below the summit line keep the error < 0.15 deg.
    R, h, th = 1737.4e3, 2000.0, 20e3 / 1737.4e3
    expect = np.degrees(np.arctan2((R + h) * np.cos(th) - (R + 2.0), (R + h) * np.sin(th)))
    assert expect == pytest.approx(5.372, abs=1e-3)
    assert m.at(0.0) == pytest.approx(expect, abs=0.15)
    # far from the hill the horizon is the smooth-sphere dip (-0.087 deg) within the ray resolution
    assert m.at(180.0) == pytest.approx(-0.087, abs=0.05)
    assert m.observer_height_m == 2.0
    assert any(d["name"].startswith("DEM pgda") for d in m.meta["data_sources"])
    assert np.all(pc.covered_radius_km(m) >= 0)


# ------------------------------------------------------------------------------------------
# Real geometry (method C analytic, offline; method A Horizons, network)
# ------------------------------------------------------------------------------------------
REAL_SITES = [
    Site("sp", "South pole", -89.9, 0.0),
    Site("shack", "Shackleton rim", -89.45, 222.69),
    Site("n86", "North polar", 86.0, 250.0),
    Site("a11", "Apollo 11", 0.674, 23.473),
    Site("far", "Far side", 10.0, 170.0),
]


@pytest.fixture(scope="module")
def analytic_run(tmp_path_factory):
    mod = pytest.importorskip("lunarnav.ephem.analytic")
    out = tmp_path_factory.mktemp("analytic") / "run"
    run_precompute(REAL_SITES, "2026-01-01", "2026-04-01", 60, mod.AnalyticProvider(), make_horizon_fn(), out, TS,
                   horizon_method="flat")
    return out


def test_analytic_real_geometry_passes_all_invariants(analytic_run):
    assert check_output(analytic_run) == []


def test_analytic_real_geometry_expectations(analytic_run):
    sh = read_table(analytic_run / "sites" / "shack" / "visibility.csv.gz")
    # Earth seen from near the south pole sits at az ~ 360 - lon = 137.31 deg (+- longitude
    # libration 8 deg + off-pole geometry) and within ~ colatitude + 7 deg of the horizon
    dev = np.abs((sh["earth_az_deg"] - 137.31 + 180) % 360 - 180)
    assert dev.max() < 10.0
    assert np.abs(sh["earth_el_deg"]).max() < 0.55 + 7.3
    assert np.abs(sh["sun_el_deg"]).max() < 0.55 + 1.65
    a11 = read_table(analytic_run / "sites" / "a11" / "visibility.csv.gz")
    assert a11["earth_visible"].all()  # near side: Earth always up (el 58..74 deg)
    far = read_table(analytic_run / "sites" / "far" / "visibility.csv.gz")
    assert not far["earth_visible"].any()
    # equatorial sites: Sun up ~ half the time (upper-limb rule adds ~1.4 h per lunar day ~ +0.2 %)
    assert 100 * a11["sun_visible"].mean() == pytest.approx(50.2, abs=1.5)


def _sep_deg(az1, el1, az2, el2) -> np.ndarray:
    """Angle (deg) between two topocentric directions given by az/el (deg)."""
    from lunarnav.precompute import _unit

    return np.degrees(np.arccos(np.clip(np.sum(_unit(el1, az1) * _unit(el2, az2), axis=-1), -1, 1)))


@pytest.mark.network
def test_horizons_vs_analytic_visibility_agree(tmp_path):
    """Method A (JPL Horizons) vs method C (analytic): same visibility to within one step per event.

    The analytic model is good to ~0.01 deg; the Sun crosses the polar horizon at <= 0.02 deg/h, so
    flags can differ at the samples next to a rise/set: allow <= 2 differing samples per transition.
    """
    hz = pytest.importorskip("lunarnav.ephem.horizons")
    an = pytest.importorskip("lunarnav.ephem.analytic")
    sites = [REAL_SITES[1], REAL_SITES[3]]
    a = run_precompute(sites, "2026-03-01", "2026-03-15", 60, hz.HorizonsProvider(), make_horizon_fn(),
                       tmp_path / "A", TS, horizon_method="flat")
    c = run_precompute(sites, "2026-03-01", "2026-03-15", 60, an.AnalyticProvider(), make_horizon_fn(),
                       tmp_path / "C", TS, horizon_method="flat")
    assert check_output(a) == [] and check_output(c) == []
    for s in sites:
        va = read_table(a / "sites" / s.id / "visibility.csv.gz")
        vc = read_table(c / "sites" / s.id / "visibility.csv.gz")
        # directions agree to 0.05 deg (analytic accuracy ~0.01 deg + Horizons output rounding);
        # compare the angular separation, since azimuth is ill-conditioned near the zenith
        for b in ("sun", "earth"):
            sep = _sep_deg(va[f"{b}_az_deg"], va[f"{b}_el_deg"], vc[f"{b}_az_deg"], vc[f"{b}_el_deg"])
            assert sep.max() < 0.05, (s.id, b, sep.max())
        for col in ("sun_visible", "earth_visible"):
            n_tr = int(np.sum(va[col][1:] != va[col][:-1]))
            assert int(np.sum(va[col] != vc[col])) <= 2 * max(n_tr, 1)


def test_trek_product_selection(monkeypatch):
    """Default Moon Trek DEM by latitude; the files are never downloaded by get_dem."""
    trek = pytest.importorskip("lunarnav.terrain.trek")

    class FakeTrek:
        def __init__(self, label=None, path=None):
            self.label, self.path, self.name = label, path, f"trek:{label}"
            self.patch_resolution_m = 5.0 if label and "5mp" in label else 30.0

    monkeypatch.setattr(trek, "TrekDem", FakeTrek)
    d = pc.get_dem("trek", Site("a", "a", -89.5, 0.0))
    assert [lv[0].label for lv in d.levels] == ["LRO_LOLA_DEM_SPole875_5mp_v04_EQ", "LRO_LOLA_DEM_SPole75_30mp_v04_EQ"]
    assert pc._dem_resolution_m(d) == 5.0  # finest level drives the ray step
    assert pc.get_dem("trek", Site("b", "b", -80.0, 0.0)).label == "LRO_LOLA_DEM_SPole75_30mp_v04_EQ"
    assert pc.get_dem("trek", Site("c", "c", -50.0, 0.0)).label == "LRO_LOLA_DEM_SPole45_100mp_v04_EQ"
    assert pc.get_dem("trek", Site("d", "d", -89.0, 0.0), path="x.tif").path == "x.tif"
    with pytest.raises(ValueError):
        pc.get_dem("trek", Site("e", "e", 10.0, 0.0))
    assert pc.get_dem("none", Site("f", "f", 0.0, 0.0)) is None


# ------------------------------------------------------------------------------------------
# Integration review fixes (each test fails on the code before the fix)
# ------------------------------------------------------------------------------------------
def _rehash(d: Path) -> None:
    """Rewrite the manifest checksums so that a corruption test isolates the invariant itself."""
    p = d / "manifest.json"
    man = json.loads(p.read_text())
    man["files"] = {f: pc.sha256_file(d / f) for f in man["files"]}
    p.write_text(json.dumps(man))


def _rewrite_eph(d: Path, site: str, fn) -> None:
    p = d / "sites" / site / "ephemeris_synthetic.csv.gz"
    cols = read_table(p)
    fn(cols)
    pc._write_bytes(p, pc._table_bytes(cols, pc.EPHEMERIS_COLUMNS), gz=True)


class TestUntestedInvariants:
    """N7, N8, N10, N11, N12 of the review: each corruption alone (checksums rewritten) is caught."""

    def _check(self, d: Path) -> list[str]:
        _rehash(d)
        v = check_output(d)
        assert not _has(v, "checksum mismatch")
        return v

    def test_hours_until_shifted(self, outdir, tmp_path):
        d = _copy(outdir, tmp_path)

        def bad(c):
            i = int(np.flatnonzero(~c["sun_visible"] & np.isfinite(c["hours_until_sunrise"]))[0])
            c["hours_until_sunrise"][i] += 1.0  # 1 h >> the 1e-3 h rounding tolerance

        _rewrite_vis(d, "eq", bad)
        assert _has(self._check(d), "site eq: hours_until_sunrise inconsistent with the visibility flags")

    def test_sun_distance_out_of_range(self, outdir, tmp_path):
        d = _copy(outdir, tmp_path)
        _rewrite_vis(d, "mid", lambda c: c["sun_dist_km"].__setitem__(7, 1e6))
        assert _has(self._check(d), "site mid: sun_dist_km outside")

    def test_ephemeris_file_azimuth_differs(self, outdir, tmp_path):
        d = _copy(outdir, tmp_path)
        _rewrite_eph(d, "eq", lambda c: c["sun_az_deg"].__setitem__(5, (c["sun_az_deg"][5] + 0.01) % 360))
        v = self._check(d)
        assert _has(v, "site eq: sun_az_deg differs between ephemeris and visibility files")
        assert len(v) == 1  # only the ephemeris file changed: nothing else may fire

    def test_horizon_el_earth_differs_from_horizon_file(self, outdir, tmp_path):
        d = _copy(outdir, tmp_path)

        def bad(c):
            c["horizon_el_earth_deg"][3] += 0.01
            c["earth_clearance_deg"][3] -= 0.01  # keep the clearance rule satisfied: only N11 fires

        _rewrite_vis(d, "sp", bad)
        v = self._check(d)
        assert _has(v, "site sp: horizon_el_earth_deg does not match the horizon file at earth_az")

    def test_power_horizontal_scaled(self, outdir, tmp_path):
        d = _copy(outdir, tmp_path)
        _rewrite_vis(d, "eq", lambda c: c.__setitem__("power_horizontal", c["power_horizontal"] * 1.01))
        assert _has(self._check(d), "site eq: power_horizontal != fraction * max(0, sin(el))")


class TestCheckerIndependentOfWriter:
    """check_output must not reuse windows.py: a bug in the writer's helpers must be caught."""

    def _run_small(self, out: Path) -> Path:
        return run_precompute([SITES[0], SITES[2]], START, "2026-01-20", 60, SyntheticProvider(), fake_horizon,
                              out, TS, dem_name="none")

    def test_buggy_hours_until_state_is_caught(self, monkeypatch, tmp_path):
        real = pc.hours_until_state

        def buggy(t, flags, target, step_s=None):
            h = real(t, flags, target, step_s)
            return np.where(h > 0, h + 5.0, h)  # the review's mutation

        monkeypatch.setattr(pc, "hours_until_state", buggy)
        v = check_output(self._run_small(tmp_path / "o"))
        assert _has(v, "site eq: hours_until_sunset inconsistent") and _has(v, "site sp: hours_until_sunset inconsistent")

    def test_buggy_compute_metrics_is_caught(self, monkeypatch, tmp_path):
        import lunarnav.analysis as an

        real = an.compute_metrics

        def buggy(*a, **k):
            m = real(*a, **k)
            m["longest_dark_h"] += 1.0
            m["pct_sun"] += 0.5
            m["n_comms_gaps"] += 1
            m["mean_power_tracking"] += 0.01
            return m

        monkeypatch.setattr(an, "compute_metrics", buggy)
        v = check_output(self._run_small(tmp_path / "o"))
        for k in ("longest_dark_h", "pct_sun", "n_comms_gaps", "mean_power_tracking"):
            assert _has(v, f"metric {k}"), k

    def test_reference_helpers_on_hand_built_series(self):
        f = np.array([0, 0, 1, 1, 1, 0, 1], bool)
        ti = np.arange(7) * 3600
        h = pc._ref_hours_until(ti, f, True)
        assert np.array_equal(h, [2.0, 1.0, 0, 0, 0, 1.0, 0])
        h = pc._ref_hours_until(ti, f, False)
        assert np.array_equal(h[:6], [0, 0, 3.0, 2.0, 1.0, 0]) and np.isnan(h[6])
        assert pc._ref_runs(f) == [(False, 2), (True, 3), (False, 1), (True, 1)]


class _AzEdgeProvider(SyntheticProvider):
    """Synthetic geometry with azimuths at the 360/0 wrap that round to 360.000000 in %.6f."""

    def compute(self, site, times_utc, h):
        e = super().compute(site, times_utc, h)
        e.sun_az_deg[0] = 359.99999975
        e.earth_az_deg[1] = np.mod(-1e-13, 360.0)  # == 360.0 - 1.1e-13
        return e


def test_azimuth_written_in_0_360(tmp_path):
    got = pc._fmt_column("sun_az_deg", np.array([359.9999997, np.mod(-1e-13, 360.0), 359.9999994, -0.0]))
    assert got == ["0.000000", "0.000000", "359.999999", "0.000000"]
    out = run_precompute([SITES[2]], START, "2026-01-03", 60, _AzEdgeProvider(), "flat", tmp_path / "o", TS)
    assert check_output(out) == []
    vis = read_table(out / "sites" / "eq" / "visibility.csv.gz")
    assert vis["sun_az_deg"][0] == 0.0 and vis["earth_az_deg"][1] == 0.0


class TestResume:
    def test_changed_site_coordinates_are_recomputed(self, tmp_path):
        out = tmp_path / "o"
        a = Site("X", "X", -89.45, 222.69)
        run_precompute([a], START, "2026-01-03", 60, SyntheticProvider(), "flat", out, TS)
        msgs: list[str] = []
        b = Site("X", "X", 0.674, 23.473)  # same id, other place (the review's reproduction)
        run_precompute([b], START, "2026-01-03", 60, SyntheticProvider(), "flat", out, TS, resume=True,
                       progress=msgs.append)
        assert not any("reused" in m for m in msgs)
        rec = json.loads((out / "sites.json").read_text())["sites"][0]
        assert (rec["lat_deg"], rec["lon_deg"]) == (0.674, 23.473)
        vis = read_table(out / "sites" / "X" / "visibility.csv.gz")
        assert vis["earth_visible"].all()  # Apollo 11 data now, not the polar site
        assert check_output(out) == []

    def test_provider_config_and_code_version_in_fingerprint(self, tmp_path, monkeypatch):
        out = tmp_path / "o"
        kw = dict(sites=[SITES[2]], start=START, end="2026-01-03", step_minutes=60, horizon_fn="flat",
                  out_dir=out, run_timestamp_utc=TS)
        run_precompute(provider=SyntheticProvider(), **kw)
        man = json.loads((out / "manifest.json").read_text())
        assert man["parameters"]["provider_config"]["sun_lon0_deg"] == 0.0
        fp0 = man["params_fingerprint"]
        msgs: list[str] = []
        run_precompute(provider=SyntheticProvider(sun_lon0_deg=30.0), resume=True, progress=msgs.append, **kw)
        assert not any("reused" in m for m in msgs)
        fp1 = json.loads((out / "manifest.json").read_text())["params_fingerprint"]
        assert fp1 != fp0
        monkeypatch.setattr(pc, "__version__", "999.0")  # a new code version must not reuse old files
        msgs.clear()
        run_precompute(provider=SyntheticProvider(sun_lon0_deg=30.0), resume=True, progress=msgs.append, **kw)
        assert not any("reused" in m for m in msgs)
        msgs.clear()
        run_precompute(provider=SyntheticProvider(sun_lon0_deg=30.0), resume=True, progress=msgs.append, **kw)
        assert any("reused" in m for m in msgs)  # identical everything -> reused


class TestSiteIds:
    def test_sites_custom_site_ids_work(self, tmp_path):
        from lunarnav import sites

        s = sites.custom_site(-89.45, 222.69)
        assert s.id == "custom:-89.4500:222.6900"
        out = run_precompute([s], START, "2026-01-03", 60, SyntheticProvider(), "flat", tmp_path / "o", TS)
        assert (out / "sites" / "custom_-89.4500_222.6900" / "windows.json").is_file()
        assert json.loads((out / "sites.json").read_text())["sites"][0]["id"] == s.id
        assert check_output(out) == []

    def test_cli_accepts_custom_ids(self, tmp_path, capsys):
        rc = main(["precompute", "--sites", "custom:-89.4500:222.6900", "--provider", "synthetic",
                   "--start", "2026-01-01", "--end", "2026-01-02", "--out", str(tmp_path / "o"),
                   "--run-timestamp", TS])
        assert rc == 0 and "check_output: 0 violation(s)" in capsys.readouterr().out

    @pytest.mark.parametrize("ids", [("X", "x"), ("custom:1.0000:2.0000", "custom_1.0000_2.0000")])
    def test_ids_sharing_a_directory_are_rejected(self, tmp_path, ids):
        s = [Site(ids[0], "a", -89.45, 222.69), Site(ids[1], "b", 0.674, 23.473)]
        with pytest.raises(ValueError, match="same directory"):
            run_precompute(s, START, "2026-01-03", 60, SyntheticProvider(), "flat", tmp_path / "o", TS)


class TestCliFixes:
    def test_tiny_negative_longitude_normalised_to_zero(self, tmp_path, capsys):
        assert parse_custom_site("X:-89.5:-1e-14").lon_deg == 0.0
        assert parse_custom_site("X:-89.5:360").lon_deg == 0.0
        for bad in ("X:-89.5:nan", "X:-89.5:inf", "X:nan:0", "X:-90.5:0"):
            with pytest.raises(Exception):
                parse_custom_site(bad)
        rc = main(["precompute", "--custom-site", "X:-89.5:-1e-14", "--provider", "synthetic", "--start",
                   "2026-01-01", "--end", "2026-01-03", "--out", str(tmp_path / "o"), "--run-timestamp", TS])
        assert rc == 0 and "check_output: 0 violation(s)" in capsys.readouterr().out

    def test_validate_options_passed_through(self, monkeypatch):
        import lunarnav.validate as val

        got = {}

        def fake_main(argv):
            got["argv"] = list(argv)
            return 0

        monkeypatch.setattr(val, "main", fake_main)
        assert main(["validate", "--no-terrain", "--offline"]) == 0
        assert got["argv"] == ["--no-terrain", "--offline"]


class TestDemCoverage:
    """--dem pgda / trek for sites the DEM cannot serve: found up front, explicit fallback."""

    POLE = Site("pole", "p", -89.45, 222.69, height_m=1000.0)
    IM1 = Site("im1", "im1", -80.13, 1.44, height_m=0.0)
    CH3 = Site("ch3", "ch3", -69.3734, 32.3198, height_m=0.0)
    A11 = Site("a11", "a11", 0.67416, 23.47314, height_m=0.0)
    CE4 = Site("ce4", "ce4", -45.457, 177.589, height_m=0.0)

    def test_pgda_band_choice_by_position(self):
        near = {s.id: pc.pgda_bands_for_site(s).layout[0][0] for s in (self.POLE, self.IM1, self.CH3)}
        # 80S 20 m product: polar cap |lat| >= 80 (304 km grid radius); IM-1 at 80.13S lies 300 km
        # from the pole, so its 15 km near band leaves the cap -> 75S 30 m; Chandrayaan-3 -> 60S 60 m
        assert near == {"pole": "LDEM_80S_20MPP_ADJ", "im1": "LDEM_75S_30MPP_ADJ", "ch3": "LDEM_60S_60MPP_ADJ"}
        b = pc.pgda_bands_for_site(self.POLE)
        assert [(x.product, x.outer_radius_m) for x in b.bands(150e3)] == [
            ("LDEM_80S_20MPP_ADJ", 15e3), ("LDEM_60S_120MPP_ADJ", 60e3), ("LDEM_60S_240MPP_ADJ", 150e3)]
        assert [(x.product, x.outer_radius_m) for x in b.bands(40e3)] == [
            ("LDEM_80S_20MPP_ADJ", 15e3), ("LDEM_60S_120MPP_ADJ", 40e3)]
        assert [x.outer_radius_m for x in b.bands(10e3)] == [10e3]
        for s in (self.A11, self.CE4):
            with pytest.raises(pc.DemCoverageError):
                pc.pgda_bands_for_site(s)

    def test_coverage_problems_listed_for_all_sites(self):
        probs = pc.dem_coverage_problems([self.POLE, self.CH3, self.A11, self.CE4], "pgda", 150.0)
        assert set(probs) == {"a11", "ce4"}
        assert pc.dem_coverage_problems([self.A11], "none") == {}

    def test_fallback_flat_is_explicit(self):
        m = make_horizon_fn("pgda", "raymarch", dem_fallback="flat")(self.A11)
        assert m.method == "flat" and m.dem_source == "none:outside-pgda-coverage"
        assert "south polar" in m.meta["dem_fallback"]
        with pytest.raises(pc.DemCoverageError, match="--dem-fallback flat"):
            make_horizon_fn("pgda", "bruteforce")(self.A11)

    def test_cli_preflight_and_fallback(self, tmp_path, capsys):
        args = ["precompute", "--custom-site", "EQ:0.674:23.473:0", "--custom-site", "FAR:-45.457:177.589:0",
                "--provider", "synthetic", "--dem", "pgda", "--start", "2026-01-01", "--end", "2026-01-03",
                "--run-timestamp", TS]
        with pytest.raises(SystemExit) as e:
            main(args + ["--out", str(tmp_path / "a")])
        assert "cannot serve 2 site(s)" in str(e.value) and "EQ:" in str(e.value) and "FAR:" in str(e.value)
        assert not (tmp_path / "a" / "manifest.json").exists()  # nothing computed before the error
        assert main(args + ["--out", str(tmp_path / "b"), "--dem-fallback", "flat"]) == 0
        assert "check_output: 0 violation(s)" in capsys.readouterr().out
        recs = json.loads((tmp_path / "b" / "sites.json").read_text())["sites"]
        assert {r["dem_source"] for r in recs} == {"none:outside-pgda-coverage"}
        man = json.loads((tmp_path / "b" / "manifest.json").read_text())
        assert man["parameters"]["dem_fallback"] == "flat" and man["parameters"]["horizon_method"] == "raymarch"


@pytest.mark.network
def test_pgda_default_terrain_serves_review_sites():  # ~5 min on a cold PGDA block cache, ~15 s warm
    """The review's failing cases: chandrayaan3 height (was NaN on the 80S product) and a 150 km
    bruteforce horizon at a3_peak_near_cabeus_b (was a 15002 x 15002 px patch > max_pixels)."""
    from lunarnav.sites import get_site

    ch3 = get_site("chandrayaan3_vikram")
    h = float(np.asarray(pc.get_dem("pgda", ch3).height_at(ch3.lat_deg, ch3.lon_deg)).reshape(-1)[0])
    assert np.isfinite(h) and -9000.0 < h < 11000.0  # lunar relief range
    s = get_site("a3_peak_near_cabeus_b")
    bf = make_horizon_fn("pgda", "bruteforce", radius_km=150.0)(s)
    ray = make_horizon_fn("pgda", "raymarch", radius_km=150.0)(s)
    assert bf.method == "bruteforce" and ray.method == "raymarch" and bf.radius_km == 150.0
    assert bf.surface_height_m == pytest.approx(ray.surface_height_m)
    assert bf.dem_source.startswith("pgda:bands[LDEM_80S_20MPP_ADJ<15km")
    assert np.all(np.isfinite(bf.el_deg)) and np.all(np.abs(bf.el_deg) < 30.0)
    # Full masks differ near the observer by the DEM model (bilinear surface vs flat-topped cells:
    # 1 m over the 20 m neighbour cell = 2.9 deg; documented p95 up to 0.92 deg in
    # docs/VALIDATION_TERRAIN.md), so the algorithms are compared on terrain beyond 2 km, where the
    # documented agreement is p95 0.015-0.070 deg: assert p95 < 0.1 deg, max < 0.3 deg.
    from lunarnav.validate_terrain import banded_mask

    bands = pc.get_dem("pgda", s).bands(150e3)
    bf2 = banded_mask(s, bands, "bruteforce", 2.0, near_exclusion_m=2000.0)
    ray2 = banded_mask(s, bands, "raymarch", 2.0, near_exclusion_m=2000.0)
    d = bf2.el_deg - ray2.el_deg
    print(f"\nbf - ray beyond 2 km: p95 {np.percentile(np.abs(d), 95):.4f} max {np.abs(d).max():.4f} "
          f"mean {d.mean():.4f}")
    assert np.percentile(np.abs(d), 95) < 0.1 and np.abs(d).max() < 0.3
    assert d.mean() > -0.01  # block model >= bilinear surface: bruteforce not systematically lower
    # close the remote GDAL datasets now (validate_terrain.pgda_dem caches them for the process);
    # left open, their destructors run at interpreter shutdown and print excepthook noise
    from lunarnav.validate_terrain import pgda_dem

    for b in bands:
        pgda_dem(b.product).close()
    pgda_dem(pc.pgda_bands_for_site(ch3).layout[0][0]).close()
    pgda_dem.cache_clear()


def test_missing_trek_file_is_fatal_even_with_fallback(tmp_path, monkeypatch):
    """A Moon Trek product that is not downloaded (empty data dir) must stop the run up front; the
    flat fallback is only for sites OUTSIDE the DEM coverage, never for a setup error."""
    monkeypatch.setenv("LUNARNAV_DATA", str(tmp_path / "data"))
    s = Site("ch3", "ch3", -69.3734, 32.3198)
    probs = pc.dem_coverage_problems([s], "trek")
    assert isinstance(probs["ch3"], pc.DemFileMissingError) and "SPole45_100mp" in str(probs["ch3"])
    with pytest.raises(pc.DemFileMissingError):
        make_horizon_fn("trek", "raymarch", dem_fallback="flat")(s)
    with pytest.raises(SystemExit, match="cannot serve 1 site"):
        main(["precompute", "--custom-site", "ch3:-69.3734:32.3198", "--provider", "synthetic", "--dem", "trek",
              "--dem-fallback", "flat", "--start", "2026-01-01", "--end", "2026-01-02", "--out", str(tmp_path / "o")])
