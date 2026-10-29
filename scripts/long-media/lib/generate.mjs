// Fixture generation: .part -> probe-verified -> rename -> sha256 -> manifest (+ ledger, + resource samples).
import fs from 'node:fs';
import path from 'node:path';
import {FFMPEG, FFPROBE, APP_ROOT, OWNER_ROOT, TMP_DIR, ensureOwnerRoot, ownerPath, workPath, assertNoReparseAncestry, hostFacts, lowerOwnPriority} from './env.mjs';
import {runProcess, progressParser} from './proc.mjs';
import {sha256File} from './hash.mjs';
import {ffprobeJson, probeFacts} from './probe.mjs';
import {generatorArgs} from './ffmpeg-args.mjs';
import {derive, describe} from './fixtures.mjs';
import {ledgerAppend, removeOwnedFile} from './ledger.mjs';
import {ResourceSampler} from './resource-sampler.mjs';
import {freeBytes, gib, MIN_FREE_DURING_RUN} from './space.mjs';
import {VIDEO_IDENTITY} from './identity-video.mjs';
import {AUDIO_IDENTITY, audioTiming} from './identity-audio.mjs';
import {toDecimalString} from './rational.mjs';

const toolCache = new Map();
export async function toolIdentity(p) {
  if (!toolCache.has(p)) toolCache.set(p, {path: p, ...(await sha256File(p))});
  return toolCache.get(p);
}

export function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), {recursive: true});
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, p);
  return p;
}

export const fixturePath = spec => ownerPath('fixtures', spec.set, `${spec.id}.mp4`);
export const manifestWorkPath = spec => workPath('fixtures', `${spec.id}.manifest.json`);

/** Facts checked right after encoding, before the .part is published. */
export function verifyProbe(spec, facts) {
  const d = derive(spec), v = facts.video, a = facts.audio[0];
  const problems = [];
  if (!v) problems.push('no video stream');
  else {
    if (v.width !== spec.width || v.height !== spec.height) problems.push(`size ${v.width}x${v.height}`);
    if (v.nbFrames !== d.outputFrames) problems.push(`frames ${v.nbFrames} != ${d.outputFrames}`);
    if (v.pix_fmt !== 'yuv420p') problems.push(`pix_fmt ${v.pix_fmt}`);
    if (v.color_primaries !== 'bt709' || v.color_transfer !== 'bt709' || v.color_space !== 'bt709' || v.color_range !== 'tv') problems.push('colour tags');
  }
  if (spec.audio) {
    if (!a) problems.push('no audio stream');
    else {
      if (a.sampleRate !== spec.audio.sampleRate) problems.push(`sample rate ${a.sampleRate}`);
      if (a.channels !== spec.audio.channels) problems.push(`channels ${a.channels}`);
      if (Number(a.duration_ts) !== d.audioSamples) problems.push(`audio duration_ts ${a.duration_ts} != ${d.audioSamples}`);
    }
  } else if (a) problems.push('unexpected audio stream');
  return problems;
}

/**
 * Generates one fixture. opts: {threads, force, outPath (override, must be inside the owner root),
 * samplerIntervalMs, log, writeManifest (default true)}.
 */
