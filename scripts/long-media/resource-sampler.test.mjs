import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ResourceSampler} from './lib/resource-sampler.mjs';
import {runProcess} from './lib/proc.mjs';
import {OWNER_ROOT, ownerPath} from './lib/env.mjs';
import {removeOwnedScratchDir} from './lib/ledger.mjs';

const ok = fs.existsSync(path.parse(OWNER_ROOT).root);
const DIR = ownerPath('unit', `sampler-${process.pid}-${Date.now()}`);
after(() => { if (ok && fs.existsSync(DIR)) removeOwnedScratchDir(DIR, 'sampler test finished'); });

test('samples a writing child: CPU time, working set, bytes written, watched bytes, volume free', {skip: ok ? false : 'owner volume missing'}, async () => {
  fs.mkdirSync(DIR, {recursive: true});
  const target = path.join(DIR, 'w.bin'), jsonl = path.join(DIR, 's.jsonl');
  // child: writes 5 x 4 MiB with 1.5 s pauses (~7 s, robust to a slow, heavily loaded machine) and burns some CPU
  const script = `const fs=require('fs');const f=fs.openSync(${JSON.stringify(target)},'w');let i=0;const b=Buffer.alloc(4<<20,1);
const step=()=>{fs.writeSync(f,b);fs.fsyncSync(f);let x=0;for(let k=0;k<3e7;k++)x+=k;if(++i<5)setTimeout(step,1500);else fs.closeSync(f);};step();`;
  const sampler = new ResourceSampler({intervalMs: 300, watchPaths: [target], jsonlPath: jsonl});
  await sampler.warmup();
  const r = await runProcess(process.execPath, ['-e', script], {onSpawn: c => { sampler.start(c.pid); }});
  assert.equal(r.code, 0);
  assert.equal(r.priority, 'PRIORITY_BELOW_NORMAL');
  const s = await sampler.stop();
  const rows = fs.readFileSync(jsonl, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(s.samples >= 4, `samples ${s.samples}`);
  assert.equal(rows.length, s.samples);
  assert.equal(s.peaks.watchedBytes, 20 << 20);
  assert.ok(s.peaks.treeWorkingSetBytes > 0);
  assert.ok(s.treeBytesWrittenObserved >= 4 << 20, `written ${s.treeBytesWrittenObserved}`);
  assert.ok(s.treeCpuSecondsObserved > 0);
  assert.ok(rows.some(x => x.tree && x.tree.n >= 1));
  assert.ok(Object.keys(s.minFreeBytes).includes('E:'));
  assert.ok(rows.every((x, i) => i === 0 || x.t >= rows[i - 1].t));
  // cadence: slow process-tree queries must not stretch the sample interval (they run asynchronously)
  const gaps = rows.slice(1, -1).map((x, i) => x.t - rows[i].t).sort((a, b) => a - b);
  assert.ok(gaps[Math.floor(gaps.length / 2)] <= 600, `median gap ${gaps[Math.floor(gaps.length / 2)]} ms for a 300 ms interval`);
  assert.ok(rows.filter(x => x.tree).every(x => x.tree.ageMs >= 0));
  // rates are computed between snapshots: they can never exceed the machine (a response-arrival clock did: 170 "cores")
  assert.ok(s.peaks.treeCores <= os.cpus().length * 1.1, `peak tree cores ${s.peaks.treeCores} > ${os.cpus().length} logical CPUs`);
  const cum = rows.filter(x => x.tree).map(x => x.tree.cpuSecondsCumulative);
  assert.ok(cum.every((v, i) => i === 0 || v >= cum[i - 1]));
  assert.equal(sampler.psExited, true, 'helper must exit on stop');
});

test('system-only sampling (no process tree) works and stops cleanly', async () => {
  const sampler = new ResourceSampler({intervalMs: 200});
  await sampler.start(null);
  await new Promise(r => setTimeout(r, 700));
  const s = await sampler.stop();
  assert.ok(s.samples >= 3);
  assert.equal(s.peaks.processCount, 0);
  assert.ok(s.peaks.systemMemUsedBytes > 0);
});
