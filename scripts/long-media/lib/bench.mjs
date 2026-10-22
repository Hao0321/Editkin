// Bench runner core: other work packages plug a workload in; the runner records the LV-06 numbers.
//
// Workload contract (an object or a module whose default export is (opts) => object):
//   {
//     id: 'wp-b-chunked-composite-v1',          // what is measured (route + version)
//     family: 'copy' | 'render',                 // LV-06 workload family
//     describe?(): object,                       // free-form facts recorded in the result (settings, project, etc.)
//     async run(ctx) -> {outputPath, mediaSeconds?, notes?}
//     async reference?(ctx) -> path              // high-precision reference with the SAME effects (render family)
//   }
// ctx: {runId, workDir (owned, on the owner volume), outputPath(name), stage(name, fn), spawn(cmd, args, opts), input, inputs, log}
// Stage names should follow LV-06: prepare, decode, effects, audio, encode, mux, faststart, verify, identity, cleanup.
// All-in wall time = the whole run() (the product's own QA/cleanup belong inside it). The benchmark's external
// evaluation (identity/audio/quality checks below) is timed separately and never counted as product speed.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {performance} from 'node:perf_hooks';
import {FFMPEG, FFPROBE, OWNER_ROOT, ownerPath, workPath, ensureOwnerRoot, hostFacts, lowerOwnPriority, assertNoReparseAncestry, assertInsideOwnerRoot} from './env.mjs';
import {runProcess} from './proc.mjs';
import {sha256File} from './hash.mjs';
import {ffprobeJson, probeFacts} from './probe.mjs';
import {ResourceSampler} from './resource-sampler.mjs';
import {writeJson, toolIdentity} from './generate.mjs';
import {evaluateFrames, evaluateAudio, defaultPoints} from './evaluate.mjs';
import {evaluateQuality} from './quality.mjs';
import {evaluateSeamWithin} from './seam.mjs';
import {ledgerAppend, removeOwnedFile, dirBytes} from './ledger.mjs';
import {volumeRoot, freeBytes, planCheck} from './space.mjs';

/** LV-06 initial targets (CODEX_LONG_MEDIA_EXPORT_20261013.md); never lowered by the runner. */
export const LV06_TARGETS = Object.freeze({
  'copy-1080p30': {realtimeXMin: 20, baselineThroughputFractionMin: 0.70, quality: 'packet / decoded-frame identity'},
  'basic-1080p30': {realtimeXMin: 4, speedupVsLegacyMin: 2, quality: {psnrMinDb: 40, ssimMin: 0.995}},
  'basic-2160p30': {realtimeXMin: 1, quality: {psnrMinDb: 40, ssimMin: 0.995}, note: 'if not reached on this hardware, record the bottleneck'},
  'complex': {baselineFirst: true, speedupVsBaselineMin: 2, quality: {psnrMinDb: 40, ssimMin: 0.995}},
});

async function gpuFacts() {
  try {
    const r = await runProcess('nvidia-smi', ['--query-gpu=name,driver_version,memory.total,memory.used', '--format=csv,noheader'], {timeoutMs: 15000});
    return r.code === 0 ? r.stdoutTail.trim().split(/\r?\n/).map(l => { const [name, driver, memTotal, memUsed] = l.split(',').map(s => s.trim()); return {name, driver, memTotal, memUsed}; }) : null;
  } catch { return null; }
}

/** Sequential copy throughput between the input volume and the output volume (fsync'd, then removed). */
export async function measureCopyThroughput(src, destDir) {
  fs.mkdirSync(destDir, {recursive: true});
  const dst = path.join(destDir, `throughput-${process.pid}-${Date.now()}.bin`);
  const t0 = performance.now();
  const fin = fs.openSync(src, 'r'), fout = fs.openSync(dst, 'wx');
  const buf = Buffer.allocUnsafe(8 * 1024 * 1024);
  let n, total = 0;
  try {
    while ((n = fs.readSync(fin, buf, 0, buf.length, null)) > 0) { fs.writeSync(fout, buf, 0, n); total += n; }
    fs.fsyncSync(fout);
  } finally { fs.closeSync(fin); fs.closeSync(fout); }
  const sec = (performance.now() - t0) / 1000;
  ledgerAppend({action: 'create', path: dst, kind: 'throughput-probe', bytes: total});
  removeOwnedFile(dst, 'throughput probe measured');
  return {bytes: total, seconds: +sec.toFixed(3), bytesPerSecond: Math.round(total / sec), from: src, toDir: destDir,
    caveat: total < os.totalmem() ? 'source smaller than RAM: the read side may be served from the OS cache' : null};
}

