/**
 * Site metadata that is not in the precompute output: `extra` from lunarnav/catalog/sites.json and the
 * south polar stereographic map position (same formula as scripts/make-fixtures.py).
 */
import { readFile } from 'node:fs/promises';
import type { MapPointValue } from '../repos/types.ts';

export const R_MOON_KM = 1737.4;
export const MAP_PROJECTION = 'south_polar_stereographic_R1737.4km' as const;

/** LOLA south polar stereographic (sphere R = 1737.4 km); null north of 60 S. x/y rounded to 1 m. */
export function southPolarXY(latDeg: number, lonDeg: number): MapPointValue | null {
  if (latDeg > -60) return null;
  const rho = 2 * R_MOON_KM * Math.tan(((45 + latDeg / 2) * Math.PI) / 180);
  const lam = (lonDeg * Math.PI) / 180;
  const r3 = (v: number): number => Math.round(v * 1000) / 1000;
  return { projection: MAP_PROJECTION, x_km: r3(rho * Math.sin(lam)), y_km: r3(rho * Math.cos(lam)) };
}

/** site id -> catalog `extra` object. Missing/unreadable catalog -> empty map + the reason. */
export async function loadCatalogExtras(catalogPath: string): Promise<{ extras: Map<string, Record<string, unknown>>; warning: string | null }> {
  const extras = new Map<string, Record<string, unknown>>();
  let data: unknown;
  try {
    data = JSON.parse(await readFile(catalogPath, 'utf8'));
  } catch (e) {
    return { extras, warning: `catalog not read (${catalogPath}): ${e instanceof Error ? e.message : String(e)}` };
  }
  const sites = typeof data === 'object' && data !== null ? (data as { sites?: unknown }).sites : undefined;
  if (!Array.isArray(sites)) return { extras, warning: `catalog ${catalogPath} has no "sites" array` };
  for (const s of sites as unknown[]) {
    if (typeof s !== 'object' || s === null) continue;
    const rec = s as { id?: unknown; extra?: unknown };
    if (typeof rec.id === 'string' && typeof rec.extra === 'object' && rec.extra !== null && !Array.isArray(rec.extra)) {
      extras.set(rec.id, rec.extra as Record<string, unknown>);
    }
  }
  return { extras, warning: null };
}
