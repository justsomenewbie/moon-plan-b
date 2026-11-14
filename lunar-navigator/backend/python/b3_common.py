"""Shared helpers of the B3 report bridges (check_json.py, validate_json.py, validate_terrain_json.py,
compare_runs.py). Only the standard library (+ numpy scalars when present); never imports lunarnav.

* read_request(): the UTF-8 JSON request on stdin (built by the server, never by a client).
* jsonable(): strict-JSON copy (NaN -> null, +-inf -> "inf"/"-inf", numpy scalars / arrays -> Python),
  so Node's JSON.parse always accepts what we write (lunarnav.validate_terrain writes NaN).
* scrub(): replaces server paths (both slash styles) by placeholders in every string of a structure, so
  reports never leak absolute paths of the server.
* collect_checks(): every boolean "pass" / "passed" leaf of a report, with its JSON path.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any, Iterable, Sequence


def read_request() -> dict:
    raw = sys.stdin.buffer.read().decode("utf-8")
    req = json.loads(raw)
    if not isinstance(req, dict):
        raise ValueError("stdin must be a JSON object")
    return req


def jsonable(o: Any) -> Any:
    if isinstance(o, dict):
        return {str(k): jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [jsonable(v) for v in o]
    tolist = getattr(o, "tolist", None)  # numpy arrays and scalars
    if tolist is not None and not isinstance(o, (str, bytes)):
        return jsonable(tolist())
    if isinstance(o, bool) or o is None or isinstance(o, (int, str)):
        return o
    if isinstance(o, float):
        if math.isnan(o):
            return None
        if math.isinf(o):
            return "inf" if o > 0 else "-inf"
        return o
    return str(o)


def _variants(path: str) -> list[str]:
    p = str(path)
    out = {p, p.replace("\\", "/"), p.replace("/", "\\")}
    return sorted((x for x in out if len(x) >= 3), key=len, reverse=True)


def scrub(o: Any, pairs: Sequence[Sequence[str]]) -> Any:
    """Replace each [absolute_path, label] (longest first, both slash styles) in every string."""
    reps: list[tuple[str, str]] = []
    for pair in pairs:
        if len(pair) != 2:
            continue
        for v in _variants(pair[0]):
            reps.append((v, str(pair[1])))
    reps.sort(key=lambda r: len(r[0]), reverse=True)

    def fix(s: str) -> str:
        for a, b in reps:
            if a in s:
                s = s.replace(a, b)
        return s

    def walk(x: Any) -> Any:
        if isinstance(x, str):
            return fix(x)
        if isinstance(x, dict):
            return {fix(str(k)): walk(v) for k, v in x.items()}
        if isinstance(x, list):
            return [walk(v) for v in x]
        return x

    return walk(o)


def collect_checks(o: Any, prefix: str = "") -> list[tuple[str, bool]]:
    out: list[tuple[str, bool]] = []
    if isinstance(o, dict):
        for k, v in o.items():
            p = f"{prefix}.{k}" if prefix else str(k)
            if k in ("pass", "passed") and isinstance(v, bool):
                out.append((prefix or str(k), v))
            else:
                out.extend(collect_checks(v, p))
    elif isinstance(o, list):
        for i, v in enumerate(o):
            out.extend(collect_checks(v, f"{prefix}[{i}]"))
    return out


def write_json(path: str | Path, obj: Any, indent: int | None = 1) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj, indent=indent, sort_keys=True, allow_nan=False) + "\n", encoding="utf-8")


def write_text(path: str | Path, text: str) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def first(items: Iterable[Any], n: int) -> list[Any]:
    out = []
    for i, x in enumerate(items):
        if i >= n:
            break
        out.append(x)
    return out
