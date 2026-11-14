/**
 * GET /api/v1/capabilities service (docs/PYTHON_INTEGRATION.md section 5): one cached document
 * describing what this server can run.
 *   - Python: backend/python/capabilities_probe.py (lunarnav version, importable modules, CLI sub-commands
 *     and the long options of their --help output -> cli.near_exclusion_m), through runPython().
 *   - Files (no Python): SPICE kernels and Moon Trek GeoTIFFs in LUNARNAV_DATA, PGDA tile cache.
 *   - Network (optional, CAPABILITIES_NETWORK_PROBE; default off under NODE_ENV=test): one HEAD request to
 *     JPL Horizons and to PGDA (any HTTP answer = reachable). No user data is sent. PGDA unreachable ->
 *     dems.pgda unavailable even with cached tiles (lunarnav always opens the product over /vsicurl/).
 *   - job_types: registry defs (implemented + def.available(caps)); tools: src/contract/tools.ts.
 * Cached CAPABILITIES_TTL_S (600 s); concurrent callers share one probe; `force` re-probes.
 */
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Config } from '../config.ts';
import type { Availability, Capabilities } from '../contract/capabilities.ts';
import { TOOL_NAMES, TOOLS_IMPLEMENTED } from '../contract/tools.ts';
import { toIsoUtc } from '../lib/time.ts';
import { listJobTypes } from '../jobs/types/index.ts';
import { lunarnavCodeVersion, lunarnavDataDir } from './lunarnav.ts';
import { runPython } from './process.ts';
import { bridgeScriptArgs, lunarnavEnv } from './scripts.ts';

export type CapabilitiesConfig = Pick<Config, 'PYTHON_BIN' | 'LUNARNAV_ROOT' | 'JOB_TIMEOUT_S' | 'CUSTOM_RUN_TTL_DAYS'> &
  Partial<Pick<Config, 'NODE_ENV' | 'CAPABILITIES_NETWORK_PROBE' | 'CAPABILITIES_TTL_S' | 'PRECOMPUTE_RUN_TTL_DAYS'>>;

export const PROBE_SCRIPT = 'capabilities_probe.py';
export const PROBE_TIMEOUT_MS = 30_000;
export const NETWORK_TIMEOUT_MS = 4000;
export const FORCE_MIN_INTERVAL_MS = 30_000;
export const HORIZONS_PROBE_URL = 'https://ssd.jpl.nasa.gov/api/horizons.api';
export const PGDA_PROBE_URL = 'https://pgda.gsfc.nasa.gov/products/90';
/** SPICE kernel set of lunarnav.ephem.kernels (lunar_set "de440", de440s), flat in LUNARNAV_DATA/kernels. */
export const SPICE_KERNELS = ['naif0012.tls', 'pck00011.tpc', 'de440s.bsp', 'moon_pa_de440_200625.bpc', 'moon_de440_250416.tf'] as const;
const TREK_FILE_RE = /^(LRO_LOLA_DEM_[A-Za-z0-9_]+)\.tif$/i;

export const ProbeOut = z.object({
  python_version: z.string(),
  lunarnav_version: z.string().nullable(),
  subcommands: z.array(z.string()),
  flags: z.record(z.string(), z.array(z.string())),
  modules: z.record(z.string(), z.boolean()),
  errors: z.array(z.string()),
});
export type ProbeOut = z.output<typeof ProbeOut>;

const ok = (): Availability => ({ available: true, reason: null });
const no = (reason: string): Availability => ({ available: false, reason });

type Reach = Capabilities['network']['horizons'];

async function reach(url: string, enabled: boolean): Promise<Reach> {
  if (!enabled) return { reachable: null, latency_ms: null, error: null };
  const t0 = performance.now();
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });
    await res.body?.cancel();
    return { reachable: true, latency_ms: Math.round(performance.now() - t0), error: null };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    return { reachable: false, latency_ms: null, error: (err.cause?.code ?? err.name ?? 'error').slice(0, 80) };
  }
}

