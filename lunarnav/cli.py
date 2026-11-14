"""Command line entry point: ``lunarnav <command> ...`` (also ``python -m lunarnav.cli``).

Commands
  precompute  compute and write a precompute directory (docs/OUTPUT_SPEC.md)
  analyse     analyse and rank sites over a period, print a table (or --json FILE)
  alt-dates   rank alternative landing times for one site under mission constraints
  check       verify a precompute directory (exit code 1 if any invariant is violated)
  validate    cross-method validation (delegates to lunarnav.validate.main)

Sites: ``--sites`` takes catalog ids separated by commas, ``all``, ``group:<name>`` (catalog
from lunarnav.sites.load_catalog) or canonical custom ids ``custom:<lat>:<lon>`` (as made by
lunarnav.sites.custom_site, e.g. ``custom:-89.4500:222.6900``), and/or ``--custom-site ID:LAT:LON[:HEIGHT_M]`` (repeatable;
planetocentric latitude, EAST longitude, height above the 1737.4 km sphere).

Examples
  lunarnav precompute --sites group:south_pole --start 2026-01-01 --end 2031-01-01 --step-min 60 \
      --provider horizons --dem trek --horizon-method raymarch --out output/sp_2026_2030
  lunarnav alt-dates --custom-site SR:-89.45:222.69 --earliest 2027-03-01 --latest 2027-06-01 \
      --mission-h 336 --min-sun-pct 70 --require-earth-at-landing --provider spice
"""
from __future__ import annotations

import argparse
import datetime as _dt
import importlib
import json
import math
import re
import sys
from pathlib import Path
from typing import Sequence

from .config import (
    DEFAULT_AZ_STEP_DEG,
    DEFAULT_END_UTC,
    DEFAULT_HORIZON_RADIUS_KM,
    DEFAULT_OBSERVER_HEIGHT_M,
    DEFAULT_START_UTC,
    DEFAULT_STEP_MINUTES,
)
from .types import Site

_ID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")


def parse_custom_site(spec: str) -> Site:
    """Parse ``ID:LAT:LON[:HEIGHT_M]`` into a Site (longitude normalised to [0, 360)).

    LAT: planetocentric latitude in [-90, 90] deg; LON: east longitude (deg, any finite value,
    west-negative accepted), normalised with ``lunarnav.sites.normalize_lon`` so that e.g. -1e-14
    maps to 0.0 and never to 360.0 (types.py: east longitude in [0, 360)); HEIGHT_M: metres above
    the 1737.4 km sphere.
    """
    from .sites import normalize_lon

    parts = spec.split(":")
    if len(parts) not in (3, 4):
        raise argparse.ArgumentTypeError(f"custom site {spec!r}: expected ID:LAT:LON[:HEIGHT_M]")
    sid = parts[0]
    if not _ID_RE.match(sid):
        raise argparse.ArgumentTypeError(f"custom site id {sid!r} must match {_ID_RE.pattern}")
    try:
        lat, lon = float(parts[1]), float(parts[2])
        h = float(parts[3]) if len(parts) == 4 else None
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"custom site {spec!r}: {exc}") from exc
    if not -90.0 <= lat <= 90.0:
        raise argparse.ArgumentTypeError(f"custom site {spec!r}: latitude outside [-90, 90]")
    if h is not None and not math.isfinite(h):
        raise argparse.ArgumentTypeError(f"custom site {spec!r}: height must be finite")
    try:
        lon_n = normalize_lon(lon)
    except (TypeError, ValueError) as exc:
        raise argparse.ArgumentTypeError(f"custom site {spec!r}: {exc}") from exc
    return Site(id=sid, name=sid, lat_deg=lat, lon_deg=lon_n, origin="custom", height_m=h)


