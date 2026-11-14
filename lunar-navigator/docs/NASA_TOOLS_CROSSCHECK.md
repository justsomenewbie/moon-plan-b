# Cross-check sheet: backend results vs NASA tools

This checklist compares numbers computed by the Lunar Landing Site Navigator backend with what three public NASA tools
show for the same places and times: JPL Horizons (Sun and Earth directions), LROC QuickMap (terrain height,
illumination, permanently shadowed regions) and NASA Moon Trek (terrain height). It was used by an independent tester
who has no programming background and did not work on the backend; anyone can repeat it in a web browser, no login or
software installation needed. The Vietnamese original that the tester filled in is
[`docs/vi/KIEM_THU_DOI_CHIEU_NASA.md`](vi/KIEM_THU_DOI_CHIEU_NASA.md).

**Who it is for:** anyone; no programming knowledge needed.
**How it works:** open the NASA tool, follow the steps, read the number and write it in the blank cell. Then compare
it with the **backend number that is already filled in**.
**Time:** about 45–60 minutes for all 8 cases.

Tools used:

| Tool | Address | Used to check |
|---|---|---|
| JPL Horizons | https://ssd.jpl.nasa.gov/horizons/app.html | In which direction the Sun and the Earth are, and how many degrees above the horizon |
| LROC QuickMap | https://quickmap.lroc.asu.edu/ (redirects to quickmap.lroc.im-ldi.com) | Terrain height, % of sunlight, permanently shadowed craters |
| NASA Moon Trek | https://trek.nasa.gov/moon/ | Terrain height (1 case) |

## Where the "Backend (pre-filled)" numbers come from

