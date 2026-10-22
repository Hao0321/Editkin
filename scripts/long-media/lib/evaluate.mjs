// Evaluators: frame identity at timestamps, audio sample positions, seams.
// Expectations come from a fixture spec (or a manifest that embeds it). An output that must reproduce
// the fixture timeline (copy/remux/full-length render) is evaluated against the source fixture's spec.
import {ffprobeJson, probeFacts} from './probe.mjs';
import {decodeVideoFrames, decodeAudioWindow} from './decode.mjs';
import {decodeBand, videoLayout} from './identity-video.mjs';
import {audioTiming, findMarkers, decodeWord, lfeBurst, lfePositions} from './identity-audio.mjs';
import {derive, isDropped} from './fixtures.mjs';
import {parseRational, rat, add, sub, mul, cmp, floorBig, ceilBig, framePts, toSafeNumber, toDecimalString, hms, exactTicks} from './rational.mjs';

export const LV01_POINTS = ['start', 'middle', '9:59:59', '10:00:00', '11:59:59', 'last'];

/** Chooses the point set: the LV-01 six when the media covers 11:59:59, else a scaled analogue. */
export function defaultPoints(spec) {
  const d = derive(spec);
  const secs = Number(floorBig(d.durationSeconds));
  if (secs >= 43200) return [...LV01_POINTS];
  const half = Math.floor(secs / 2);
  return ['start', 'middle', String(half - 1), String(half), String(secs - 1), 'last'];
}

function localIndexAt(t, spec, d) {
  let k = toSafeNumber(floorBig(mul(t, d.fps)), 'frame index');
  k = Math.max(0, Math.min(k, spec.frames - 1));
  while (k > 0 && isDropped(spec.startFrame + k, spec.vfr)) k--;
  return k;
}

export function resolvePoint(name, spec, d = derive(spec)) {
  if (name === 'start') { let k = 0; while (isDropped(spec.startFrame + k, spec.vfr)) k++; return {name, t: framePts(k, d.fps), localIndex: k}; }
  if (name === 'last') return {name, t: d.lastPtsSeconds, localIndex: d.lastSourceLocalIndex};
  if (name === 'middle') { const k = localIndexAt(framePts(Math.floor(spec.frames / 2), d.fps), spec, d); return {name, t: framePts(k, d.fps), localIndex: k}; }
  const t = parseRational(name);
  if (cmp(t, rat(0)) < 0 || cmp(t, d.durationSeconds) >= 0) return {name, t, localIndex: null, outOfRange: true};
  return {name, t, localIndex: localIndexAt(t, spec, d)};
}

const expectedFlash = (abs, fps) => floorBig(mul(rat(abs), rat(fps.den, fps.num))) > floorBig(mul(rat(abs - 1), rat(fps.den, fps.num)));

