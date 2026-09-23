import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { cpus, hostname, platform, release } from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { planSmartCutReference } from "../src/application/smartCut";
// @ts-ignore JavaScript evaluator is intentionally runnable without the TypeScript toolchain.
import { assessSmartCutBenchmark } from "./lib/smart-cut-gate.mjs";

const percentile = (samples: number[], value: number) => [...samples].sort((a, b) => a - b)[Math.min(samples.length - 1, Math.ceil(samples.length * value) - 1)];
const sha256Bytes = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const sha256File = async (path: string) => sha256Bytes(await readFile(path));
const round = (value: number) => Number(value.toFixed(3));

async function main() {
  const root = resolve(import.meta.dirname, "..");
  const evidencePath = resolve(process.argv[2] ?? "../../.rd/benchmarks/editkin-smart-cut-windows-x64-20260822.json");
  const artifactRoot = resolve(root, "../../.rd/artifacts/smart-cut");
  const nativeCore = process.env.HAO_NATIVE_CORE_PATH ?? resolve(root, "native/bin/win32-x64/hao-core.exe");
  const inputSilenceCount = 10_000;
  const request = {
    fps: 30,
    duration: inputSilenceCount * 0.5 + 1,
    silences: Array.from({ length: inputSilenceCount }, (_, index) => ({ start: index * 0.5 + 0.2, end: index * 0.5 + 0.4 })),
    options: { padding: 0.02, minSilence: 0.1, minKeep: 0.1 },
  };
  await mkdir(artifactRoot, { recursive: true });
  const inputPath = resolve(artifactRoot, "smart-cut-10000.json");
  await writeFile(inputPath, `${JSON.stringify(request)}\n`, "utf8");
  const invoke = () => {
    const result = spawnSync(nativeCore, ["smart-cut", inputPath], { encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(result.stderr.trim() || `hao-core exit ${result.status}`);
    return JSON.parse(result.stdout) as ReturnType<typeof planSmartCutReference>;
  };
  for (let index = 0; index < 5; index += 1) invoke();
  const samples = [];
  let candidate = invoke();
  for (let index = 0; index < 30; index += 1) {
    const started = performance.now();
    candidate = invoke();
    samples.push(performance.now() - started);
  }
  const reference = planSmartCutReference(request);
  const comparableCandidate = { ...candidate, engine: reference.engine };
  const equivalentToReference = JSON.stringify(comparableCandidate) === JSON.stringify(reference);
  const p95Ms = percentile(samples, 0.95);
  const measurement = {
    inputSilenceCount,
    equivalentToReference,
    ranges: candidate.ranges,
    p95Ms,
    engine: candidate.engine,
    removedFrames: candidate.removedFrames,
  };
  const gate = assessSmartCutBenchmark(measurement);
  const executable = await stat(nativeCore);
  const payload = {
    status: gate.status,
    protocol: { id: "editkin-smart-cut-v1", warmups: 5, samples: 30, percentile: "p95", latencyCeilingMs: 100 },
    evaluator: { path: "scripts/lib/smart-cut-gate.mjs", sha256: await sha256File(resolve(root, "scripts/lib/smart-cut-gate.mjs")) },
    benchmark: { path: "scripts/smart-cut-benchmark.ts", sha256: await sha256File(import.meta.filename) },
    environment: { hostname: hostname(), platform: platform(), release: release(), node: process.version, arch: process.arch, cpu: cpus()[0]?.model, logicalCpus: cpus().length },
    dataset: { id: "editkin-smart-cut-synthetic-10000-v1", inputSilenceCount, bytes: (await stat(inputPath)).size, sha256: await sha256File(inputPath) },
    candidate: {
      engine: candidate.engine,
      executable: { path: "native/bin/win32-x64/hao-core.exe", bytes: executable.size, sha256: await sha256File(nativeCore) },
      samplesMs: samples.map(round), p50Ms: round(percentile(samples, 0.5)), p95Ms: round(p95Ms),
      rangeCount: candidate.ranges.length, removedFrames: candidate.removedFrames, sourceFrames: candidate.sourceFrames,
    },
    reference: { engine: reference.engine, sha256: sha256Bytes(JSON.stringify(reference)) },
    equivalentToReference,
    gate,
    ranges: candidate.ranges,
  };
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ status: payload.status, p50Ms: payload.candidate.p50Ms, p95Ms: payload.candidate.p95Ms, equivalentToReference, rangeCount: payload.candidate.rangeCount, evidencePath })}\n`);
  if (payload.status !== "GREEN") process.exitCode = 1;
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
