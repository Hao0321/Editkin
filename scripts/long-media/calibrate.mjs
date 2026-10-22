#!/usr/bin/env node
// Calibration (LV-08: evaluators are calibrated on short real media before any long run).
//   node scripts/long-media/calibrate.mjs [--skip-determinism] [--only-section frames,audio,seam,quality,determinism,fixtures]
// 1. determinism: regenerate C1 into scratch and compare sha256 with its manifest;
// 2. every calibration fixture verified at its default points (frames + audio);
// 3. positive and negative controls derived from C1/C8 with recorded FFmpeg argv (under <owner root>\controls);
//    a negative control the evaluator does not reject is a calibration FAILURE;
// 4. seam and quality evaluator controls.
// Writes .rd/benchmarks/usable-v1-20261009/work/long-media/calibration/CALIBRATION.json
import fs from 'node:fs';
import path from 'node:path';
import {getSpec, makeSpec, CALIB_IDS} from './lib/fixtures.mjs';
import {generateFixture, manifestWorkPath, writeJson} from './lib/generate.mjs';
import {evaluateFrames, evaluateAudio} from './lib/evaluate.mjs';
import {evaluateSeamConcat, evaluateSeamCompare, evaluateSeamWithin} from './lib/seam.mjs';
import {evaluateQuality} from './lib/quality.mjs';
import {verifyFixture} from './verify-fixture.mjs';
import {runChecked} from './lib/proc.mjs';
import {sha256File} from './lib/hash.mjs';
import {FFMPEG, ownerPath, workPath, ensureOwnerRoot, lowerOwnPriority} from './lib/env.mjs';
import {ledgerAppend, removeOwnedFile} from './lib/ledger.mjs';
import {parseArgs, list} from './lib/cli.mjs';

lowerOwnPriority();
ensureOwnerRoot();
const o = parseArgs();
const sections = list(o['only-section']) ?? ['determinism', 'fixtures', 'frames', 'audio', 'seam', 'quality'];
const OUT = workPath('calibration');
const man = id => JSON.parse(fs.readFileSync(manifestWorkPath(getSpec(id)), 'utf8'));
const C1 = man('C1-1080p30-2m'), C8A = man('C8-1080p30-segA-1m'), C8B = man('C8-1080p30-segB-1m');
const specC1 = getSpec('C1-1080p30-2m');
const spec20 = makeSpec({...specC1, id: 'C1-first20s', frames: 600});
const spec25 = makeSpec({...specC1, id: 'C1-first25s', frames: 750});
const CTRL = (...p) => ownerPath('controls', ...p);
const X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-threads', '4', '-pix_fmt', 'yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv'];
const MP4 = ['-movflags', '+faststart', '-fflags', '+bitexact', '-map_metadata', '-1'];

