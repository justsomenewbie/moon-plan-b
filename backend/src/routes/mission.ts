/**
 * Mission energy - contract: src/contract/mission.ts, model: src/mission/energy.ts (pure).
 *   POST /api/v1/mission/survival   will the lander survive? battery state of charge over the mission
 *
 * Reads the stored hourly series of the run (sun az/el/fraction/distance, power_horizontal, sun_visible)
 * for [landing, landing + mission_h) and integrates the battery step by step. Synchronous and cheap
 * (8760 steps + a panel-size bisection take a few ms), so it uses the global rate limit like /compare.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { SurvivalRequest, SurvivalResponse } from '../contract/mission.ts';
import { ApiError, problemResponses, siteNotFound } from '../lib/problem.ts';
import { provenanceOf } from '../lib/provenance.ts';
import { MS_PER_H, MS_PER_S, parseIsoUtc, sampleIndex, toIsoUtc } from '../lib/time.ts';
import { batteryText, decimateSoc, nightOnlyBatteryWh, simulate, type EnergyParams, type EnergySample, type SimulationResult } from '../mission/energy.ts';
import { getSeries, getSite, resolveRun, type RunDoc } from '../repos/index.ts';
import { pyRound } from './a/pyround.ts';
import { siteTerrainModelled } from './pointing.ts';
import { recordOf } from './sites.ts';

const MODEL_FIELDS = ['sun_az_deg', 'sun_el_deg', 'sun_fraction', 'power_horizontal', 'sun_visible', 'sun_dist_km'] as const;

const r3 = (x: number): number => Math.round(x * 1000) / 1000 + 0;
const r4 = (x: number): number => Math.round(x * 10000) / 10000 + 0;
const pct = (wh: number, cap: number): number => r3((100 * wh) / cap);
/** `2026-01-05 12:00 UTC` */
const shortUtc = (ms: number): string => `${toIsoUtc(ms).slice(0, 16).replace('T', ' ')} UTC`;
const num = (x: number, digits = 1): string => (Math.round(x * 10 ** digits) / 10 ** digits).toString();

export interface MissionWindow {
  landingMs: number;
  endMs: number;
  i0: number;
  nSteps: number;
}

/** Validate landing / mission length against the run (422 OUT_OF_RANGE / BAD_MISSION_LENGTH). */
export function missionWindow(run: Pick<RunDoc, 'start' | 'end' | 'step_s' | 'n_samples'>, landingUtc: string, missionH: number): MissionWindow {
  const runStart = run.start.getTime();
  const runEnd = run.end.getTime();
  const stepMs = run.step_s * MS_PER_S;
  const range = { run_start_utc: toIsoUtc(runStart), run_end_utc: toIsoUtc(runEnd) };
  const t = parseIsoUtc(landingUtc);
  const k = sampleIndex(t, runStart, run.step_s);
  if (t < runStart || t >= runEnd || k >= run.n_samples) {
    throw new ApiError('OUT_OF_RANGE', `landing_utc ${toIsoUtc(t)} is outside the run [${range.run_start_utc}, ${range.run_end_utc})`, {
      errors: [{ path: 'landing_utc', in: 'body', message: `must be in [${range.run_start_utc}, ${range.run_end_utc})` }],
      extensions: range,
    });
  }
  const m = (missionH * 3600) / run.step_s;
  if (Math.abs(m - Math.round(m)) > 1e-6 || Math.round(m) < 1) {
    throw new ApiError('BAD_MISSION_LENGTH', `mission_h ${missionH} is not a positive multiple of the run step (${run.step_s / 3600} h)`, {
      errors: [{ path: 'mission_h', in: 'body', message: `must be a multiple of ${run.step_s / 3600}` }],
      extensions: { step_h: run.step_s / 3600 },
    });
  }
  const nSteps = Math.round(m);
  const landingMs = runStart + k * stepMs;
  const endMs = landingMs + nSteps * stepMs;
  if (endMs > runEnd) {
    const maxH = (runEnd - landingMs) / MS_PER_H;
    throw new ApiError('OUT_OF_RANGE', `landing + mission_h = ${toIsoUtc(endMs)} is after the run end ${range.run_end_utc}`, {
      errors: [{ path: 'mission_h', in: 'body', message: `must be <= ${maxH} for this landing` }],
      extensions: { ...range, max_mission_h: maxH },
    });
  }
  return { landingMs, endMs, i0: k, nSteps };
}

