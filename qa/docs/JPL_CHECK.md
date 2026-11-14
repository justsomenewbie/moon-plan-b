# Live Horizons Q4 parser check

On 14 November 2026, two HTTPS observer tables from NASA/JPL Horizons were archived locally and parsed offline. The interval was 00:00 through 02:00 UTC on 14 November with an hourly step. The observer used east longitude 45 degrees, latitude -89.1 degrees and height 0 km. These coordinates are an engineering test location.

Both responses reported API version 1.2 and DE441, with `MEAN_ME (high precision)` in the center-frame header. The program verified the Moon center, target, observer coordinates, time header and three ordered UTC samples per body. A second read using CSV column labels independently matched all six azimuth/elevation pairs to the parser output. This checks ingestion from the service. It uses the same source for both reads. Independent scientific review and the team's production export remain pending.

| Target | Azimuth / elevation at 00:00 UTC (degrees) | Exact archived response SHA-256 |
| --- | --- | --- |
| Sun (10) | 81.642695 / 1.687615 | f3fa58c87e49d6915119e5eb2d0cd76ae01f008756218f52b2c32901a8ca3f85 |
| Earth (399) | 313.819123 / -4.025579 | 3e301b24709c1c075b739095712c70ca7a3c735b2e8546b55c1e1439eb8a9dbe |

For reproduction use the [Horizons API](https://ssd-api.jpl.nasa.gov/doc/horizons.html) with format=text, COMMAND=10 or 399, CENTER=coord@301, COORD_TYPE=GEODETIC, SITE_COORD=45,-89.1,0, START_TIME='2026-11-14 00:00', STOP_TIME='2026-11-14 02:00', STEP_SIZE='1 h', QUANTITIES=4, APPARENT=AIRLESS, TIME_TYPE=UT, EPHEM_TYPE=OBSERVER, CSV_FORMAT=YES, CAL_FORMAT=CAL, TIME_DIGITS=SECONDS and OBJ_DATA=NO. Server generation time and later model versions may change the response hash. The routine automated gate uses the committed synthetic fixtures and runs offline.
