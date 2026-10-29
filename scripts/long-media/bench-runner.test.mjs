import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {runBench, LV06_TARGETS} from './lib/bench.mjs';
import {makeSpec} from './lib/fixtures.mjs';
import {generateFixture} from './lib/generate.mjs';
import {sha256File} from './lib/hash.mjs';
import {OWNER_ROOT, ownerPath} from './lib/env.mjs';
import {removeOwnedScratchDir} from './lib/ledger.mjs';
import remuxWorkload from './workloads/example-ffmpeg-remux.mjs';
import basicWorkload from './workloads/example-ffmpeg-x264-basic.mjs';

const ok = fs.existsSync(path.parse(OWNER_ROOT).root);
const DIR = ownerPath('unit', `bench-${process.pid}-${Date.now()}`);
const spec = makeSpec({id: 'U-bench', width: 320, height: 180, fps: '30/1', frames: 120, audio: {sampleRate: 48000, layout: 'stereo', channels: 2, bitrate: '96k'},
  video: {codec: 'libx264', profile: 'high', preset: 'veryfast', keyint: 30, bframes: 2, bitrate: '300k', threads: 2}});
let input;
before(async () => {
  if (!ok) return;
  fs.mkdirSync(DIR, {recursive: true});
  const r = await generateFixture(spec, {outPath: path.join(DIR, 'U-bench.mp4'), writeManifest: false, samplerIntervalMs: 1000, log: () => {}});
  const h = await sha256File(r.path);
  input = {id: spec.id, path: r.path, bytes: h.bytes, sha256: h.sha256};
});
after(() => { if (ok && fs.existsSync(DIR)) removeOwnedScratchDir(DIR, 'bench test finished'); });
const t = (name, fn) => test(name, {skip: ok ? false : 'owner volume missing'}, fn);
const common = id => ({runId: `unit-${id}`, input, spec, workDir: path.join(DIR, `work-${id}`), resultDir: path.join(DIR, `result-${id}`), samplerIntervalMs: 500, log: () => {}});

t('copy-family run records the LV-06 numbers, stages, environment, resources and evaluations', async () => {
  const r = await runBench({...common('copy'), workload: remuxWorkload(), target: 'copy-1080p30', baselineThroughput: true, checks: {quality: [{start: '0', duration: '2'}]}});
  assert.equal(r.error, null);
  assert.ok(fs.existsSync(path.join(DIR, 'result-copy', 'RESULT.json')));
  assert.ok(fs.existsSync(path.join(DIR, 'result-copy', 'samples.jsonl')));
  assert.deepEqual(r.timing.stages.map(s => s.name), ['mux', 'verify']);
  assert.ok(r.lv06.realtimeX > 0 && r.lv06.mediaSeconds === 4);
  assert.ok(r.lv06.throughputFractionOfBaseline > 0);
  assert.ok(['PASS', 'FAIL'].includes(r.verdicts.realtime) && ['PASS', 'FAIL'].includes(r.verdicts.throughput));
  assert.equal(r.verdicts.frames, 'PASS');
  assert.equal(r.verdicts.audio, 'PASS');
  assert.equal(r.evaluation.quality.status, 'PASS');
  assert.ok(r.environment.ffmpeg.sha256.length === 64 && r.frozenInputs[0].sizeMatchesManifest);
  assert.ok(r.resources.samples >= 1 && r.children.every(c => c.priority === 'PRIORITY_BELOW_NORMAL'));
  assert.equal(r.output.removedAfterEvaluation, true);
  assert.deepEqual(r.targets, LV06_TARGETS['copy-1080p30']);
});

t('render-family run compares against the workload reference (same effects, lossless) and removes it', async () => {
  const r = await runBench({...common('render'), workload: basicWorkload({threads: 2}), target: 'basic-1080p30', checks: {quality: [{start: '0', duration: '2'}]}});
  assert.equal(r.error, null);
  const w = r.evaluation.quality.windows[0];
  assert.equal(w.frames, 60);
  assert.equal(w.identity.equal, true);
  assert.ok(typeof w.psnrAvg.min === 'number' && w.psnrAvg.min > 30, JSON.stringify(w.psnrAvg)); // a real comparison, not inf
  assert.equal(r.evaluation.quality.referenceRemovedAfterEvaluation, true);
  assert.equal(r.verdicts.speedupVsLegacy, 'NOT_MEASURED');
  assert.equal(r.status, Object.values(r.verdicts).includes('FAIL') ? 'FAIL' : 'INCOMPLETE'); // never PASS without the legacy comparison
  assert.ok(r.children.some(c => c.phase === 'evaluation' && c.argv.some(a => String(a).includes('reference-lossless'))));
});

t('a failing workload is recorded as ERROR with its result file', async () => {
  const bad = {id: 'unit-failing', family: 'render', run: async ctx => { await ctx.stage('prepare', async () => {}); throw new Error('boom'); }};
  const r = await runBench({...common('error'), workload: bad});
  assert.equal(r.status, 'ERROR');
  assert.match(r.error, /boom/);
  assert.ok(fs.existsSync(path.join(DIR, 'result-error', 'RESULT.json')));
});

t('a frozen input that does not match its manifest is refused', async () => {
  await assert.rejects(runBench({...common('frozen'), workload: remuxWorkload(), input: {...input, bytes: input.bytes + 1}}), /does not match its manifest/);
});
