// Child process runner: BELOW_NORMAL priority, owned TEMP/TMP, bounded output tails.
import {spawn} from 'node:child_process';
import os from 'node:os';
import {performance} from 'node:perf_hooks';
import {APP_ROOT, childEnv, priorityName} from './env.mjs';

class Tail {
  constructor(limit) { this.limit = limit; this.chunks = []; this.size = 0; this.total = 0; }
  push(buf) {
    this.total += buf.length; this.chunks.push(buf); this.size += buf.length;
    while (this.size > this.limit && this.chunks.length > 1) this.size -= this.chunks.shift().length;
  }
  text() { const b = Buffer.concat(this.chunks); return b.subarray(Math.max(0, b.length - this.limit)).toString('utf8'); }
}

function lineSplitter(onLine) {
  let rest = '';
  return {
    push(buf) {
      rest += buf.toString('utf8');
      let i;
      while ((i = rest.search(/\r?\n|\r/)) >= 0) {
        const line = rest.slice(0, i);
        rest = rest.slice(i + (rest[i] === '\r' && rest[i + 1] === '\n' ? 2 : 1));
        onLine(line);
      }
    },
    end() { if (rest) onLine(rest); rest = ''; },
  };
}

/**
 * Runs a child to completion (resolves on 'close', i.e. after all stdio closed).
 * opts.collectStdout: keep the full stdout Buffer (for raw frames / PCM).
 * opts.onStdoutLine / onStderrLine: line callbacks.
 * opts.timeoutMs: hard kill after this long (result.timedOut = true).
 * opts.onSpawn(child): called right after spawn (e.g. to attach a resource sampler).
 */
export function runProcess(cmd, args, opts = {}) {
  const {
    cwd = APP_ROOT, env = childEnv(), collectStdout = false, onStdoutLine, onStderrLine,
    tailBytes = 64 * 1024, timeoutMs = 0, onSpawn, belowNormal = true, input,
  } = opts;
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const startedAt = new Date().toISOString();
    let child;
    try {
      child = spawn(cmd, args, {cwd, env, windowsHide: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']});
    } catch (e) { reject(e); return; }
    let priority = null;
    if (belowNormal && child.pid) {
      try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* exited already */ }
    }
    try { priority = priorityName(os.getPriority(child.pid)); } catch { priority = null; }
    const outChunks = [];
    const outTail = new Tail(tailBytes), errTail = new Tail(tailBytes);
    const outLines = onStdoutLine ? lineSplitter(onStdoutLine) : null;
    const errLines = onStderrLine ? lineSplitter(onStderrLine) : null;
    child.stdout.on('data', b => { if (collectStdout) outChunks.push(b); else outTail.push(b); outLines?.push(b); });
    child.stderr.on('data', b => { errTail.push(b); errLines?.push(b); });
    if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input); }
    let timedOut = false, timer = null;
    if (timeoutMs > 0) timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    try { onSpawn?.(child); } catch (e) { try { child.kill(); } catch { /* gone */ } reject(e); return; }
    child.on('error', e => { if (timer) clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      outLines?.end(); errLines?.end();
      resolve({
        cmd, args, cwd, pid: child.pid, priority, code, signal, timedOut, startedAt,
        finishedAt: new Date().toISOString(), wallMs: performance.now() - t0,
        stdout: collectStdout ? Buffer.concat(outChunks) : null,
        stdoutTail: collectStdout ? null : outTail.text(), stderrTail: errTail.text(),
        stdoutBytes: collectStdout ? outChunks.reduce((n, b) => n + b.length, 0) : outTail.total,
        stderrBytes: errTail.total,
      });
    });
  });
}

/** Runs and throws a descriptive error on non-zero exit. */
export async function runChecked(cmd, args, opts = {}) {
  const r = await runProcess(cmd, args, opts);
  if (r.code !== 0 || r.timedOut) {
    const e = new Error(`${cmd.split(/[\\/]/).pop()} exited ${r.code}${r.timedOut ? ' (timeout)' : ''}: ${r.stderrTail.slice(-2000)}`);
    e.result = r;
    throw e;
  }
  return r;
}

/** Parses ffmpeg `-progress pipe:1` blocks; calls onBlock(obj) at every `progress=` line. */
export function progressParser(onBlock) {
  let cur = {};
  return line => {
    const i = line.indexOf('=');
    if (i <= 0) return;
    const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
    cur[k] = v;
    if (k === 'progress') { onBlock(cur); cur = {}; }
  };
}
