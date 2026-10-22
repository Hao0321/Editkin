// Exact rational time arithmetic for frame / sample / tick positions.
// Everything is BigInt internally; results crossing back to Number are safe-integer checked.

const big = v => (typeof v === 'bigint' ? v : BigInt(v));
const absBig = v => (v < 0n ? -v : v);
function gcd(a, b) { a = absBig(a); b = absBig(b); while (b) [a, b] = [b, a % b]; return a || 1n; }

export function rat(num, den = 1n) {
  num = big(num); den = big(den);
  if (den === 0n) throw new RangeError('zero denominator');
  if (den < 0n) { num = -num; den = -den; }
  const g = gcd(num, den);
  return {num: num / g, den: den / g};
}

/**
 * Parses a time or rate: integer, "30000/1001", "35999", "43199.5", "9:59:59", "10:00:00.25",
 * or {num, den}. Decimal strings are exact (no binary floating point involved).
 */
export function parseRational(x) {
  if (x && typeof x === 'object' && 'num' in x) return rat(x.num, x.den);
  if (typeof x === 'bigint') return rat(x);
  if (typeof x === 'number') {
    if (Number.isInteger(x)) return rat(x);
    return parseRational(String(x));
  }
  const s = String(x).trim();
  if (/^-?\d+\/\d+$/.test(s)) { const [n, d] = s.split('/'); return rat(n, d); }
  if (/^\d+(:\d{1,2}){1,2}(\.\d+)?$/.test(s)) {
    const parts = s.split(':');
    let total = rat(0);
    for (const p of parts) total = add(mul(total, rat(60)), parseRational(p));
    return total;
  }
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new RangeError(`cannot parse rational: ${JSON.stringify(x)}`);
  const frac = m[3] || '';
  const r = rat(BigInt(m[2] + frac), 10n ** BigInt(frac.length));
  return m[1] ? rat(-r.num, r.den) : r;
}

export const add = (a, b) => rat(a.num * b.den + b.num * a.den, a.den * b.den);
export const sub = (a, b) => rat(a.num * b.den - b.num * a.den, a.den * b.den);
export const mul = (a, b) => rat(a.num * b.num, a.den * b.den);
export const div = (a, b) => rat(a.num * b.den, a.den * b.num);
export const cmp = (a, b) => { const d = a.num * b.den - b.num * a.den; return d < 0n ? -1 : d > 0n ? 1 : 0; };
export const floorBig = r => (r.num >= 0n ? r.num / r.den : -((-r.num + r.den - 1n) / r.den));
export const ceilBig = r => -floorBig(rat(-r.num, r.den));
export const roundHalfUpBig = r => floorBig(add(r, rat(1n, 2n)));

export function toSafeNumber(b, what = 'value') {
  const n = Number(b);
  if (!Number.isSafeInteger(n) || BigInt(n) !== b) throw new RangeError(`${what} ${b} is not a safe integer`);
  return n;
}

export const toNumber = r => Number(r.num) / Number(r.den);
export const ratString = r => (r.den === 1n ? `${r.num}` : `${r.num}/${r.den}`);

/** Decimal string with `digits` fraction digits, rounded toward -inf (exact, no float). */
export function toDecimalString(r, digits = 6) {
  const scale = 10n ** BigInt(digits);
  const scaled = floorBig(mul(r, rat(scale)));
  const neg = scaled < 0n;
  const a = neg ? -scaled : scaled;
  const ip = a / scale;
  const fp = (a % scale).toString().padStart(digits, '0');
  return `${neg ? '-' : ''}${ip}${digits ? '.' + fp : ''}`;
}

/** Presentation time of frame k at rate fps (rational seconds). */
export const framePts = (k, fps) => rat(big(k) * fps.den, fps.num);
/** Index of the frame displayed at time t (floor(t * fps)). */
export const frameAt = (t, fps) => toSafeNumber(floorBig(mul(t, fps)), 'frame index');
/** First frame whose pts >= t. */
export const firstFrameAtOrAfter = (t, fps) => toSafeNumber(ceilBig(mul(t, fps)), 'frame index');
/** Sample index at time t (floor). */
export const sampleAt = (t, rate) => toSafeNumber(floorBig(mul(t, rat(rate))), 'sample index');
/** Converts a rational time to integer ticks of a time base {num, den} (seconds per tick). Exact or throws. */
export function exactTicks(t, tb) {
  const q = div(t, tb);
  if (q.den !== 1n) return null;
  return toSafeNumber(q.num, 'ticks');
}

/** Formats seconds as H:MM:SS.mmm (hours unbounded). */
export function hms(t) {
  const ms = floorBig(mul(t, rat(1000)));
  const h = ms / 3600000n, m = (ms / 60000n) % 60n, s = (ms / 1000n) % 60n, f = ms % 1000n;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(f).padStart(3, '0')}`;
}