/** Frame-identity decode at timestamps. */
export async function evaluateFrames({file, spec, points = defaultPoints(spec), framesPerPoint = 5, probe}) {
  const d = derive(spec);
  const t0 = Date.now();
  const pj = probe || (await ffprobeJson(file)).json;
  const facts = probeFacts(pj);
  const v = facts.video;
  const checks = [];
  const add_ = (name, ok, detail) => checks.push({name, ok: !!ok, ...detail});
  if (!v) { add_('video stream present', false, {}); return {status: 'FAIL', checks, points: [], wallMs: Date.now() - t0}; }
  const tb = parseRational(v.time_base);
  add_('dimensions', v.width === spec.width && v.height === spec.height, {expected: `${spec.width}x${spec.height}`, actual: `${v.width}x${v.height}`});
  add_('frame count (container)', v.nbFrames === d.outputFrames, {expected: d.outputFrames, actual: v.nbFrames});
  if (!spec.vfr) add_('r_frame_rate', parseRational(v.r_frame_rate).num * d.fps.den === d.fps.num * parseRational(v.r_frame_rate).den, {expected: d.fpsString, actual: v.r_frame_rate});
  const lastEndTicks = exactTicks(add(d.lastPtsSeconds, rat(d.fps.den, d.fps.num)), tb);
  if (lastEndTicks !== null && v.duration_ts !== undefined) add_('video duration_ts', Number(v.duration_ts) === lastEndTicks, {expected: lastEndTicks, actual: Number(v.duration_ts)});
  const L = videoLayout(v.width, v.height);
  const period = rat(d.fps.den, d.fps.num);
  const results = [];
  for (const name of points) {
    const p = resolvePoint(String(name), spec, d);
    if (p.outOfRange) { results.push({name: p.name, status: 'OUT_OF_RANGE', t: toDecimalString(p.t, 6)}); continue; }
    const isLast = p.name === 'last';
    let startT = sub(framePts(p.localIndex, d.fps), mul(period, rat(5, 2)));
    if (cmp(startT, rat(0)) < 0) startT = rat(0);
    const count = isLast ? framesPerPoint + 3 : framesPerPoint;
    let dec;
    try { dec = await decodeVideoFrames(file, {start: startT, count, timeBase: tb, width: v.width, height: v.height, region: 'band', bandRows: L.bandHeight}); }
    catch (e) { results.push({name: p.name, t: toDecimalString(p.t, 6), hms: hms(p.t), status: 'ERROR', error: e.message.slice(0, 1000), decoded: []}); continue; }
    const targetTicks = exactTicks(framePts(p.localIndex, d.fps), tb);
    const decoded = dec.frames.map(f => {
      const id = decodeBand(f.data, v.width, v.height);
      const tSec = mul(rat(f.pts), tb);
      const localQ = mul(tSec, d.fps);
      const localExact = localQ.den === 1n;
      const local = localExact ? Number(localQ.num) : null;
      const abs = local === null ? null : spec.startFrame + local;
      const flashExp = abs === null ? null : expectedFlash(abs, d.fps);
      const ok = id.valid && abs !== null && id.index === abs && !isDropped(abs, spec.vfr) && id.flashOn === flashExp;
      return {pts: f.pts, time: toDecimalString(tSec, 6), hms: hms(tSec), type: f.type, key: f.key, identity: id.index, valid: id.valid,
        minContrast: id.minContrast, flashOn: id.flashOn, flashExpected: flashExp, expectedIdentity: abs, ok};
    });
    // ordering: strictly increasing pts; CFR steps by exactly one period, VFR to the next surviving index
    let orderOk = true;
    for (let i = 1; i < decoded.length; i++) {
      const a = decoded[i - 1].expectedIdentity, b = decoded[i].expectedIdentity;
      if (a === null || b === null) { orderOk = false; break; }
      let next = a + 1; while (isDropped(next, spec.vfr)) next++;
      if (b !== next) orderOk = false;
    }
    const target = decoded.find(f => f.pts === targetTicks);
    const expectedAbs = spec.startFrame + p.localIndex;
    let eofOk = true;
    if (isLast) eofOk = !!target && decoded[decoded.length - 1] === target;
    const ok = !!target && target.ok && target.identity === expectedAbs && decoded.every(f => f.ok) && orderOk && eofOk && targetTicks !== null;
    results.push({
      name: p.name, t: toDecimalString(p.t, 6), hms: hms(p.t), expected: {localIndex: p.localIndex, identity: expectedAbs, ptsTicks: targetTicks},
      found: !!target, targetIdentity: target?.identity ?? null, decoded, orderOk, ...(isLast ? {eofOk, decodedAfterLast: target ? decoded.length - 1 - decoded.indexOf(target) : null} : {}),
      decodeWallMs: Math.round(dec.wallMs), decodeArgv: dec.argv, status: ok ? 'PASS' : 'FAIL',
    });
  }
  const status = checks.every(c => c.ok) && results.every(r => r.status === 'PASS') ? 'PASS' : 'FAIL';
  return {evaluator: 'frame-identity/v1', file, status, timeBase: v.time_base, layout: L, checks, points: results, wallMs: Date.now() - t0};
}

