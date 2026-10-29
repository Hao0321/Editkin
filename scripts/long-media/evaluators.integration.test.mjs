// Integration tests on tiny real clips made by the generator (320x180, a few seconds) under
// <owner root>\unit\run-*; the folder is removed afterwards. Needs the bundled FFmpeg and the owner volume.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {makeSpec} from './lib/fixtures.mjs';
import {generateFixture} from './lib/generate.mjs';
import {evaluateFrames, evaluateAudio} from './lib/evaluate.mjs';
import {evaluateSeamConcat, evaluateSeamCompare, evaluateSeamWithin} from './lib/seam.mjs';
import {evaluateQuality} from './lib/quality.mjs';
import {aevalsrcFilter, referenceSample} from './lib/identity-audio.mjs';
import {runChecked} from './lib/proc.mjs';
import {sha256File} from './lib/hash.mjs';
import {FFMPEG, OWNER_ROOT, ownerPath} from './lib/env.mjs';
import {removeOwnedScratchDir} from './lib/ledger.mjs';

const ownerVolumeOk = fs.existsSync(path.parse(OWNER_ROOT).root);
const UNIT = ownerPath('unit', `run-${process.pid}-${Date.now()}`);
const V = {codec: 'libx264', profile: 'high', preset: 'veryfast', keyint: 30, bframes: 2, bitrate: '300k', threads: 2};
const ST = {sampleRate: 48000, layout: 'stereo', channels: 2, bitrate: '96k'};
const S = {
  u30: makeSpec({id: 'U-30', width: 320, height: 180, fps: '30/1', frames: 120, audio: ST, video: V}),
  late: makeSpec({id: 'U-2997-late', width: 320, height: 180, fps: '30000/1001', frames: 120, startFrame: 2679321, audio: {sampleRate: 44100, layout: 'mono', channels: 1, bitrate: '64k'}, video: V}),
  vfr: makeSpec({id: 'U-vfr', width: 320, height: 180, fps: '30/1', frames: 120, vfr: {dropMod: 7, dropRem: 3}, audio: ST, video: V}),
  noaudio: makeSpec({id: 'U-noaudio', width: 320, height: 180, fps: '30/1', frames: 60, video: V}),
  ch51: makeSpec({id: 'U-60-51', width: 320, height: 180, fps: '60/1', frames: 150, audio: {sampleRate: 48000, layout: '5.1', channels: 6, bitrate: '192k'}, video: {...V, keyint: 60}}),
  segA: makeSpec({id: 'U-segA', width: 320, height: 180, fps: '30/1', frames: 60, audio: ST, video: V}),
  segB: makeSpec({id: 'U-segB', width: 320, height: 180, fps: '30/1', frames: 60, startFrame: 60, audio: ST, video: V}),
  baseline: makeSpec({id: 'U-baseline', width: 320, height: 180, fps: '30/1', frames: 90, audio: ST, video: {...V, profile: 'baseline', bframes: 0}}),
};
const P = {};
const gen = async (spec, name = spec.id) => (await generateFixture(spec, {outPath: path.join(UNIT, `${name}.mp4`), writeManifest: false, samplerIntervalMs: 1000, log: () => {}})).path;
const ff = args => runChecked(FFMPEG, ['-hide_banner', '-nostdin', '-n', '-loglevel', 'error', ...args]);
const X = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-threads', '2', '-pix_fmt', 'yuv420p'];

before(async () => {
  if (!ownerVolumeOk) return;
  fs.mkdirSync(UNIT, {recursive: true});
  for (const k of Object.keys(S)) P[k] = await gen(S[k]);
});
after(() => { if (ownerVolumeOk && fs.existsSync(UNIT)) removeOwnedScratchDir(UNIT, 'unit test run finished'); });

const t = (name, fn) => test(name, {skip: ownerVolumeOk ? false : `owner volume ${OWNER_ROOT} not available`}, fn);

t('generator is deterministic: same argv twice gives the same bytes', async () => {
  const again = await gen(S.u30, 'U-30-again');
  assert.equal((await sha256File(again)).sha256, (await sha256File(P.u30)).sha256);
});

