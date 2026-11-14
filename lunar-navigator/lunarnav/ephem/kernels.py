"""NAIF SPICE generic kernels: download (once, cached), verify, and load (furnsh).

Kernel set (all from https://naif.jpl.nasa.gov/pub/naif/generic_kernels/):

  * ``lsk/naif0012.tls``            leap seconds (UTC <-> ET/TDB), valid for leap seconds up to 2017
                                    (no leap second has been announced since; IERS Bulletin C).
  * ``pck/pck00011.tpc``            IAU body shapes/orientations (Earth/Sun radii, IAU_MOON fallback).
  * ``spk/planets/de440s.bsp``      DE440 "small" planetary ephemeris, 1849-12-26 .. 2150-01-22 TDB.
                                    Covers the whole mission planning range (2026-2031+) and is 31 MB
                                    instead of 114 MB for de440.bsp (1550-2650).
  * Lunar orientation, selectable with ``lunar_set``:

    - ``"de440"`` (DEFAULT): ``pck/moon_pa_de440_200625.bpc`` (high-precision lunar libration from
      DE440, 1550-2650) + ``fk/satellites/moon_de440_250416.tf`` (defines MOON_PA_DE440,
      MOON_ME_DE440_ME421 and the generic aliases MOON_PA / MOON_ME).
      Chosen because it is consistent with the DE440 planetary ephemeris above and with JPL Horizons
      (which uses DE440/DE441), and because the FK keeps the MOON_ME axes realised as DE421-ME
      ("MOON_ME_DE440_ME421") - i.e. the same Mean-Earth frame in which LOLA products are
      delivered (LOLA uses the DE421 ME frame).  The DE440 vs DE421 PA libration difference is
      a few metres at the surface (< 0.3 arcsec of orientation).
    - ``"de421"``: ``pck/moon_pa_de421_1900-2050.bpc`` + ``fk/satellites/moon_080317.tf``.
      The original LOLA frame definition; coverage ends 2050-01-01, still fine for 2026-2031.

Frames exposed after loading: ``MOON_ME`` (LOLA, the contract frame), ``MOON_PA``, ``IAU_MOON``
(low precision IAU model, for comparison only).

Thread safety: CSPICE keeps global state (kernel pool, error status) and is NOT thread safe.
Every call into spiceypy in this package must hold :data:`SPICE_LOCK` (an ``RLock``).
"""
from __future__ import annotations

import hashlib
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import requests
import spiceypy as sp

from lunarnav import config

NAIF_BASE = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/"

#: Global lock guarding all CSPICE calls (CSPICE is not thread safe).
SPICE_LOCK = threading.RLock()


@dataclass(frozen=True)
class KernelSpec:
    """One kernel file: relative URL path under NAIF_BASE and the expected size in bytes.

    ``size`` is the exact byte size (0 = not pinned) published on the NAIF server (checked after download, so a
    truncated/HTML-error download can never be furnished).
    """

    rel_url: str
    size: int

    @property
    def filename(self) -> str:
        return self.rel_url.rsplit("/", 1)[-1]


# Exact sizes from the NAIF server (verified at implementation time, 2026-11).
KERNELS: dict[str, KernelSpec] = {
    "lsk": KernelSpec("lsk/naif0012.tls", 5257),
    "pck": KernelSpec("pck/pck00011.tpc", 131_226),
    "spk": KernelSpec("spk/planets/de440s.bsp", 32_726_016),
    "spk_full": KernelSpec("spk/planets/de440.bsp", 119_799_808),
    "moon_bpc_de440": KernelSpec("pck/moon_pa_de440_200625.bpc", 12_863_488),
    "moon_fk_de440": KernelSpec("fk/satellites/moon_de440_250416.tf", 19_478),
    "moon_bpc_de421": KernelSpec("pck/moon_pa_de421_1900-2050.bpc", 1_770_496),
    "moon_fk_de421": KernelSpec("fk/satellites/moon_080317.tf", 21_437),
}

LUNAR_SETS: dict[str, tuple[str, str]] = {
    "de440": ("moon_bpc_de440", "moon_fk_de440"),
    "de421": ("moon_bpc_de421", "moon_fk_de421"),
}

_loaded: dict[str, list[Path]] = {}


class KernelError(RuntimeError):
    """Raised when a kernel cannot be downloaded, verified, or loaded."""


