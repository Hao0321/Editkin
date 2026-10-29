// Resource sampler (default every 2 s): system CPU/RAM, volume free bytes, watched-path bytes,
// and a process tree's CPU time, working set, private bytes and I/O byte counters (bytes written).
// Per-process counters come from ONE persistent BELOW_NORMAL PowerShell helper (Win32_Process via CIM),
// so a sample costs one IPC round trip instead of a process launch.
import {spawn} from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {childEnv} from './env.mjs';
import {freeBytes} from './space.mjs';
import {dirBytes} from './ledger.mjs';

// One snapshot of ALL processes per query (consistent instant for every process), stamped with the helper's
// monotonic stopwatch right after the snapshot, so CPU rates use snapshot-to-snapshot time, not response arrival.
const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$props = 'ProcessId','ParentProcessId','Name','KernelModeTime','UserModeTime','WorkingSetSize','PrivatePageCount','ReadTransferCount','WriteTransferCount','ThreadCount','CreationDate'
$sw = [Diagnostics.Stopwatch]::StartNew()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line -or $line -eq 'quit') { break }
  $parts = $line.Trim().Split(' ')
  $seq = $parts[0]
  $root = [int]$parts[1]
  $snap = @(Get-CimInstance -ClassName Win32_Process -Property $props)
  $ms = [long]$sw.Elapsed.TotalMilliseconds
  $byParent = @{}
  foreach ($p in $snap) { $k = [int]$p.ParentProcessId; if (-not $byParent.ContainsKey($k)) { $byParent[$k] = New-Object System.Collections.ArrayList }; [void]$byParent[$k].Add($p) }
  $all = New-Object System.Collections.ArrayList
  foreach ($p in $snap) { if ([int]$p.ProcessId -eq $root) { [void]$all.Add($p) } }
  $frontier = @($root); $depth = 0
  while ($all.Count -gt 0 -and $frontier.Count -gt 0 -and $depth -lt 6) {
    $next = @()
    foreach ($f in $frontier) { if ($byParent.ContainsKey($f)) { foreach ($c in $byParent[$f]) { if ([int]$c.ProcessId -ne $f) { [void]$all.Add($c); $next += [int]$c.ProcessId } } } }
    $frontier = $next; $depth++
  }
  $rows = foreach ($p in $all) { '{0},{1},{2},{3},{4},{5},{6},{7},{8},{9},{10}' -f $p.ProcessId,$p.ParentProcessId,$p.KernelModeTime,$p.UserModeTime,$p.WorkingSetSize,$p.PrivatePageCount,$p.ReadTransferCount,$p.WriteTransferCount,$p.ThreadCount,$p.CreationDate.Ticks,($p.Name -replace '[,;]','_') }
  [Console]::Out.WriteLine('S ' + $seq + ' ' + $ms + ' ' + ($rows -join ';'))
  [Console]::Out.Flush()
}
`;

function cpuTimes() {
  let busy = 0, idle = 0;
  for (const c of os.cpus()) { busy += c.times.user + c.times.nice + c.times.sys + c.times.irq; idle += c.times.idle; }
  return {busy, idle};
}

/** Helper stopwatch milliseconds at the snapshot ("S <seq> <ms> <rows>"). */
const snapshotMs = line => Number(line.split(' ')[2]);

function parseRows(line) {
  const body = line.split(' ').slice(3).join(' ');
  if (!body) return [];
  return body.split(';').map(r => {
    const f = r.split(',');
    return {pid: +f[0], ppid: +f[1], cpu100ns: (+f[2] || 0) + (+f[3] || 0), ws: +f[4] || 0, priv: +f[5] || 0, rd: +f[6] || 0, wr: +f[7] || 0, threads: +f[8] || 0, created: +f[9] || 0, name: f.slice(10).join(',')};
  });
}

export class ResourceSampler {
  constructor({intervalMs = 2000, volumes = ['E:\\', 'C:\\', 'D:\\'], watchPaths = [], jsonlPath = null, onSample = null, queryTimeoutMs = 10000} = {}) {
    Object.assign(this, {intervalMs, volumes, watchPaths, jsonlPath, onSample, queryTimeoutMs});
    this.count = 0; this.skipped = 0; this.busy = false; this.pending = null; this.stopped = false;
    this.prevProcs = new Map(); this.cumCpu100ns = 0; this.writeByPid = new Map(); this.readByPid = new Map();
    this.peak = {systemCpuPct: 0, treeCores: 0, treeWorkingSetBytes: 0, treePrivateBytes: 0, systemMemUsedBytes: 0, processCount: 0, watchedBytes: 0, queryLatencyMs: 0};
    this.minFree = {}; this.sumSys = 0; this.sumCores = 0; this.coreSamples = 0; this.last = null;
  }

  start(rootPid = null) {
    this.starting = this._start(rootPid);
    return this.starting;
  }

  /** Starts the helper and runs one throw-away query, so the first real sample is not delayed by start-up. */
  async warmup() {
    this._ensureHelper();
    const saved = this.rootPid;
    this.rootPid = process.pid;
    await this.query();
    this.rootPid = saved;
    return this;
  }

  _ensureHelper() {
    if (this.ps && !this.psExited) return;
    {
      const enc = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');
      this.ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], {env: childEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
      try { os.setPriority(this.ps.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* ignore */ }
      let rest = '';
      this.ps.stdout.on('data', b => {
        rest += b.toString('utf8');
        let i;
        while ((i = rest.indexOf('\n')) >= 0) {
          const l = rest.slice(0, i).trim(); rest = rest.slice(i + 1);
          const seq = Number(l.split(' ')[1]);
          if (l.startsWith('S ') && this.pending && seq === this.seq) { const p = this.pending; this.pending = null; p(l); }
        }
      });
      this.ps.stdin.on('error', () => {});
      this.ps.on('exit', () => { this.psExited = true; if (this.pending) { const p = this.pending; this.pending = null; p(null); } });
    }
  }

  async _start(rootPid) {
    this.rootPid = rootPid;
    if (this.jsonlPath) { fs.mkdirSync(path.dirname(this.jsonlPath), {recursive: true}); this.out = fs.createWriteStream(this.jsonlPath, {flags: 'a'}); }
    if (rootPid) this._ensureHelper();
    this.t0 = performance.now(); this.startedAt = new Date().toISOString(); this.prevCpu = cpuTimes(); this.prevT = this.t0;
    await this.tick();
    if (!this.stopped) this.timer = setInterval(() => { this.tick().catch(() => {}); }, this.intervalMs);
    return this;
  }

  query() {
    if (!this.ps || this.psExited) return Promise.resolve(null);
    return new Promise(resolve => {
      const to = setTimeout(() => { if (this.pending === done) this.pending = null; resolve(null); }, this.queryTimeoutMs);
      const done = l => { clearTimeout(to); resolve(l); };
      this.pending = done;
      this.seq = (this.seq || 0) + 1;
      this.ps.stdin.write(`${this.seq} ${this.rootPid}\n`);
    });
  }

  watchedBytes() {
    let total = 0;
    for (const p of this.watchPaths) {
      try { const st = fs.statSync(p); total += st.isDirectory() ? dirBytes(p, {maxEntries: 4096}).bytes : st.size; } catch { /* not yet / gone */ }
    }
    return total;
  }

  /**
   * Starts a process-tree query unless one is already running. The CIM query can take seconds on a loaded
   * machine (up to ~10 s was measured), so it never blocks the 2 s tick: samples carry the latest tree result
   * and its age (tree.ageMs).
   */
  refreshTree() {
    if (this.treeInFlight) return this.treeInFlight;
    if (this.noMoreQueries || !this.rootPid || !this.ps || this.psExited) return Promise.resolve();
    const q0 = performance.now();
    this.treeInFlight = this.query().then(line => {
      const lat = Math.round(performance.now() - q0);
      this.peak.queryLatencyMs = Math.max(this.peak.queryLatencyMs, lat);
      if (line) this.updateTree(line, performance.now(), lat);
    }).catch(() => {}).finally(() => { this.treeInFlight = null; });
    return this.treeInFlight;
  }

  updateTree(line, now, lat) {
    let procs = parseRows(line);
    const helper = new Set(this.ps?.pid ? [this.ps.pid] : []);
    for (let grew = true; grew;) { grew = false; for (const p of procs) if (helper.has(p.ppid) && !helper.has(p.pid)) { helper.add(p.pid); grew = true; } }
    procs = procs.filter(p => !helper.has(p.pid));
    const created = new Map(procs.map(p => [p.pid, p.created]));
    procs = procs.filter(p => p.pid === this.rootPid || !created.has(p.ppid) || p.created >= created.get(p.ppid));
    let dCpu = 0;
    const cur = new Map();
    for (const p of procs) {
      const prev = this.prevProcs.get(p.pid);
      dCpu += prev && prev.created === p.created ? Math.max(0, p.cpu100ns - prev.cpu100ns) : p.cpu100ns;
      cur.set(p.pid, p);
      this.writeByPid.set(`${p.pid}:${p.created}`, p.wr); this.readByPid.set(`${p.pid}:${p.created}`, p.rd);
    }
    this.prevProcs = cur;
    this.cumCpu100ns += dCpu;
    // rate between SNAPSHOTS (helper stopwatch), not between response arrivals: query latency varies by seconds
    const snap = snapshotMs(line);
    const dt = this.treeSnapMs === undefined || !Number.isFinite(snap) ? null : (snap - this.treeSnapMs) / 1000;
    if (Number.isFinite(snap)) this.treeSnapMs = snap;
    const cores = dt && dt > 0 ? dCpu / 1e7 / dt : null;
    this.tree = {n: procs.length, cores: cores === null ? null : Math.round(cores * 100) / 100,
      cpuPct: cores === null ? null : Math.round((cores / os.cpus().length) * 1000) / 10,
      ws: procs.reduce((s, p) => s + p.ws, 0), priv: procs.reduce((s, p) => s + p.priv, 0),
      rd: procs.reduce((s, p) => s + p.rd, 0), wr: procs.reduce((s, p) => s + p.wr, 0),
      threads: procs.reduce((s, p) => s + p.threads, 0), names: [...new Set(procs.map(p => p.name))].join('+'), latencyMs: lat,
      cpuSecondsCumulative: Math.round(this.cumCpu100ns / 1e5) / 100, measuredAt: now};
    this.treeUpdates = (this.treeUpdates || 0) + 1;
    const pk = this.peak;
    if (cores !== null) { pk.treeCores = Math.max(pk.treeCores, this.tree.cores); this.sumCores += cores; this.coreSamples++; }
    pk.treeWorkingSetBytes = Math.max(pk.treeWorkingSetBytes, this.tree.ws);
    pk.treePrivateBytes = Math.max(pk.treePrivateBytes, this.tree.priv);
    pk.processCount = Math.max(pk.processCount, this.tree.n);
  }

  async tick() {
    if (this.busy) { this.skipped++; return; }
    this.busy = true;
    try {
      this.refreshTree(); // asynchronous; never delays the cheap measurements below
      const now = performance.now();
      const cpu = cpuTimes();
      const dBusy = cpu.busy - this.prevCpu.busy, dIdle = cpu.idle - this.prevCpu.idle;
      const sysCpu = dBusy + dIdle > 0 ? (100 * dBusy) / (dBusy + dIdle) : 0;
      this.prevCpu = cpu; this.prevT = now;
      const free = {};
      for (const v of this.volumes) { try { free[v.slice(0, 2)] = freeBytes(v); } catch { free[v.slice(0, 2)] = null; } }
      const memUsed = os.totalmem() - os.freemem();
      const watch = this.watchedBytes();
      let tree = null;
      if (this.tree) { const {measuredAt, ...t} = this.tree; tree = {...t, ageMs: Math.round(now - measuredAt)}; }
      const s = {i: this.count, t: Math.round(now - this.t0), at: new Date().toISOString(), sysCpu: Math.round(sysCpu * 10) / 10,
        memUsed, free, watch, tree, rootAlive: !!(tree && tree.n > 0)};
      this.count++;
      if (this.count > 1) { this.sumSys += sysCpu; this.sysSamples = (this.sysSamples || 0) + 1; }
      const pk = this.peak;
      pk.systemCpuPct = Math.max(pk.systemCpuPct, this.count > 1 ? s.sysCpu : 0);
      pk.systemMemUsedBytes = Math.max(pk.systemMemUsedBytes, memUsed);
      pk.watchedBytes = Math.max(pk.watchedBytes, watch);
      for (const [k, v] of Object.entries(free)) if (v !== null) this.minFree[k] = Math.min(this.minFree[k] ?? Infinity, v);
      this.last = s;
      this.out?.write(JSON.stringify(s) + '\n');
      try { this.onSample?.(s); } catch { /* callback errors must not stop sampling */ }
    } finally { this.busy = false; }
  }

  async stop() {
    if (this.stopped) return this.summary();
    this.stopped = true;
    try { await this.starting; } catch { /* a failed start still gets a summary */ }
    clearInterval(this.timer);
    while (this.busy) await new Promise(r => setTimeout(r, 20));
    if (this.treeInFlight) await this.treeInFlight; // bounded by queryTimeoutMs
    await this.refreshTree(); // final tree state, then no further queries
    this.noMoreQueries = true;
    if (this.t0 !== undefined) await this.tick();
    else { this.t0 = performance.now(); this.startedAt = new Date().toISOString(); }
    if (this.ps && !this.psExited) {
      try { this.ps.stdin.end('quit\n'); } catch { /* ignore */ }
      await new Promise(r => { const to = setTimeout(() => { try { this.ps.kill(); } catch { /* gone */ } r(); }, 3000); this.ps.once('exit', () => { clearTimeout(to); r(); }); });
    }
    if (this.out) await new Promise(r => this.out.end(r));
    return this.summary();
  }

  summary() {
    const wr = [...this.writeByPid.values()].reduce((a, b) => a + b, 0), rd = [...this.readByPid.values()].reduce((a, b) => a + b, 0);
    return {
      sampler: 'resource-sampler/v2', intervalMs: this.intervalMs, startedAt: this.startedAt, samples: this.count, skippedTicks: this.skipped,
      treeUpdates: this.treeUpdates || 0, durationMs: Math.round(performance.now() - this.t0), jsonlPath: this.jsonlPath,
      peaks: this.peak, minFreeBytes: this.minFree,
      averages: {systemCpuPct: this.sysSamples ? Math.round(this.sumSys / this.sysSamples * 10) / 10 : null, treeCores: this.coreSamples ? Math.round(this.sumCores / this.coreSamples * 100) / 100 : null},
      treeCpuSecondsObserved: Math.round(this.cumCpu100ns / 1e5) / 100,
      treeBytesWrittenObserved: wr, treeBytesReadObserved: rd,
      note: 'Tree counters are the last values observed while each process was alive (a final burst after the last sample is not included); watched bytes measure the output files directly.',
    };
  }
}