interface VerdictInput {
  sim: SimulationResult;
  p: EnergyParams;
  landingMs: number;
}

export function survivalVerdict({ sim, p, landingMs }: VerdictInput): { vi: string; en: string } {
  const cap = sim.capacity_wh;
  const reserve = p.min_soc_pct > 0;
  const noNight = sim.longest_dark_h === 0;
  const nightVi = noNight
    ? 'không có lúc nào mất Mặt Trời trong nhiệm vụ'
    : `đêm dài nhất ${num(sim.longest_dark_h)} h${sim.longest_dark_truncated ? ' (bị cắt bởi đầu/cuối nhiệm vụ)' : ''}`;
  const nightEn = noNight
    ? 'the Sun never sets during the mission'
    : `longest night ${num(sim.longest_dark_h)} h${sim.longest_dark_truncated ? ' (cut by the mission start/end)' : ''}`;
  if (sim.survived) {
    const minPct = num((100 * sim.min_soc_wh) / cap);
    const at = shortUtc(landingMs + sim.min_soc_h * MS_PER_H);
    const resVi = reserve ? ` (mức dự trữ ${num(p.min_soc_pct)} %)` : '';
    const resEn = reserve ? ` (reserve ${num(p.min_soc_pct)} %)` : '';
    // energy balance only: "enough energy", never an outright "survives" (no thermal / dust / ageing model)
    return {
      vi: `Đủ điện (chỉ tính cân bằng năng lượng, chưa mô hình nhiệt/bụi): pin thấp nhất ${minPct} %${resVi} lúc ${at}; ${nightVi}.`,
      en: `Energy OK (power balance only, no thermal/dust model): battery lowest ${minPct} %${resEn} at ${at}; ${nightEn}.`,
    };
  }
  const depH = sim.first_depletion_h ?? 0;
  const at = shortUtc(landingMs + depH * MS_PER_H);
  const whatVi = reserve ? `Thiếu điện: pin xuống dưới mức dự trữ ${num(p.min_soc_pct)} %` : 'Thiếu điện: hết pin';
  const whatEn = reserve ? `Out of energy: battery below the ${num(p.min_soc_pct)} % reserve` : 'Out of energy: battery empty';
  const ctxVi =
    sim.dark_h_at_depletion === null
      ? 'lúc Mặt Trời vẫn còn: tấm pin phát ít hơn tải'
      : sim.dark_at_depletion_truncated
        ? 'tối liên tục từ lúc hạ cánh'
        : `sau ${num(sim.dark_h_at_depletion)} h đêm`;
  const ctxEn =
    sim.dark_h_at_depletion === null
      ? 'while the Sun was up: the panel produced less than the load'
      : sim.dark_at_depletion_truncated
        ? 'dark since landing'
        : `after ${num(sim.dark_h_at_depletion)} h of night`;
  const needVi: string[] = [];
  const needEn: string[] = [];
  // required_battery_wh takes initial_soc_pct / min_soc_pct as % of the CANDIDATE battery: say so, and give
  // the full-at-landing size too, so a part-charged landing does not read as a 20x bigger battery
  const partCharged = p.initial_soc_pct < 100;
  const fullText = batteryText(sim.required_battery_full_start_wh);
  const fullVi = `nếu sạc đầy lúc hạ cánh: cần pin >= ${fullText}`;
  const fullEn = `fully charged at landing: >= ${fullText}`;
  if (sim.required_battery_wh === null) {
    needVi.push(`không dung lượng pin nào đủ khi bắt đầu ở mức dự trữ (${fullVi})`);
    needEn.push(`no battery size is enough when starting at the reserve (${fullEn})`);
  } else {
    const condVi: string[] = [];
    const condEn: string[] = [];
    if (partCharged) {
      condVi.push(`nếu chỉ sạc ${num(p.initial_soc_pct)} % lúc hạ cánh`);
      condEn.push(`charged to ${num(p.initial_soc_pct)} % at landing`);
    }
    if (reserve) {
      condVi.push(`giữ ${num(p.min_soc_pct)} % dự trữ`);
      condEn.push(`${num(p.min_soc_pct)} % reserve kept`);
    } else if (partCharged) {
      condVi.push('0 % dự trữ');
      condEn.push('0 % reserve');
    }
    const req = batteryText(sim.required_battery_wh);
    const showFull = partCharged && fullText !== req;
    needVi.push(`cần pin >= ${req}${condVi.length ? ` (${condVi.join(', ')}${showFull ? `; ${fullVi}` : ''})` : ''}`);
    needEn.push(`needs a battery >= ${req}${condEn.length ? ` (${condEn.join(', ')}${showFull ? `; ${fullEn}` : ''})` : ''}`);
  }
  if (sim.required_panel_peak_w !== null && sim.required_panel_peak_w > 0) {
    needVi.push(`hoặc tấm pin >= ${Math.ceil(sim.required_panel_peak_w)} W`);
    needEn.push(`or a panel >= ${Math.ceil(sim.required_panel_peak_w)} W`);
  } else if (sim.required_panel_peak_w === null) {
    const gap = num(sim.longest_no_input_h);
    if (sim.longest_no_input_h > sim.longest_dark_h) {
      needVi.push(`(tấm pin lớn hơn không giúp được: tấm pin không phát điện ${gap} h liền vì Mặt Trời khuất hoặc ở phía sau tấm pin, quá lâu so với pin)`);
      needEn.push(`(a bigger panel cannot help: it produces nothing for ${gap} h in a row - Sun hidden or behind the panel - longer than the battery can bridge)`);
    } else {
      needVi.push(`(tấm pin lớn hơn không giúp được: đêm ${gap} h liền quá dài so với pin)`);
      needEn.push(`(a bigger panel cannot help: the ${gap} h night is longer than the battery can bridge)`);
    }
  }
  return {
    vi: `${whatVi} lúc ${at} (${num(depH)} h sau hạ cánh, ${ctxVi}); ${needVi.join(' ')}.`,
    en: `${whatEn} at ${at} (${num(depH)} h after landing, ${ctxEn}); ${needEn.join(' ')}.`,
  };
}

