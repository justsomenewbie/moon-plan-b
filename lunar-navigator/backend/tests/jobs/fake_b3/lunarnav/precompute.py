"""FAKE lunarnav.precompute (B3 tests): check_output only (see __init__.py)."""
from pathlib import Path


def check_output(out_dir):
    d = Path(out_dir)
    if (d / "FAKE_RAISE").exists():
        raise RuntimeError("fake check_output exploded")
    f = d / "FAKE_VIOLATIONS"
    n = int(f.read_text().strip()) if f.exists() else 0
    return [f"{d / 'sites' / 'apollo11' / 'visibility.csv.gz'}: fake violation {i + 1}" for i in range(n)]
