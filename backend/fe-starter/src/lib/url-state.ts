/**
 * Shareable URL state (suggestion). Everything the user picked lives in the query string, so a copied
 * link reproduces the same view:
 *
 *   /explore?site=ref_connecting_ridge_c1&run=pf_21c3f3f6dc56b1e1&start=2026-03-01T00:00:00Z
 *           &end=2026-04-01T00:00:00Z&t=2026-03-14T05:00:00Z&kinds=sun,earth&cmp=a3_haworth,apollo11
 *
 * - Keys are short, values use the API's own formats (ISO UTC with Z, comma lists) -> pass them through.
 * - Omit `run` to follow the server default run; a job result is shareable as run=job_<job_id>
 *   (custom runs expire after CUSTOM_RUN_TTL_DAYS, see expires_at -> show a notice when RUN_NOT_FOUND).
 * - Usage in a Client Component:  const view = parseView(useSearchParams());
 *                                 router.replace(`?${serializeView({ ...view, t })}`, { scroll: false });
 */

export type WindowKind = 'sun' | 'earth' | 'both';

export interface ViewState {
  site?: string;
  run?: string;
  start?: string;
  end?: string;
  /** Timeline slider instant (GET /sites/{id}/instant?t=...) */
  t?: string;
  kinds?: WindowKind[];
  /** Extra sites to compare with `site` (POST /compare, 2-4 sites in total) */
  cmp?: string[];
}

const SITE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const RUN_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const KINDS: readonly WindowKind[] = ['sun', 'earth', 'both'];

interface ParamsLike {
  get(name: string): string | null;
}

const pick = (p: ParamsLike, k: string, re: RegExp): string | undefined => {
  const v = p.get(k);
  return v !== null && re.test(v) ? v : undefined;
};

/** Never throws: invalid values are dropped (a hand-edited link still opens). */
export function parseView(p: ParamsLike): ViewState {
  const v: ViewState = {};
  const site = pick(p, 'site', SITE_RE);
  const run = pick(p, 'run', RUN_RE);
  const start = pick(p, 'start', ISO_RE);
  const end = pick(p, 'end', ISO_RE);
  const t = pick(p, 't', ISO_RE);
  if (site) v.site = site;
  if (run) v.run = run;
  if (start) v.start = start;
  if (end && (!start || end > start)) v.end = end;
  if (t) v.t = t;
  const kinds = (p.get('kinds') ?? '').split(',').filter((k): k is WindowKind => (KINDS as readonly string[]).includes(k));
  if (kinds.length > 0) v.kinds = [...new Set(kinds)];
  const cmp = (p.get('cmp') ?? '').split(',').filter((s) => SITE_RE.test(s) && s !== site);
  if (cmp.length > 0) v.cmp = [...new Set(cmp)].slice(0, 3);
  return v;
}

/** Stable key order -> identical views give identical URLs. ':' in values is kept readable. */
export function serializeView(v: ViewState): string {
  const parts: string[] = [];
  const add = (k: string, val: string | undefined) => {
    if (val) parts.push(`${k}=${encodeURIComponent(val).replace(/%3A/gi, ':').replace(/%2C/gi, ',')}`);
  };
  add('site', v.site);
  add('run', v.run);
  add('start', v.start);
  add('end', v.end);
  add('t', v.t);
  add('kinds', v.kinds?.join(','));
  add('cmp', v.cmp?.join(','));
  return parts.join('&');
}