Every number in a **Backend (pre-filled)** column was read from the default dataset served by the live API
(https://api.lunavigator.com/api/v1) on **14 Nov 2026**. That default dataset is **run B**: NAIF SPICE ephemerides +
NASA GSFC PGDA LOLA terrain, 2026–2030, hourly, 23 sites, computed after the rim-site horizon fix (commit `676af9d`).
The notes "When we tested, we measured …" under some cases record the differences the team itself observed against
the NASA tools while preparing the sheet, before handing it to the tester. If a later dataset is published, the
backend numbers may change slightly; the "Pass if" tolerances stay the same.

## Read these 4 points first

1. **All times are UTC.** Type the times exactly as written in the sheet; do not convert them to your local time.
2. **Coordinates are already written in the format each tool expects.** Just copy and paste them.
3. **Numbers on screen use a decimal point** (for example `36.929`). This sheet writes numbers the same way so they are
   easy to compare.
4. **Backend numbers** come from the default run **B** described above. A very small difference (within the "Pass if"
   limit of each case) is normal and not an error.

---

## Part 1. JPL Horizons (4 cases)

### One-time setup (about 5 minutes)

Open https://ssd.jpl.nasa.gov/horizons/app.html. The page has 5 sections from top to bottom.

1. **Ephemeris Type**: choose **Observer Table**.
2. **Table Settings → Edit**:
   * Click **None** to clear all ticked boxes.
   * Tick exactly **one** box: **4. Apparent AZ & EL**.
   * Scroll down to *Additional Table Settings*:
     * Angle format: **decimal degrees**
     * Refraction model: **no refraction (airless)**
     * Tick **Extra precision**
   * Leave everything else unchanged. Click **Use Specified Settings**.

These settings are kept for the following cases. Each case only changes 3 sections: **Target Body**,
**Observer Location** and **Time Specification**.

**How to enter the Observer Location** (the same for every case):
1. Click **Edit** in the Observer Location section.
2. *Choose a method*: choose **Specify Coordinates**.
3. *Coordinate Body*: click **change** → scroll the list, choose **[id:301] Moon** → **Select Indicated Body**.
4. *Type of coordinates*: choose **Geodetic Coordinates**. Units: **kilometers**.
5. Type **longitude**, **latitude** and **altitude** from the sheet → click **Use Specified Coordinates**.

**How to enter the Time Specification:** click **Edit**, type **Start time**, **Stop time** and **Step size** from the
sheet → click **Use Specified Time Span**.

Finally click **Generate Ephemeris**. The result table is between the two lines `$$SOE` and `$$EOE`. Each line looks
like this:

```
 2026-Mar-13 16:00 *    36.929480953  -0.214169914
 ^ date and time   ^ * = the Sun is above the horizon
                        ^ AZIMUTH (deg) ^ ELEVATION (deg)
```

* **Azimuth**: 0 = North, 90 = East, 180 = South, 270 = West.
* **Elevation**: positive means above the horizon, negative means below.

---

### Case H-1. The Sun seen from the rim of Shackleton crater

*Purpose: does the backend compute the Sun direction the same way NASA does?*

| Enter in Horizons | |
|---|---|
| Target Body | type `Sun` → choose **Sun [Sol] (10)** |
| longitude / latitude / altitude | `203.97` / `-89.7849` / `1.73925` |
| Start / Stop / Step | `2026-03-13 16:00` / `2026-03-13 17:00` / `1` hours |

Read the **16:00 line**:

| | Horizons (you write) | Backend (pre-filled) | Pass if |
|---|---|---|---|
| Azimuth (deg) | ............ | **36.929481** | difference ≤ 0.001 |
| Elevation (deg) | ............ | **−0.214170** | difference ≤ 0.001 |

Result: ☐ Pass ☐ Fail

### Case H-2. The Earth seen from the same place

*Purpose: the same check as H-1, but for the Earth.*

Keep the Observer Location and the time of case H-1. Only change the **Target Body**: type `399` → choose
**Earth (399)** → **Generate Ephemeris**.

Read the **16:00 line**:

| | Horizons (you write) | Backend (pre-filled) | Pass if |
|---|---|---|---|
| Azimuth (deg) | ............ | **151.844305** | difference ≤ 0.001 |
| Elevation (deg) | ............ | **−5.754085** | difference ≤ 0.001 |

Result: ☐ Pass ☐ Fail

### Case H-3. Sunset at the Apollo 11 landing site

*Purpose: the backend says the Sun sets at Apollo 11 between 09:00 and 10:00 UTC on 9 March 2026. Does NASA give the
same result?*

| Enter in Horizons | |
|---|---|
| Target Body | **Sun [Sol] (10)** |
| longitude / latitude / altitude | `23.47314` / `0.67416` / `0.002` |
| Start / Stop / Step | `2026-03-09 09:00` / `2026-03-09 10:00` / `1` hours |

| Line | Is there a `*`? (you write) | Elevation (you write) | Backend (pre-filled) |
|---|---|---|---|
| 09:00 | ☐ yes ☐ no | ............ | **still sunlit**, elevation −0.297791 |
| 10:00 | ☐ yes ☐ no | ............ | **already dark**, elevation −0.804677 |

**Pass if:** the 09:00 line **has** a `*`, the 10:00 line **has no** `*`, and the elevations differ by ≤ 0.001.

At 09:00 a negative elevation with the site still sunlit is correct. Reason: the Sun is a disc, and its upper edge
still shows above the horizon.

Result: ☐ Pass ☐ Fail

### Case H-4. The far side of the Moon (Chang'e-6 landing site): the Earth is never visible

*Purpose: the backend says the Earth is visible here **0 %** of the time. Check that the Earth always stays below the
horizon.*

| Enter in Horizons | |
|---|---|
| Target Body | **Earth (399)** |
| longitude / latitude / altitude | `206.0148` / `-41.6385` / `0.002` |
| Start / Stop / Step | `2026-01-01 00:00` / `2026-02-01 00:00` / `1` days |

Look at the **elevation** column of all 32 lines.

| | You write | Backend (pre-filled) |
|---|---|---|
| Highest elevation in the month | ............ | about **−35.47** |
| Lowest elevation in the month | ............ | about **−48.90** |
| Is any elevation positive? | ☐ yes ☐ no | **no** (Earth visible 0 %) |

**Pass if:** every line has a negative elevation.

Result: ☐ Pass ☐ Fail

---

## Part 2. LROC QuickMap (3 cases, read at the same points)

### Procedure (done once for 5 points)

1. Open https://quickmap.lroc.asu.edu/. The page redirects to `quickmap.lroc.im-ldi.com`. Close the notice box with
   the **×**.
2. In the search box at the top left, paste the point's coordinates (column "Type into QuickMap" in the table below)
   → choose **Create Point at …**.
3. The **Object Inspector** panel opens on the right. Choose the **Inspect** tab.
4. **At the first point only:** click **Sources**, find and tick the following 3 sources. Close the list, then wait a
   few seconds for the numbers to appear.
   * **LOLA 80S 20M ADJ DEM** (height)
   * **Sun Visibility 60m** (% sunlight)
   * **SPOLE PSRs (80S to 90S)** (permanently shadowed regions)
5. Read those 3 lines and write them in the tables of cases Q-1, Q-2 and Q-3. Repeat steps 2–5 for the next point. The
   ticked sources are kept; you do not need to tick them again.

| Point | Description | Type into QuickMap |
|---|---|---|
| P1 | Ridge connecting to Shackleton (point C1) | `-89.4505,222.84` |
| P2 | Rim of Shackleton crater | `-89.7849,203.97` |
| P3 | Rim of de Gerlache crater | `-88.6646,291.6044` |
| P4 | Haworth area (Artemis III) | `-86.752966,336.328186` |
| P5 | Floor of Shackleton crater (permanently dark) | `-89.67,129.78` |

### Case Q-1. Terrain height

*Read the `LOLA 80S 20M ADJ DEM` line (in metres).*

| Point | QuickMap (you write) | Backend (pre-filled) | Pass if |
|---|---|---|---|
| P1 | ............ | **1957.3** | difference ≤ 5 m |
| P2 | ............ | **1737.3** | difference ≤ 5 m |
| P3 | ............ | **1815.2** | difference ≤ 5 m |
| P4 | ............ | **1556.4** | difference ≤ 5 m |
| P5 | ............ | **−2788.9** | difference ≤ 5 m |

When we tested, we measured differences of no more than 1.1 m at all 5 points.

Result: ☐ Pass ☐ Fail

### Case Q-2. Permanently shadowed crater

*Read the `SPOLE PSRs` line. 1 means the place is permanently dark, 0 means it is not.*

| Point | QuickMap PSR (you write) | Backend (pre-filled) |
|---|---|---|
| P5 (crater floor) | ............ | **sunlight 0 %**, dark for the whole 5 years 2026–2030 |
| P2 (crater rim, as a control) | ............ | **sunlight about 88 %** |

**Pass if:** P5 = 1 and P2 = 0.

Result: ☐ Pass ☐ Fail

### Case Q-3. Average sunlight

*Read the `Sun Visibility 60m` line. The number is shown as 0–1; multiply by 100 to get %. For example `0.864` →
**86.4 %**.*

| Point | QuickMap % (you write) | Backend % (pre-filled) | Pass if |
|---|---|---|---|
| P1 | ............ | **85.6** | difference ≤ 5 |
| P2 | ............ | **83.2** | difference ≤ 5 |
| P3 | ............ | **81.4** | difference ≤ 5 |
| P4 | ............ | **31.8** | difference ≤ 5 |
| P5 | ............ | **0** | difference ≤ 5 |

When we tested, we measured differences of 0.8 to 2.3 points.

**Why don't they match exactly?** The NASA map is an average over **18.6 years**, while the backend computes
**2026–2030**. The two also use slightly different terrain maps. So a difference of a few points is normal.

> Note: the backend number here is "**the average fraction of the solar disc that is visible**", the same kind of
> measure as QuickMap. It is **not** the "% of hours with sunlight" shown in the web interface (for example 90.25 % for
> P1). The number in the interface is always a few points higher, because a time step counts as sunlit as soon as the
> edge of the Sun shows.

Result: ☐ Pass ☐ Fail

---

## Part 3. NASA Moon Trek (1 case)

### Case T-1. Height at point C1

*Purpose: check the terrain height with a second tool. C1 lies on top of a flat ridge, so placing the mouse slightly
off the point does not matter.*

1. Open https://trek.nasa.gov/moon/ → click **Skip Tutorial**.
2. Switch to the south pole map: click the **globe** icon at the **bottom left** → **Projections** →
   **South Pole Map**.
3. Fly to the point: click the **airplane** icon at the bottom right → paste `-89.4505, -137.16` into the `Lat, Lon`
   box → Enter.
   (Moon Trek only accepts longitudes from −180 to 180. If the box turns red, the longitude was typed incorrectly.)
4. Zoom in with the **+** button a few times. The coordinates under the mouse pointer are shown at the bottom right.
   Move the mouse to the spot showing `Lat: -89.450…, Lon: -137.16…`.
5. Click the **☰** menu at the top right → **Calculate Elevation Profile** → **Line**. **Press and hold the mouse on
   that point**, drag about 1–2 cm, then release → click **Submit**.
6. A chart with several lines appears. Hover over the **first point on the left** (Distance = 0) of the
   **"LRO LOLA DEM 75 deg"** line and read the Elevation value (metres).

| | Moon Trek (you write) | Backend (pre-filled) | Pass if |
|---|---|---|---|
| Height (m) | ............ | **1957.3** | difference ≤ 3 m |

When we tested, we read **1958.0** in Moon Trek on the 75 deg line (30 m) and **1957.5** on the 87.5 deg line (5 m).

Result: ☐ Pass ☐ Fail

---

## Summary table (fill in and send back to the team)

| Case | Content | Pass / Fail | Notes |
|---|---|---|---|
| H-1 | Sun direction at Shackleton | | |
| H-2 | Earth direction at Shackleton | | |
| H-3 | Apollo 11 sunset | | |
| H-4 | Far side never sees the Earth | | |
| Q-1 | Height at 5 points (QuickMap) | | |
| Q-2 | Permanently shadowed crater | | |
| Q-3 | Average sunlight | | |
| T-1 | Height at C1 (Moon Trek) | | |

**If a case fails**, send the team 3 things:
1. The case code (for example H-1).
2. A screenshot of the NASA tool showing both what you entered and the number you read.
3. The number you read.

Before reporting, check these 3 things yourself:
* Did you paste exactly the coordinates in the sheet?
* Did you type exactly the UTC time in the sheet (not your local time)?
* In Horizons, did you choose the right body, Sun or Earth?

---

*For the full technical validation (Horizons vs SPICE vs an analytic model, negative controls, terrain horizon
algorithms, comparison with NASA PGDA illumination maps), see [`VALIDATION.md`](VALIDATION.md) and
[`VALIDATION_TERRAIN.md`](VALIDATION_TERRAIN.md). They are written for readers with a technical background and are not
needed for this sheet.*
