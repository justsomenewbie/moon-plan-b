/**
 * Job type 'analyse' (docs/PYTHON_INTEGRATION.md). OWNER: builder B1 (compute).
 * `lunarnav analyse --json` with the same sites / range / options as precompute (same guard rails):
 * the CLI writes the ranking straight into the artifacts dir (ranking.json), which is zod-validated and
 * summarised in Job.output. Nothing is imported.
 */
import path from 'node:path';
import { AnalyseJobOutput, AnalyseRankingFile, type AnalyseJobRequest } from '../../contract/job_types/analyse.ts';
import { readJsonFile } from '../artifacts.ts';
import { flagArg, lunarnavCliArgs } from '../../python/scripts.ts';
import { defineJobType } from './define.ts';
import {
  COMMON_FLAGS,
  PRECOMPUTE_TIMEOUT_S,
  canonicalRangeJob,
  cliAvailability,
  computeFlags,
  samplesOf,
  type ComputeParams,
} from './precompute.ts';
import { PRECOMPUTE_LIMITS } from '../../contract/job_types/precompute.ts';

export type AnalyseParams = {
  type: 'analyse';
  site_ids: string[];
  start: string;
  end: string;
} & ComputeParams;

export const RANKING_ARTIFACT = 'ranking.json';

export const analyseJob = defineJobType<AnalyseJobRequest, AnalyseParams>({
  type: 'analyse',
  implemented: true,
  owner: 'builder B1 (compute)',
  summary: 'lunarnav analyse: rank sites over a period (Job.output.ranking + artifact ranking.json; no import)',
  label: 'lunarnav analyse',
  logName: 'analyse.log',
  pythonStage: 'python',
  limits: {
    timeout_s: PRECOMPUTE_TIMEOUT_S,
    result_ttl_h: 7 * 24,
    public: { ...PRECOMPUTE_LIMITS },
  },

  available: (caps) => cliAvailability(caps, 'analyse', [...COMMON_FLAGS, '--start', '--end', '--json']),

  async canonicalize(req, ctx) {
    const { n_samples: _n, ...rest } = await canonicalRangeJob(req, ctx);
    return { type: 'analyse', ...rest };
  },

  siteId: (p) => (p.site_ids.length === 1 ? (p.site_ids[0] ?? null) : null),

  planPython: (p, run) => ({
    args: lunarnavCliArgs('analyse', [
      flagArg('--sites', p.site_ids.join(',')),
      flagArg('--start', p.start),
      flagArg('--end', p.end),
      ...computeFlags(p),
      flagArg('--json', path.join(run.artifactsDir, RANKING_ARTIFACT)),
    ]),
  }),

  progress: (line, prev) => {
    // the CLI prints only DEM notes, then the ranking table at the end
    if (/^\s*rank\s+site\s/.test(line)) return { stage: 'python', pct: Math.max(prev.pct ?? 0, 90) };
    if (line.startsWith('note: site ')) return { stage: 'python', pct: Math.max(prev.pct ?? 0, 10) };
    return prev;
  },

  async onSuccess(p, run) {
    await run.setProgress('artifacts', 95);
    const file = await readJsonFile(path.join(run.artifactsDir, RANKING_ARTIFACT), AnalyseRankingFile);
    const got = new Set(file.ranking.map((r) => r.site_id));
    const missing = p.site_ids.filter((id) => !got.has(id));
    if (missing.length > 0) throw new Error(`${RANKING_ARTIFACT} lacks ${missing.length} requested site(s): ${missing.slice(0, 5).join(', ')}`);
    const output = AnalyseJobOutput.parse({
      n_sites: p.site_ids.length,
      start: p.start,
      end: p.end,
      step_min: p.step_min,
      n_samples: samplesOf(p),
      provider: p.provider,
      dem: p.dem,
      horizon_method: p.horizon_method,
      ranking: [...file.ranking].sort((a, b) => a.rank - b.rank),
    });
    return { output };
  },
});
