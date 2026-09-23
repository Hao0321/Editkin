import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  evaluateNativeAudioRecovery,
  selfTestNativeAudioRecoveryEvaluator,
} from "./lib/native-audio-recovery.mjs";

const root = resolve(import.meta.dirname, "..");
const evidenceRoot = resolve(root, ".rd/benchmarks/native-audio-recovery-product");
const reportPath = resolve(evidenceRoot, "report.json");
const baselinePath = resolve(evidenceRoot, "baseline.json");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

if (process.argv.includes("--self-test")) {
  process.stdout.write(`${JSON.stringify(selfTestNativeAudioRecoveryEvaluator())}\n`);
  process.exit(0);
}

await mkdir(evidenceRoot, { recursive: true });
if (process.argv.includes("--baseline")) {
  const sourcePath = resolve(root, ".rd/benchmarks/native-audio-mix-product/report.json");
  const sourceBytes = await readFile(sourcePath);
  const report = {
    schema: "editkin.native-audio-recovery-product-gate/v1",
    platform: "win32",
    runtime: { sha256: `sha256:${"0".repeat(64)}`, bytes: 0 },
    receipt: null,
  };
  const decision = evaluateNativeAudioRecovery(report);
  if (decision.status !== "BLOCK") throw new Error("Slice 44 missing-recovery baseline was not rejected");
  const baseline = {
    schema: "editkin.native-audio-recovery-baseline/v1",
    expectedDecision: "BLOCK",
    source: ".rd/benchmarks/native-audio-mix-product/report.json",
    sourceSha256: sha256(sourceBytes),
    decision,
  };
  await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: "GREEN", baseline: "BLOCK", failures: decision.findings.filter((finding) => finding.status === "FAIL").map((finding) => finding.code) })}\n`);
  process.exit(0);
}

if (process.platform !== "win32") throw new Error("native audio recovery promotion requires Windows WASAPI");
const executable = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(root, "native/bin/win32-x64/hao-core.exe");
const runtimeBytes = await readFile(executable);
const receipt = JSON.parse(execFileSync(executable, ["audio-preview-recovery-selftest"], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
  timeout: 30_000,
  maxBuffer: 4 * 1024 * 1024,
}));
const report = {
  schema: "editkin.native-audio-recovery-product-gate/v1",
  measuredAt: new Date().toISOString(),
  platform: process.platform,
  runtime: { path: executable, sha256: `sha256:${sha256(runtimeBytes)}`, bytes: runtimeBytes.length },
  receipt,
};
report.decision = evaluateNativeAudioRecovery(report);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
if (report.decision.status !== "GREEN") {
  process.stderr.write(`${JSON.stringify(report.decision)}\n`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify({ status: "GREEN", checks: report.decision.checks, runtimeSha256: report.runtime.sha256, recovery: receipt.recovery, events: receipt.events, formatTransitionOracle: receipt.formatTransitionOracle })}\n`);
