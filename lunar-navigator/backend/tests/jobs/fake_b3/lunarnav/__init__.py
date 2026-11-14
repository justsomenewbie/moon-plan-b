"""FAKE lunarnav package for the B3 report job-type tests (check / validate / validate_terrain).

compare_runs needs no fake (backend/python/compare_runs.py uses numpy only). Behaviour is chosen by the
inputs the bridges pass (the bridge env is allow-listed, so no env switches):
  precompute.check_output(dir)  dir/FAKE_RAISE -> RuntimeError; dir/FAKE_VIOLATIONS = n -> n violations
                                 naming the absolute run dir (the bridge must scrub it); else none
  validate.run_all(...)          offline=True -> RuntimeError (not cached); quick=False -> a FAILED matrix
                                 row (passed False); terrain=True -> the hook writes a NaN report
  validate_terrain.run(quick)    quick=False -> RuntimeError; quick=True -> NaN report, one failed check
"""
__version__ = "0.0.0-fake-b3"
