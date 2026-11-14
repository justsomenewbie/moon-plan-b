/**
 * POST /api/v1/alt-dates (plan 6.2 #12): alternative landing dates ("slip calendar") for one site.
 * Maps 1:1 to lunarnav.analysis.DateConstraints / find_alternative_dates; the response is
 * AltDateResult.to_dict() + provenance + cache_id. Synchronous Python bridge (<= ALTDATES_TIMEOUT_S).
 */
import { z } from 'zod';
import { IsoUtc, IsoUtcInput, RunId, SiteId, provenance } from './common.ts';
import { exampleAltDatesRequest, exampleAltDatesResponse } from '../fixtures/index.ts';

export const ALT_DATE_OBJECTIVES = ['balanced', 'sun', 'earth', 'both', 'energy', 'earliest'] as const;
export const AltDateObjective = z
  .enum(ALT_DATE_OBJECTIVES)
  .describe("balanced = 0.5 sun_pct + 0.25 earth_pct + 0.25 both_pct; energy = 100 * mean tracking power; earliest = smallest slip. Ties -> earlier landing.");

export const ALT_DATES_LIMITS = { max_results_max: 50, max_results_default: 10 } as const;

const pct = z.number().min(0).max(100);
const hours = z.number().min(0);

export const DateConstraints = z
  .strictObject({
    min_sun_pct: pct.default(0).describe('Minimum % of the mission with Sun'),
    min_earth_pct: pct.default(0),
    min_both_pct: pct.default(0),
    require_sun_at_landing: z.boolean().default(true),
    require_earth_at_landing: z.boolean().default(false),
    min_continuous_sun_h: hours.default(0).describe('Uninterrupted Sun from landing (may extend past mission end)'),
    min_continuous_earth_h: hours.default(0),
    max_dark_gap_h: hours.nullable().default(null).describe('Longest Sun-less run allowed inside the mission; null = no limit'),
    max_comms_gap_h: hours.nullable().default(null),
    min_sun_el_at_landing_deg: z.number().min(-90).max(90).nullable().default(null),
    objective: AltDateObjective.default('balanced'),
    min_separation_h: hours.default(12).describe('Returned candidates are at least this far apart'),
  })
  .meta({ id: 'DateConstraints' });

const AltDatesRequestShape = z
  .strictObject({
    run_id: RunId.optional(),
    site_id: SiteId,
    earliest: IsoUtcInput.describe('Earliest landing instant (inclusive)'),
    latest: IsoUtcInput.describe('Latest landing instant (inclusive); latest + mission_h must be inside the run (else 422 OUT_OF_RANGE with max_latest)'),
    mission_h: z.number().positive().describe('Mission duration, h; must be a multiple of the run step (else 422 BAD_MISSION_LENGTH)'),
    max_results: z.int().min(1).max(ALT_DATES_LIMITS.max_results_max).default(ALT_DATES_LIMITS.max_results_default),
    constraints: DateConstraints.default(DateConstraints.parse({})),
  });
export type AltDatesRequest = z.output<typeof AltDatesRequestShape>;
export const AltDatesRequest = AltDatesRequestShape.meta({ id: 'AltDatesRequest', examples: [exampleAltDatesRequest()] });

export const LandingCandidate = z
  .object({
    rank: z.int().min(1),
    landing_utc: IsoUtc,
    mission_end_utc: IsoUtc,
    slip_h: z.number().describe('landing - earliest, h'),
    score: z.number(),
    sun_pct: z.number(),
    earth_pct: z.number(),
    both_pct: z.number(),
    longest_dark_h: z.number(),
    longest_comms_gap_h: z.number(),
    continuous_sun_h: z.number().describe('From landing; lower bound if continuous_sun_lower_bound'),
    continuous_sun_lower_bound: z.boolean(),
    continuous_earth_h: z.number(),
    continuous_earth_lower_bound: z.boolean(),
    sun_at_landing: z.boolean(),
    earth_at_landing: z.boolean(),
    sun_el_at_landing_deg: z.number(),
    earth_el_at_landing_deg: z.number(),
    mean_power_horizontal: z.number(),
    mean_power_tracking: z.number(),
  })
  .meta({ id: 'LandingCandidate' });

const AltDatesResponseShape = z
  .object({
    ...provenance,
    cache_id: z.string().describe('sha256 of (endpoint, params, params_fingerprint) - identical requests are served from cache'),
    site_id: SiteId,
    earliest_utc: IsoUtc,
    latest_utc: IsoUtc,
    mission_duration_h: z.number(),
    constraints: DateConstraints,
    n_evaluated: z.int().min(0).describe('Landing instants examined'),
    n_feasible: z.int().min(0).describe('Instants satisfying all constraints'),
    rejected_by: z.record(z.string(), z.int().min(0)).describe('constraint -> number of instants failing it (one instant can fail several)'),
    candidates: z.array(LandingCandidate).describe('Empty = no feasible date (still 200; see rejected_by)'),
  });
export type AltDatesResponse = z.output<typeof AltDatesResponseShape>;
export const AltDatesResponse = AltDatesResponseShape.meta({ id: 'AltDatesResponse', examples: [exampleAltDatesResponse()] });
