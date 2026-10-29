import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {OWNER_ROOT, ownerPath, assertInsideOwnerRoot, assertNotSystemDrive, assertNoReparseAncestry} from './lib/env.mjs';
import {removeOwnedFile, removeOwnedScratchDir} from './lib/ledger.mjs';
import {planCheck, GiB} from './lib/space.mjs';
import {derive, getSpec, makeSpec, LONG_IDS, CALIB_IDS} from './lib/fixtures.mjs';
import {generateFixture} from './lib/generate.mjs';
import {generatorArgs, movieTimescale} from './lib/ffmpeg-args.mjs';

const ok = fs.existsSync(path.parse(OWNER_ROOT).root);
const DIR = ownerPath('unit', `env-${process.pid}-${Date.now()}`);
after(() => {
  if (!ok || !fs.existsSync(DIR)) return;
  const j = path.join(DIR, 'junction');
  try { fs.lstatSync(j); try { fs.unlinkSync(j); } catch { fs.rmdirSync(j); } } catch { /* no junction */ } // removes the link only
  removeOwnedScratchDir(DIR, 'env test finished');
});

test('owner-root guards', () => {
  assert.equal(assertInsideOwnerRoot(path.join(OWNER_ROOT, 'a', 'b.mp4')), path.join(OWNER_ROOT, 'a', 'b.mp4'));
  assert.throws(() => assertInsideOwnerRoot('D:\\Creator\\x.mp4'), /outside the owner root/);
  assert.throws(() => assertInsideOwnerRoot(OWNER_ROOT + 'X\\a.mp4'), /outside the owner root/);
  assert.throws(() => assertInsideOwnerRoot(OWNER_ROOT), /owner root itself/);
  assert.throws(() => assertNotSystemDrive('C:\\Users\\x.mp4'), /system drive/);
  assert.equal(assertNotSystemDrive('E:\\x.mp4'), 'E:\\x.mp4');
  assert.throws(() => removeOwnedFile('D:\\Creator\\apps\\editor\\package.json', 'test'), /outside the owner root/);
  assert.throws(() => removeOwnedScratchDir(path.join(OWNER_ROOT, 'fixtures', 'long'), 'test'), /not an owned scratch dir/);
});

test('a junction in the owned ancestry is refused', {skip: ok ? false : 'owner volume missing'}, () => {
  fs.mkdirSync(path.join(DIR, 'real'), {recursive: true});
  fs.symlinkSync(path.join(DIR, 'real'), path.join(DIR, 'junction'), 'junction');
  assert.throws(() => assertNoReparseAncestry(path.join(DIR, 'junction', 'x.mp4')), /reparse point/);
  assert.equal(assertNoReparseAncestry(path.join(DIR, 'real', 'x.mp4')), path.join(DIR, 'real', 'x.mp4'));
  assert.equal(removeOwnedFile(path.join(DIR, 'real', 'missing.mp4'), 'test'), false);
});

test('generation refuses before encoding when the free-space floor would be crossed', {skip: ok ? false : 'owner volume missing'}, async () => {
  const tiny = makeSpec({id: 'U-floor', width: 320, height: 180, fps: '30/1', frames: 30, video: {codec: 'libx264', profile: 'high', preset: 'veryfast', keyint: 30, bframes: 0, bitrate: '200k', threads: 1}});
  fs.mkdirSync(DIR, {recursive: true});
  const out = path.join(DIR, 'floor.mp4');
  await assert.rejects(generateFixture(tiny, {outPath: out, writeManifest: false, minFreeBytes: 1e15, log: () => {}}), /floor/);
  assert.equal(fs.existsSync(out) || fs.existsSync(`${out}.part`), false);
});

test('generation budget: 40 GiB cap and free-space rule', () => {
  const p = [{id: 'x', expected: 4 * GiB, worstCase: 5 * GiB}];
  assert.equal(planCheck({planned: p, ownedBytes: 0, free: 200 * GiB}).ok, true);
  assert.match(planCheck({planned: p, ownedBytes: 36 * GiB, free: 200 * GiB}).reason, /exceeds the 40\.00 GiB cap/);
  assert.match(planCheck({planned: p, ownedBytes: 0, free: 12 * GiB}).reason, /free space/);
});

test('fixture matrix: LV-01 coverage, budgets and exact derived values', () => {
  const ids = new Set(LONG_IDS);
  for (const id of ['F1-1080p30-12h', 'F2-1080p2997-12h', 'F3-360p2997-25h', 'F4-2160p30-30m', 'F5-1080p60-51-30m', 'F6-1080p30-noaudio-30m', 'F7-1080p30-vfr-30m']) assert.ok(ids.has(id), id);
  const f1 = derive(getSpec('F1-1080p30-12h'));
  assert.equal(f1.outputFrames, 1296000);
  assert.equal(f1.audioSamples, 2073600000);
  assert.ok(f1.estimateBytes.worstCase <= 6 * GiB, 'F1 worst case <= 6 GiB');
  const f3 = derive(getSpec('F3-360p2997-25h'));
  assert.ok(f3.audioSamples > 2 ** 32, '25 h fixture crosses 2^32 samples');
  assert.equal(derive(getSpec('F7-1080p30-vfr-30m')).outputFrames, 54000 - 7714);
  assert.ok(LONG_IDS.reduce((s, id) => s + derive(getSpec(id)).estimateBytes.worstCase, 0) < 40 * GiB);
  assert.equal(CALIB_IDS.length, 9);
  assert.equal(movieTimescale(getSpec('F2-1080p2997-12h'), derive(getSpec('F2-1080p2997-12h'))), 4410000);
  const {args} = generatorArgs(getSpec('F1-1080p30-12h'), 'E:\\x.mp4.part');
  for (const a of ['-n', '-nostdin', '-fflags', '-b:v', '-movie_timescale', 'setparams=color_primaries=bt709']) assert.ok(args.some(x => x === a || String(x).includes(a)), a);
  for (const a of ['-maxrate', '-bufsize']) assert.ok(!args.includes(a), `${a} must not be used: VBV makes multi-threaded x264 non-deterministic`);
});