def resolve_sites(spec: str | None, custom: Sequence[Site] = ()) -> list[Site]:
    """Catalog selection (ids, 'all', 'group:<g>', comma-separated) plus custom sites."""
    out: list[Site] = []
    if spec:
        try:
            sites_mod = importlib.import_module("lunarnav.sites")
        except ImportError as exc:
            raise SystemExit(f"--sites needs lunarnav.sites (catalog): {exc}") from exc
        catalog = list(sites_mod.load_catalog())
        by_id = {s.id: s for s in catalog}
        for tok in [x.strip() for x in spec.split(",") if x.strip()]:
            if tok == "all":
                out.extend(catalog)
            elif tok.startswith("group:"):
                g = tok.split(":", 1)[1]
                sel = [s for s in catalog if s.group == g]
                if not sel:
                    raise SystemExit(f"no catalog site in group {g!r}")
                out.extend(sel)
            elif tok in by_id:
                out.append(by_id[tok])
            elif tok.startswith("custom:"):  # canonical sites.custom_site id, e.g. custom:-89.4500:222.6900
                try:
                    out.append(sites_mod.get_site(tok))
                except ValueError as exc:
                    raise SystemExit(str(exc)) from exc
            else:
                raise SystemExit(f"unknown site id {tok!r}; known: {sorted(by_id)}")
    out.extend(custom)
    seen, uniq = set(), []
    for s in out:
        if s.id not in seen:
            seen.add(s.id)
            uniq.append(s)
    if not uniq:
        raise SystemExit("no sites selected: use --sites and/or --custom-site")
    return uniq


def _near_exclusion(v: str):
    """--near-exclusion-m value: 'auto' or a distance >= 0 (m)."""
    if v.strip().lower() == "auto":
        return "auto"
    try:
        d = float(v)
    except ValueError:
        raise argparse.ArgumentTypeError(f"--near-exclusion-m: expected 'auto' or metres, got {v!r}")
    if not (math.isfinite(d) and d >= 0):
        raise argparse.ArgumentTypeError(f"--near-exclusion-m must be >= 0, got {v!r}")
    return d


def _add_common(p: argparse.ArgumentParser, period: bool = True) -> None:
    p.add_argument("--sites", help="catalog ids (comma separated), 'all' or 'group:<name>'")
    p.add_argument("--custom-site", action="append", type=parse_custom_site, default=[],
                   metavar="ID:LAT:LON[:H]", help="custom site (repeatable)")
    if period:
        p.add_argument("--start", default=DEFAULT_START_UTC, help="UTC start (inclusive), ISO 8601")
        p.add_argument("--end", default=DEFAULT_END_UTC, help="UTC end (exclusive), ISO 8601")
    p.add_argument("--step-min", type=float, default=DEFAULT_STEP_MINUTES, help="time step, minutes")
    p.add_argument("--provider", default="horizons", choices=["horizons", "spice", "analytic", "synthetic"],
                   help="ephemeris method A/B/C (synthetic = test toy model)")
    p.add_argument("--dem", default="none", choices=["trek", "pgda", "none"], help="terrain source")
    p.add_argument("--horizon-method", default="raymarch", choices=["raymarch", "bruteforce", "flat"])
    p.add_argument("--radius-km", type=float, default=DEFAULT_HORIZON_RADIUS_KM, help="horizon search radius")
    p.add_argument("--dem-label", help="Trek productLabel / PGDA product (default: chosen by latitude)")
    p.add_argument("--dem-path", help="local DEM GeoTIFF (e.g. downloaded on Colab)")
    p.add_argument("--dem-res-m", type=float, default=None,
                   help="finest DEM pixel size for raymarch (default: auto-detect from the DEM)")
    p.add_argument("--az-step", type=float, default=DEFAULT_AZ_STEP_DEG, help="horizon azimuth step, deg")
    p.add_argument("--observer-height", type=float, default=DEFAULT_OBSERVER_HEIGHT_M,
                   help="mast height above local terrain, m")
    p.add_argument("--min-clearance", type=float, default=0.0,
                   help="Earth must be this many deg above the horizon (0..10)")
    p.add_argument("--dem-fallback", default="error", choices=["error", "flat"],
                   help="sites outside the DEM coverage: 'error' (default, checked for all sites before "
                        "computing) or 'flat' (smooth-sphere horizon, recorded in dem_source)")
    p.add_argument("--near-exclusion-m", type=_near_exclusion, default="auto", metavar="auto|M",
                   help="raymarch: ignore terrain closer than M metres; 'auto' (default) = 250 m when the "
                        "finest DEM is <= 5 m (Moon Trek 5 m knobs), nothing on coarser DEMs; 0 = off")


