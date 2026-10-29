// Seam checks between two outputs (and inside one output around a cut/chunk boundary).
//   concat : A then B must continue the identity timeline (next frame identity, audio markers exactly
//            (kB-kA)*R samples apart when B's audio starts right after A's last sample).
//   compare: A and B should be the same media around time t (chunked vs single graph, copy vs source):
//            identity sequences equal and consecutive, decoded pixels equal (else PSNR/max error), audio null test.
//   within : one file around t: identities consecutive (no drop/dup), audio markers exactly R apart across t.
import {ffprobeJson, probeFacts} from './probe.mjs';
import {decodeVideoFrames, decodeAudioWindow} from './decode.mjs';
import {decodeBand, videoLayout} from './identity-video.mjs';
import {findMarkers, decodeWord} from './identity-audio.mjs';
import {sha256} from './hash.mjs';
import {parseRational, rat, mul, sub, cmp, floorBig, toSafeNumber, toDecimalString, ratString} from './rational.mjs';

async function videoInfo(file) {
  const facts = probeFacts((await ffprobeJson(file)).json);
  if (!facts.video) throw new Error(`no video stream in ${file}`);
  const v = facts.video;
  return {facts, v, tb: parseRational(v.time_base), fps: parseRational(v.r_frame_rate), layout: videoLayout(v.width, v.height)};
}

const isConsecutive = ids => ids.every((id, i) => i === 0 || id === ids[i - 1] + 1);

async function framesAround(file, info, t, before, after, region) {
  const period = rat(info.fps.den, info.fps.num);
  let start = sub(t, mul(period, rat(2 * before + 1, 2)));
  if (cmp(start, rat(0)) < 0) start = rat(0);
  const dec = await decodeVideoFrames(file, {start, count: before + after, timeBase: info.tb, width: info.v.width, height: info.v.height,
    region, bandRows: info.layout.bandHeight});
  return dec.frames.map(f => {
    const id = decodeBand(f.data, info.v.width, info.v.height);
    return {pts: f.pts, time: toDecimalString(mul(rat(f.pts), info.tb), 6), identity: id.index, valid: id.valid, data: f.data};
  });
}

function psnr(a, b, start, len) {
  let se = 0, maxd = 0;
  for (let i = start; i < start + len; i++) { const d = a[i] - b[i]; se += d * d; if (Math.abs(d) > maxd) maxd = Math.abs(d); }
  const mse = se / len;
  return {psnr: mse === 0 ? Infinity : 10 * Math.log10(255 * 255 / mse), maxAbsDiff: maxd};
}

async function audioMarkers(file, start, seconds, R) {
  const w = await decodeAudioWindow(file, {start, samples: toSafeNumber(floorBig(mul(parseRational(seconds), rat(R))), 'window'), sampleRate: R});
  const x = w.channels[0] || new Float32Array(0);
  const markers = findMarkers(x, R).map(m => ({local: w.firstSample + m.posFrac, ...decodeWord(x, m.pos, R)})).filter(m => m.complete && m.valid);
  return {firstSample: w.firstSample, length: x.length, markers, channels: w.channels, gaps: w.gaps};
}

