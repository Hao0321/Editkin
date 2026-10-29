// Audio identity track: every second k of absolute time carries, on every channel,
//   [0, R/100)          a Hann-windowed linear chirp 1 kHz -> 5 kHz (the sample-position marker),
//   [R/50, R/50+31*R/50) 31 FSK symbols of R/50 samples (1000 Hz = 0, 1500 Hz = 1):
//                        bits 0..19 = k, bits 20..22 = channel position c, bits 23..30 = (8k + c) mod 251,
//   then silence to the end of the second.
// The marker of second k starts exactly at absolute sample k*R. LFE channels carry a 200 ms 50 Hz
// burst at the same instant instead (AAC limits LFE bandwidth, so the chirp/FSK would not survive).
// The FFmpeg expression and the JS reference below implement the same formulas.

export const AUDIO_IDENTITY = Object.freeze({
  version: 1, secondBits: 20, channelBits: 3, checkBits: 8, checkModulus: 251, symbols: 31,
  chirpHz: [1000, 5000], fskHz: [1000, 1500], lfeHz: 50,
  chirpAmp: 0.5, fskAmp: 0.25, lfeAmp: 0.5,
});

export function audioTiming(R) {
  if (!Number.isInteger(R) || R % 100 !== 0) throw new RangeError(`sample rate ${R} must be a multiple of 100`);
  const M = R / 100, S0 = R / 50, Ls = R / 50;
  return {R, markerLen: M, symStart: S0, symLen: Ls, symEnd: S0 + AUDIO_IDENTITY.symbols * Ls, lfeLen: R / 5};
}

/** FFmpeg channel-layout positions that are LFE (no chirp/FSK, 50 Hz burst instead). */
export function lfePositions(layout) {
  const L = String(layout || '');
  if (/^(2\.1|3\.1|4\.1|5\.1|6\.1|7\.1)/.test(L)) return [L.startsWith('2.1') ? 2 : 3];
  return [];
}

export function audioWord(k, c) {
  if (!Number.isSafeInteger(k) || k < 0 || k >= 2 ** AUDIO_IDENTITY.secondBits) throw new RangeError(`second ${k} outside 20-bit range`);
  if (!Number.isInteger(c) || c < 0 || c >= 8) throw new RangeError(`channel ${c} outside 3-bit range`);
  const check = (k * 8 + c) % AUDIO_IDENTITY.checkModulus;
  const bits = [];
  for (let j = 0; j < 20; j++) bits.push(Math.floor(k / 2 ** j) % 2);
  for (let j = 0; j < 3; j++) bits.push(Math.floor(c / 2 ** j) % 2);
  for (let j = 0; j < 8; j++) bits.push(Math.floor(check / 2 ** j) % 2);
  return {k, c, check, bits};
}

/** aevalsrc expression for one channel. A0 = absolute sample index of local sample 0. */
export function channelExpression({R, c, A0 = 0, lfe = false}) {
  const T = audioTiming(R);
  const [fa, fb] = AUDIO_IDENTITY.chirpHz, [f0, f1] = AUDIO_IDENTITY.fskHz;
  const head = `st(0,n+${A0});st(1,floor(ld(0)/${R}));st(2,ld(0)-ld(1)*${R});`;
  if (lfe) {
    return head + `if(lt(ld(2),${T.lfeLen}),${AUDIO_IDENTITY.lfeAmp}*pow(sin(PI*ld(2)/${T.lfeLen}),2)*sin(2*PI*${AUDIO_IDENTITY.lfeHz}*ld(2)/${R}),0)`;
  }
  const chirp = `${AUDIO_IDENTITY.chirpAmp}*pow(sin(PI*ld(2)/${T.markerLen}),2)*sin(2*PI*(${fa}*ld(2)/${R}+${fb - fa}*ld(2)*ld(2)/${2 * T.markerLen * R}))`;
  const bit = `if(lt(ld(3),20),mod(floor(ld(1)/pow(2,ld(3))),2),if(lt(ld(3),23),mod(floor(${c}/pow(2,ld(3)-20)),2),mod(floor(mod(ld(1)*8+${c},251)/pow(2,ld(3)-23)),2)))`;
  const fsk = `st(3,floor((ld(2)-${T.symStart})/${T.symLen}));st(4,ld(2)-${T.symStart}-ld(3)*${T.symLen});st(5,${bit});` +
    `${AUDIO_IDENTITY.fskAmp}*pow(sin(PI*ld(4)/${T.symLen}),2)*sin(2*PI*(${f0}+ld(5)*${f1 - f0})*ld(4)/${R})`;
  return head + `if(lt(ld(2),${T.markerLen}),${chirp},if(lt(ld(2),${T.symStart}),0,if(lt(ld(2),${T.symEnd}),${fsk},0)))`;
}

/** Full aevalsrc filter (one expression per channel position). */
export function aevalsrcFilter({R, layout, channels, A0 = 0}) {
  const lfe = new Set(lfePositions(layout));
  const exprs = [];
  for (let c = 0; c < channels; c++) exprs.push(channelExpression({R, c, A0, lfe: lfe.has(c)}));
  return `aevalsrc=exprs='${exprs.join('|')}':s=${R}:c=${layout}:nb_samples=1024`;
}

