"""FAKE lunarnav.visibility for the alt-dates bridge tests."""


class VisibilitySeries:
    def __init__(self, site_id, times_utc, min_earth_clearance_deg=0.0, **kw):
        self.site_id = site_id
        self.times_utc = times_utc
        self.min_earth_clearance_deg = min_earth_clearance_deg
        self.columns = kw