/** A followed by B. */
export async function evaluateSeamConcat({a, b, framesEachSide = 3, audioSeconds = '2.5'}) {
  const [ia, ib] = await Promise.all([videoInfo(a), videoInfo(b)]);
  const checks = [];
  const add_ = (name, ok, detail) => checks.push({name, ok: !!ok, ...detail});
  add_('same frame rate', cmp(ia.fps, ib.fps) === 0, {a: ratString(ia.fps), b: ratString(ib.fps)});
  add_('same frame size', ia.v.width === ib.v.width && ia.v.height === ib.v.height, {a: `${ia.v.width}x${ia.v.height}`, b: `${ib.v.width}x${ib.v.height}`});
  const durA = mul(rat(Number(ia.v.duration_ts)), ia.tb);
  const lastA = sub(durA, rat(ia.fps.den, ia.fps.num));
  const tailA = await framesAround(a, ia, lastA, framesEachSide - 1, framesEachSide + 1, 'band');
  const headB = await framesAround(b, ib, rat(0), 0, framesEachSide, 'band');
  const ids = [...tailA.map(f => f.identity), ...headB.map(f => f.identity)];
  add_('all identities valid', [...tailA, ...headB].every(f => f.valid), {});
  add_('video identity continues across the seam (no drop/dup)', isConsecutive(ids), {aTail: tailA.map(f => f.identity), bHead: headB.map(f => f.identity)});
  const out = {mode: 'concat', a, b, checks, video: {aTail: tailA.map(({data, ...f}) => f), bHead: headB.map(({data, ...f}) => f)}};
  const aa = ia.facts.audio[0], ab = ib.facts.audio[0];
  if (aa && ab) {
    const R = aa.sampleRate;
    add_('same sample rate', R === ab.sampleRate, {a: R, b: ab.sampleRate});
    const lenA = toSafeNumber(floorBig(mul(mul(rat(Number(aa.duration_ts)), parseRational(aa.time_base)), rat(R))), 'samples');
    const videoSamplesA = toSafeNumber(floorBig(mul(durA, rat(R))), 'samples');
    add_('A audio length equals A video duration', lenA === videoSamplesA, {audioSamples: lenA, videoDurationSamples: videoSamplesA, differenceSamples: lenA - videoSamplesA});
    // what a decoder actually delivers at A's end (FFmpeg decodes AAC end padding past the edit-list duration)
    const tw = await decodeAudioWindow(a, {start: rat(Math.max(0, lenA - R / 2), R), samples: 2 * R, sampleRate: R});
    const decodedEndA = tw.firstSample + (tw.channels[0]?.length ?? 0);
    out.audio = {aContainerSamples: lenA, aDecodedEndSample: decodedEndA, aDecoderTailExcessSamples: decodedEndA - lenA};
    if (decodedEndA !== lenA) (out.warnings ||= []).push(`A: the bundled FFmpeg decodes ${decodedEndA - lenA} samples past A's container duration (AAC end padding); a joiner that does not trim to the container duration shifts B's audio by that much`);
    const tA = await audioMarkers(a, sub(mul(rat(lenA), rat(1, R)), parseRational(audioSeconds)), audioSeconds, R);
    const hB = await audioMarkers(b, rat(0), audioSeconds, R);
    const mA = tA.markers[tA.markers.length - 1], mB = hB.markers[0];
    if (mA && mB) {
      const measured = lenA + mB.local - mA.local, expected = (mB.k - mA.k) * R;
      add_('audio markers continue across the seam', Math.abs(measured - expected) <= 2, {aLastSecond: mA.k, bFirstSecond: mB.k, measuredSpacingSamples: Math.round(measured * 100) / 100, expectedSpacingSamples: expected, errorSamples: Math.round((measured - expected) * 100) / 100});
      add_('audio second identity continues', mB.k === mA.k + 1 || mB.k === mA.k, {aLastSecond: mA.k, bFirstSecond: mB.k});
    } else add_('audio markers found on both sides', false, {aMarkers: tA.markers.length, bMarkers: hB.markers.length});
  } else if (aa || ab) add_('both sides have audio', false, {a: !!aa, b: !!ab});
  out.status = checks.every(c => c.ok) ? 'PASS' : 'FAIL';
  return out;
}

