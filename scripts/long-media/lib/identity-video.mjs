// Per-frame video identity: a barcode burned with FFmpeg drawbox filters, decodable from luma.
//
// Layout (all sizes derive from the frame height, so proportional rescales keep decoding):
//   cell = 2*floor(H/45)  (1080->48, 2160->96, 720->32, 360->16, 180->8)
//   a black band covers y in [0, 3*cell) across the full width (it also hides testsrc2's own counter);
//   32 columns of cells start at x0 = centred, y0 = cell/2; column j carries word bit j as a vertical
//   complementary pair: bit 1 = top cell white / bottom black, bit 0 = top black / bottom white.
//   Word = 24-bit frame index (LSB first) + 8-bit check = index mod 251.
//   A flash box (white) in the right margin of the band is lit on the first frame of every second.
// Burned human-readable text below the band: frame index, pts as H:MM:SS.mmm, SMPTE timecode.
import {FONT_REL} from './env.mjs';

export const VIDEO_IDENTITY = Object.freeze({
  version: 1, indexBits: 24, checkBits: 8, checkModulus: 251, columns: 32,
  encoding: 'vertical-complementary-pair', minContrast: 40,
});

export function videoLayout(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new TypeError(`bad frame size ${width}x${height}`);
  const cell = 2 * Math.floor(height / 45);
  if (cell < 8) throw new RangeError(`frame height ${height} too small for the identity barcode (cell ${cell}px < 8px)`);
  const gridWidth = VIDEO_IDENTITY.columns * cell;
  const x0 = 2 * Math.floor((width - gridWidth) / 4);
  const flashSize = 2 * Math.round(cell * 1.25);
  if (x0 < flashSize + 2) throw new RangeError(`frame ${width}x${height} too narrow for barcode + flash (needs ~16:9)`);
  const bandHeight = 3 * cell;
  return {
    width, height, cell, x0, y0: cell / 2, gridWidth, bandHeight,
    flash: {x: x0 + gridWidth + 2 * Math.floor((x0 - flashSize) / 4), y: (bandHeight - flashSize) / 2, size: flashSize},
    fontSize: Math.max(12, cell), textX: cell / 2, textY1: bandHeight + cell / 2, textY2: bandHeight + 2 * cell,
  };
}

export function identityWord(index) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= 2 ** VIDEO_IDENTITY.indexBits) throw new RangeError(`frame index ${index} outside 24-bit range`);
  const check = index % VIDEO_IDENTITY.checkModulus;
  const bits = [];
  for (let j = 0; j < 24; j++) bits.push(Math.floor(index / 2 ** j) % 2);
  for (let j = 0; j < 8; j++) bits.push(Math.floor(check / 2 ** j) % 2);
  return {index, check, bits};
}

/** FFmpeg enable-expression for word bit j of absolute frame index (n + startFrame). */
export function bitExpression(j, startFrame = 0) {
  const n = startFrame ? `(n+${startFrame})` : 'n';
  if (j < 24) return `mod(floor(${n}/${2 ** j}),2)`;
  return `mod(floor(mod(${n},${VIDEO_IDENTITY.checkModulus})/${2 ** (j - 24)}),2)`;
}

/**
 * Filters (in order) that burn the identity into each frame. They must run BEFORE any frame
 * dropping (VFR select) so `n` is the source frame number.
 * opts: {width, height, fps:{num,den} (BigInt ok), startFrame, startSecondsDecimal, label}
 */
export function identityFilters({width, height, fps, startFrame = 0, startSecondsDecimal = '0', label = ''}) {
  const L = videoLayout(width, height);
  const c = L.cell, num = String(fps.num), den = String(fps.den);
  const n = startFrame ? `(n+${startFrame})` : 'n';
  const f = [`drawbox=x=0:y=0:w=${width}:h=${L.bandHeight}:color=black:t=fill`];
  for (let j = 0; j < VIDEO_IDENTITY.columns; j++) {
    const x = L.x0 + j * c, e = bitExpression(j, startFrame);
    f.push(`drawbox=x=${x}:y=${L.y0}:w=${c}:h=${c}:color=white:t=fill:enable='${e}'`);
    f.push(`drawbox=x=${x}:y=${L.y0 + c}:w=${c}:h=${c}:color=white:t=fill:enable='1-${e}'`);
  }
  f.push(`drawbox=x=${L.flash.x}:y=${L.flash.y}:w=${L.flash.size}:h=${L.flash.size}:color=white:t=fill:enable='gt(floor(${n}*${den}/${num}),floor((${n}-1)*${den}/${num}))'`);
  const font = `fontfile=${FONT_REL}:fontsize=${L.fontSize}:fontcolor=white:box=1:boxcolor=black@0.75:boxborderw=${Math.max(2, c / 8)}`;
  f.push(`drawtext=${font}:x=${L.textX}:y=${L.textY1}:text='F %{eif\\:${n}\\:d\\:8}  %{pts\\:hms\\:${startSecondsDecimal}}'`);
  const tcSep = String(fps.den) === '1001' ? ';' : ':';
  const tcStart = smpteStart(startFrame, fps, tcSep).replace(/[:;]/g, m => '\\' + m);
  const safeLabel = String(label).replace(/[^A-Za-z0-9 ._/+-]/g, '');
  f.push(`drawtext=${font}:x=${L.textX}:y=${L.textY2}:timecode='${tcStart}':timecode_rate=${num}/${den}:text='${safeLabel} TC '`);
  return {filters: f, layout: L};
}