function assumptions(p: EnergyParams, run: RunDoc, site: { dem_source: string; horizon_method: string }): string[] {
  const stepH = run.step_s / 3600;
  const terrain = siteTerrainModelled(site);
  const factor = {
    tracking: 'tracking panel: output factor = sun_fraction (2-axis, always facing the Sun, no pointing loss)',
    vertical_fixed: `vertical fixed panel facing azimuth ${p.panel_azimuth_deg ?? 0} deg: output factor = sun_fraction * cos(sun_el) * max(0, cos(sun_az - panel_azimuth))`,
    horizontal: 'horizontal panel: output factor = power_horizontal = sun_fraction * max(0, sin(sun_el))',
  }[p.panel_mode];
  return [
    `energy balance per step of ${stepH} h: each sample's values are held constant over [t, t + ${stepH} h); SOC is linear inside a step, so depletion instants are interpolated`,
    `panel input = panel_peak_w * factor * irradiance / 1361 W/m2; panel_peak_w is the output at 1361 W/m2, normal incidence, fully lit (efficiency included)`,
    factor,
    p.irradiance === 'solar_distance'
      ? 'irradiance = 1361 W/m2 * (1 AU / sun_dist_km)^2 per sample (same as irradiance_tracking_wm2 / sun_fraction)'
      : 'irradiance = 1361 W/m2 constant (solar distance ignored)',
    terrain
      ? `terrain shadowing from the run's horizon (${site.horizon_method}, ${site.dem_source}); sun_fraction = visible part of the solar disc above that horizon`
      : `NO terrain model: ideal flat horizon (${site.horizon_method}, ${site.dem_source}), so hills and crater walls do not shadow the site; sun_fraction = visible part of the solar disc above that flat horizon`,
    'ENERGY BALANCE ONLY: survived / "Energy OK" means the battery never fell below the reserve, not that the lander survives - no temperature (thermal survival, heater needs vs temperature), dust, degradation, MPPT/wiring losses, reflected light, Earthshine or self-shadowing by the lander',
    `load = day_load_w while sun_visible (upper limb above the ${terrain ? 'terrain ' : 'flat '}horizon), else night_load_w; both constant (night_load_w does not depend on temperature)`,
    'ideal battery: 100 % charge/discharge efficiency, no self-discharge, no charge-rate limit; SOC clamped to [0, battery_wh]; surplus when full is curtailed',
    `dead = SOC below min_soc_pct (${p.min_soc_pct} %) of battery_wh, or empty while the load exceeds the panel input; the lander is assumed to keep drawing its load and may recover when the Sun returns (counted in n_depletions / hours_below_min)`,
    'required_battery_wh: initial_soc_pct and min_soc_pct are taken as % of the required battery (exact for this model), so with a part-charged landing it is larger than required_battery_full_start_wh (the same with the battery full at landing)',
    'required_battery_night_only_wh: the same model with an unlimited panel (battery full again after every lit step), initial 100 %, reserve 0 %: = night_load_w x longest_dark_h; this is the GET /dataset include=survival_hint required_battery_wh for the same range and night_load_w',
    `Sun visibility itself is sampled every ${stepH} h: event times are accurate to +- ${stepH} h`,
  ];
}

