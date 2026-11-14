/**
 * Mission energy (lander survival):
 *   POST /api/v1/mission/survival   battery state of charge over a mission at one site (model: src/mission/energy.ts)
 */
import { z } from 'zod';
import { IsoUtc, IsoUtcInput, RunId, SiteId, provenance } from './common.ts';
import { IRRADIANCE_MODES, PANEL_MODES } from '../mission/energy.ts';

export const SURVIVAL_LIMITS = {
  max_mission_h: 8760,
  max_battery_wh: 1e9,
  max_power_w: 1e7,
  max_points_default: 1000,
  max_points_min: 10,
  max_points_max: 5000,
} as const;

const watts = z.number().min(0).max(SURVIVAL_LIMITS.max_power_w);

export const PanelMode = z
  .enum(PANEL_MODES)
  .describe(
    'tracking: 2-axis panel always facing the Sun (factor = sun_fraction); vertical_fixed: vertical panel facing panel_azimuth_deg ' +
      '(factor = sun_fraction * cos(sun_el) * max(0, cos(sun_az - panel_az))); horizontal: flat-lying panel (factor = power_horizontal = sun_fraction * max(0, sin(sun_el)))',
  )
  .meta({ id: 'PanelMode' });

export const IrradianceMode = z
  .enum(IRRADIANCE_MODES)
  .describe('solar_distance: 1361 W/m2 * (AU / sun_dist_km)^2 per sample (as irradiance_tracking_wm2); constant: 1361 W/m2 always')
  .meta({ id: 'IrradianceMode' });

const SurvivalRequestShape = z
  .strictObject({
    run_id: RunId.optional().describe('Default: the default run'),
    site_id: SiteId,
    landing_utc: IsoUtcInput.describe('Landing instant; snapped DOWN to the sample grid; must be inside the run (else 422 OUT_OF_RANGE)'),
    mission_h: z
      .number()
      .positive()
      .max(SURVIVAL_LIMITS.max_mission_h)
      .describe(`Mission length, h (<= ${SURVIVAL_LIMITS.max_mission_h}); a whole number of steps (else 422 BAD_MISSION_LENGTH); landing + mission_h <= run end (else 422 OUT_OF_RANGE with max_mission_h)`),
    battery_wh: z.number().positive().max(SURVIVAL_LIMITS.max_battery_wh).describe('Battery capacity, Wh'),
    night_load_w: watts.describe('Load while the Sun is not visible (survival heaters, ...), W'),
    day_load_w: watts.optional().describe('Load while the Sun is visible, W; default = night_load_w'),
    panel_peak_w: watts.describe('Panel output at 1361 W/m2, normal incidence, fully lit (already includes efficiency), W; 0 = no panel'),
    panel_mode: PanelMode.default('tracking'),
    panel_azimuth_deg: z.number().min(0).lt(360).optional().describe('vertical_fixed only (required there): compass azimuth the panel faces, deg clockwise from north'),
    initial_soc_pct: z.number().gt(0).max(100).default(100).describe('Battery charge at landing, % of battery_wh; must be >= min_soc_pct'),
    min_soc_pct: z.number().min(0).lt(100).default(0).describe('Reserve: below it the lander counts as dead, % of battery_wh (0 = dead when empty and the load is not met)'),
    irradiance: IrradianceMode.default('solar_distance'),
    max_points: z
      .int()
      .min(SURVIVAL_LIMITS.max_points_min)
      .max(SURVIVAL_LIMITS.max_points_max)
      .default(SURVIVAL_LIMITS.max_points_default)
      .describe('Maximum points of the SOC timeline; above it the timeline is decimated keeping every bucket minimum and maximum, the global minimum, first and last point'),
  })
  .superRefine((b, ctx) => {
    if (b.panel_mode === 'vertical_fixed' && b.panel_azimuth_deg === undefined) {
      ctx.addIssue({ code: 'custom', path: ['panel_azimuth_deg'], message: 'required when panel_mode is vertical_fixed' });
    }
    if (b.panel_mode !== 'vertical_fixed' && b.panel_azimuth_deg !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['panel_azimuth_deg'], message: 'only allowed when panel_mode is vertical_fixed' });
    }
    if (b.initial_soc_pct < b.min_soc_pct) {
      ctx.addIssue({ code: 'custom', path: ['initial_soc_pct'], message: `must be >= min_soc_pct (${b.min_soc_pct})` });
    }
  });
export type SurvivalRequest = z.output<typeof SurvivalRequestShape>;
export const SurvivalRequest = SurvivalRequestShape.meta({
  id: 'SurvivalRequest',
  examples: [
    {
      site_id: 'ref_connecting_ridge_c1',
      landing_utc: '2026-01-01T00:00:00Z',
      mission_h: 720,
      battery_wh: 3000,
      night_load_w: 30,
      panel_peak_w: 200,
      panel_mode: 'tracking',
    },
  ],
});