/**
 * SMPTE start timecode for a frame offset. Drop-frame (';') counting for 30000/1001 and 60000/1001
 * follows the standard 2/4-frame drop every minute except every tenth minute.
 */
export function smpteStart(startFrame, fps, sep = ':') {
  const nominal = Math.round(Number(fps.num) / Number(fps.den));
  let frame = startFrame;
  if (sep === ';') {
    const drop = Math.round(nominal / 15); // 2 for 29.97, 4 for 59.94
    const per10 = nominal * 600 - drop * 9;
    const per1 = nominal * 60 - drop;
    const d = Math.floor(frame / per10), m = frame % per10;
    frame += drop * 9 * d + (m > drop ? drop * Math.floor((m - drop) / per1) : 0);
  }
  const ff = frame % nominal, totalS = Math.floor(frame / nominal);
  const hh = Math.floor(totalS / 3600), mm = Math.floor(totalS / 60) % 60, ss = totalS % 60;
  const p = v => String(v).padStart(2, '0');
  return `${p(hh)}:${p(mm)}:${p(ss)}${sep}${p(ff)}`;
}

function regionMean(gray, stride, x, y, w, h) {
  const x1 = Math.round(x), y1 = Math.round(y), x2 = Math.round(x + w), y2 = Math.round(y + h);
  let s = 0, cnt = 0;
  for (let yy = y1; yy < y2; yy++) { const o = yy * stride; for (let xx = x1; xx < x2; xx++) { s += gray[o + xx]; cnt++; } }
  return cnt ? s / cnt : NaN;
}

/**
 * Decodes the identity from a gray8 buffer holding at least the band rows of a frame.
 * The layout is computed from the decoded frame size (proportional rescales decode the same).
 */
export function decodeBand(gray, width, height, {minContrast = VIDEO_IDENTITY.minContrast} = {}) {
  const L = videoLayout(width, height);
  const c = L.cell, inset = c / 4, inner = c / 2;
  const bits = [], contrasts = [];
  let whiteSum = 0;
  for (let j = 0; j < VIDEO_IDENTITY.columns; j++) {
    const x = L.x0 + j * c;
    const top = regionMean(gray, width, x + inset, L.y0 + inset, inner, inner);
    const bot = regionMean(gray, width, x + inset, L.y0 + c + inset, inner, inner);
    bits.push(top > bot ? 1 : 0);
    contrasts.push(Math.abs(top - bot));
    whiteSum += Math.max(top, bot);
  }
  let index = 0, check = 0;
  for (let j = 0; j < 24; j++) index += bits[j] * 2 ** j;
  for (let j = 0; j < 8; j++) check += bits[24 + j] * 2 ** j;
  const minC = Math.min(...contrasts);
  const ambiguous = contrasts.map((v, j) => (v < minContrast ? j : -1)).filter(j => j >= 0);
  const blackRef = regionMean(gray, width, inset, L.y0 + inset, Math.max(2, L.x0 - 2 * inset), c);
  const whiteRef = whiteSum / VIDEO_IDENTITY.columns;
  const fl = L.flash;
  const flashMean = regionMean(gray, width, fl.x + fl.size / 4, fl.y + fl.size / 4, fl.size / 2, fl.size / 2);
  const valid = ambiguous.length === 0 && check === index % VIDEO_IDENTITY.checkModulus;
  return {
    index, check, valid, ambiguousBits: ambiguous, minContrast: Math.round(minC * 10) / 10,
    blackRef: Math.round(blackRef * 10) / 10, whiteRef: Math.round(whiteRef * 10) / 10,
    flashMean: Math.round(flashMean * 10) / 10, flashOn: flashMean > (blackRef + whiteRef) / 2,
  };
}

/** Paints the identity into a gray8 buffer (JS reference used by unit tests). */
export function paintBand(gray, width, height, index, {flash = false, black = 16, white = 235} = {}) {
  const L = videoLayout(width, height);
  const fill = (x, y, w, h, v) => { for (let yy = y; yy < y + h; yy++) gray.fill(v, yy * width + x, yy * width + x + w); };
  fill(0, 0, width, L.bandHeight, black);
  const {bits} = identityWord(index);
  bits.forEach((b, j) => fill(L.x0 + j * L.cell, L.y0 + (b ? 0 : L.cell), L.cell, L.cell, white));
  if (flash) fill(L.flash.x, L.flash.y, L.flash.size, L.flash.size, white);
  return L;
}