export async function generateFixture(spec, opts = {}) {
  const {threads, force = false, samplerIntervalMs = 2000, log = console.log, writeManifest = true, minFreeBytes = MIN_FREE_DURING_RUN} = opts;
  lowerOwnPriority();
  ensureOwnerRoot();
  const out = opts.outPath ? ownerPath(path.relative(OWNER_ROOT, opts.outPath)) : fixturePath(spec);
  fs.mkdirSync(path.dirname(out), {recursive: true});
  assertNoReparseAncestry(path.dirname(out));
  const mPath = writeManifest ? manifestWorkPath(spec) : null;
  if (fs.existsSync(out) && !force) {
    if (mPath && fs.existsSync(mPath)) {
      const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
      if (m.bytes === fs.statSync(out).size) { log(`[skip] ${spec.id}: exists with manifest (${m.sha256.slice(0, 12)}…)`); return {skipped: true, manifest: m}; }
    }
    throw new Error(`${out} exists without a matching manifest; refusing to overwrite (use --force to regenerate)`);
  }
  if (fs.existsSync(out) && force) removeOwnedFile(out, `regenerate ${spec.id} (--force)`);
  const part = `${out}.part`;
  if (fs.existsSync(part)) removeOwnedFile(part, `stale .part of ${spec.id}`);
  const d = derive(spec);
  const {args, layout} = generatorArgs(spec, part, {threads});
  const free0 = freeBytes(out);
  // free-space floor: the volume must stay above minFreeBytes even after the worst-case output is written
  if (free0 - d.estimateBytes.worstCase < minFreeBytes) {
    throw new Error(`STOP ${spec.id}: free ${gib(free0)} GiB minus worst case ${gib(d.estimateBytes.worstCase)} GiB would fall below the ${gib(minFreeBytes)} GiB floor`);
  }
  const ff = await toolIdentity(FFMPEG);
  log(`[gen] ${spec.id}: ${spec.width}x${spec.height} ${d.fpsString} ${d.outputFrames} frames (${d.durationDecimal} s)` +
    `${spec.audio ? `, ${spec.audio.sampleRate} Hz ${spec.audio.layout}` : ', no audio'}; estimate ${gib(d.estimateBytes.expected)} GiB (worst ${gib(d.estimateBytes.worstCase)} GiB); free ${gib(free0)} GiB`);
  // fixture runs keep their samples with the manifests; scratch/unit runs (explicit outPath) keep them next to the
  // output inside the owner root, so test folders are removed with their samples
  const samplesPath = opts.outPath ? `${out}.samples.jsonl` : workPath('samples', `${spec.id}.${Date.now()}.jsonl`);
  let abortReason = null, child = null, lastProgress = null, lastLog = 0;
  const sampler = new ResourceSampler({intervalMs: samplerIntervalMs, watchPaths: [part], jsonlPath: samplesPath, onSample: s => {
    const f = s.free[path.parse(out).root.slice(0, 2)];
    if (f !== null && f !== undefined && f < minFreeBytes && !abortReason) { abortReason = `free space ${gib(f)} GiB below the ${gib(minFreeBytes)} GiB floor`; try { child?.kill(); } catch { /* gone */ } }
  }});
  const ledgerStart = {action: 'create-begin', path: part, kind: 'fixture-part', id: spec.id};
  ledgerAppend(ledgerStart);
  await sampler.warmup();
  const t0 = Date.now();
  const res = await runProcess(FFMPEG, args, {
    cwd: APP_ROOT,
    onSpawn: c => { child = c; sampler.start(c.pid).catch(e => log(`[sampler] ${e.message}`)); },
    onStdoutLine: progressParser(b => {
      lastProgress = b;
      const now = Date.now();
      if (now - lastLog >= 30000 || b.progress === 'end') {
        lastLog = now;
        const fr = Number(b.frame || 0), el = (now - t0) / 1000, rate = fr / Math.max(el, 1e-3);
        const eta = rate > 0 ? (d.outputFrames - fr) / rate : NaN;
        log(`[gen] ${spec.id}: frame ${fr}/${d.outputFrames} (${(100 * fr / d.outputFrames).toFixed(2)}%) ${rate.toFixed(1)} fps, speed ${b.speed}, out ${b.out_time}, size ${gib(Number(b.total_size || 0))} GiB, elapsed ${(el / 60).toFixed(1)} min, ETA ${(eta / 60).toFixed(1)} min`);
      }
    }),
  });
  const samplerSummary = await sampler.stop();
  const encodeMs = Date.now() - t0;
  if (res.code !== 0 || abortReason) {
    removeOwnedFile(part, `failed generation of ${spec.id}`);
    const err = new Error(`generation of ${spec.id} failed: exit ${res.code}${abortReason ? `, aborted: ${abortReason}` : ''}\n${res.stderrTail.slice(-3000)}`);
    err.result = res;
    throw err;
  }
  const tp = Date.now();
  const probe = await ffprobeJson(part);
  const facts = probeFacts(probe.json);
  const problems = verifyProbe(spec, facts);
  if (problems.length) { removeOwnedFile(part, `probe verification failed for ${spec.id}`); throw new Error(`${spec.id}: probe verification failed: ${problems.join('; ')}`); }
  const probeMs = Date.now() - tp;
  if (fs.existsSync(out)) throw new Error(`${out} appeared during generation; refusing to replace it`);
  fs.renameSync(part, out);
  const th = Date.now();
  const {sha256, bytes} = await sha256File(out);
  const hashMs = Date.now() - th;
  const free1 = freeBytes(out);
  ledgerAppend({action: 'create', path: out, kind: 'fixture', id: spec.id, bytes, sha256});
  const manifest = {
    schema: 'editkin.longMedia.fixtureManifest/v1', id: spec.id, set: spec.set, purpose: spec.purpose,
    path: out, bytes, sha256, createdAt: new Date().toISOString(),
    spec: describe(spec),
    expected: {
      fps: d.fpsString, sourceFrames: d.sourceFrames, outputFrames: d.outputFrames, startFrame: spec.startFrame,
      durationSeconds: d.durationDecimal, durationRational: `${d.durationSeconds.num}/${d.durationSeconds.den}`,
      lastFrame: {localIndex: d.lastSourceLocalIndex, identity: d.lastAbsIndex, ptsSeconds: toDecimalString(d.lastPtsSeconds, 6)},
      videoStartSeconds: d.videoStartDecimal,
      audio: spec.audio ? {sampleRate: spec.audio.sampleRate, channels: spec.audio.channels, layout: spec.audio.layout, samples: d.audioSamples, absoluteStartSample: d.audioStartSample} : null,
    },
    identity: {
      video: {...VIDEO_IDENTITY, layout, note: 'barcode word = 24-bit absolute frame index + (index mod 251); burned before any VFR frame drop'},
      audio: spec.audio ? {...AUDIO_IDENTITY, timing: audioTiming(spec.audio.sampleRate), note: 'chirp marker of second k starts at absolute sample k*R'} : null,
    },
    ffprobe: {facts, argv: probe.argv, raw: probe.json},
    generator: {
      argv: [FFMPEG, ...args], cwd: APP_ROOT, env: {TEMP: TMP_DIR, TMP: TMP_DIR},
      ffmpeg: ff, ffprobe: await toolIdentity(FFPROBE),
      script: {path: path.join(APP_ROOT, 'scripts', 'long-media', 'lib', 'generate.mjs')},
      priority: res.priority, threads: threads ?? spec.video.threads,
      deterministic: 'same argv + same ffmpeg binary => same bytes (x264 ABR without VBV; VBV was measured non-deterministic with threads; calibration regenerates C1 and compares sha256)',
    },
    timing: {startedAt: res.startedAt, finishedAt: new Date().toISOString(), encodeSeconds: +(encodeMs / 1000).toFixed(1), probeSeconds: +(probeMs / 1000).toFixed(1),
      hashSeconds: +(hashMs / 1000).toFixed(1), speedX: +(Number(d.durationSeconds.num) / Number(d.durationSeconds.den) / (encodeMs / 1000)).toFixed(3),
      fps: +(d.outputFrames / (encodeMs / 1000)).toFixed(1), lastProgress},
    resources: samplerSummary,
    volume: {path: path.parse(out).root, freeBeforeBytes: free0, freeAfterBytes: free1},
    host: hostFacts(),
    stderrTail: res.stderrTail.slice(-4000),
  };
  if (writeManifest) {
    writeJson(mPath, manifest);
    writeJson(`${out}.manifest.json`, manifest);
    ledgerAppend({action: 'create', path: `${out}.manifest.json`, kind: 'manifest-mirror', id: spec.id});
  }
  log(`[done] ${spec.id}: ${bytes} B sha256 ${sha256} in ${(encodeMs / 60000).toFixed(1)} min (${manifest.timing.fps} fps, ${manifest.timing.speedX}x)`);
  return {skipped: false, manifest, path: out};
}
