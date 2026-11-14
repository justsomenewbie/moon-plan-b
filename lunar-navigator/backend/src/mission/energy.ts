/**
 * Lander energy model for POST /api/v1/mission/survival (pure, no I/O; route: src/routes/mission.ts).
 *
 * One battery, one solar panel, two constant loads, a fixed time step dt (= run step_s / 3600 h).
 * Sample k describes the interval [t_k, t_k + dt) and its values are held constant over it:
 *
 *   P_in(k)  = panel_peak_w * factor(k) * scale(k)                 [W]
 *     factor  tracking       : sun_fraction                        (2-axis panel always facing the Sun)
 *             vertical_fixed : sun_fraction * cos(el) * max(0, cos(sun_az - panel_az))
 *             horizontal     : power_horizontal (= sun_fraction * max(0, sin el))
 *     scale   solar_distance : (AU / sun_dist_km)^2  (= irradiance / 1361 W/m2; the series' irradiance_tracking_wm2
 *                                                     is exactly 1361 * scale * sun_fraction, docs/OUTPUT_SPEC.md)
 *             constant       : 1                     (1361 W/m2 at every sample)
 *   load(k)  = day_load_w if sun_visible(k) else night_load_w     [W]
 *   SOC(t_k+1) = clamp(SOC(t_k) + (P_in(k) - load(k)) * dt, 0, battery_wh)
 *
 * Inside a step SOC is linear (until it hits 0 or full), so depletion instants, time below the reserve
 * and the minimum are exact for this model, not rounded to the step.
 *
 * "Below the reserve" means SOC < min_soc_wh, or SOC = 0 while the load exceeds the panel input (load not
 * met) - with min_soc_pct = 0 that is "the battery is empty and the lander is off". survived = never below.
 *
 * required_battery_wh is exact (Lindley recursion of the deficit from full): with x_k = (load - P_in) * dt,
 * S_k = x_1 + ... + x_k, s0 = initial_soc_pct/100, m = min_soc_pct/100 and BOTH percentages applied to the
 * candidate capacity C, the deficit from full after k steps is D_k = max(C(1-s0) + S_k, max_{1<=j<=k}(S_k - S_j)).
 * Never below the reserve  <=>  D_k <= C(1-m) for all k  <=>  C >= max(A / (s0 - m), B / (1 - m)) with
 * A = max(0, max_k S_k) and B = max(0, max_{j<=k}(S_k - S_j)) (largest drawdown). A > 0 with s0 = m -> no
 * capacity works (null).
 */

export const SOLAR_CONSTANT_WM2 = 1361;
/** Astronomical unit, km (IAU 2012) - same constant as lunarnav.visibility.AU_KM. */
export const AU_KM = 149_597_870.7;
const DEG = Math.PI / 180;
/** Energy tolerance (Wh) for "zero" tests; comparisons against the reserve use tolWh(capacity). */
export const EPS_WH = 1e-9;
/** Tolerance of the "below the reserve" test: floating point noise of the running sums (1e-9 relative). */
export const tolWh = (capWh: number): number => EPS_WH * (1 + capWh);

export const PANEL_MODES = ['tracking', 'vertical_fixed', 'horizontal'] as const;
export type PanelMode = (typeof PANEL_MODES)[number];
export const IRRADIANCE_MODES = ['solar_distance', 'constant'] as const;
export type IrradianceMode = (typeof IRRADIANCE_MODES)[number];

/** The series columns the model reads (names = docs/OUTPUT_SPEC.md / visibility.csv.gz). */
export interface EnergySample {
  sun_az_deg: number;
  sun_el_deg: number;
  sun_fraction: number;
  power_horizontal: number;
  sun_visible: boolean;
  sun_dist_km: number;
}

export interface EnergyParams {
  battery_wh: number;
  night_load_w: number;
  day_load_w: number;
  panel_peak_w: number;
  panel_mode: PanelMode;
  /** Required for vertical_fixed: compass azimuth the panel faces, deg clockwise from north. */
  panel_azimuth_deg: number | null;
  initial_soc_pct: number;
  min_soc_pct: number;
  irradiance: IrradianceMode;
}

