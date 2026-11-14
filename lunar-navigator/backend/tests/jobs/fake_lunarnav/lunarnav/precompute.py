"""FAKE lunarnav.precompute (read_table only) for the alt-dates bridge tests."""


def read_table(path):
    with open(path, "rb"):
        pass  # the file must exist
    return {"time_utc": [], "sun_el_deg": []}
