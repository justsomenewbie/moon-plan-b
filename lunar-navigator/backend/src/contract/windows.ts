/**
 * GET /api/v1/sites/{site_id}/windows (plan 6.2 #8): visibility windows clipped to [start, end).
 * The FE draws timeline bands from these (not from the raw series).
 */
import { z } from 'zod';
import { IsoUtc, IsoUtcInput, SiteId, WindowKind, WindowsByKind, csvList, provenance, runIdQuery } from './common.ts';
import { exampleWindows } from '../fixtures/index.ts';

export const WindowsQuery = z.strictObject({
  run_id: runIdQuery,
  start: IsoUtcInput.optional().describe('Inclusive start (default: run start)'),
  end: IsoUtcInput.optional().describe('EXCLUSIVE end (default: run end)'),
  kinds: csvList(WindowKind, {
    min: 1,
    max: 3,
    default: 'sun,earth,both',
    description: 'Comma separated window kinds: sun, earth, both',
  }),
});
export type WindowsQuery = z.output<typeof WindowsQuery>;

const WindowsResponseShape = z
  .object({
    ...provenance,
    site_id: SiteId,
    start: IsoUtc.describe('Snapped query start actually used'),
    end: IsoUtc.describe('Snapped EXCLUSIVE query end actually used'),
    ...WindowsByKind.shape,
  })
  .describe('Windows overlapping [start, end) (start < end_q AND end > start_q), clipped to it; boundaries +- precision_h');
export type WindowsResponse = z.output<typeof WindowsResponseShape>;
export const WindowsResponse = WindowsResponseShape.meta({ id: 'WindowsResponse', examples: [exampleWindows()] });