t('aevalsrc expression equals the JS reference (5.1 incl. LFE, offset across 2^32)', async () => {
  const A0 = 2 ** 32 - 24000, R = 48000, N = 72000;
  const r = await runChecked(FFMPEG, ['-hide_banner', '-v', 'error', '-filter_complex', `${aevalsrcFilter({R, layout: '5.1', channels: 6, A0})},atrim=end_sample=${N}[a]`,
    '-map', '[a]', '-f', 'f32le', '-c:a', 'pcm_f32le', 'pipe:1'], {collectStdout: true});
  const ab = new ArrayBuffer(r.stdout.length); new Uint8Array(ab).set(r.stdout);
  const f = new Float32Array(ab);
  assert.equal(f.length, N * 6);
  let maxd = 0;
  for (let i = 0; i < N; i += 7) for (let c = 0; c < 6; c++) maxd = Math.max(maxd, Math.abs(f[i * 6 + c] - referenceSample(A0 + i, R, c, c === 3)));
  assert.ok(maxd < 1e-5, `max difference ${maxd}`);
});

t('frame identity PASS: CFR, 29.97 late offset, VFR, 60 fps, no audio', async () => {
  for (const k of ['u30', 'late', 'vfr', 'ch51', 'noaudio']) {
    const r = await evaluateFrames({file: P[k], spec: S[k]});
    assert.equal(r.status, 'PASS', `${k}: ${JSON.stringify(r.points.filter(p => p.status !== 'PASS').map(p => [p.name, p.decoded?.map(f => [f.pts, f.identity, f.expectedIdentity])]))} ${JSON.stringify(r.checks.filter(c => !c.ok))}`);
  }
});

t('audio positions PASS: 48 kHz stereo, 44.1 kHz mono late offset, 5.1 with LFE burst; none for no-audio', async () => {
  for (const k of ['u30', 'late', 'vfr', 'ch51']) {
    const r = await evaluateAudio({file: P[k], spec: S[k]});
    assert.equal(r.status, 'PASS', `${k}: ${JSON.stringify(r.checks.filter(c => !c.ok))} ${JSON.stringify(r.points?.filter(p => p.status !== 'PASS'))}`);
    assert.ok(r.maxAbsErrorSamples <= 2);
  }
  const lfe = (await evaluateAudio({file: P.ch51, spec: S.ch51})).points[0].channels[3];
  assert.equal(lfe.lfe, true);
  assert.ok(lfe.bursts.every(b => b.present));
  assert.equal((await evaluateAudio({file: P.noaudio, spec: S.noaudio})).status, 'NOT_APPLICABLE');
});

t('the marker at sample 0 decodes with its AAC priming frame (Baseline video, no B-frame delay)', async () => {
  // regression: an input seek to 0 skipped the priming packet and muted samples 0..456 (found on F3)
  const r = await evaluateAudio({file: P.baseline, spec: S.baseline, points: ['start']});
  assert.equal(r.status, 'PASS', JSON.stringify(r.points[0]?.channels?.map(c => ({missing: c.missing, ks: c.markers.map(m => m.k)}))));
  assert.deepEqual(r.points[0].channels[0].markers.map(m => m.k), [0, 1]);
  assert.equal(r.points[0].channels[0].markers[0].errorSamples, 0);
});

t('negative controls: a dropped frame and a 1024-sample audio delay are rejected', async () => {
  const drop = path.join(UNIT, 'N-drop.mp4'), delay = path.join(UNIT, 'N-delay.mp4');
  await ff(['-i', P.u30, '-map', '0', '-vf', "select='not(eq(n,45))',setpts=N/(30*TB)", ...X, '-c:a', 'copy', drop]);
  await ff(['-i', P.u30, '-map', '0', '-c:v', 'copy', '-af', 'adelay=delays=1024S:all=1', '-c:a', 'aac', '-b:a', '128k', delay]);
  assert.equal((await evaluateFrames({file: drop, spec: S.u30})).status, 'FAIL');
  const a = await evaluateAudio({file: delay, spec: S.u30});
  assert.equal(a.status, 'FAIL');
  const errs = a.points.flatMap(p => p.channels.flatMap(c => c.markers.map(m => m.errorSamples)));
  assert.ok(errs.some(e => Math.abs(e - 1024) <= 2), `errors ${errs}`);
  assert.equal((await evaluateFrames({file: P.u30, spec: S.ch51})).status, 'FAIL'); // wrong expectation (60 fps) is not accepted
});