/** Relative panel output (0..1) of one sample before the irradiance scale. */
export function panelFactor(s: EnergySample, mode: PanelMode, panelAzDeg: number | null): number {
  switch (mode) {
    case 'tracking':
      return Math.max(0, s.sun_fraction);
    case 'horizontal':
      return Math.max(0, s.power_horizontal);
    case 'vertical_fixed': {
      if (panelAzDeg === null) throw new RangeError('vertical_fixed needs panel_azimuth_deg');
      const facing = Math.max(0, Math.cos((s.sun_az_deg - panelAzDeg) * DEG));
      return Math.max(0, s.sun_fraction * Math.cos(s.sun_el_deg * DEG) * facing);
    }
  }
}

/** Irradiance relative to 1361 W/m2: (AU / d)^2, or 1 for the constant mode. */
export function irradianceScale(s: EnergySample, mode: IrradianceMode): number {
  if (mode === 'constant') return 1;
  if (!(s.sun_dist_km > 0)) throw new RangeError(`sun_dist_km must be > 0: ${s.sun_dist_km}`);
  const r = AU_KM / s.sun_dist_km;
  return r * r;
}

/** Per-step panel input power (W) and load (W). */
export interface PowerSeries {
  p_in_w: Float64Array;
  load_w: Float64Array;
  /** sun_visible per step (load selector, dark periods). */
  lit: Uint8Array;
}

export function powerSeries(samples: readonly EnergySample[], p: Pick<EnergyParams, 'panel_peak_w' | 'panel_mode' | 'panel_azimuth_deg' | 'irradiance' | 'day_load_w' | 'night_load_w'>): PowerSeries {
  const n = samples.length;
  const pIn = new Float64Array(n);
  const load = new Float64Array(n);
  const lit = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const s = samples[k] as EnergySample;
    pIn[k] = p.panel_peak_w * panelFactor(s, p.panel_mode, p.panel_azimuth_deg) * irradianceScale(s, p.irradiance);
    lit[k] = s.sun_visible ? 1 : 0;
    load[k] = s.sun_visible ? p.day_load_w : p.night_load_w;
  }
  return { p_in_w: pIn, load_w: load, lit };
}

export interface BatteryRun {
  /** SOC at t_0 .. t_n (n + 1 values, clamped to [0, battery_wh]). */
  soc_wh: Float64Array;
  survived: boolean;
  /** Hours after the start when SOC first fell below the reserve (exact inside the step); null if never. */
  first_depletion_h: number | null;
  /** Step containing first_depletion_h. */
  first_depletion_step: number | null;
  /** Number of separate periods below the reserve. */
  n_depletions: number;
  hours_below_min: number;
  min_soc_wh: number;
  /** Hours after the start when the minimum was first reached. */
  min_soc_h: number;
  end_soc_wh: number;
  /** Panel production (gross), Wh. */
  energy_in_wh: number;
  /** Load demand, Wh. */
  energy_out_wh: number;
  /** Panel energy thrown away because the battery was full, Wh. */
  energy_curtailed_wh: number;
  /** Load energy that could not be delivered because the battery was empty, Wh. */
  energy_unserved_wh: number;
}

/**
 * Integrate the battery for given per-step input power and load (the core of simulate(); also used by
 * the panel-size search with a scaled p_in). capWh > 0; 0 <= minWh <= initWh <= capWh.
 */