async function runProbe(cfg: CapabilitiesConfig): Promise<{ probe: ProbeOut | null; error: string | null }> {
  const r = await runPython({
    bin: cfg.PYTHON_BIN,
    args: bridgeScriptArgs(PROBE_SCRIPT),
    cwd: cfg.LUNARNAV_ROOT,
    env: lunarnavEnv(cfg, { bridge: true }),
    captureStdout: true,
    maxStdoutBytes: 256 * 1024,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (r.spawnError) return { probe: null, error: `could not start Python: ${r.spawnError}` };
  if (r.timedOut) return { probe: null, error: 'capabilities probe timed out' };
  try {
    const parsed = ProbeOut.safeParse(JSON.parse(r.stdout.trim().split('\n').at(-1) ?? ''));
    if (parsed.success) return { probe: parsed.data, error: null };
  } catch {
    // fall through
  }
  return { probe: null, error: r.stderrTail.at(-1) ?? `capabilities probe exited with code ${String(r.exitCode)}` };
}

async function trekFiles(demDir: string): Promise<{ label: string; bytes: number }[]> {
  let names: string[];
  try {
    names = await readdir(demDir);
  } catch {
    return [];
  }
  const out: { label: string; bytes: number }[] = [];
  for (const n of names.sort()) {
    const m = TREK_FILE_RE.exec(n);
    if (!m?.[1]) continue;
    const st = await stat(path.join(demDir, n)).catch(() => null);
    if (st?.isFile() && st.size > 0) out.push({ label: m[1], bytes: st.size });
  }
  return out;
}

async function countDirs(dir: string): Promise<number> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).length;
  } catch {
    return 0;
  }
}

