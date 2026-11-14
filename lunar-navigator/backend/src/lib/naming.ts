/**
 * Field naming policy of the public API - the ONE place that decides it.
 *
 * Policy (v1): JSON keys and query parameters are snake_case and IDENTICAL to docs/OUTPUT_SPEC.md
 * (`sun_el_deg`, `pct_sun`, `longest_dark_h`, ...). Contract schemas (src/contract/*) are written
 * with these names and data read from MongoDB / Python keeps them, so no conversion happens today.
 *
 * If the FE ever needs camelCase, do it HERE ONLY:
 *   1. set `FIELD_CASE = 'camelCase'`;
 *   2. app.ts already routes every JSON body through `toWire()` (preSerialization hook) and every
 *      JSON request body / query through `fromWire()` (preValidation hook) - see `namingHooksEnabled`;
 *   3. map the zod schemas for OpenAPI with `wireKey` (not implemented: the contract would have to
 *      be regenerated with converted keys - out of scope for v1).
 * Until then both functions are the identity and cost nothing.
 */

export type FieldCase = 'snake_case' | 'camelCase';

export const FIELD_CASE = 'snake_case' as FieldCase;

/** True when a conversion is needed at the HTTP boundary (false for v1). */
export const namingHooksEnabled = (): boolean => FIELD_CASE !== 'snake_case';

export const snakeToCamel = (k: string): string => k.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
export const camelToSnake = (k: string): string => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Internal (snake_case) key -> wire key. */
export const wireKey = (k: string): string => (FIELD_CASE === 'camelCase' ? snakeToCamel(k) : k);
/** Wire key -> internal (snake_case) key. */
export const internalKey = (k: string): string => (FIELD_CASE === 'camelCase' ? camelToSnake(k) : k);

/**
 * Keys whose CHILD keys are data, not field names (site ids, file paths, series field names are
 * already in their final form) - never converted.
 */
const OPAQUE_PARENTS = new Set(['sites', 'files', 'rejected_by', 'extra', 'manifest']);

function mapKeysDeep(value: unknown, fn: (k: string) => string, opaque = false): unknown {
  if (Array.isArray(value)) return value.map((v) => mapKeysDeep(v, fn, false));
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const key = opaque ? k : fn(k);
    out[key] = mapKeysDeep(v, fn, OPAQUE_PARENTS.has(k));
  }
  return out;
}

/** Internal object -> wire object (identity under snake_case). */
export function toWire<T>(value: T): T {
  return FIELD_CASE === 'snake_case' ? value : (mapKeysDeep(value, wireKey) as T);
}

/** Wire object -> internal object (identity under snake_case). */
export function fromWire<T>(value: T): T {
  return FIELD_CASE === 'snake_case' ? value : (mapKeysDeep(value, internalKey) as T);
}
