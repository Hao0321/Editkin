#!/usr/bin/env node
// LV-06 bench runner (skeleton other work packages plug their renders into).
//   node scripts/long-media/bench-runner.mjs --workload scripts/long-media/workloads/example-ffmpeg-remux.mjs \
//        --fixture C1-1080p30-2m --target copy-1080p30 --baseline-throughput
//   node scripts/long-media/bench-runner.mjs --workload <module> --fixture F1-1080p30-12h --target basic-1080p30 \
//        --quality-window 0:10 --quality-window 21600:10 [--legacy-result <earlier RESULT.json>] [--seam 36000]
// Options: --points a,b,c (identity/audio points; default LV-01 six or scaled), --run-id, --keep-output, --label L,
//          --rehash-inputs, --sampler-interval-ms 2000.
// A workload module's default export is (opts) => workload (see lib/bench.mjs for the contract).
// Results: .rd/benchmarks/usable-v1-20261009/work/long-media/bench/<run-id>/RESULT.json (+ samples.jsonl).
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {runBench, LV06_TARGETS} from './lib/bench.mjs';
import {getSpec} from './lib/fixtures.mjs';
import {manifestWorkPath} from './lib/generate.mjs';
import {APP_ROOT} from './lib/env.mjs';
import {main, list} from './lib/cli.mjs';

main(async o => {
  if (!o.workload || !o.fixture) throw new Error('need --workload <module> and --fixture <id>');
  if (o.target && !LV06_TARGETS[o.target]) throw new Error(`unknown --target ${o.target}; known: ${Object.keys(LV06_TARGETS).join(', ')}`);
  const modPath = [path.resolve(o.workload), path.resolve(APP_ROOT, o.workload)].find(p => fs.existsSync(p));
  if (!modPath) throw new Error(`workload module not found: ${o.workload}`);
  const mod = await import(pathToFileURL(modPath).href);
  const workload = typeof mod.default === 'function' ? mod.default(o) : mod.default;
  const spec = getSpec(o.fixture);
  const input = JSON.parse(fs.readFileSync(manifestWorkPath(spec), 'utf8'));
  const quality = list(o['quality-window'])?.map(w => { const [start, duration] = w.split(':'); return {start, duration}; });
  const r = await runBench({
    runId: o['run-id'], workload, input, spec, target: o.target || null, labels: list(o.label) || [],
    checks: {points: list(o.points), quality, seams: list(o.seam)}, baselineThroughput: !!o['baseline-throughput'],
    legacyResult: o['legacy-result'], keepOutput: !!o['keep-output'], rehashInputs: !!o['rehash-inputs'],
    samplerIntervalMs: o['sampler-interval-ms'] ? Number(o['sampler-interval-ms']) : 2000,
  });
  console.log(JSON.stringify({runId: r.runId, status: r.status, error: r.error, lv06: r.lv06, verdicts: r.verdicts, stages: r.timing.stages,
    resources: {peaks: r.resources.peaks, avgTreeCores: r.resources.averages.treeCores}}, null, 2));
  return {status: r.status === 'ERROR' ? 'ERROR' : 'PASS'}; // a completed measurement exits 0; verdicts live in RESULT.json
});