/** Derived control media: [id, ffmpeg args builder(src, out), source manifest]. */
const CONTROLS = {
  'P-remux': {src: C1, args: (s, d) => ['-i', s, '-map', '0', '-c', 'copy', ...MP4, d], what: 'stream-copy remux of C1 (positive: identical packets)'},
  'P-reencode-hq-20s': {src: C1, args: (s, d) => ['-i', s, '-t', '20', '-map', '0', ...X264, '-crf', '12', '-c:a', 'aac', '-b:a', '192k', ...MP4, d], what: 'first 20 s re-encoded at high quality (positive for identity/audio positions; quality reference pair)'},
  'N-crf45-20s': {src: C1, args: (s, d) => ['-i', s, '-t', '20', '-map', '0', ...X264, '-crf', '45', '-c:a', 'copy', ...MP4, d], what: 'first 20 s heavily compressed (negative for quality)'},
  'N-drop-frame-20s': {src: C1, args: (s, d) => ['-i', s, '-t', '20', '-map', '0', '-vf', "select='not(eq(n,299))',setpts=N/(30*TB)", ...X264, '-crf', '16', '-c:a', 'copy', ...MP4, d], what: 'frame 299 dropped and the rest retimed (negative: one-frame drift)'},
  'N-dup-frame-20s': {src: C1, args: (s, d) => ['-i', s, '-t', '20', '-map', '0', '-vf', 'loop=loop=1:size=1:start=300,setpts=N/(30*TB)', ...X264, '-crf', '16', '-c:a', 'copy', ...MP4, d], what: 'frame 300 duplicated and the rest retimed (negative)'},
  'N-fps15-20s': {src: C1, args: (s, d) => ['-i', s, '-t', '20', '-map', '0', '-vf', 'fps=15', ...X264, '-crf', '16', '-c:a', 'copy', ...MP4, d], what: 'frame rate lowered to 15 fps (negative: fps downgrade)'},
  'N-scale540-20s': {src: C1, args: (s, d) => ['-i', s, '-t', '20', '-map', '0', '-vf', 'scale=960:540', ...X264, '-crf', '16', '-c:a', 'copy', ...MP4, d], what: 'resolution lowered to 960x540 (negative: size downgrade; identity must still decode)'},
  'N-audio-delay1024-20s': {src: C1, args: (s, d) => ['-i', s, '-t', '20', '-map', '0', '-c:v', 'copy', '-af', 'adelay=delays=1024S:all=1', '-c:a', 'aac', '-b:a', '192k', ...MP4, d], what: 'audio delayed by 1024 samples (negative: uncompensated AAC priming size)'},
  'N-audio-delay3-20s': {src: C1, args: (s, d) => ['-i', s, '-t', '20', '-map', '0', '-c:v', 'copy', '-af', 'adelay=delays=3S:all=1', '-c:a', 'aac', '-b:a', '192k', ...MP4, d], what: 'audio delayed by 3 samples (negative: just above the 2-sample tolerance)'},
  'P-audio-reencode-20s': {src: C1, args: (s, d) => ['-i', s, '-t', '20', '-map', '0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', ...MP4, d], what: 'audio re-encoded with no shift (positive: a second AAC generation stays within tolerance)'},
  'N-audio-44k1-20s': {src: C1, args: (s, d) => ['-i', s, '-t', '20', '-map', '0', '-c:v', 'copy', '-ar', '44100', '-c:a', 'aac', '-b:a', '192k', ...MP4, d], what: 'audio resampled to 44.1 kHz (negative: sample-rate change)'},
  'N-long-audio-25s': {src: C1, args: (s, d) => ['-i', s, '-filter_complex', '[0:v]trim=end_frame=600[v];[0:a]atrim=end_sample=1200000[a]', '-map', '[v]', '-map', '[a]', ...X264, '-crf', '16', '-c:a', 'aac', '-b:a', '192k', ...MP4, d], what: '20 s of video under 25 s of audio (negative: long audio hides a short video EOF)'},
  'P-concat-trimmed-8A8B': {src: C8A, src2: C8B, args: (s, d, s2) => ['-i', s, '-i', s2, '-filter_complex',
    `[0:a]atrim=end_sample=${C8A.expected.audio.samples}[a0];[1:a]atrim=end_sample=${C8B.expected.audio.samples}[a1];[0:v][a0][1:v][a1]concat=n=2:v=1:a=1[v][a]`,
    '-map', '[v]', '-map', '[a]', ...X264, '-crf', '16', '-c:a', 'aac', '-b:a', '192k', ...MP4, d], what: 'C8A+C8B joined by the concat filter with each audio trimmed to its container duration (positive seam at 60 s)'},
  'N-concat-untrimmed-8A8B': {src: C8A, src2: C8B, args: (s, d, s2) => ['-i', s, '-i', s2, '-filter_complex', '[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]', '-map', '[v]', '-map', '[a]', ...X264, '-crf', '16', '-c:a', 'aac', '-b:a', '192k', ...MP4, d], what: 'C8A+C8B joined by the plain concat filter: FFmpeg decodes A\'s AAC end padding, so B\'s audio lands late (negative: seam drift)'},
  'O-concat-copy-8A8B': {src: C8A, src2: C8B, list: true, what: 'C8A+C8B joined by the concat demuxer with -c copy (observation: AAC priming at the join)'},
};

