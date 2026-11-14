/**
 * Canonical custom site ids, bit-for-bit identical to lunarnav.sites.custom_site_id / parse_custom_id
 * (parity-tested against Python in tests/jobs/customSiteId.test.ts):
 *   custom:<lat>:<lon>  lat in [-90, 90], east lon in [0, 360), exactly CUSTOM_ID_DECIMALS decimals.
 *
 * Python's round(x, 4) rounds the EXACT binary value of x correctly, ties to even. JS toFixed() also
 * rounds the exact value correctly but resolves exact ties away from zero, so exact ties (x * 1e4 ends
 * in .5 exactly, e.g. 0.03125) are detected with BigInt arithmetic and re-rounded to even.
 */
export const CUSTOM_ID_DECIMALS = 4;
const SCALE = 10 ** CUSTOM_ID_DECIMALS;
export const CUSTOM_ID_RE = /^custom:(-?\d{1,2}\.\d{4}):(\d{1,3}\.\d{4})$/;
const LON_INPUT_MIN = -360;
const LON_INPUT_MAX = 360;

/** x = mant * 2^exp exactly (finite x). */
function decompose(x: number): { mant: bigint; exp: bigint } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(x));
  const bits = view.getBigUint64(0);
  const e = Number((bits >> 52n) & 0x7ffn);
  const frac = bits & ((1n << 52n) - 1n);
  return e === 0 ? { mant: frac, exp: -1074n } : { mant: frac | (1n << 52n), exp: BigInt(e - 1075) };
}

/** true when |x| * 10^d is exactly k + 1/2 for an integer k (an exact rounding tie). */
function isExactHalfTie(x: number, d: number): boolean {
  if (x === 0) return false;
  const { mant, exp } = decompose(x);
  const twice = mant * 2n * 10n ** BigInt(d); // 2 * |x| * 10^d = twice * 2^exp
  if (exp >= 0n) return false; // integer * even -> even, never odd
  const div = 1n << -exp;
  if (twice % div !== 0n) return false;
  return (twice / div) % 2n === 1n;
}

/** Python `round(x, d)` for finite floats (correct rounding, ties to even). */
export function pyRound(x: number, d: number): number {
  let s = x.toFixed(d);
  if (isExactHalfTie(x, d)) {
    const neg = s.startsWith('-');
    const digits = BigInt(s.replace('-', '').replace('.', ''));
    if (digits % 2n === 1n) {
      const down = (digits - 1n).toString().padStart(d + 1, '0');
      s = `${neg ? '-' : ''}${down.slice(0, down.length - d)}.${down.slice(down.length - d)}`;
    }
  }
  return Number(s) + 0; // + 0 turns -0 into 0, like Python
}

/** lunarnav.sites.normalize_lon: any finite east/west longitude -> [0, 360). */
export function normalizeLon(lon: number): number {
  if (!Number.isFinite(lon)) throw new RangeError(`longitude must be finite, got ${lon}`);
  let out = lon % 360; // same as C fmod
  if (out < 0) out += 360;
  if (out >= 360) out = 0;
  return out + 0;
}

function checkLat(lat: number): number {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new RangeError(`latitude must be in [-90, 90], got ${lat}`);
  return lat + 0;
}

function checkLonInput(lon: number): number {
  if (!Number.isFinite(lon) || lon < LON_INPUT_MIN || lon > LON_INPUT_MAX) {
    throw new RangeError(`longitude must be in [${LON_INPUT_MIN}, ${LON_INPUT_MAX}], got ${lon}`);
  }
  return lon;
}

/** lunarnav.sites._round_custom */
export function roundCustom(lat: number, lon: number): { lat: number; lon: number } {
  const latR = pyRound(checkLat(lat), CUSTOM_ID_DECIMALS) + 0;
  let lonR = normalizeLon(pyRound(normalizeLon(checkLonInput(lon)), CUSTOM_ID_DECIMALS));
  lonR = pyRound(lonR, CUSTOM_ID_DECIMALS) + 0;
  return { lat: latR, lon: lonR };
}

/** lunarnav.sites.custom_site_id. Throws RangeError on invalid input. */
export function customSiteId(lat: number, lon: number): string {
  const r = roundCustom(lat, lon);
  return `custom:${r.lat.toFixed(CUSTOM_ID_DECIMALS)}:${r.lon.toFixed(CUSTOM_ID_DECIMALS)}`;
}

/** lunarnav.sites.parse_custom_id: only canonical ids are accepted. Throws RangeError otherwise. */
export function parseCustomSiteId(siteId: string): { lat: number; lon: number } {
  const m = CUSTOM_ID_RE.exec(siteId);
  if (!m || m[1] === undefined || m[2] === undefined) {
    throw new RangeError(`not a canonical custom site id: ${siteId}; expected custom:<lat>:<lon> with ${CUSTOM_ID_DECIMALS} decimals, e.g. custom:-89.4500:222.6900`);
  }
  const lat = checkLat(Number(m[1]));
  const lon = Number(m[2]);
  if (!(lon >= 0 && lon < 360)) throw new RangeError(`custom site id longitude must be in [0, 360): ${siteId}`);
  const canonical = customSiteId(lat, lon);
  if (canonical !== siteId) throw new RangeError(`non-canonical custom site id ${siteId}; canonical form is ${canonical}`);
  return { lat, lon };
}

export const isCustomSiteId = (siteId: string): boolean => siteId.startsWith('custom:');
// keep SCALE referenced for readers: ids have 1 / SCALE deg resolution (~3 m at the equator)
export const CUSTOM_ID_RESOLUTION_DEG = 1 / SCALE;