def _setup(args):
    from .analysis import AnalysisOptions
    from .precompute import DemFileMissingError, dem_coverage_problems, get_provider, make_horizon_fn

    sites = resolve_sites(args.sites, args.custom_site)
    provider = get_provider(args.provider)
    method = "flat" if args.dem == "none" else args.horizon_method
    if args.dem != "none" and method != "flat":
        # Pre-flight: find every site the DEM cannot serve BEFORE hours of computing (a crash at
        # site k would otherwise repeat on every --resume rerun). A missing DEM file is always
        # fatal (setup error); a site outside the DEM coverage may get --dem-fallback flat.
        probs = dem_coverage_problems(sites, args.dem, args.radius_km, args.dem_label, args.dem_path)
        missing_file = any(isinstance(e, DemFileMissingError) for e in probs.values())
        if missing_file or (probs and args.dem_fallback == "error"):
            lines = "\n".join(f"  {sid}: {why}" for sid, why in probs.items())
            raise SystemExit(f"--dem {args.dem} cannot serve {len(probs)} site(s):\n{lines}\n"
                             "download the missing DEM product, pass --dem-path / --dem-label, remove the "
                             "sites, or use --dem-fallback flat (smooth-sphere horizon for those sites)")
        for sid, why in probs.items():
            print(f"note: site {sid}: smooth-sphere horizon (--dem-fallback flat): {why}", flush=True)
    hfn = make_horizon_fn(args.dem, method, args.radius_km, args.az_step, args.observer_height,
                          args.dem_res_m, args.dem_label, args.dem_path, dem_fallback=args.dem_fallback,
                          near_exclusion_m=args.near_exclusion_m)
    opt = AnalysisOptions(min_earth_clearance_deg=args.min_clearance, observer_height_m=args.observer_height)
    return sites, provider, hfn, opt, method


def cmd_precompute(args) -> int:
    from .precompute import check_output, run_precompute

    sites, provider, hfn, opt, method = _setup(args)
    ts = args.run_timestamp or _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    out = run_precompute(
        sites, args.start, args.end, args.step_min, provider, hfn, args.out, ts,
        options=opt, dem_name=args.dem, horizon_method=method,
        extra_parameters={"horizon_radius_km": args.radius_km, "az_step_deg": args.az_step,
                          "dem_res_m": args.dem_res_m, "dem_label": args.dem_label,
                          "dem_path": args.dem_path, "dem_fallback": args.dem_fallback},
        resume=args.resume, progress=lambda m: print(m, flush=True),
    )
    if args.no_check:
        return 0
    viol = check_output(out)
    for x in viol:
        print("VIOLATION:", x)
    print(f"check_output: {len(viol)} violation(s)")
    return 1 if viol else 0


def cmd_analyse(args) -> int:
    from .analysis import analyse

    sites, provider, hfn, opt, _ = _setup(args)
    res = analyse(sites, args.start, args.end, args.step_min, provider, hfn, opt)
    print(f"{'rank':>4} {'site':<24} {'score':>7} {'%sun':>7} {'%earth':>7} {'%both':>7} {'maxdark_h':>9} {'maxgap_h':>9}")
    for r in res.ranking:
        print(f"{r['rank']:>4} {r['site_id']:<24} {r['score']:7.2f} {r['pct_sun']:7.2f} {r['pct_earth']:7.2f} "
              f"{r['pct_both']:7.2f} {r['longest_dark_h']:9.1f} {r['longest_comms_gap_h']:9.1f}")
    if args.json:
        Path(args.json).write_text(json.dumps({"ranking": res.ranking}, indent=1, sort_keys=True))
    return 0


def cmd_alt_dates(args) -> int:
    from .analysis import DateConstraints, find_alternative_dates_for_site

    sites, provider, hfn, opt, _ = _setup(args)
    if len(sites) != 1:
        raise SystemExit("alt-dates needs exactly one site")
    c = DateConstraints(
        min_sun_pct=args.min_sun_pct,
        min_earth_pct=args.min_earth_pct,
        min_both_pct=args.min_both_pct,
        require_sun_at_landing=not args.allow_dark_landing,
        require_earth_at_landing=args.require_earth_at_landing,
        min_continuous_sun_h=args.min_continuous_sun_h,
        min_continuous_earth_h=args.min_continuous_earth_h,
        max_dark_gap_h=args.max_dark_gap_h,
        max_comms_gap_h=args.max_comms_gap_h,
        min_sun_el_at_landing_deg=args.min_sun_el,
        objective=args.objective,
        min_separation_h=args.min_separation_h,
    )
    res = find_alternative_dates_for_site(
        sites[0], args.earliest, args.latest, args.mission_h, provider, hfn, c, args.step_min, opt, args.max_results
    )
    print(f"site {res.site_id}: {res.n_feasible}/{res.n_evaluated} landing times feasible; rejected_by={res.rejected_by}")
    print(f"{'rank':>4} {'landing_utc':<21} {'slip_h':>8} {'score':>7} {'%sun':>6} {'%earth':>6} {'%both':>6} {'sun_h':>7} {'maxdark_h':>9}")
    for x in res.candidates:
        print(f"{x.rank:>4} {str(x.landing_utc) + 'Z':<21} {x.slip_h:8.1f} {x.score:7.2f} {x.sun_pct:6.1f} "
              f"{x.earth_pct:6.1f} {x.both_pct:6.1f} {x.continuous_sun_h:7.1f} {x.longest_dark_h:9.1f}")
    if args.json:
        Path(args.json).write_text(json.dumps(res.to_dict(), indent=1, sort_keys=True))
    return 0 if res.candidates else 2


