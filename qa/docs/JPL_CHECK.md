# Live Horizons Q4 parser check

On 14 November 2026, two HTTPS observer tables from NASA/JPL Horizons were archived locally and parsed offline. The interval was 00:00 through 02:00 UTC on 14 November with an hourly step. The observer used east longitude 45 degrees, latitude -89.1 degrees and height 0 km. These coordinates are an engineering test location.

Both responses reported API version 1.2 and DE441, with `MEAN_ME (high precision)` in the center-frame header. The program verified the Moon center, target, observer coordinates, time header and three ordered UTC samples per body. A second read using CSV column labels independently matched all six azimuth/elevation pairs to the parser output. This checks ingestion from the service. It uses the same source for both reads. Independent scientific review and the team's production export remain pending.

| Target | Azimuth / elevation at 00:00 UTC (degrees) | Exact archived response SHA-256 |
| --- | --- | --- |
| Sun (10) | 81.642695 / 1.687615 | f3fa58c87e49d6915119e5eb2d0cd76ae01f008756218f52b2c32901a8ca3f85 |
| Earth (399) | 313.819123 / -4.025579 | 3e301b24709c1c075b739095712c70ca7a3c735b2e8546b55c1e1439eb8a9dbe |

For reproduction use the [Horizons API](https://ssd-api.jpl.nasa.gov/doc/horizons.html) with format=text, COMMAND=10 or 399, CENTER=coord@301, COORD_TYPE=GEODETIC, SITE_COORD=45,-89.1,0, START_TIME='2026-11-14 00:00', STOP_TIME='2026-11-14 02:00', STEP_SIZE='1 h', QUANTITIES=4, APPARENT=AIRLESS, TIME_TYPE=UT, EPHEM_TYPE=OBSERVER, CSV_FORMAT=YES, CAL_FORMAT=CAL, TIME_DIGITS=SECONDS and OBJ_DATA=NO. Server generation time and later model versions may change the response hash. The offline QA suite also uses the committed archives below.

## Archived four-response check

At 09:20 UTC on 14 November 2026, the offline Python regression compared the complete [paired control](../evidence/odysseus-athena-hour-gap/control.json) against four original JSON responses from Horizons. Each SHA-256 covered the original response bytes. The Sun and Earth targets, Moon center, observer coordinates, and all five hourly UTC, azimuth and elevation records per target matched for both Odysseus and Athena on 7 January 2026. The parser now accepts the full Q4 column names emitted with extra precision, as well as the abbreviated text headers. Run `python3 -B -m unittest qa.test_edge_cases.TraceabilityTests.test_archived_horizons_q4` from the repository root.

An independent CLI retest used a temporary QA manifest with normalized request times. Its calendar format was inferred from the returned calendar dates. The control passed four raw comparisons. Changing Athena’s 02:00 solar azimuth by 0.001° or importing the deliberately gapped copy failed the row comparison even with updated dataset hashes. Appending one whitespace byte to an original response failed the raw-hash check. DATA-001 still awaits a production package from the data owner and scientific review.

## B2 body-center directions

At 00:00–04:00 UTC on January 7, 2026, four archived JPL Horizons tables and the public B2 SPICE service both returned the airless apparent directions of the Sun and Earth at Odysseus and Athena. The largest angular separation across the 20 comparisons was about 0.0094 arcseconds (Earth at Odysseus). The six-decimal-degree B2 output limits the precision of small residuals. The coordinates matched in latitude and east longitude. The B2 observers were 15.074 m and 2.906 m higher, respectively, and the ephemeris configurations differed. Terrain masking, upper-limb visibility, and the complete five-year time series require separate validation.

Run `python3 qa/check_b2_horizons_angles.py` to compare the stored source responses, or add `--live` to repeat the B2 request. [Verifier and source identifiers](../check_b2_horizons_angles.py).