/** JS reference: value of absolute sample a for channel c (same formula as the expression). */
export function referenceSample(a, R, c, lfe = false) {
  const T = audioTiming(R);
  const k = Math.floor(a / R), s = a - k * R;
  if (lfe) return s < T.lfeLen ? AUDIO_IDENTITY.lfeAmp * Math.sin(Math.PI * s / T.lfeLen) ** 2 * Math.sin(2 * Math.PI * AUDIO_IDENTITY.lfeHz * s / R) : 0;
  const [fa, fb] = AUDIO_IDENTITY.chirpHz, [f0, f1] = AUDIO_IDENTITY.fskHz;
  if (s < T.markerLen) return AUDIO_IDENTITY.chirpAmp * Math.sin(Math.PI * s / T.markerLen) ** 2 * Math.sin(2 * Math.PI * (fa * s / R + (fb - fa) * s * s / (2 * T.markerLen * R)));
  if (s < T.symStart || s >= T.symEnd) return 0;
  const j = Math.floor((s - T.symStart) / T.symLen), u = s - T.symStart - j * T.symLen;
  const b = audioWord(k, c).bits[j];
  return AUDIO_IDENTITY.fskAmp * Math.sin(Math.PI * u / T.symLen) ** 2 * Math.sin(2 * Math.PI * (f0 + b * (f1 - f0)) * u / R);
}

export function synthesize(R, c, startAbs, length, lfe = false) {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = referenceSample(startAbs + i, R, c, lfe);
  return out;
}

const templates = new Map();
export function chirpTemplate(R) {
  if (!templates.has(R)) {
    const T = audioTiming(R), t = new Float64Array(T.markerLen);
    for (let s = 0; s < T.markerLen; s++) t[s] = referenceSample(s, R, 0); // second 0, s < M -> chirp only
    let e = 0; for (const v of t) e += v * v;
    templates.set(R, {t, norm: Math.sqrt(e)});
  }
  return templates.get(R);
}

/**
 * Finds chirp markers by normalized cross-correlation. Returns [{pos (integer), posFrac (sub-sample), corr}].
 * Only positions where the full template fits are scanned.
 */
export function findMarkers(x, R, {threshold = 0.6} = {}) {
  const {t, norm} = chirpTemplate(R);
  const L = t.length, n = x.length - L + 1;
  if (n <= 0) return [];
  const corr = new Float64Array(n);
  let e = 0;
  for (let i = 0; i < L; i++) e += x[i] * x[i];
  for (let p = 0; p < n; p++) {
    if (p > 0) { const a = x[p - 1], b = x[p + L - 1]; e += b * b - a * a; }
    if (e > 1e-6) {
      let d = 0;
      for (let i = 0; i < L; i++) d += x[p + i] * t[i];
      corr[p] = d / (norm * Math.sqrt(e));
    }
  }
  const minGap = Math.floor(R / 2), out = [];
  let p = 0;
  while (p < n) {
    if (corr[p] >= threshold) {
      let best = p;
      const lim = Math.min(n, p + L);
      for (let q = p; q < lim; q++) if (corr[q] > corr[best]) best = q;
      let frac = 0;
      if (best > 0 && best < n - 1) {
        const y0 = corr[best - 1], y1 = corr[best], y2 = corr[best + 1], den = y0 - 2 * y1 + y2;
        if (den < 0) frac = 0.5 * (y0 - y2) / den;
      }
      out.push({pos: best, posFrac: best + frac, corr: Math.round(corr[best] * 10000) / 10000});
      p = best + minGap;
    } else p++;
  }
  return out;
}

function goertzelPower(x, start, len, f, R) {
  const w = 2 * Math.cos(2 * Math.PI * f / R);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < len; i++) { const s0 = x[start + i] + w * s1 - s2; s2 = s1; s1 = s0; }
  return s1 * s1 + s2 * s2 - w * s1 * s2;
}

/** Decodes the FSK word that follows a marker at integer position `pos`. */
export function decodeWord(x, pos, R) {
  const T = audioTiming(R), [f0, f1] = AUDIO_IDENTITY.fskHz;
  if (pos + T.symEnd > x.length) return {complete: false};
  const bits = [];
  let minRatioDb = Infinity;
  for (let j = 0; j < AUDIO_IDENTITY.symbols; j++) {
    const st = pos + T.symStart + j * T.symLen;
    const p0 = goertzelPower(x, st, T.symLen, f0, R), p1 = goertzelPower(x, st, T.symLen, f1, R);
    bits.push(p1 > p0 ? 1 : 0);
    minRatioDb = Math.min(minRatioDb, 10 * Math.log10((Math.max(p0, p1) + 1e-30) / (Math.min(p0, p1) + 1e-30)));
  }
  let k = 0, c = 0, check = 0;
  for (let j = 0; j < 20; j++) k += bits[j] * 2 ** j;
  for (let j = 0; j < 3; j++) c += bits[20 + j] * 2 ** j;
  for (let j = 0; j < 8; j++) check += bits[23 + j] * 2 ** j;
  const valid = minRatioDb >= 6 && check === (k * 8 + c) % AUDIO_IDENTITY.checkModulus;
  return {complete: true, k, c, check, valid, minRatioDb: Math.round(minRatioDb * 10) / 10};
}

/** LFE burst presence at position pos: 50 Hz energy in the burst vs. the silent half second after it. */
export function lfeBurst(x, pos, R) {
  const T = audioTiming(R);
  const q = pos + Math.floor(R / 2);
  if (pos < 0 || q + T.lfeLen > x.length) return {complete: false};
  const on = goertzelPower(x, pos, T.lfeLen, AUDIO_IDENTITY.lfeHz, R), off = goertzelPower(x, q, T.lfeLen, AUDIO_IDENTITY.lfeHz, R);
  const ratioDb = 10 * Math.log10((on + 1e-30) / (off + 1e-30));
  return {complete: true, ratioDb: Math.round(ratioDb * 10) / 10, present: ratioDb >= 20};
}
