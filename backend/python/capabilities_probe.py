"""Capabilities probe for the web backend (GET /api/v1/capabilities). Only IMPORTS lunarnav; never modifies it.

stdout (ASCII JSON, one line, exit 0 even when lunarnav is broken - the errors are in the JSON):
  {"python_version": "3.13.1", "lunarnav_version": "0.1.0" | null,
   "subcommands": ["alt-dates", "analyse", ...], "flags": {"precompute": ["--az-step", ...], ...},
   "modules": {"spiceypy": true, "lunarnav.validate": true, ...}, "errors": ["..."]}

`flags` are the long options found in the argparse HELP OUTPUT of each sub-command
(`lunarnav <cmd> --help`, rendered in-process with format_help(): no extra processes, no side effects).
"""
from __future__ import annotations

import argparse
import importlib
import importlib.util
import json
import platform
import re
import sys

MODULES = (
    "numpy", "scipy", "requests", "spiceypy", "rasterio", "pyproj",
    "lunarnav.analysis", "lunarnav.precompute", "lunarnav.horizon", "lunarnav.windows", "lunarnav.sites",
    "lunarnav.validate", "lunarnav.validate_terrain", "lunarnav.ephem.spice", "lunarnav.ephem.horizons",
    "lunarnav.ephem.analytic", "lunarnav.terrain.pgda", "lunarnav.terrain.trek",
)
HELP_OF = ("precompute", "analyse", "alt-dates", "check")
_FLAG_RE = re.compile(r"(?<![\w-])--[a-z][a-z0-9-]*")


def _has_module(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def main() -> int:
    out: dict = {"python_version": platform.python_version(), "lunarnav_version": None, "subcommands": [],
                 "flags": {}, "modules": {}, "errors": []}
    try:
        import lunarnav
        out["lunarnav_version"] = getattr(lunarnav, "__version__", None)
    except Exception as exc:  # noqa: BLE001 - report, never crash
        out["errors"].append(f"import lunarnav: {type(exc).__name__}: {exc}")
    for m in MODULES:
        out["modules"][m] = _has_module(m)
    try:
        cli = importlib.import_module("lunarnav.cli")
        build = getattr(cli, "build_parser", None)
        if build is None:
            raise AttributeError("lunarnav.cli has no build_parser()")
        ap = build()
        subs = [a for a in ap._actions if isinstance(a, argparse._SubParsersAction)]  # noqa: SLF001
        choices = subs[0].choices if subs else {}
        out["subcommands"] = sorted(choices)
        for name in HELP_OF:
            p = choices.get(name)
            if p is not None:
                out["flags"][name] = sorted(set(_FLAG_RE.findall(p.format_help())) - {"--help"})
    except Exception as exc:  # noqa: BLE001
        out["errors"].append(f"lunarnav.cli: {type(exc).__name__}: {exc}")
    sys.stdout.write(json.dumps(out, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
