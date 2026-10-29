#!/usr/bin/env node
// Prints markdown tables from the long-media artefacts: fixture manifests, verify results, calibration
// checks, bench results and the owner-root inventory (paths + sizes). Read-only.
//   node scripts/long-media/report-summary.mjs [--section manifests,verify,calibration,bench,inventory]
import fs from 'node:fs';
import path from 'node:path';
import {WORK_DIR, OWNER_ROOT} from './lib/env.mjs';
import {inventory} from './lib/ledger.mjs';
import {parseArgs, list} from './lib/cli.mjs';
import {gib, freeBytes} from './lib/space.mjs';

const o = parseArgs();
const sections = list(o.section) ?? ['manifests', 'verify', 'calibration', 'bench', 'inventory'];
const readDir = d => (fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'))) : []);
const mb = b => (b / 2 ** 20).toFixed(1);

if (sections.includes('manifests')) {
  console.log('\n### Fixture manifests\n\n| id | path | bytes | sha256 | duration (s) | frames | audio | encode | speed | fps |\n|---|---|---:|---|---:|---:|---|---:|---:|---:|');
  for (const m of readDir(path.join(WORK_DIR, 'fixtures')).sort((a, b) => a.id.localeCompare(b.id))) {
    const a = m.expected.audio;
    console.log(`| ${m.id} | ${m.path} | ${m.bytes} (${mb(m.bytes)} MiB) | \`${m.sha256}\` | ${m.expected.durationSeconds} | ${m.expected.outputFrames} | ${a ? `${a.sampleRate} Hz ${a.layout} (${a.samples} samples)` : 'none'} | ${(m.timing.encodeSeconds / 60).toFixed(1)} min | ${m.timing.speedX}x | ${m.timing.fps} |`);
  }
}
if (sections.includes('verify')) {
  console.log('\n### Verification\n');
  for (const v of readDir(path.join(WORK_DIR, 'verify')).sort((a, b) => a.id.localeCompare(b.id))) {
    console.log(`- **${v.id}**: ${v.status} (hash ${v.hash ? (v.hash.ok ? 'ok' : 'MISMATCH') : 'skipped'}, frames ${v.frames.status}, audio ${v.audio.status}, max audio error ${v.audio.maxAbsErrorSamples ?? '-'} samples, ${v.wallSeconds} s)`);
    for (const p of v.frames.points) console.log(`  - frame \`${p.name}\` ${p.hms}: ${p.status}, identity ${p.targetIdentity} (expected ${p.expected?.identity}), pts ticks ${p.expected?.ptsTicks}, decoded ${(p.decoded || []).map(f => f.identity).join(', ')}`);
    for (const p of v.audio.points || []) console.log(`  - audio \`${p.name}\` ${p.hms}: ${p.status}, seconds ${(p.expectedSeconds || []).join(', ')}, max |error| ${Math.max(0, ...(p.channels || []).map(c => c.maxAbsErrorSamples ?? 0))} samples`);
  }
}
if (sections.includes('calibration')) {
  const f = path.join(WORK_DIR, 'calibration', 'CALIBRATION.json');
  if (fs.existsSync(f)) {
    const c = JSON.parse(fs.readFileSync(f, 'utf8'));
    console.log(`\n### Calibration (${c.summary.ok}/${c.summary.checks} as expected)\n\n| check | expected | got | ok |\n|---|---|---|---|`);
    for (const k of c.checks) console.log(`| ${k.name} | ${k.expect} | ${k.got} | ${k.ok ? 'yes' : '**NO**'} |`);
    if (c.determinism) console.log(`\nDeterminism: ${JSON.stringify(c.determinism)}`);
    if (c.observations) console.log(`\nObservations: ${JSON.stringify(c.observations)}`);
  }
}
if (sections.includes('bench')) {
  const d = path.join(WORK_DIR, 'bench');
  if (fs.existsSync(d)) for (const run of fs.readdirSync(d)) {
    const f = path.join(d, run, 'RESULT.json');
    if (!fs.existsSync(f)) continue;
    const r = JSON.parse(fs.readFileSync(f, 'utf8'));
    console.log(`\n- **${r.runId}** (${r.workload.id}, target ${r.target}): status ${r.status}; LV-06 ${JSON.stringify(r.lv06)}; verdicts ${JSON.stringify(r.verdicts)}; stages ${JSON.stringify(r.timing.stages)}; peaks ${JSON.stringify(r.resources.peaks)}`);
  }
}
if (sections.includes('inventory')) {
  const inv = inventory(OWNER_ROOT);
  const total = inv.reduce((s, x) => s + x.bytes, 0);
  console.log(`\n### Owner root inventory: ${OWNER_ROOT} (${inv.length} files, ${total} bytes = ${gib(total)} GiB; volume free ${gib(freeBytes(OWNER_ROOT))} GiB)\n\n| path | bytes |\n|---|---:|`);
  for (const x of inv) console.log(`| ${x.path} | ${x.bytes} |`);
}