export function runBattery(pIn: ArrayLike<number>, load: ArrayLike<number>, dtH: number, capWh: number, initWh: number, minWh: number, panelScale = 1): BatteryRun {
  const n = pIn.length;
  const soc = new Float64Array(n + 1);
  let a = initWh;
  soc[0] = a;
  let firstH: number | null = null;
  let firstStep: number | null = null;
  let nDep = 0;
  let below = false;
  let belowH = 0;
  let minWh2 = a;
  let minH = 0;
  let eIn = 0;
  let eOut = 0;
  let curtailed = 0;
  let unserved = 0;
  const tol = tolWh(capWh);
  const thr = minWh - tol;
  for (let k = 0; k < n; k++) {
    const pin = (pIn[k] ?? 0) * panelScale;
    const ld = load[k] ?? 0;
    const r = pin - ld; // Wh per h
    eIn += pin * dtH;
    eOut += ld * dtH;
    const u = a + r * dtH; // unclamped end of step
    // time in [0, dtH) with the unclamped line below the reserve (clamping never changes that: 0 <= min <= cap)
    let tBelow0 = 0; // start offset of the below part inside the step
    let tBelow = 0;
    if (a < thr) {
      tBelow = r <= 0 ? dtH : Math.min(dtH, (minWh - a) / r);
      tBelow0 = 0;
    } else if (r < 0 && u < thr) {
      tBelow0 = Math.max(0, (a - minWh) / -r);
      tBelow = dtH - tBelow0;
    }
    if (tBelow > 0) {
      const startsNew = !(below && tBelow0 === 0);
      if (startsNew) {
        nDep++;
        if (firstH === null) {
          firstH = k * dtH + tBelow0;
          firstStep = k;
        }
      }
      belowH += tBelow;
    }
    below = tBelow > 0 && tBelow0 + tBelow >= dtH - 1e-12;
    // clamp, with the exact instant of hitting 0 for the minimum
    let b = u;
    let hitZeroAt: number | null = null;
    if (u > capWh) {
      curtailed += u - capWh;
      b = capWh;
    } else if (u < 0) {
      unserved += -u;
      b = 0;
      hitZeroAt = k * dtH + (r < 0 ? a / -r : 0);
    }
    if (b < minWh2 - tol) {
      minWh2 = b;
      minH = hitZeroAt ?? (k + 1) * dtH;
    }
    soc[k + 1] = b;
    a = b;
  }
  return {
    soc_wh: soc,
    survived: belowH === 0,
    first_depletion_h: firstH,
    first_depletion_step: firstStep,
    n_depletions: nDep,
    hours_below_min: belowH,
    min_soc_wh: Math.max(0, minWh2),
    min_soc_h: minH,
    end_soc_wh: a,
    energy_in_wh: eIn,
    energy_out_wh: eOut,
    energy_curtailed_wh: curtailed,
    energy_unserved_wh: unserved,
  };
}

/**
 * Smallest capacity (Wh) for which SOC never drops below the reserve, with initial and reserve given
 * as fractions of that capacity (see the module comment). null = no capacity works (s0 = m and the
 * mission starts with a net drain). 0 = no storage needed at all.
 */
export function requiredBatteryWh(pIn: ArrayLike<number>, load: ArrayLike<number>, dtH: number, initialFrac: number, minFrac: number): number | null {
  let s = 0;
  let maxS = 0; // A
  let minSj = 0; // min over j >= 1 of S_j seen so far (j = k gives drawdown 0)
  let drawdown = 0; // B
  let first = true;
  for (let k = 0; k < pIn.length; k++) {
    s += ((load[k] ?? 0) - (pIn[k] ?? 0)) * dtH;
    if (s > maxS) maxS = s;
    if (first) {
      minSj = s;
      first = false;
    } else {
      drawdown = Math.max(drawdown, s - minSj);
      if (s < minSj) minSj = s;
    }
  }
  const a = maxS > EPS_WH ? maxS : 0;
  const b = drawdown > EPS_WH ? drawdown : 0;
  let req = b / (1 - minFrac);
  if (a > 0) {
    const head = initialFrac - minFrac;
    if (!(head > 0)) return null;
    req = Math.max(req, a / head);
  }
  return req;
}

/**
 * Battery the NIGHT LOAD ALONE needs (the /dataset include=survival_hint value): this model in the limit of an
 * unlimited panel - the battery is full again at the end of every lit step, so the day load and the panel size
 * drop out - with initial_soc_pct 100 and min_soc_pct 0. The only deficits left are the dark runs
 * (sun_visible false); each starts full with zero input and the night load, so requiredBatteryWh() of the
 * series = the worst run = night_load_w x longest dark period. Computed run by run (exactly what
 * requiredBatteryWh() gives with an unlimited p_in in the lit steps, without the huge-number round-off).
 * Used by POST /mission/survival (required_battery_night_only_wh) and GET /dataset (survival_hint).
 */
export function nightOnlyBatteryWhOfRuns(darkSteps: readonly number[], dtH: number, nightLoadW: number): number {
  let worst = 0;
  for (const n of darkSteps) {
    if (!(n > 0)) continue;
    const req = requiredBatteryWh(new Float64Array(n), new Float64Array(n).fill(nightLoadW), dtH, 1, 0) ?? 0;
    if (req > worst) worst = req;
  }
  return worst;
}

