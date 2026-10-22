#!/usr/bin/env node
// Long-media WP-D fixture generator (LV-01 minimum matrix, synthetic, deterministic).
//
//   vendor\node\win32-x64\node.exe scripts\long-media\generate-fixtures.mjs --list
//   vendor\node\win32-x64\node.exe scripts\long-media\generate-fixtures.mjs --set calib
//   vendor\node\win32-x64\node.exe scripts\long-media\generate-fixtures.mjs --only F1-1080p30-12h [--dry-run]
//
// Options: --set calib|long, --only id[,id], --dry-run (print plan + argv only), --threads N, --force,
//          --sampler-interval-ms N (default 2000), --min-free-gib N (volume floor before and during each encode).
// Media goes ONLY under the owner root (E:\Editkin-LongMediaTest by default); manifests go to
// .rd/benchmarks/usable-v1-20261009/work/long-media/fixtures/. Runs at BELOW_NORMAL priority, one encode at a time.
import fs from 'node:fs';
import {LONG_IDS, CALIB_IDS, getSpec, derive, describe} from './lib/fixtures.mjs';
import {generateFixture, fixturePath, manifestWorkPath} from './lib/generate.mjs';
import {generatorArgs} from './lib/ffmpeg-args.mjs';
import {planCheck, freeBytes, gib, GiB} from './lib/space.mjs';
import {dirBytes} from './lib/ledger.mjs';
import {OWNER_ROOT, ensureOwnerRoot, lowerOwnPriority, FFMPEG} from './lib/env.mjs';

function argOf(name, def) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; }
const has = n => process.argv.includes(n);

lowerOwnPriority();
if (has('--list')) {
  for (const id of [...LONG_IDS, ...CALIB_IDS]) { const s = describe(getSpec(id)); console.log(`${id.padEnd(26)} ${String(s.width + 'x' + s.height).padEnd(10)} ${s.fps.padEnd(11)} ${String(s.outputFrames).padStart(8)} fr ${s.durationSeconds.padStart(16)} s  ~${gib(s.estimateBytes.expected)} GiB (worst ${gib(s.estimateBytes.worstCase)})  ${s.purpose}`); }
  process.exit(0);
}
const ids = argOf('--only') ? argOf('--only').split(',') : argOf('--set') === 'long' ? LONG_IDS : argOf('--set') === 'calib' ? CALIB_IDS : null;
if (!ids) { console.error('usage: --set calib|long | --only id[,id] [--dry-run] [--threads N] [--force] | --list'); process.exit(2); }
const specs = ids.map(getSpec);
ensureOwnerRoot();
const pending = specs.filter(s => has('--force') || !fs.existsSync(fixturePath(s)));
const plan = planCheck({planned: pending.map(s => ({id: s.id, ...derive(s).estimateBytes})), ownedBytes: dirBytes(OWNER_ROOT).bytes, free: freeBytes(OWNER_ROOT)});
console.log(`Owner root ${OWNER_ROOT}\nPlan (${pending.length} to generate, ${specs.length - pending.length} present):\n${plan.lines.join('\n')}`);
if (has('--dry-run')) {
  for (const s of specs) console.log(`\n# ${s.id}\n${JSON.stringify([FFMPEG, ...generatorArgs(s, fixturePath(s) + '.part', {threads: argOf('--threads') ? Number(argOf('--threads')) : undefined}).args])}`);
  process.exit(plan.ok ? 0 : 3);
}
if (!plan.ok) { console.error(`STOP: ${plan.reason}`); process.exit(3); }
// --min-free-gib N: the owner volume must stay above N GiB free, before (free - worst case) and during each encode
const minFreeBytes = argOf('--min-free-gib') ? Number(argOf('--min-free-gib')) * GiB : undefined;
if (minFreeBytes !== undefined) {
  const left = freeBytes(OWNER_ROOT) - plan.worst;
  console.log(`  floor: ${gib(minFreeBytes)} GiB must stay free; after the planned worst case ${gib(left)} GiB would remain`);
  if (left < minFreeBytes) { console.error(`STOP: free space would drop below the ${gib(minFreeBytes)} GiB floor`); process.exit(3); }
}
let failed = 0;
for (const s of specs) {
  try {
    const r = await generateFixture(s, {threads: argOf('--threads') ? Number(argOf('--threads')) : undefined, force: has('--force'), samplerIntervalMs: Number(argOf('--sampler-interval-ms', 2000)), minFreeBytes});
    console.log(`manifest: ${manifestWorkPath(s)}${r.skipped ? ' (existing)' : ''}`);
  } catch (e) { failed++; console.error(`[FAIL] ${s.id}: ${e.message}`); }
}
process.exit(failed ? 1 : 0);