def cmd_check(args) -> int:
    from .precompute import check_output

    viol = check_output(args.dir)
    for x in viol:
        print("VIOLATION:", x)
    print(f"{args.dir}: {len(viol)} violation(s)")
    return 1 if viol else 0


def cmd_validate(args) -> int:
    try:
        mod = importlib.import_module("lunarnav.validate")
    except ImportError as exc:
        raise SystemExit(f"lunarnav.validate is not available: {exc}") from exc
    if not hasattr(mod, "main"):
        raise SystemExit("lunarnav.validate has no main(argv) function")
    rc = mod.main(list(args.rest))
    return int(rc or 0)


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="lunarnav", description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="command", required=True)

    p = sub.add_parser("precompute", help="compute and write a precompute directory")
    _add_common(p)
    p.add_argument("--out", required=True, help="output directory")
    p.add_argument("--run-timestamp", help="UTC timestamp written to the manifest (default: now)")
    p.add_argument("--resume", action="store_true", help="reuse finished sites with identical parameters")
    p.add_argument("--no-check", action="store_true", help="skip check_output at the end")
    p.set_defaults(func=cmd_precompute)

    p = sub.add_parser("analyse", aliases=["analyze"], help="analyse and rank sites")
    _add_common(p)
    p.add_argument("--json", help="write the ranking to this JSON file")
    p.set_defaults(func=cmd_analyse)

    p = sub.add_parser("alt-dates", help="alternative landing dates for one site")
    _add_common(p, period=False)
    p.add_argument("--earliest", required=True, help="earliest landing (UTC)")
    p.add_argument("--latest", required=True, help="latest landing (UTC)")
    p.add_argument("--mission-h", type=float, required=True, help="mission duration, hours")
    p.add_argument("--min-sun-pct", type=float, default=0.0)
    p.add_argument("--min-earth-pct", type=float, default=0.0)
    p.add_argument("--min-both-pct", type=float, default=0.0)
    p.add_argument("--allow-dark-landing", action="store_true", help="do not require Sun at landing")
    p.add_argument("--require-earth-at-landing", action="store_true")
    p.add_argument("--min-continuous-sun-h", type=float, default=0.0)
    p.add_argument("--min-continuous-earth-h", type=float, default=0.0)
    p.add_argument("--max-dark-gap-h", type=float, default=None)
    p.add_argument("--max-comms-gap-h", type=float, default=None)
    p.add_argument("--min-sun-el", type=float, default=None, help="minimum Sun elevation at landing, deg")
    p.add_argument("--objective", default="balanced",
                   choices=["balanced", "sun", "earth", "both", "energy", "earliest"])
    p.add_argument("--min-separation-h", type=float, default=12.0)
    p.add_argument("--max-results", type=int, default=10)
    p.add_argument("--json", help="write candidates to this JSON file")
    p.set_defaults(func=cmd_alt_dates)

    p = sub.add_parser("check", help="verify a precompute directory against docs/OUTPUT_SPEC.md")
    p.add_argument("dir")
    p.set_defaults(func=cmd_check)

    p = sub.add_parser("validate", help="cross-method validation (lunarnav.validate)")
    p.add_argument("rest", nargs=argparse.REMAINDER, help="arguments passed to lunarnav.validate.main")
    p.set_defaults(func=cmd_validate)
    return ap


def main(argv: Sequence[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "validate":
        # FIX (review): argparse REMAINDER in a sub-parser rejects options such as --no-terrain;
        # hand every argument after 'validate' to lunarnav.validate.main unparsed.
        return cmd_validate(argparse.Namespace(rest=argv[1:]))
    args = build_parser().parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