export const SurvivalInputs = z
  .object({
    battery_wh: z.number(),
    night_load_w: z.number(),
    day_load_w: z.number(),
    panel_peak_w: z.number(),
    panel_mode: PanelMode,
    panel_azimuth_deg: z.number().nullable(),
    initial_soc_pct: z.number(),
    min_soc_pct: z.number(),
    min_soc_wh: z.number().describe('= battery_wh * min_soc_pct / 100'),
    irradiance: IrradianceMode,
  })
  .describe('The inputs actually used (defaults filled in)')
  .meta({ id: 'SurvivalInputs' });

export const SocTimeline = z
  .object({
    t: z.array(IsoUtc).describe('Step boundaries (landing .. mission end); decimated -> a subset'),
    soc_wh: z.array(z.number()),
    soc_pct: z.array(z.number()),
    decimated: z.boolean(),
    n_full: z.int().min(0).describe('Points before decimation (= n_steps + 1)'),
  })
  .meta({ id: 'SocTimeline' });

const SurvivalResponseShape = z.object({
  ...provenance,
  site_id: SiteId,
  site_name: z.string(),
  landing_utc: IsoUtc.describe('Snapped landing instant actually used'),
  mission_end_utc: IsoUtc,
  mission_h: z.number(),
  n_steps: z.int().min(1),
  inputs: SurvivalInputs,
  survived: z
    .boolean()
    .describe('true = SOC never fell below the reserve (min_soc_pct) during the mission. ENERGY BALANCE ONLY: no thermal, dust or degradation model, so true means "enough energy", not that the lander survives'),
  first_depletion_utc: IsoUtc.nullable().describe('First instant SOC fell below the reserve (exact inside the step for this model); null = never'),
  hours_after_landing_at_depletion: z.number().nullable(),
  dark_h_at_depletion: z.number().nullable().describe('How long the lander had been in the dark at first_depletion_utc, h; null = never depleted or it happened in sunlight'),
  dark_at_depletion_truncated: z.boolean().describe('true -> that dark period began before landing (value counts from landing)'),
  n_depletions: z.int().min(0).describe('Separate periods below the reserve'),
  hours_below_min: z.number().min(0).describe('Total time below the reserve, h'),
  min_soc_wh: z.number().min(0),
  min_soc_pct: z.number().min(0),
  min_soc_utc: IsoUtc.describe('First instant the minimum was reached'),
  end_soc_wh: z.number().min(0),
  end_soc_pct: z.number().min(0),
  energy_in_wh: z.number().min(0).describe('Panel production over the mission (gross), Wh'),
  energy_out_wh: z.number().min(0).describe('Load demand over the mission, Wh'),
  energy_curtailed_wh: z.number().min(0).describe('Panel energy lost because the battery was full, Wh'),
  energy_unserved_wh: z.number().min(0).describe('Load that could not be supplied because the battery was empty, Wh'),
  longest_dark_h: z.number().min(0).describe('Longest continuous period without Sun inside the mission, h'),
  longest_dark_truncated: z.boolean().describe('true -> touches landing or mission end (the real night is at least this long)'),
  longest_no_input_h: z
    .number()
    .min(0)
    .describe('Longest continuous period in which this panel (mode / azimuth, any size) produces nothing, h: the Sun is hidden, or behind / edge-on to a fixed panel. >= longest_dark_h; only the battery can bridge it'),
  required_battery_wh: z
    .number()
    .nullable()
    .describe('Smallest battery that never falls below the reserve with the same loads, panel, initial_soc_pct and min_soc_pct (both % of that battery). Exact for this model (cumulative-deficit / drawdown). null = no size works (initial_soc_pct = min_soc_pct and the mission starts with a net drain)'),
  required_battery_full_start_wh: z
    .number()
    .min(0)
    .describe('required_battery_wh with the battery FULL at landing (initial_soc_pct 100), same loads, panel and min_soc_pct. Equals required_battery_wh when initial_soc_pct = 100; with a part-charged landing it is the size to compare with hardware that is charged full before landing'),
  required_panel_peak_w: z
    .number()
    .nullable()
    .describe('Smallest panel_peak_w that survives with the same battery and loads (bisection, +- 0.01 W, rounded up); 0 = no panel needed; null = no panel size is enough (a night longer than the battery can bridge)'),
  required_battery_night_only_wh: z
    .number()
    .min(0)
    .describe('Battery the night load alone needs: this model with an unlimited panel (full again after every lit step, so day load and panel size drop out), initial 100 %, reserve 0 % = night_load_w x longest_dark_h. Same number as GET /dataset include=survival_hint required_battery_wh for the same range and night_load_w; a lower bound of required_battery_wh when initial_soc_pct = 100 and min_soc_pct = 0'),
  timeline: SocTimeline,
  verdict: z
    .object({ vi: z.string(), en: z.string() })
    .describe('One-line plain-language result: "Energy OK (power balance only, no thermal/dust model): ..." / "Out of energy: ..." (vi: "Đủ điện ..." / "Thiếu điện ..."); a battery size states the landing charge and reserve it assumes'),
  assumptions: z.array(z.string()).describe('Every modelling assumption behind these numbers'),
});
export type SurvivalResponse = z.output<typeof SurvivalResponseShape>;
export const SurvivalResponse = SurvivalResponseShape.meta({ id: 'SurvivalResponse' });