/** A vs B around time t (both should carry the same media there). */
export async function evaluateSeamCompare({a, b, at, framesEachSide = 4, audioSeconds = '1.0', nullThresholdDb = -90}) {
  const t = parseRational(at);
  const [ia, ib] = await Promise.all([videoInfo(a), videoInfo(b)]);
  const checks = [];
  const add_ = (name, ok, detail) => checks.push({name, ok: !!ok, ...detail});
  add_('same frame size', ia.v.width === ib.v.width && ia.v.height === ib.v.height, {a: `${ia.v.width}x${ia.v.height}`, b: `${ib.v.width}x${ib.v.height}`});
  add_('same frame rate', cmp(ia.fps, ib.fps) === 0, {a: ratString(ia.fps), b: ratString(ib.fps)});
  const fa = await framesAround(a, ia, t, framesEachSide, framesEachSide, 'full-yuv420p');
  const fb = await framesAround(b, ib, t, framesEachSide, framesEachSide, 'full-yuv420p');
  const W = ia.v.width, H = ia.v.height, ySize = W * H, cSize = ySize / 4;
  const pairs = [];
  for (let i = 0; i < Math.max(fa.length, fb.length); i++) {
    const x = fa[i], y = fb[i];
    if (!x || !y) { pairs.push({i, missing: !x ? 'a' : 'b'}); continue; }
    const same = x.data.length === y.data.length && sha256(x.data) === sha256(y.data);
    const p = {i, timeA: x.time, timeB: y.time, identityA: x.identity, identityB: y.identity, validA: x.valid, validB: y.valid, pixelsIdentical: same};
    if (!same && x.data.length === y.data.length) {
      const py = psnr(x.data, y.data, 0, ySize), pu = psnr(x.data, y.data, ySize, cSize), pv = psnr(x.data, y.data, ySize + cSize, cSize);
      Object.assign(p, {psnrY: +py.psnr.toFixed(3), psnrU: +pu.psnr.toFixed(3), psnrV: +pv.psnr.toFixed(3), maxAbsDiff: Math.max(py.maxAbsDiff, pu.maxAbsDiff, pv.maxAbsDiff)});
    }
    pairs.push(p);
  }
  const complete = pairs.filter(p => !p.missing);
  add_('same number of frames decoded', fa.length === fb.length, {a: fa.length, b: fb.length});
  add_('identities valid', complete.every(p => p.validA && p.validB), {});
  add_('identity sequences equal', complete.every(p => p.identityA === p.identityB), {a: fa.map(f => f.identity), b: fb.map(f => f.identity)});
  add_('identities consecutive in A (no drop/dup)', isConsecutive(fa.map(f => f.identity)), {});
  add_('identities consecutive in B (no drop/dup)', isConsecutive(fb.map(f => f.identity)), {});
  add_('timestamps equal', complete.every(p => p.timeA === p.timeB), {});
  const identical = complete.filter(p => p.pixelsIdentical).length;
  const minPsnr = Math.min(...complete.map(p => (p.pixelsIdentical ? Infinity : Math.min(p.psnrY, p.psnrU, p.psnrV))));
  const pixelSummary = {framesCompared: complete.length, pixelsIdentical: identical, minPsnr: minPsnr === Infinity ? 'inf' : +minPsnr.toFixed(3), maxAbsDiff: Math.max(0, ...complete.map(p => p.maxAbsDiff || 0))};
  const out = {mode: 'compare', a, b, at: toDecimalString(t, 6), checks, pixels: pixelSummary, frames: pairs};
  const aa = ia.facts.audio[0], ab = ib.facts.audio[0];
  if (aa && ab) {
    const R = aa.sampleRate;
    add_('same sample rate', R === ab.sampleRate, {a: R, b: ab.sampleRate});
    let s = sub(t, mul(parseRational(audioSeconds), rat(1, 2)));
    if (cmp(s, rat(0)) < 0) s = rat(0);
    const n = toSafeNumber(floorBig(mul(parseRational(audioSeconds), rat(R))), 'samples');
    const [wa, wb] = await Promise.all([decodeAudioWindow(a, {start: s, samples: n, sampleRate: R}), decodeAudioWindow(b, {start: s, samples: n, sampleRate: R})]);
    const off = wb.firstSample - wa.firstSample;
    add_('audio windows start at the same sample', off === 0, {a: wa.firstSample, b: wb.firstSample});
    const chans = Math.min(wa.channels.length, wb.channels.length);
    const len = Math.min(wa.channels[0]?.length ?? 0, wb.channels[0]?.length ?? 0);
    let se = 0, peak = 0;
    for (let c = 0; c < chans; c++) for (let i = 0; i < len; i++) { const d = wa.channels[c][i] - wb.channels[c][i]; se += d * d; peak = Math.max(peak, Math.abs(d)); }
    const rms = Math.sqrt(se / Math.max(1, chans * len));
    const db = rms === 0 ? -Infinity : 20 * Math.log10(rms);
    add_(`audio null test <= ${nullThresholdDb} dBFS`, off === 0 && wa.channels.length === wb.channels.length && db <= nullThresholdDb, {differenceRmsDbfs: db === -Infinity ? '-inf' : +db.toFixed(2), peakDifference: +peak.toFixed(6), samples: len, channels: chans});
  } else if (aa || ab) add_('both sides have audio', false, {a: !!aa, b: !!ab});
  out.status = checks.every(c => c.ok) ? 'PASS' : 'FAIL';
  out.pixelVerdict = identical === complete.length ? 'IDENTICAL' : `DIFFERENT (${complete.length - identical} of ${complete.length} frames; min PSNR ${pixelSummary.minPsnr} dB)`;
  return out;
}

/** One file around time t. */
export async function evaluateSeamWithin({file, at, framesEachSide = 4, audioSeconds = '2.5'}) {
  const t = parseRational(at);
  const info = await videoInfo(file);
  const checks = [];
  const add_ = (name, ok, detail) => checks.push({name, ok: !!ok, ...detail});
  const fr = await framesAround(file, info, t, framesEachSide, framesEachSide, 'band');
  add_('identities valid', fr.every(f => f.valid), {});
  add_('identities consecutive across t (no drop/dup)', isConsecutive(fr.map(f => f.identity)), {identities: fr.map(f => f.identity), times: fr.map(f => f.time)});
  const a = info.facts.audio[0];
  if (a) {
    const R = a.sampleRate;
    let s = sub(t, mul(parseRational(audioSeconds), rat(1, 2)));
    if (cmp(s, rat(0)) < 0) s = rat(0);
    const w = await audioMarkers(file, s, audioSeconds, R);
    const sp = w.markers.slice(1).map((m, i) => ({from: w.markers[i].k, to: m.k, spacing: Math.round((m.local - w.markers[i].local) * 100) / 100, expected: (m.k - w.markers[i].k) * R}));
    add_('audio markers found', w.markers.length >= 2, {markers: w.markers.map(m => ({k: m.k, local: Math.round(m.local * 100) / 100}))});
    add_('audio marker spacing exact across t', sp.length > 0 && sp.every(x => Math.abs(x.spacing - x.expected) <= 2 && x.to === x.from + 1), {spacings: sp});
  }
  return {mode: 'within', file, at: toDecimalString(t, 6), checks, frames: fr.map(({data, ...f}) => f), status: checks.every(c => c.ok) ? 'PASS' : 'FAIL'};
}