/**
 * opts: {runId, workload, input (fixture manifest object), inputs?: [manifest], target?: key of LV06_TARGETS,
 *        checks?: {points?: [..], quality?: [{start, duration}], seams?: [t..]}, baselineThroughput?: bool,
 *        legacyResult?: path of an earlier RESULT.json to compute speedup against, samplerIntervalMs?: 2000, keepOutput?: bool, log?}
 */
export async function runBench(opts) {
  lowerOwnPriority();
  ensureOwnerRoot();
  const {workload, input, target = null, checks = {}, samplerIntervalMs = 2000, log = console.log} = opts;
  const runId = opts.runId || `${workload.id}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const workDir = opts.workDir ? assertInsideOwnerRoot(opts.workDir) : ownerPath('bench', runId);
  fs.mkdirSync(workDir, {recursive: true});
  assertNoReparseAncestry(workDir);
  const resultDir = opts.resultDir || workPath('bench', runId);
  fs.mkdirSync(resultDir, {recursive: true});
  const inputs = opts.inputs || [input];
  const env = {host: hostFacts(), gpu: await gpuFacts(), ffmpeg: await toolIdentity(FFMPEG), ffprobe: await toolIdentity(FFPROBE),
    volumes: {input: volumeRoot(input.path), output: volumeRoot(workDir), sameVolume: volumeRoot(input.path).toLowerCase() === volumeRoot(workDir).toLowerCase(),
      outputFreeBefore: freeBytes(workDir)}};
  // frozen inputs: manifest sha256 + size/mtime check (a full re-hash of multi-GiB inputs is opt-in)
  const frozen = [];
  for (const m of inputs) {
    const st = fs.statSync(m.path);
    const rec = {id: m.id, path: m.path, manifestSha256: m.sha256, bytes: st.size, sizeMatchesManifest: st.size === m.bytes, mtime: st.mtime.toISOString()};
    if (opts.rehashInputs) { const h = await sha256File(m.path); rec.rehashSha256 = h.sha256; rec.rehashMatches = h.sha256 === m.sha256; }
    frozen.push(rec);
  }
  if (frozen.some(f => !f.sizeMatchesManifest || f.rehashMatches === false)) throw new Error(`input does not match its manifest: ${JSON.stringify(frozen)}`);
  // space plan before writing anything big: output (+ baseline copy) estimate against the 40 GiB cap and free space
  const inBytes = inputs.reduce((s, m) => s + m.bytes, 0);
  const estimate = opts.estimateBytes ?? Math.ceil(inBytes * 1.1 * (opts.baselineThroughput ? 2 : 1));
  const plan = planCheck({planned: [{id: runId, expected: estimate, worstCase: estimate}], ownedBytes: dirBytes(OWNER_ROOT).bytes, free: freeBytes(workDir)});
  log(`[bench] ${runId}: space plan\n${plan.lines.join('\n')}`);
  if (!plan.ok) throw new Error(`bench ${runId} refused: ${plan.reason}`);
  // background load just before the run (5 s of system CPU, no tree)
  const pre = new ResourceSampler({intervalMs: 1000, volumes: [env.volumes.output]});
  await pre.start(null); await new Promise(r => setTimeout(r, 5000));
  const background = await pre.stop();
  const baseline = opts.baselineThroughput ? await measureCopyThroughput(input.path, path.join(workDir, 'throughput')) : null;

  const stages = [], children = [];
  let phase = 'product';
  const sampler = new ResourceSampler({intervalMs: samplerIntervalMs, watchPaths: [workDir], volumes: [...new Set([env.volumes.output, env.volumes.input, 'C:\\'])],
    jsonlPath: path.join(resultDir, 'samples.jsonl')});
  await sampler.start(process.pid);
  const ctx = {
    runId, workDir, input, inputs, log,
    outputPath: name => path.join(workDir, name),
    async stage(name, fn) {
      const s = {name, startMs: performance.now()};
      try { return await fn(); } finally { s.endMs = performance.now(); s.seconds = +((s.endMs - s.startMs) / 1000).toFixed(3); stages.push(s); }
    },
    async spawn(cmd, args, o = {}) {
      const r = await runProcess(cmd, args, o);
      children.push({phase, cmd, argv: [cmd, ...args], exe: cmd === FFMPEG || cmd === FFPROBE ? await toolIdentity(cmd) : null, code: r.code, timedOut: r.timedOut,
        wallSeconds: +(r.wallMs / 1000).toFixed(3), priority: r.priority, stdoutTail: (r.stdoutTail || '').slice(-4000), stderrTail: r.stderrTail.slice(-4000)});
      if (r.code !== 0 && !o.allowFailure) throw new Error(`child failed (${r.code}): ${cmd} ${args.join(' ').slice(0, 300)}\n${r.stderrTail.slice(-1500)}`);
      return r;
    },
  };
  const t0 = performance.now();
  let out, error = null;
  try { out = await workload.run(ctx); } catch (e) { error = e.message; }
  const wallSeconds = (performance.now() - t0) / 1000;
  phase = 'evaluation';
  const resources = await sampler.stop();
  const timing = {
    allInWallSeconds: +wallSeconds.toFixed(3),
    stages: stages.map(s => ({name: s.name, seconds: s.seconds, startOffsetSeconds: +((s.startMs - t0) / 1000).toFixed(3)})),
  };
  timing.unstagedSeconds = +(wallSeconds - stages.reduce((a, s) => a + s.seconds, 0)).toFixed(3);
  const result = {schema: 'editkin.longMedia.benchResult/v1', runId, workload: {id: workload.id, family: workload.family, describe: workload.describe?.() ?? null},
    target, targets: target ? LV06_TARGETS[target] : null, labels: opts.labels || [], startedAt: new Date(Date.now() - wallSeconds * 1000).toISOString(),
    environment: env, frozenInputs: frozen, backgroundLoad: {systemCpuPctAvg: background.averages.systemCpuPct, peak: background.peaks.systemCpuPct},
    baselineThroughput: baseline, timing, children, resources, error};
  if (error) { result.status = 'ERROR'; writeJson(path.join(resultDir, 'RESULT.json'), result); return result; }

  // output identity
  const outPath = out.outputPath;
  const tq = performance.now();
  const probe = await ffprobeJson(outPath);
  const facts = probeFacts(probe.json);
  const outHash = await sha256File(outPath);
  ledgerAppend({action: 'create', path: outPath, kind: 'bench-output', id: runId, bytes: outHash.bytes, sha256: outHash.sha256});
  const mediaSeconds = out.mediaSeconds !== undefined ? Number(out.mediaSeconds) : Number(facts.format.duration);
  result.output = {path: outPath, bytes: outHash.bytes, sha256: outHash.sha256, facts, notes: out.notes ?? null};
  // external evaluation (not product time)
  const evals = {};
  const spec = opts.spec;
  if (spec) {
    const pts = checks.points || defaultPoints(spec);
    evals.frames = await evaluateFrames({file: outPath, spec, points: pts, probe: probe.json});
    evals.audio = await evaluateAudio({file: outPath, spec, points: pts, probe: probe.json});
  }
  for (const t of checks.seams || []) (evals.seams ||= []).push(await evaluateSeamWithin({file: outPath, at: t}));
  if (checks.quality?.length) {
    const ref = workload.reference ? await workload.reference(ctx) : (checks.referencePath || input.path);
    evals.quality = await evaluateQuality({distorted: outPath, reference: ref, windows: checks.quality, statsDir: path.join(resultDir, 'quality')});
    evals.quality.referencePath = ref;
    if (ref.toLowerCase().startsWith(workDir.toLowerCase() + path.sep) && fs.existsSync(ref)) {
      const st = fs.statSync(ref);
      evals.quality.referenceBytes = st.size;
      ledgerAppend({action: 'create', path: ref, kind: 'bench-reference', id: runId, bytes: st.size});
      if (!opts.keepOutput) { removeOwnedFile(ref, `bench ${runId} reference used`); evals.quality.referenceRemovedAfterEvaluation = true; }
    }
  }
  result.evaluation = Object.fromEntries(Object.entries(evals).map(([k, v]) => [k, Array.isArray(v) ? v.map(x => ({status: x.status, ...x})) : v]));
  result.evaluationWallSeconds = +((performance.now() - tq) / 1000).toFixed(3);

  // LV-06 numbers
  const inputBytes = inputs.reduce((s, m) => s + m.bytes, 0);
  const lv06 = {mediaSeconds, allInWallSeconds: timing.allInWallSeconds, realtimeX: +(mediaSeconds / wallSeconds).toFixed(3),
    outputBytes: outHash.bytes, outputBytesPerSecond: Math.round(outHash.bytes / wallSeconds), inputBytes, inputBytesPerSecond: Math.round(inputBytes / wallSeconds)};
  if (baseline) lv06.throughputFractionOfBaseline = +(lv06.inputBytesPerSecond / baseline.bytesPerSecond).toFixed(3);
  if (opts.legacyResult) {
    const legacy = JSON.parse(fs.readFileSync(opts.legacyResult, 'utf8'));
    lv06.legacyAllInWallSeconds = legacy.timing.allInWallSeconds;
    lv06.speedupVsLegacy = +(legacy.timing.allInWallSeconds / wallSeconds).toFixed(3);
  }
  result.lv06 = lv06;
  const verdicts = {};
  const T = target ? LV06_TARGETS[target] : null;
  if (T) {
    if (T.realtimeXMin !== undefined) verdicts.realtime = lv06.realtimeX >= T.realtimeXMin ? 'PASS' : 'FAIL';
    if (T.baselineThroughputFractionMin !== undefined) verdicts.throughput = lv06.throughputFractionOfBaseline === undefined ? 'NOT_MEASURED' : lv06.throughputFractionOfBaseline >= T.baselineThroughputFractionMin ? 'PASS' : 'FAIL';
    if (T.speedupVsLegacyMin !== undefined) verdicts.speedupVsLegacy = lv06.speedupVsLegacy === undefined ? 'NOT_MEASURED' : lv06.speedupVsLegacy >= T.speedupVsLegacyMin ? 'PASS' : 'FAIL';
    if (T.speedupVsBaselineMin !== undefined) verdicts.speedupVsBaseline = lv06.speedupVsLegacy === undefined ? 'NOT_MEASURED' : lv06.speedupVsLegacy >= T.speedupVsBaselineMin ? 'PASS' : 'FAIL';
    verdicts.quality = evals.quality ? evals.quality.status : (T.quality && typeof T.quality === 'object' ? 'NOT_MEASURED' : (evals.frames ? evals.frames.status : 'NOT_MEASURED'));
  }
  for (const k of ['frames', 'audio']) if (evals[k]) verdicts[k] = evals[k].status;
  if (evals.seams) verdicts.seams = evals.seams.every(s => s.status === 'PASS') ? 'PASS' : 'FAIL';
  result.verdicts = verdicts;
  result.status = Object.values(verdicts).every(v => v === 'PASS' || v === 'NOT_APPLICABLE') ? 'PASS' : Object.values(verdicts).includes('FAIL') ? 'FAIL' : 'INCOMPLETE';
  result.environment.volumes.outputFreeAfter = freeBytes(workDir);
  if (!opts.keepOutput) { removeOwnedFile(outPath, `bench ${runId} evaluated (sha256 recorded)`); result.output.removedAfterEvaluation = true; }
  writeJson(path.join(resultDir, 'RESULT.json'), result);
  return result;
}
