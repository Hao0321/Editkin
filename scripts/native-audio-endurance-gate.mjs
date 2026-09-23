import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  evaluateNativeAudioEndurance,
  selfTestNativeAudioEnduranceEvaluator,
} from "./lib/native-audio-endurance.mjs";

const root = resolve(import.meta.dirname, "..");
const node = process.execPath;
const runtime = resolve(root, "native/bin/win32-x64/hao-core.exe");
const evidenceRoot = resolve(root, ".rd/benchmarks/native-audio-endurance-internal");
const evidencePath = resolve(evidenceRoot, "report.json");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

if (process.argv.includes("--self-test")) {
  process.stdout.write(`${JSON.stringify(selfTestNativeAudioEnduranceEvaluator())}\n`);
  process.exit(0);
}
if (process.platform !== "win32") {
  throw new Error("native audio endurance promotion currently requires a real Windows WASAPI host");
}

const buildOutput = execFileSync(node, [resolve(root, "scripts/build-native-core.mjs"), "--windows-only"], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
  timeout: 300_000,
});
const buildReceipt = JSON.parse(buildOutput.trim().split(/\r?\n/).at(-1));
if (buildReceipt.status !== "GREEN" || resolve(buildReceipt.promoted) !== runtime) {
  throw new Error("native core build did not promote the canonical Windows runtime");
}

const receipt = JSON.parse(execFileSync(runtime, ["audio-device-endurance", "60"], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
  timeout: 90_000,
}));
const runtimeBytes = await readFile(runtime);
const report = {
  schema: "editkin.native-audio-endurance-closure/v1",
  platform: process.platform,
  productVersion: "0.15.0",
  scope: "internal",
  runtime: {
    path: "native/bin/win32-x64/hao-core.exe",
    sha256: `sha256:${sha256(runtimeBytes)}`,
    bytes: runtimeBytes.length,
    buildReceipt,
  },
  receipt,
  claimBoundary: {
    measured: "one 60-second sustained physical Windows WASAPI run in the staged native product runtime",
    open: [
      "physical default-device replacement or unplug",
      "changed-format resample/remix reopen",
      "multi-hour A/V playback drift",
      "macOS CoreAudio parity",
      "final encoded loudness across diverse programs",
    ],
  },
};
report.decision = evaluateNativeAudioEndurance(report);
if (report.decision.status !== "GREEN") {
  throw new Error(JSON.stringify(report.decision));
}
await mkdir(evidenceRoot, { recursive: true });
await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  status: report.decision.status,
  checks: report.decision.checks,
  durationMs: receipt.duration.actualMs,
  callbacks: receipt.device.eventCallbacks,
  p95CallbackWaitMicros: receipt.device.p95CallbackWaitMicros,
  hardwareQpcDriftMs: receipt.device.hardwareQpcDriftMs,
  underrunSamples: receipt.transport.underrunSamples,
  runtimeSha256: report.runtime.sha256,
  evidence: evidencePath,
})}\n`);
