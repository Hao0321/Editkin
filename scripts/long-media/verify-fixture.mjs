#!/usr/bin/env node
// Verifies a generated fixture end to end: sha256 against its manifest, then frame identity and audio
// sample positions at the default points (LV-01 six for >=12 h media; scaled analogue for short media).
//   node scripts/long-media/verify-fixture.mjs --fixture F1-1080p30-12h [--points ...] [--skip-hash]
// Writes .rd/benchmarks/usable-v1-20261009/work/long-media/verify/<id>.verify.json
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {getSpec} from './lib/fixtures.mjs';
import {manifestWorkPath, writeJson} from './lib/generate.mjs';
import {evaluateFrames, evaluateAudio, defaultPoints} from './lib/evaluate.mjs';
import {sha256File} from './lib/hash.mjs';
import {ffprobeJson} from './lib/probe.mjs';
import {workPath} from './lib/env.mjs';
import {main, list} from './lib/cli.mjs';

export async function verifyFixture(id, {points, skipHash = false} = {}) {
  const spec = getSpec(id);
  const m = JSON.parse(fs.readFileSync(manifestWorkPath(spec), 'utf8'));
  const t0 = Date.now();
  let hash = null;
  if (!skipHash) {
    const th = Date.now();
    const h = await sha256File(m.path);
    hash = {ok: h.sha256 === m.sha256 && h.bytes === m.bytes, sha256: h.sha256, bytes: h.bytes, seconds: +((Date.now() - th) / 1000).toFixed(1)};
  }
  const probe = (await ffprobeJson(m.path)).json;
  const pts = points || defaultPoints(spec);
  const frames = await evaluateFrames({file: m.path, spec, points: pts, probe});
  const audio = await evaluateAudio({file: m.path, spec, points: pts, probe});
  const status = (hash === null || hash.ok) && frames.status === 'PASS' && (audio.status === 'PASS' || audio.status === 'NOT_APPLICABLE') ? 'PASS' : 'FAIL';
  const r = {schema: 'editkin.longMedia.fixtureVerify/v1', id, path: m.path, manifestSha256: m.sha256, points: pts, hash, frames, audio, status,
    verifiedAt: new Date().toISOString(), wallSeconds: +((Date.now() - t0) / 1000).toFixed(1)};
  writeJson(workPath('verify', `${id}.verify.json`), r);
  return r;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(async o => {
    const r = await verifyFixture(o.fixture, {points: list(o.points), skipHash: !!o['skip-hash']});
    console.log(`${r.id}: ${r.status} (hash ${r.hash ? (r.hash.ok ? 'ok' : 'MISMATCH') : 'skipped'}, frames ${r.frames.status}, audio ${r.audio.status}, max audio error ${r.audio.maxAbsErrorSamples ?? '-'} samples) in ${r.wallSeconds} s`);
    for (const p of r.frames.points) console.log(`  frame ${p.name.padEnd(9)} ${String(p.hms).padStart(13)} ${p.status} identity ${p.targetIdentity} (expected ${p.expected?.identity}) decoded ${(p.decoded || []).map(f => f.identity).join(',')}${p.error ? ' ' + p.error.slice(0, 200) : ''}`);
    for (const p of r.audio.points || []) console.log(`  audio ${p.name.padEnd(9)} ${String(p.hms).padStart(13)} ${p.status} seconds ${p.expectedSeconds} max|err| ${Math.max(0, ...(p.channels || []).map(c => c.maxAbsErrorSamples ?? 0))} samples${p.error ? ' ' + p.error.slice(0, 200) : ''}`);
    return r;
  });
}