/** Lengths (steps) of the runs of dark steps (lit = 0), in time order. */
export function darkRuns(lit: ArrayLike<number>): number[] {
  const out: number[] = [];
  let run = 0;
  for (let k = 0; k < lit.length; k++) {
    if (lit[k] === 0) run++;
    else if (run > 0) {
      out.push(run);
      run = 0;
    }
  }
  if (run > 0) out.push(run);
  return out;
}

/** nightOnlyBatteryWhOfRuns() of a per-step sun_visible series. */
export function nightOnlyBatteryWh(lit: ArrayLike<number>, dtH: number, nightLoadW: number): number {
  return nightOnlyBatteryWhOfRuns(darkRuns(lit), dtH, nightLoadW);
}

/** Battery size for a sentence, never understated: >= 1 kWh -> kWh rounded UP to 0.1, else Wh rounded up. */
export function batteryText(wh: number): string {
  return wh >= 1000 ? `${(Math.ceil(wh / 100 - 1e-9) / 10).toFixed(1)} kWh` : `${Math.ceil(wh - 1e-9)} Wh`;
}

/**
 * Longest run of dark steps (sun_visible false), hours. truncated = a run of that length touches the
 * mission start or end, so the real night may be longer (the value is a lower bound).
 */
export function longestDark(lit: ArrayLike<number>, dtH: number): { hours: number; truncated: boolean } {
  let best = 0;
  let bestTrunc = false;
  let run = 0;
  let runStart = 0;
  const n = lit.length;
  for (let k = 0; k <= n; k++) {
    if (k < n && lit[k] === 0) {
      if (run === 0) runStart = k;
      run++;
      continue;
    }
    if (run > 0) {
      const trunc = runStart === 0 || k === n;
      if (run > best) {
        best = run;
        bestTrunc = trunc;
      } else if (run === best && trunc) bestTrunc = true;
    }
    run = 0;
  }
  return { hours: best * dtH, truncated: bestTrunc };
}

/**
 * Smallest panel_peak_w that survives with the same battery and loads (bisection; SOC is monotone in the
 * panel size). 0 when no panel is needed; null when even PANEL_SEARCH_MAX_W does not survive (a dark
 * period longer than the battery can bridge). Accurate to max(0.01 W, 1e-6 relative), rounded up.
 */
export const PANEL_SEARCH_MAX_W = 1e7;
export function requiredPanelPeakW(unitPIn: ArrayLike<number>, load: ArrayLike<number>, dtH: number, capWh: number, initWh: number, minWh: number): number | null {
  const ok = (w: number): boolean => runBattery(unitPIn, load, dtH, capWh, initWh, minWh, w).survived;
  if (ok(0)) return 0;
  // doubling search capped at PANEL_SEARCH_MAX_W; lo = the last size that failed, so [lo, hi] is always
  // bisected (also when the answer lies between the last power of two and the cap)
  let lo = 0;
  let hi = 1;
  while (!ok(hi)) {
    if (hi >= PANEL_SEARCH_MAX_W) return null;
    lo = hi;
    hi = Math.min(hi * 2, PANEL_SEARCH_MAX_W);
  }
  while (hi - lo > Math.max(0.01, 1e-6 * hi)) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) hi = mid;
    else lo = mid;
  }
  return Math.ceil(hi * 100) / 100;
}

export interface SimulationResult extends BatteryRun {
  dt_h: number;
  n_steps: number;
  capacity_wh: number;
  min_soc_reserve_wh: number;
  longest_dark_h: number;
  longest_dark_truncated: boolean;
  /**
   * Longest run of steps in which a panel of this mode / azimuth produces nothing (Sun hidden, or behind a
   * fixed panel), h - independent of panel_peak_w. No panel size can bridge it; only the battery can.
   */
  longest_no_input_h: number;
  /** Length of the dark period the lander was in when it first fell below the reserve (h); null if lit then or never. */
  dark_h_at_depletion: number | null;
  /** true when that dark period started before the mission (value is a lower bound). */
  dark_at_depletion_truncated: boolean;
  required_battery_wh: number | null;
  /** required_battery_wh with the battery FULL at landing (initial 100 %), same reserve: never null. */
  required_battery_full_start_wh: number;
  required_panel_peak_w: number | null;
  /** Per-step panel input (W) and load (W) actually used. */
  power: PowerSeries;
}