async function makeControl(id) {
  const c = CONTROLS[id];
  const out = CTRL(`${id}.mp4`);
  if (fs.existsSync(out)) return {id, path: out, existing: true, ...(await sha256File(out))};
  fs.mkdirSync(path.dirname(out), {recursive: true});
  let args;
  if (c.list) {
    const lst = CTRL(`${id}.txt`);
    fs.writeFileSync(lst, `ffconcat version 1.0\nfile '${c.src.path.replace(/\\/g, '/')}'\nfile '${c.src2.path.replace(/\\/g, '/')}'\n`);
    ledgerAppend({action: 'create', path: lst, kind: 'control-list', id});
    args = ['-hide_banner', '-nostdin', '-n', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', lst, '-map', '0', '-c', 'copy', ...MP4, out];
  } else args = ['-hide_banner', '-nostdin', '-n', '-loglevel', 'error', ...c.args(c.src.path, out, c.src2?.path)];
  const r = await runChecked(FFMPEG, args);
  const h = await sha256File(out);
  ledgerAppend({action: 'create', path: out, kind: 'control', id, bytes: h.bytes, sha256: h.sha256});
  return {id, path: out, what: c.what, argv: [FFMPEG, ...args], wallMs: Math.round(r.wallMs), ...h};
}

if (o['fresh-controls']) {
  // controls are derived from the calibration fixtures; rebuild them after the fixtures changed
  for (const id of [...Object.keys(CONTROLS), 'N-truncated-tail']) for (const ext of ['.mp4', '.txt']) {
    const p = CTRL(`${id}${ext}`);
    if (fs.existsSync(p)) removeOwnedFile(p, 'fresh controls requested (source fixtures regenerated)');
  }
}
for (const retired of ['P-concat-filter-8A8B']) { // superseded control (it was an untrimmed join wrongly labelled positive)
  const p = CTRL(`${retired}.mp4`);
  if (fs.existsSync(p)) removeOwnedFile(p, 'retired control: replaced by P-concat-trimmed / N-concat-untrimmed');
}

const results = {schema: 'editkin.longMedia.calibration/v1', startedAt: new Date().toISOString(), sections, determinism: null, fixtures: {}, controls: {}, checks: []};
const prevPath = path.join(OUT, 'CALIBRATION.json');
if (!sections.includes('determinism') && fs.existsSync(prevPath)) {
  // the determinism section re-encodes C1; when it is not re-run (e.g. while a long encode is running) the
  // previous result for the SAME generator is carried forward and labelled as such
  const prev = JSON.parse(fs.readFileSync(prevPath, 'utf8'));
  if (prev.determinism) {
    results.determinism = {...prev.determinism, carriedFrom: prev.startedAt};
    results.checks.push({...prev.checks.find(c => c.name.startsWith('determinism')), carriedFrom: prev.startedAt});
  }
}
const record = (name, expect, got, detail) => {
  const ok = expect === got;
  results.checks.push({name, expect, got, ok, ...detail});
  console.log(`${ok ? 'ok  ' : 'BAD '} ${name}: expected ${expect}, got ${got}`);
};
const save = () => writeJson(path.join(OUT, 'CALIBRATION.json'), {...results, finishedAt: new Date().toISOString(),
  summary: {checks: results.checks.length, ok: results.checks.filter(c => c.ok).length, bad: results.checks.filter(c => !c.ok).map(c => c.name)}});
const keep = (name, r) => { writeJson(path.join(OUT, `${name.replace(/[^A-Za-z0-9._-]+/g, '_')}.json`), r); return r; };

if (sections.includes('determinism')) {
  const rerun = ownerPath('scratch', 'determinism', 'C1-1080p30-2m.rerun.mp4');
  for (const p of [rerun, `${rerun}.samples.jsonl`]) if (fs.existsSync(p)) removeOwnedFile(p, 'stale determinism rerun');
  const r = await generateFixture(getSpec('C1-1080p30-2m'), {outPath: rerun, writeManifest: false, log: () => {}});
  const h = await sha256File(rerun);
  results.determinism = {fixture: 'C1-1080p30-2m', manifestSha256: C1.sha256, rerunSha256: h.sha256, bytes: h.bytes, identical: h.sha256 === C1.sha256, rerunEncodeSeconds: r.manifest.timing.encodeSeconds};
  record('determinism: regenerated C1 is byte-identical', true, h.sha256 === C1.sha256, results.determinism);
  removeOwnedFile(rerun, 'determinism rerun compared; not needed');
  if (fs.existsSync(`${rerun}.samples.jsonl`)) removeOwnedFile(`${rerun}.samples.jsonl`, 'samples of the determinism rerun');
  save();
}

if (sections.includes('fixtures')) {
  for (const id of CALIB_IDS) {
    const v = await verifyFixture(id);
    results.fixtures[id] = {status: v.status, hash: v.hash?.ok, frames: v.frames.status, audio: v.audio.status, maxAudioErrorSamples: v.audio.maxAbsErrorSamples ?? null,
      points: v.points, minContrast: Math.min(...v.frames.points.flatMap(p => p.decoded.map(f => f.minContrast)))};
    record(`fixture ${id} verifies (hash + frames + audio)`, 'PASS', v.status, results.fixtures[id]);
    save();
  }
}

const ctl = {};
async function control(id) { if (!ctl[id]) { ctl[id] = await makeControl(id); results.controls[id] = (({data, ...x}) => x)(ctl[id]); } return ctl[id]; }

if (sections.includes('frames')) {
  const f = async (id, spec, expect, extra = {}) => {
    const c = id === 'C1' ? {path: C1.path} : await control(id);
    const r = keep(`frames-${id}`, await evaluateFrames({file: c.path, spec, ...extra}));
    record(`frames ${id}`, expect, r.status, {failedChecks: r.checks.filter(x => !x.ok).map(x => x.name), points: r.points.map(p => `${p.name}:${p.status}:${p.targetIdentity}`)});
    return r;
  };
  await f('C1', specC1, 'PASS', {points: ['start', 'middle', '59', '60', '119', 'last', '0.5', '33.366667']});
  await f('P-remux', specC1, 'PASS');
  await f('P-reencode-hq-20s', spec20, 'PASS');
  await f('N-drop-frame-20s', spec20, 'FAIL');
  await f('N-dup-frame-20s', spec20, 'FAIL');
  await f('N-fps15-20s', spec20, 'FAIL');
  const sc = await f('N-scale540-20s', spec20, 'FAIL');
  record('identity still decodes at 960x540 (only the size check fails)', true, sc.points.every(p => p.status === 'PASS') && sc.checks.filter(c => !c.ok).every(c => c.name === 'dimensions'), {});
  await f('N-long-audio-25s', spec25, 'FAIL');
  // truncated tail: copy of C1 cut at 85 % of its bytes
  const trunc = CTRL('N-truncated-tail.mp4');
  if (!fs.existsSync(trunc)) {
    const b = fs.readFileSync(C1.path);
    fs.writeFileSync(trunc, b.subarray(0, Math.floor(b.length * 0.85)));
    ledgerAppend({action: 'create', path: trunc, kind: 'control', id: 'N-truncated-tail', bytes: Math.floor(b.length * 0.85)});
  }
  results.controls['N-truncated-tail'] = {id: 'N-truncated-tail', path: trunc, what: 'C1 with the last 15 % of its bytes cut (negative: corrupt tail)'};
  let tr;
  try { tr = await evaluateFrames({file: trunc, spec: specC1}); } catch (e) { tr = {status: 'FAIL', error: e.message.slice(0, 500)}; }
  keep('frames-N-truncated-tail', tr);
  record('frames N-truncated-tail', 'FAIL', tr.status, {error: tr.error, points: tr.points?.map(p => `${p.name}:${p.status}`)});
  save();
}

if (sections.includes('audio')) {
  const a = async (id, spec, expect) => {
    const c = id === 'C1' ? {path: C1.path} : await control(id);
    const r = keep(`audio-${id}`, await evaluateAudio({file: c.path, spec}));
    const errs = (r.points || []).flatMap(p => p.channels.flatMap(ch => (ch.markers || []).map(m => m.errorSamples)));
    record(`audio ${id}`, expect, r.status, {maxAbsErrorSamples: r.maxAbsErrorSamples, errors: [...new Set(errs)].slice(0, 12), failedChecks: (r.checks || []).filter(x => !x.ok).map(x => x.name)});
    return r;
  };
  await a('C1', specC1, 'PASS');
  await a('P-remux', specC1, 'PASS');
  await a('P-audio-reencode-20s', spec20, 'PASS');
  await a('P-reencode-hq-20s', spec20, 'PASS');
  await a('N-audio-delay1024-20s', spec20, 'FAIL');
  await a('N-audio-delay3-20s', spec20, 'FAIL');
  await a('N-audio-44k1-20s', spec20, 'FAIL');
  save();
}

if (sections.includes('seam')) {
  const s = async (name, expect, fn) => { const r = keep(`seam-${name}`, await fn()); record(`seam ${name}`, expect, r.status, {failedChecks: r.checks.filter(x => !x.ok).map(x => ({name: x.name, ...x}))}); return r; };
  await s('concat C8A->C8B', 'PASS', () => evaluateSeamConcat({a: C8A.path, b: C8B.path}));
  await s('concat C8A->C8A (gap)', 'FAIL', () => evaluateSeamConcat({a: C8A.path, b: C8A.path}));
  const pf = await control('P-concat-trimmed-8A8B');
  await s('within concat-trimmed @60', 'PASS', () => evaluateSeamWithin({file: pf.path, at: '60'}));
  const nf = await control('N-concat-untrimmed-8A8B');
  await s('within concat-untrimmed @60 (AAC end padding)', 'FAIL', () => evaluateSeamWithin({file: nf.path, at: '60'}));
  const dr = await control('N-drop-frame-20s');
  await s('within drop-frame @10', 'FAIL', () => evaluateSeamWithin({file: dr.path, at: '10'}));
  const rm = await control('P-remux');
  await s('compare C1 vs remux @60', 'PASS', () => evaluateSeamCompare({a: C1.path, b: rm.path, at: '60'}));
  await s('compare C1 vs drop-frame @10', 'FAIL', () => evaluateSeamCompare({a: C1.path, b: dr.path, at: '10'}));
  const ar = await control('P-audio-reencode-20s');
  const cmpAudio = await s('compare C1 vs audio-reencode @10 (null test)', 'FAIL', () => evaluateSeamCompare({a: C1.path, b: ar.path, at: '10'}));
  results.observations = {...(results.observations || {}), audioReencodeNullTest: cmpAudio.checks.find(c => c.name.startsWith('audio null'))};
  const oc = await control('O-concat-copy-8A8B');
  const obs = keep('seam-observation-concat-copy', await evaluateSeamWithin({file: oc.path, at: '60'}));
  results.observations = {...results.observations, concatDemuxerCopyAt60: {status: obs.status, checks: obs.checks}};
  console.log(`obs  concat demuxer -c copy C8A+C8B within @60: ${obs.status}`);
  save();
}

if (sections.includes('quality')) {
  const statsDir = workPath('calibration', 'quality-stats');
  const q = async (name, d, ref, windows, expect) => { const r = keep(`quality-${name}`, await evaluateQuality({distorted: d, reference: ref, windows, statsDir: path.join(statsDir, name)})); record(`quality ${name}`, expect, r.status, {windows: r.windows.map(w => ({psnrAvg: w.psnrAvg, ssimAll: w.ssimAll, below: [w.framesBelowPsnr, w.framesBelowSsim], identity: w.identity?.equal}))}); return r; };
  const rm = await control('P-remux'), hq = await control('P-reencode-hq-20s'), lo = await control('N-crf45-20s'), dr = await control('N-drop-frame-20s');
  await q('remux-vs-C1', rm.path, C1.path, [{start: '0', duration: '5'}, {start: '60', duration: '5'}, {start: '115', duration: '5'}], 'PASS');
  await q('hq-reencode-vs-C1', hq.path, C1.path, [{start: '0', duration: '10'}, {start: '10', duration: '10'}], 'PASS');
  await q('crf45-vs-C1', lo.path, C1.path, [{start: '0', duration: '10'}], 'FAIL');
  await q('drop-frame-vs-C1', dr.path, C1.path, [{start: '5', duration: '10'}], 'FAIL');
  save();
}

save();
const bad = results.checks.filter(c => !c.ok);
console.log(`\ncalibration: ${results.checks.length - bad.length}/${results.checks.length} checks as expected${bad.length ? `; unexpected: ${bad.map(b => b.name).join('; ')}` : ''}`);
process.exitCode = bad.length ? 1 : 0;