def _verify(path: Path, spec: KernelSpec) -> None:
    """Raise KernelError unless ``path`` looks like a complete, valid kernel."""
    if not path.is_file():
        raise KernelError(f"kernel missing: {path}")
    n = path.stat().st_size
    if spec.size and n != spec.size:
        raise KernelError(f"kernel {path.name}: size {n} B != expected {spec.size} B (truncated or changed?)")
    with path.open("rb") as f:
        head = f.read(8)
    if spec.filename.endswith((".bsp", ".bpc")):
        if not head.startswith(b"DAF/"):
            raise KernelError(f"kernel {path.name} is not a DAF binary kernel (header {head!r})")
    else:
        if not head.startswith(b"KPL/"):
            raise KernelError(f"kernel {path.name} is not a SPICE text kernel (header {head!r})")


def _download(spec: KernelSpec, dest: Path, retries: int = 4) -> None:
    """Stream ``spec`` to ``dest`` (atomic rename), retrying with exponential backoff."""
    url = NAIF_BASE + spec.rel_url
    tmp = dest.with_suffix(dest.suffix + ".part")
    last: Exception | None = None
    for attempt in range(retries):
        try:
            with requests.get(url, stream=True, timeout=120) as r:
                r.raise_for_status()
                with tmp.open("wb") as f:
                    for chunk in r.iter_content(chunk_size=1 << 20):
                        f.write(chunk)
            _verify(tmp, spec)
            tmp.replace(dest)
            return
        except (requests.RequestException, KernelError, OSError) as e:  # retry then re-raise
            last = e
            time.sleep(2.0 * 2**attempt)
    tmp.unlink(missing_ok=True)
    raise KernelError(f"failed to download {url}: {last}") from last


def ensure_kernel(key: str, download: bool = True) -> Path:
    """Return the local path of kernel ``key`` (see :data:`KERNELS`), downloading it once if needed."""
    if key not in KERNELS:
        raise KeyError(f"unknown kernel key {key!r}; known: {sorted(KERNELS)}")
    spec = KERNELS[key]
    dest = config.kernels_dir() / spec.filename
    if dest.is_file():
        _verify(dest, spec)
        return dest
    if not download:
        raise KernelError(f"kernel {spec.filename} not present in {dest.parent} and download=False")
    _download(spec, dest)
    return dest


def kernel_paths(lunar_set: str = "de440", full_spk: bool = False) -> list[Path]:
    """Ensure and return the ordered list of kernel files for a configuration."""
    if lunar_set not in LUNAR_SETS:
        raise ValueError(f"lunar_set must be one of {sorted(LUNAR_SETS)}, got {lunar_set!r}")
    keys = ["lsk", "pck", "spk_full" if full_spk else "spk", *LUNAR_SETS[lunar_set]]
    return [ensure_kernel(k) for k in keys]


def load_kernels(lunar_set: str = "de440", full_spk: bool = False) -> list[Path]:
    """Furnish the kernel set (idempotent). Clears any other kernels from the pool first.

    The whole pool is reset when the configuration changes, so that two lunar sets never coexist
    (their FKs both define MOON_ME and the last loaded would silently win).
    Returns the loaded paths. Raises KernelError if SPICE rejects a file or MOON_ME is unusable.
    """
    cfg = f"{lunar_set}|{int(full_spk)}"
    with SPICE_LOCK:
        if cfg in _loaded and sp.ktotal("ALL") == len(_loaded[cfg]):
            return _loaded[cfg]
        paths = kernel_paths(lunar_set, full_spk)
        sp.kclear()
        _loaded.clear()
        try:
            for p in paths:
                sp.furnsh(str(p))
            # Sanity check: the MOON_ME frame must resolve to a usable frame at J2000.
            m = sp.pxform("J2000", "MOON_ME", 0.0)
        except sp.utils.exceptions.SpiceyError as e:
            sp.kclear()
            raise KernelError(f"furnsh/pxform failed for kernel set {lunar_set!r}: {e}") from e
        if abs(abs(sp.det(m)) - 1.0) > 1e-12:
            raise KernelError("MOON_ME rotation matrix is not orthonormal")
        _loaded[cfg] = paths
        return paths


def sha256(path: Path) -> str:
    """Hex SHA-256 of a file (for provenance in output metadata)."""
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ensure_any_loaded() -> None:
    """Load the default kernel set only if no kernel set has been loaded yet (keeps the current one)."""
    with SPICE_LOCK:
        if not _loaded or sp.ktotal("ALL") == 0:
            load_kernels()
