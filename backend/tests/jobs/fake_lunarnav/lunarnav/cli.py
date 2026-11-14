"""FAKE `lunarnav.cli` for the backend job tests (shadows the real package via cwd = LUNARNAV_ROOT).

Behaviour is chosen by the latitude of `--sites custom:<lat>:<lon>`:
  -10  success: prints lunarnav-like progress, copies tests/importer/fixtures/run_small (a REAL lunarnav
       output, so the real importer runs) to --out, exit 0
  -20  hangs (sleep 120 s) after writing its pid -> used for cancel / timeout / queue-full tests
  -30  check_output violations, exit 1
  -40  SystemExit message on stderr (like a DEM pre-flight failure), exit 1
  -50  success exit 0 but writes a broken output dir (manifest only) -> import fails
Catalog ids (no ':' in --sites) behave like -10.
Writes argv + selected env to LUNARNAV_OUTPUT/fake_call.json so tests can assert the command line.
"""
import json
import os
import shutil
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.normpath(os.path.join(HERE, "..", "..", "..", "importer", "fixtures", "run_small"))


def arg(name):
    a = sys.argv
    return a[a.index(name) + 1] if name in a else None


def main():
    job_dir = os.environ.get("LUNARNAV_OUTPUT", ".")
    os.makedirs(job_dir, exist_ok=True)
    with open(os.path.join(job_dir, "fake_call.json"), "w", encoding="utf-8") as f:
        json.dump({"argv": sys.argv[1:], "env": {k: os.environ.get(k) for k in ("LUNARNAV_DATA", "LUNARNAV_OUTPUT", "PYTHONIOENCODING")},
                   "cwd": os.getcwd()}, f)
    site = arg("--sites") or ""
    out = arg("--out")
    lat = float(site.split(":")[1]) if site.startswith("custom:") else -10.0
    print(f"[1/1] {site}: horizon + ephemeris + visibility", flush=True)
    if lat == -20.0:
        with open(os.path.join(job_dir, "pid.txt"), "w") as f:
            f.write(str(os.getpid()))
        time.sleep(120)
        return 0
    if lat == -30.0:
        print(f"wrote {out}", flush=True)
        print("VIOLATION: sites/x/windows.json: metrics differ from visibility", flush=True)
        print("check_output: 1 violation(s)", flush=True)
        return 1
    if lat == -40.0:
        raise SystemExit("--dem pgda cannot serve 1 site(s):\n  x: missing DEM file")
    time.sleep(0.2)
    if lat == -50.0:
        os.makedirs(out, exist_ok=True)
        with open(os.path.join(out, "manifest.json"), "w", encoding="utf-8") as f:
            json.dump({"format": "lunarnav-precompute", "format_version": 1, "broken": True}, f)
    else:
        shutil.copytree(FIXTURE, out, dirs_exist_ok=True)
    print(f"wrote {out}", flush=True)
    print("check_output: 0 violation(s)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
