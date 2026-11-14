#!/usr/bin/env python
"""Build a code-only zip of the project for Google Colab (no data/, output/, .venv, caches).

Usage (from anywhere)::

    python scripts/make_colab_bundle.py                 # -> dist/lunarnav_colab_bundle.zip
    python scripts/make_colab_bundle.py --out D:/x.zip  # other destination
    python scripts/make_colab_bundle.py --list          # print the files that would be packed

Upload the zip to Colab (or to Google Drive at ``MyDrive/lunarnav/lunarnav_colab_bundle.zip``) and run
``notebooks/lunar_navigator_colab.ipynb``; it unpacks the zip to ``/content/lunar-navigator`` and
``pip install -e``'s it.

What is packed
--------------
* Only the entries in :data:`INCLUDE` (package, tests and their small fixtures, docs, notebooks,
  scripts, pyproject.toml, README.md, .gitignore), all under one top folder ``lunar-navigator/``.
* Never: the top-level data/, output/, dist/, .venv/ and .git/ (not in INCLUDE), any
  :data:`EXCLUDE_DIRS` folder (byte-code and tool caches, notebook checkpoints) and
  :data:`EXCLUDE_SUFFIXES` (byte code, partial downloads, DEM rasters).  The heavy data (Moon Trek
  DEMs of 1-2 GB, SPICE kernels, HTTP caches) is downloaded on Colab into Google Drive instead.
* Any single file larger than ``--max-file-mb`` (default 5 MB) is refused with an error, so a
  stray DEM or cache file can never slip into the bundle silently.

Reproducibility
---------------
The zip is byte-deterministic for identical sources: entries sorted, fixed timestamp
(1980-01-01), fixed permissions, fixed compression level.  ``lunar-navigator/BUNDLE_INFO.json``
records ``code_sha256`` (SHA-256 over every packed relative path and its bytes), the file count and
the git commit of the source tree if there is one.  The notebook prints it, so a Colab run can be
traced back to the exact code.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import zipfile
from dataclasses import dataclass
from pathlib import Path

#: Top-level files and folders of the repository that go into the bundle.
INCLUDE: tuple[str, ...] = (
    "lunarnav",
    "tests",
    "docs",
    "notebooks",
    "scripts",
    "pyproject.toml",
    "README.md",
    ".gitignore",
)
#: Directory names skipped at any depth inside the INCLUDE folders.  (The top-level data/, output/,
#: dist/, .venv/ and .git/ are never visited because only INCLUDE entries are walked; a folder named
#: ``data`` deeper down, such as the small test fixtures in tests/data, IS packed.)
EXCLUDE_DIRS: frozenset[str] = frozenset({
    ".venv", "venv", ".git", "__pycache__", ".pytest_cache", ".ipynb_checkpoints", ".mypy_cache",
    ".ruff_cache", ".idea", ".vscode", "output",
})
#: Directory-name suffixes skipped at any depth.
EXCLUDE_DIR_SUFFIXES: tuple[str, ...] = (".egg-info",)
#: File suffixes (lower case) never packed.
EXCLUDE_SUFFIXES: tuple[str, ...] = (
    ".pyc", ".pyo", ".part", ".tmp", ".tif", ".tiff", ".img", ".bsp", ".bpc", ".npz", ".zip",
)
#: Top folder inside the zip (the notebook extracts to /content/lunar-navigator).
TOP = "lunar-navigator"
#: Fixed zip timestamp (the earliest a zip can hold) for byte-deterministic output.
ZIP_DATE = (1980, 1, 1, 0, 0, 0)


@dataclass(frozen=True)
class BundleResult:
    """Outcome of :func:`build_bundle`: ``path`` of the zip, packed ``files`` (relative POSIX
    paths), ``code_sha256`` (hash over paths + bytes), ``total_bytes`` (uncompressed),
    ``zip_bytes`` and ``zip_sha256``."""

    path: Path
    files: tuple[str, ...]
    code_sha256: str
    total_bytes: int
    zip_bytes: int
    zip_sha256: str


def _skip_dir(name: str) -> bool:
    return name in EXCLUDE_DIRS or name.endswith(EXCLUDE_DIR_SUFFIXES)


def collect_files(root: Path, max_file_bytes: int) -> list[Path]:
    """All files to pack (absolute paths, sorted by relative POSIX path).

    Raises FileNotFoundError if the root does not look like the project (no pyproject.toml or
    lunarnav/__init__.py) and ValueError if a selected file exceeds ``max_file_bytes``.
    """
    root = root.resolve()
    if not (root / "pyproject.toml").is_file() or not (root / "lunarnav" / "__init__.py").is_file():
        raise FileNotFoundError(f"{root} is not the lunar-navigator project root "
                                "(needs pyproject.toml and lunarnav/__init__.py)")
    out: list[Path] = []
    for entry in INCLUDE:
        p = root / entry
        if not p.exists():
            continue  # e.g. README.md not written yet
        if p.is_file():
            cand = [p]
        else:
            cand = []
            for f in sorted(p.rglob("*")):
                rel_parts = f.relative_to(root).parts
                if any(_skip_dir(part) for part in rel_parts[:-1]):
                    continue
                if f.is_file():
                    cand.append(f)
        for f in cand:
            if f.suffix.lower() in EXCLUDE_SUFFIXES or f.name.endswith("~"):
                continue
            size = f.stat().st_size
            if size > max_file_bytes:
                raise ValueError(f"{f.relative_to(root)} is {size / 1e6:.1f} MB (> {max_file_bytes / 1e6:.1f} MB): "
                                 "data files do not belong in the code bundle (raise --max-file-mb if intended)")
            out.append(f)
    out.sort(key=lambda f: f.relative_to(root).as_posix())
    return out


def code_hash(root: Path, files: list[Path]) -> str:
    """SHA-256 over ``relative/posix/path \\0 bytes \\0`` of every file, in order."""
    h = hashlib.sha256()
    for f in files:
        h.update(f.relative_to(root).as_posix().encode("utf-8") + b"\0")
        h.update(f.read_bytes() + b"\0")
    return h.hexdigest()


def _git_commit(root: Path) -> str | None:
    try:
        r = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    s = r.stdout.strip()
    return s if r.returncode == 0 and len(s) == 40 else None


def _zinfo(name: str) -> zipfile.ZipInfo:
    zi = zipfile.ZipInfo(name, date_time=ZIP_DATE)
    zi.compress_type = zipfile.ZIP_DEFLATED
    zi.external_attr = (0o644 & 0xFFFF) << 16
    zi.create_system = 3  # unix, so the permissions above are honoured on Colab
    return zi


def build_bundle(root: Path, out: Path, max_file_mb: float = 5.0) -> BundleResult:
    """Write the deterministic code zip ``out`` from project ``root``; return a BundleResult.

    The zip is written to ``out.with_suffix('.zip.tmp')`` first and renamed, so an interrupted
    run never leaves a truncated bundle behind.
    """
    root = root.resolve()
    out = out.resolve()  # (*.zip is in EXCLUDE_SUFFIXES, so an old bundle is never packed again)
    files = collect_files(root, int(max_file_mb * 1e6))
    if not files:
        raise RuntimeError("nothing to pack")
    digest = code_hash(root, files)
    rels = tuple(f.relative_to(root).as_posix() for f in files)
    info = {
        "name": "lunar-navigator code bundle (scripts/make_colab_bundle.py)",
        "code_sha256": digest,
        "n_files": len(files),
        "git_commit": _git_commit(root),
        "excluded": "data/ output/ dist/ .venv/ .git/ caches, *.pyc, DEM/kernel binaries",
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + ".tmp")
    with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for f, rel in zip(files, rels):
            zf.writestr(_zinfo(f"{TOP}/{rel}"), f.read_bytes(), compresslevel=9)
        zf.writestr(_zinfo(f"{TOP}/BUNDLE_INFO.json"),
                    json.dumps(info, indent=1, sort_keys=True) + "\n", compresslevel=9)
    tmp.replace(out)
    data = out.read_bytes()
    return BundleResult(out, rels, digest, sum(f.stat().st_size for f in files), len(data),
                        hashlib.sha256(data).hexdigest())


def main(argv: list[str] | None = None) -> int:
    root_default = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", type=Path, default=root_default, help="project root (default: parent of scripts/)")
    ap.add_argument("--out", type=Path, default=None, help="zip path (default: <root>/dist/lunarnav_colab_bundle.zip)")
    ap.add_argument("--max-file-mb", type=float, default=5.0, help="refuse any single file larger than this")
    ap.add_argument("--list", action="store_true", help="only list the files that would be packed")
    a = ap.parse_args(argv)
    if a.list:
        root = a.root.resolve()
        for f in collect_files(root, int(a.max_file_mb * 1e6)):
            print(f.relative_to(root).as_posix())
        return 0
    out = a.out or (a.root / "dist" / "lunarnav_colab_bundle.zip")
    res = build_bundle(a.root, out, a.max_file_mb)
    print(f"wrote {res.path}")
    print(f"  {len(res.files)} files, {res.total_bytes / 1e6:.2f} MB of code -> {res.zip_bytes / 1e6:.2f} MB zip")
    print(f"  code_sha256 {res.code_sha256}")
    print(f"  zip sha256  {res.zip_sha256}")
    print("Upload it to Colab (or Drive: MyDrive/lunarnav/lunarnav_colab_bundle.zip) and open "
          "notebooks/lunar_navigator_colab.ipynb")
    return 0


if __name__ == "__main__":
    sys.exit(main())