/** Full simulation of one mission: samples = the mission steps in time order, dtH = step length in hours. */
export function simulate(samples: readonly EnergySample[], dtH: number, p: EnergyParams, opts: { panelSearch?: boolean } = {}): SimulationResult {
  if (!(dtH > 0)) throw new RangeError('dtH must be > 0');
  if (!(p.battery_wh > 0)) throw new RangeError('battery_wh must be > 0');
  if (p.min_soc_pct < 0 || p.min_soc_pct >= 100) throw new RangeError('min_soc_pct must be in [0, 100)');
  if (p.initial_soc_pct < p.min_soc_pct || p.initial_soc_pct > 100) throw new RangeError('initial_soc_pct must be in [min_soc_pct, 100]');
  const power = powerSeries(samples, p);
  const cap = p.battery_wh;
  const init = (cap * p.initial_soc_pct) / 100;
  const minWh = (cap * p.min_soc_pct) / 100;
  const run = runBattery(power.p_in_w, power.load_w, dtH, cap, init, minWh);
  const dark = longestDark(power.lit, dtH);
  let darkAt: number | null = null;
  let darkAtTrunc = false;
  if (run.first_depletion_h !== null && run.first_depletion_step !== null && power.lit[run.first_depletion_step] === 0) {
    let j = run.first_depletion_step;
    while (j > 0 && power.lit[j - 1] === 0) j--;
    darkAt = run.first_depletion_h - j * dtH;
    darkAtTrunc = j === 0;
  }
  const unitPIn = powerSeries(samples, { ...p, panel_peak_w: 1 }).p_in_w;
  const noInput = longestDark(Uint8Array.from(unitPIn, (w) => (w > 0 ? 1 : 0)), dtH);
  const reqPanel = opts.panelSearch === false ? null : requiredPanelPeakW(unitPIn, power.load_w, dtH, cap, init, minWh);
  return {
    ...run,
    dt_h: dtH,
    n_steps: samples.length,
    capacity_wh: cap,
    min_soc_reserve_wh: minWh,
    longest_dark_h: dark.hours,
    longest_dark_truncated: dark.truncated,
    longest_no_input_h: noInput.hours,
    dark_h_at_depletion: darkAt,
    dark_at_depletion_truncated: darkAtTrunc,
    required_battery_wh: requiredBatteryWh(power.p_in_w, power.load_w, dtH, p.initial_soc_pct / 100, p.min_soc_pct / 100),
    required_battery_full_start_wh: requiredBatteryWh(power.p_in_w, power.load_w, dtH, 1, p.min_soc_pct / 100) ?? 0,
    required_panel_peak_w: reqPanel,
    power,
  };
}

/**
 * Indices of the SOC timeline to send (n = soc length): all when n <= maxPoints, else first + last +
 * the global minimum + per bucket its argmin and argmax (minima are never lost). Size <= maxPoints.
 */
export function decimateSoc(soc: ArrayLike<number>, maxPoints: number): { indices: number[]; decimated: boolean } {
  const n = soc.length;
  if (n <= maxPoints) return { indices: Array.from({ length: n }, (_v, i) => i), decimated: false };
  const buckets = Math.max(1, Math.floor((maxPoints - 3) / 2));
  const b = Math.ceil(n / buckets);
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  let gMin = 0;
  for (let s = 0; s < n; s += b) {
    const e = Math.min(n, s + b);
    let iMin = s;
    let iMax = s;
    for (let i = s + 1; i < e; i++) {
      const v = soc[i] ?? 0;
      if (v < (soc[iMin] ?? 0)) iMin = i;
      if (v > (soc[iMax] ?? 0)) iMax = i;
    }
    keep[iMin] = 1;
    keep[iMax] = 1;
    if ((soc[iMin] ?? 0) < (soc[gMin] ?? 0)) gMin = iMin;
  }
  keep[gMin] = 1;
  const indices: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i] === 1) indices.push(i);
  return { indices, decimated: true };
}
