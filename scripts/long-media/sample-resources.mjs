#!/usr/bin/env node
// Resource sampler CLI (CPU, RAM, volume free bytes, bytes written) at 2 s intervals by default.
//   node scripts/long-media/sample-resources.mjs --out s.jsonl [--interval-ms 2000] [--watch <path>]... [--volume E:\]... -- <cmd> [args...]
//   node scripts/long-media/sample-resources.mjs --out s.jsonl --pid 1234 --seconds 60
// The wrapped command runs at BELOW_NORMAL priority. Prints the summary (also --summary <json>).
import path from 'node:path';
import {ResourceSampler} from './lib/resource-sampler.mjs';
import {runProcess} from './lib/proc.mjs';
import {writeJson} from './lib/generate.mjs';
import {main, list} from './lib/cli.mjs';

main(async o => {
  const sampler = new ResourceSampler({
    intervalMs: o['interval-ms'] ? Number(o['interval-ms']) : 2000,
    watchPaths: list(o.watch) ?? [], volumes: list(o.volume) ?? ['E:\\', 'C:\\', 'D:\\'],
    jsonlPath: o.out ? path.resolve(o.out) : null,
  });
  let result = null;
  if (o['--']?.length) {
    const [cmd, ...args] = o['--'];
    const r = await runProcess(cmd, args, {cwd: process.cwd(), onSpawn: c => { sampler.start(c.pid); }});
    result = {code: r.code, wallMs: Math.round(r.wallMs), priority: r.priority, stderrTail: r.stderrTail.slice(-2000)};
  } else if (o.pid) {
    await sampler.start(Number(o.pid));
    await new Promise(res => setTimeout(res, Number(o.seconds || 10) * 1000));
  } else throw new Error('give -- <cmd> [args] or --pid N --seconds S');
  const summary = {...(await sampler.stop()), command: result};
  if (o.summary) writeJson(path.resolve(o.summary), summary);
  console.log(JSON.stringify(summary, null, 2));
  return {ok: !result || result.code === 0};
});