export const missionRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/mission/survival',
    {
      schema: {
        tags: ['mission'],
        operationId: 'simulateSurvival',
        summary: 'Will the lander survive? Battery state of charge over the mission',
        description:
          'Hourly energy balance on the stored series: E_in = panel_peak_w * factor(panel_mode) * irradiance/1361 * step, E_out = load * step ' +
          '(day_load_w while the Sun is visible, else night_load_w), SOC clamped to [0, battery_wh]. Returns survived, first depletion, minimum SOC, ' +
          'energy totals, the longest night, the exact smallest battery and the smallest panel that would survive, a decimated SOC timeline ' +
          '(minima kept), a Vietnamese + English verdict and every assumption. landing_utc outside the run or landing + mission_h past the run end ' +
          '-> 422 OUT_OF_RANGE (max_mission_h); mission_h not a whole number of steps -> 422 BAD_MISSION_LENGTH.',
        body: SurvivalRequest,
        response: { 200: SurvivalResponse, ...problemResponses(400, 404, 409, 413, 415, 422, 503) },
      },
    },
    async (req) => {
      const b = req.body;
      const run = await resolveRun(b.run_id);
      const view = await getSite(run._id, b.site_id);
      if (!view) throw siteNotFound(b.site_id);
      const w = missionWindow(run, b.landing_utc, b.mission_h);
      const cols = await getSeries(b.site_id, run, w.landingMs, w.endMs, MODEL_FIELDS);
      const samples: EnergySample[] = new Array<EnergySample>(w.nSteps);
      for (let k = 0; k < w.nSteps; k++) {
        const v = (f: (typeof MODEL_FIELDS)[number]) => (cols.fields[f] as (number | boolean | null)[] | undefined)?.[k];
        const nums = { sun_az_deg: v('sun_az_deg'), sun_el_deg: v('sun_el_deg'), sun_fraction: v('sun_fraction'), power_horizontal: v('power_horizontal'), sun_dist_km: v('sun_dist_km') };
        const vis = v('sun_visible');
        for (const [f, x] of Object.entries(nums)) {
          if (typeof x !== 'number') throw new ApiError('INTERNAL', `run ${run._id} has no ${f} for ${b.site_id} at ${toIsoUtc(w.landingMs + k * run.step_s * MS_PER_S)} (incomplete import?)`);
        }
        if (typeof vis !== 'boolean') throw new ApiError('INTERNAL', `run ${run._id} has no sun_visible for ${b.site_id} (incomplete import?)`);
        samples[k] = { ...(nums as Record<keyof typeof nums, number>), sun_visible: vis };
      }
      const p: EnergyParams = {
        battery_wh: b.battery_wh,
        night_load_w: b.night_load_w,
        day_load_w: b.day_load_w ?? b.night_load_w,
        panel_peak_w: b.panel_peak_w,
        panel_mode: b.panel_mode,
        panel_azimuth_deg: b.panel_azimuth_deg ?? null,
        initial_soc_pct: b.initial_soc_pct,
        min_soc_pct: b.min_soc_pct,
        irradiance: b.irradiance,
      };
      const dtH = run.step_s / 3600;
      const sim = simulate(samples, dtH, p);
      const cap = p.battery_wh;
      const at = (h: number): string => toIsoUtc(w.landingMs + h * MS_PER_H);
      const dec = decimateSoc(sim.soc_wh, b.max_points);
      const rec = recordOf(view.site_run);
      return {
        ...provenanceOf(run),
        site_id: b.site_id,
        site_name: rec.name,
        landing_utc: toIsoUtc(w.landingMs),
        mission_end_utc: toIsoUtc(w.endMs),
        mission_h: (w.endMs - w.landingMs) / MS_PER_H,
        n_steps: w.nSteps,
        inputs: { ...p, min_soc_wh: r3((cap * p.min_soc_pct) / 100) },
        survived: sim.survived,
        first_depletion_utc: sim.first_depletion_h === null ? null : at(sim.first_depletion_h),
        hours_after_landing_at_depletion: sim.first_depletion_h === null ? null : r4(sim.first_depletion_h),
        dark_h_at_depletion: sim.dark_h_at_depletion === null ? null : r4(sim.dark_h_at_depletion),
        dark_at_depletion_truncated: sim.dark_at_depletion_truncated,
        n_depletions: sim.n_depletions,
        hours_below_min: r4(sim.hours_below_min),
        min_soc_wh: r3(sim.min_soc_wh),
        min_soc_pct: pct(sim.min_soc_wh, cap),
        min_soc_utc: at(sim.min_soc_h),
        end_soc_wh: r3(sim.end_soc_wh),
        end_soc_pct: pct(sim.end_soc_wh, cap),
        energy_in_wh: r3(sim.energy_in_wh),
        energy_out_wh: r3(sim.energy_out_wh),
        energy_curtailed_wh: r3(sim.energy_curtailed_wh),
        energy_unserved_wh: r3(sim.energy_unserved_wh),
        longest_dark_h: sim.longest_dark_h,
        longest_dark_truncated: sim.longest_dark_truncated,
        longest_no_input_h: sim.longest_no_input_h,
        required_battery_wh: sim.required_battery_wh === null ? null : Math.ceil(sim.required_battery_wh * 1000) / 1000,
        required_battery_full_start_wh: Math.ceil(sim.required_battery_full_start_wh * 1000) / 1000,
        required_panel_peak_w: sim.required_panel_peak_w,
        required_battery_night_only_wh: pyRound(nightOnlyBatteryWh(sim.power.lit, dtH, p.night_load_w), 6),
        timeline: {
          t: dec.indices.map((i) => toIsoUtc(w.landingMs + i * run.step_s * MS_PER_S)),
          soc_wh: dec.indices.map((i) => r3(sim.soc_wh[i] ?? 0)),
          soc_pct: dec.indices.map((i) => pct(sim.soc_wh[i] ?? 0, cap)),
          decimated: dec.decimated,
          n_full: sim.soc_wh.length,
        },
        verdict: survivalVerdict({ sim, p, landingMs: w.landingMs }),
        assumptions: assumptions(p, run, rec),
      };
    },
  );
};

export default missionRoutes;
