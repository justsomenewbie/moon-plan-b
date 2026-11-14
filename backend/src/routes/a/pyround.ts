/**
 * Python-compatible `round(x, nd)` for floats.
 *
 * Python rounds the EXACT binary value of the double to `nd` decimals, ties to even. JS
 * `Math.round(x * 10**nd) / 10**nd` differs (the multiplication itself rounds, ties go up), so
 * scores/metrics recomputed in Node would occasionally differ from lunarnav in the 6th decimal.
 * `Number.prototype.toFixed` works on the exact value too (ties -> larger magnitude), so we only
 * have to detect exact ties and send them to the even neighbour.
 */
export function pyRound(x: number, nd = 6): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const neg = x < 0;
  const ax = Math.abs(x);
  if (ax >= 1e21) return x; // toFixed switches to exponent form; such values are integers anyway
  let out = ax.toFixed(nd);
  const exact = ax.toFixed(100);
  const dot = exact.indexOf('.');
  const tail = exact.slice(dot + 1 + nd);
  if (/^50*$/.test(tail)) {
    // exact tie: keep the truncated value when its last digit is even
    const truncated = nd === 0 ? exact.slice(0, dot) : exact.slice(0, dot + 1 + nd);
    const last = Number(truncated.at(-1));
    if (last % 2 === 0) out = truncated;
  }
  const r = Number(out);
  return neg ? -r : r;
}

/** Python `<` / `>` on str (code-point order), NOT locale order. */
export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
