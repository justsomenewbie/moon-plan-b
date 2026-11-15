/**
 * Route-specific hint for 400 TOO_MANY_POINTS: each endpoint has its own caps, so the hint names the
 * limits of the route that was called (not the /series ones everywhere).
 */
import { DATASET_LIMITS } from '../contract/dataset.ts';
import { SURVIVAL_LIMITS } from '../contract/mission.ts';
import { SERIES_FIELDS, SERIES_LIMITS, SKY_LIMITS } from '../contract/series.ts';

const META = 'see GET /api/v1/meta';

/** Hint for the route of `instance` (request URL, query string allowed). */
export function tooManyPointsHint(instance: string): string {
  const path = (instance.split('?')[0] ?? '').replace(/\/+$/, '');
  if (/\/dataset$/.test(path)) return `Use max_points <= ${DATASET_LIMITS.max_points_max} per site, or fewer site_ids / a shorter range`;
  if (/\/sites\/[^/]+\/export\/series\.csv$/.test(path))
    return `Use at most ${SERIES_FIELDS.length} fields, the series field names (${META} series_fields)`;
  if (/\/sites\/[^/]+\/sky$/.test(path)) return `Use max_points <= ${SKY_LIMITS.max_points_max}`;
  if (/\/mission\/survival$/.test(path)) return `Use max_points <= ${SURVIVAL_LIMITS.max_points_max}`;
  if (/\/compare$/.test(path))
    return `Use include.series.max_points <= ${SERIES_LIMITS.max_points_max} and at most ${SERIES_LIMITS.max_fields} include.series.fields (${META} limits)`;
  return `Use max_points <= ${SERIES_LIMITS.max_points_max} and at most ${SERIES_LIMITS.max_fields} fields (${META} limits)`;
}