/** Probe everything now (no cache). */
export async function probeCapabilities(cfg: CapabilitiesConfig): Promise<Capabilities> {
  const network = cfg.CAPABILITIES_NETWORK_PROBE ?? cfg.NODE_ENV !== 'test';
  const dataDir = lunarnavDataDir(cfg);
  const [{ probe, error }, horizons, pgdaNet, trek, pgdaCached, codeVersion] = await Promise.all([
    runProbe(cfg),
    reach(HORIZONS_PROBE_URL, network),
    reach(PGDA_PROBE_URL, network),
    trekFiles(path.join(dataDir, 'dem')),
    countDirs(path.join(dataDir, 'cache', 'pgda')),
    lunarnavCodeVersion(cfg),
  ]);
  const mod = (m: string): boolean => probe?.modules[m] === true;
  const missingKernels = SPICE_KERNELS.filter((k) => !existsSync(path.join(dataDir, 'kernels', k)));
  const pyOk = probe !== null && probe.lunarnav_version !== null;
  const noPy = probe === null ? (error ?? 'Python probe failed') : probe.lunarnav_version === null ? (probe.errors[0] ?? 'lunarnav not importable') : null;

  const spice: Availability = noPy
    ? no(noPy)
    : !mod('spiceypy')
      ? no('spiceypy is not installed')
      : missingKernels.length > 0 && horizons.reachable === false
        ? no(`SPICE kernels missing (${missingKernels.join(', ')}) and NAIF not reachable`)
        : ok();
  const horizonsAv: Availability = noPy ? no(noPy) : horizons.reachable === false ? no(`JPL Horizons not reachable (${horizons.error ?? 'network'})`) : ok();
  const pgda: Availability = noPy
    ? no(noPy)
    : !mod('rasterio')
      ? no('rasterio is not installed')
      : pgdaNet.reachable === false
        ? // lunarnav.terrain.pgda.PgdaDem opens the COG over /vsicurl/ before it looks at its block cache, so
          // without the network no product opens, however many of its tiles are cached
          no(`PGDA not reachable (${pgdaNet.error ?? 'network'}); lunarnav opens every PGDA product over the network, even when its tiles are cached`)
        : ok();
  const trekAv: Availability = noPy
    ? no(noPy)
    : !mod('rasterio')
      ? no('rasterio is not installed')
      : trek.length === 0
        ? no('no Moon Trek GeoTIFF in LUNARNAV_DATA/dem (the API never downloads them: 1-2 GB each)')
        : ok();

  const flags = probe?.flags ?? {};
  const base: Omit<Capabilities, 'job_types' | 'tools'> = {
    checked_at: toIsoUtc(Date.now()),
    python: { ok: pyOk, python_version: probe?.python_version ?? null, lunarnav_code_version: probe?.lunarnav_version ?? (pyOk ? codeVersion : null), error: noPy },
    cli: {
      subcommands: probe?.subcommands ?? [],
      near_exclusion_m: (flags['precompute'] ?? []).includes('--near-exclusion-m'),
      flags,
    },
    modules: probe?.modules ?? {},
    providers: { spice, horizons: horizonsAv, analytic: noPy ? no(noPy) : ok() },
    dems: {
      pgda: { ...pgda, cached_products: pgdaCached },
      trek: { ...trekAv, files: trek },
      none: ok(),
    },
    horizon_methods: ['raymarch', 'bruteforce', 'flat'],
    network: { horizons, pgda: pgdaNet },
  };
  const tools: Capabilities['tools'] = {};
  for (const t of TOOL_NAMES) tools[t] = TOOLS_IMPLEMENTED[t] ? (noPy ? no(noPy) : ok()) : no('not implemented yet');
  const partial: Capabilities = { ...base, job_types: [], tools };
  partial.job_types = listJobTypes().map((def) => {
    let reason: string | null = def.implemented ? null : 'not implemented yet';
    if (reason === null && noPy) reason = noPy;
    if (reason === null && def.available) {
      try {
        reason = def.available(partial);
      } catch (e) {
        reason = `availability check failed: ${(e as Error).message}`;
      }
    }
    return {
      type: def.type,
      implemented: def.implemented,
      available: reason === null,
      reason,
      timeout_s: def.limits.timeout_s ?? cfg.JOB_TIMEOUT_S,
      result_ttl_h: def.resultTtlH?.(cfg) ?? def.limits.result_ttl_h ?? cfg.CUSTOM_RUN_TTL_DAYS * 24,
      limits: { ...(def.limits.public ?? {}) },
    };
  });
  return partial;
}

interface CacheEntry {
  key: string;
  at: number;
  value: Capabilities;
}
let cache: CacheEntry | null = null;
const inflight = new Map<string, Promise<Capabilities>>();

const keyOf = (cfg: CapabilitiesConfig): string => `${cfg.PYTHON_BIN}|${cfg.LUNARNAV_ROOT}|${lunarnavDataDir(cfg)}`;

/** Cached capabilities (CAPABILITIES_TTL_S); `force` re-probes. Concurrent callers share one probe. Never throws. */
export async function getCapabilities(cfg: CapabilitiesConfig, opts: { force?: boolean } = {}): Promise<Capabilities> {
  const key = keyOf(cfg);
  const ttlMs = (cfg.CAPABILITIES_TTL_S ?? 600) * 1000;
  const age = cache && cache.key === key ? Date.now() - cache.at : Infinity;
  // a forced probe (GET ?refresh=true) re-runs at most every FORCE_MIN_INTERVAL_MS (it spawns Python)
  if (cache && age < (opts.force ? Math.min(ttlMs, FORCE_MIN_INTERVAL_MS) : ttlMs)) return cache.value;
  const running = inflight.get(key);
  if (running) return running;
  const p = probeCapabilities(cfg)
    .then((value) => {
      cache = { key, at: Date.now(), value };
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Test seam: drop the cached document. */
export function resetCapabilitiesCache(): void {
  cache = null;
}