t('seams: consecutive concat PASS, gap FAIL, compare/within PASS, null test sees re-encoded audio', async () => {
  assert.equal((await evaluateSeamConcat({a: P.segA, b: P.segB})).status, 'PASS');
  assert.equal((await evaluateSeamConcat({a: P.segA, b: P.segA})).status, 'FAIL');
  const remux = path.join(UNIT, 'P-remux.mp4');
  await ff(['-i', P.u30, '-map', '0', '-c', 'copy', remux]);
  const c = await evaluateSeamCompare({a: P.u30, b: remux, at: '2'});
  assert.equal(c.status, 'PASS');
  assert.equal(c.pixelVerdict, 'IDENTICAL');
  // a correct joiner trims each part's audio to its container duration: exact seam
  const joined = path.join(UNIT, 'P-joined.mp4');
  await ff(['-i', P.segA, '-i', P.segB, '-filter_complex', '[0:a]atrim=end_sample=96000[a0];[1:a]atrim=end_sample=96000[a1];[0:v][a0][1:v][a1]concat=n=2:v=1:a=1[v][a]',
    '-map', '[v]', '-map', '[a]', ...X, '-c:a', 'aac', '-b:a', '128k', joined]);
  assert.equal((await evaluateSeamWithin({file: joined, at: '2'})).status, 'PASS');
  // the plain concat filter keeps the AAC end padding FFmpeg decodes from part A: B lands 256 samples late
  const naive = path.join(UNIT, 'N-joined-untrimmed.mp4');
  await ff(['-i', P.segA, '-i', P.segB, '-filter_complex', '[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]', '-map', '[v]', '-map', '[a]', ...X, '-c:a', 'aac', '-b:a', '128k', naive]);
  const nv = await evaluateSeamWithin({file: naive, at: '2'});
  assert.equal(nv.status, 'FAIL');
  const sp = nv.checks.find(c => c.name.startsWith('audio marker spacing')).spacings[0];
  assert.ok(Math.abs(sp.spacing - sp.expected - 256) <= 2, JSON.stringify(sp));
  const cc = await evaluateSeamConcat({a: P.segA, b: P.segB});
  assert.equal(cc.audio.aDecoderTailExcessSamples, 256);
  assert.equal(cc.warnings.length, 1);
  const reA = path.join(UNIT, 'P-reaudio.mp4');
  await ff(['-i', P.u30, '-map', '0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', reA]);
  const n = await evaluateSeamCompare({a: P.u30, b: reA, at: '2'});
  assert.equal(n.status, 'FAIL');
  assert.equal(n.pixelVerdict, 'IDENTICAL');
});

t('quality: identical media PASS (inf dB), heavy compression FAIL', async () => {
  const statsDir = path.join(UNIT, 'q');
  const remux = path.join(UNIT, 'P-remux.mp4');
  if (!fs.existsSync(remux)) await ff(['-i', P.u30, '-map', '0', '-c', 'copy', remux]);
  const ok = await evaluateQuality({distorted: remux, reference: P.u30, windows: [{start: '0', duration: '2'}], statsDir});
  assert.equal(ok.status, 'PASS');
  assert.equal(ok.windows[0].psnrAvg.min, 'inf');
  const bad = path.join(UNIT, 'N-crf51.mp4');
  await ff(['-i', P.u30, '-map', '0:v', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '51', '-threads', '2', bad]);
  const b = await evaluateQuality({distorted: bad, reference: P.u30, windows: [{start: '0', duration: '2'}], statsDir});
  assert.equal(b.status, 'FAIL');
  assert.ok(b.windows[0].framesBelowPsnr > 0);
});