/** Audio sample-position checks around timestamps. */
export async function evaluateAudio({file, spec, points = defaultPoints(spec), toleranceSamples = 2, windowBefore = '1.25', windowLength = '2.5', probe}) {
  const t0 = Date.now();
  const d = derive(spec);
  if (!spec.audio) return {evaluator: 'audio-position/v1', file, status: 'NOT_APPLICABLE', reason: 'fixture has no audio', wallMs: 0};
  const pj = probe || (await ffprobeJson(file)).json;
  const facts = probeFacts(pj);
  const a = facts.audio[0];
  const checks = [];
  const add_ = (name, ok, detail) => checks.push({name, ok: !!ok, ...detail});
  if (!a) { add_('audio stream present', false, {}); return {evaluator: 'audio-position/v1', file, status: 'FAIL', checks, points: [], wallMs: Date.now() - t0}; }
  const R = spec.audio.sampleRate, T = audioTiming(R);
  add_('sample rate', a.sampleRate === R, {expected: R, actual: a.sampleRate});
  add_('channels', a.channels === spec.audio.channels, {expected: spec.audio.channels, actual: a.channels});
  add_('channel layout', a.channel_layout === spec.audio.layout, {expected: spec.audio.layout, actual: a.channel_layout});
  if (a.sampleRate !== R) return {evaluator: 'audio-position/v1', file, status: 'FAIL', reason: 'sample rate differs; positions on the expected grid cannot be checked', checks, points: [], wallMs: Date.now() - t0};
  const durTs = a.duration_ts === undefined ? null : Number(a.duration_ts);
  const aTb = parseRational(a.time_base);
  const durSamples = durTs === null ? null : toSafeNumber(floorBig(mul(mul(rat(durTs), aTb), rat(R))), 'audio duration');
  add_('audio length (container)', durSamples === d.audioSamples, {expectedSamples: d.audioSamples, actualSamples: durSamples, differenceSamples: durSamples === null ? null : durSamples - d.audioSamples});
  const lfe = new Set(lfePositions(spec.audio.layout));
  const results = [];
  for (const name of points) {
    const p = resolvePoint(String(name), spec, d);
    if (p.outOfRange) { results.push({name: p.name, status: 'OUT_OF_RANGE'}); continue; }
    // Window in local samples around t; widened backwards when needed so it always holds the last complete
    // marker (marker + word) that ends inside the stream, e.g. the `last` point of a short clip.
    const tS = toSafeNumber(floorBig(mul(p.t, rat(R))), 'sample');
    let startS = Math.max(0, tS - toSafeNumber(floorBig(mul(parseRational(windowBefore), rat(R))), 'window'));
    const endS = startS + toSafeNumber(floorBig(mul(parseRational(windowLength), rat(R))), 'window');
    const lastK = Math.floor((d.audioStartSample + Math.min(endS, d.audioSamples) - T.symEnd) / R);
    const lastMarkerLocal = lastK * R - d.audioStartSample;
    if (lastMarkerLocal >= 0 && lastMarkerLocal < startS) startS = Math.max(0, lastMarkerLocal - R / 4);
    const want = endS - startS;
    let w;
    try { w = await decodeAudioWindow(file, {start: rat(startS, R), samples: want, sampleRate: R}); } catch (e) { results.push({name: p.name, status: 'ERROR', error: e.message.slice(0, 1000)}); continue; }
    const n = w.channels[0]?.length ?? 0;
    const w0 = w.firstSample, abs0 = d.audioStartSample + w0;
    // When the decode ran into EOF, report how far the decoder's output extends past the container duration
    // (FFmpeg decodes AAC end padding: a joiner must trim to the container duration).
    const reachedEof = n < want;
    const tail = reachedEof ? {decodedEndSample: w0 + n, containerEndSample: d.audioSamples, decoderTailExcessSamples: w0 + n - d.audioSamples} : null;
    // markers fully inside the window and inside the stream
    const kFirst = Math.ceil(abs0 / R), expectedK = [];
    for (let k = kFirst; k * R + T.symEnd <= abs0 + n && k * R - d.audioStartSample + T.symEnd <= d.audioSamples; k++) expectedK.push(k);
    const channels = [];
    for (let c = 0; c < w.channels.length; c++) {
      const x = w.channels[c];
      if (lfe.has(c)) {
        const bursts = expectedK.map(k => ({k, ...lfeBurst(x, k * R - abs0, R)}));
        channels.push({channel: c, lfe: true, bursts, ok: bursts.length > 0 && bursts.every(b => b.complete && b.present)});
        continue;
      }
      const found = findMarkers(x, R).map(m => {
        const word = decodeWord(x, m.pos, R);
        const absPos = abs0 + m.posFrac;
        const err = word.complete && word.valid ? absPos - word.k * R : null;
        return {k: word.k ?? null, channelId: word.c ?? null, wordValid: !!word.valid, complete: word.complete, minRatioDb: word.minRatioDb ?? null,
          corr: m.corr, measuredAbsSample: Math.round(absPos * 100) / 100, expectedAbsSample: word.valid ? word.k * R : null,
          errorSamples: err === null ? null : Math.round(err * 100) / 100};
      }).filter(m => m.complete);
      const byK = new Map(found.map(m => [m.k, m]));
      const missing = expectedK.filter(k => !byK.has(k));
      const unexpected = found.filter(m => !m.wordValid || !expectedK.includes(m.k));
      const maxAbsErr = found.reduce((mx, m) => Math.max(mx, Math.abs(m.errorSamples ?? Infinity)), 0);
      const ok = found.length > 0 && missing.length === 0 && unexpected.length === 0 && found.every(m => m.channelId === c) && maxAbsErr <= toleranceSamples;
      channels.push({channel: c, markers: found, missing, unexpected: unexpected.length, maxAbsErrorSamples: found.length ? Math.round(maxAbsErr * 100) / 100 : null, ok});
    }
    // A/V: flash frame of second k vs. marker of second k (expected offset from the exact grids)
    const av = expectedK.map(k => {
      const F = ceilBig(mul(rat(k), d.fps));
      const vT = framePts(F, d.fps);
      const marker = channels.find(ch => !ch.lfe)?.markers.find(m => m.k === k);
      const expectedMs = Number(toDecimalString(mul(sub(vT, rat(k)), rat(1000)), 4));
      const measuredMs = marker && marker.errorSamples !== null ? Math.round((expectedMs - marker.errorSamples / R * 1000) * 1000) / 1000 : null;
      return {k, flashFrame: Number(F), expectedOffsetMs: expectedMs, measuredOffsetMs: measuredMs};
    });
    const ok = w.gaps === 0 && expectedK.length > 0 && channels.length === spec.audio.channels && channels.every(ch => ch.ok);
    results.push({name: p.name, t: toDecimalString(p.t, 6), hms: hms(p.t), windowFirstSample: w0, windowFirstAbsSample: abs0, windowSamples: n,
      expectedSeconds: expectedK, channels, av, ...(tail ? {decoderTail: tail} : {}), decodeGaps: w.gaps, decodeWallMs: Math.round(w.wallMs), decodeArgv: w.argv, status: ok ? 'PASS' : 'FAIL'});
  }
  const maxErr = Math.max(0, ...results.flatMap(r => (r.channels || []).map(c => c.maxAbsErrorSamples ?? 0)));
  const status = checks.every(c => c.ok) && results.every(r => r.status === 'PASS') ? 'PASS' : 'FAIL';
  const tails = results.filter(r => r.decoderTail).map(r => r.decoderTail.decoderTailExcessSamples);
  return {evaluator: 'audio-position/v1', file, status, toleranceSamples, maxAbsErrorSamples: maxErr,
    decoderTailExcessSamples: tails.length ? Math.max(...tails) : null,
    decoderTailNote: 'informational: samples the bundled FFmpeg decodes past the container (edit-list) duration; a joiner must trim them',
    checks, points: results, wallMs: Date.now() - t0};
}
