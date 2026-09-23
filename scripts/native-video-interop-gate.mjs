import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidence = resolve(root, ".rd", "benchmarks", "p0-native-decode-interop", "report.json");
const executable = resolve(
  root,
  "spikes",
  "gpu-compositor",
  "target",
  "debug",
  `editkin-gpu-compositor${process.platform === "win32" ? ".exe" : ""}`,
);
const standardCargo = resolve(homedir(), ".cargo", "bin", process.platform === "win32" ? "cargo.exe" : "cargo");
const cargo = process.env.CARGO ?? (existsSync(standardCargo) ? standardCargo : "cargo");

function run(command, args, timeout) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
}

await mkdir(dirname(evidence), { recursive: true });
if (process.platform !== "win32") {
  const report = {
    schema: "hao.video-decode-interop-wrapper/v1",
    decision: "BLOCK",
    reason: "This gate currently has a Windows Media Foundation/D3D11/D3D12 implementation only; VideoToolbox/Metal parity remains required.",
  };
  await writeFile(evidence, `${JSON.stringify(report, null, 2)}\n`);
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}

const build = run(cargo, ["build", "--locked", "--manifest-path", "spikes/gpu-compositor/Cargo.toml"], 180_000);
if (build.status !== 0) {
  throw new Error(`native video interop build failed (${build.error?.message ?? build.status})\n${build.stdout ?? ""}\n${build.stderr ?? ""}`);
}
const gate = run(
  executable,
  ["decode-interop", resolve(root, "public", "demo-source.mp4"), "30", evidence],
  120_000,
);
if (gate.error?.code === "ETIMEDOUT") {
  throw new Error("native video interop gate exceeded the 120 second watchdog");
}
if (gate.status !== 0) {
  throw new Error(`native video interop gate failed\n${gate.stdout ?? ""}\n${gate.stderr ?? ""}`);
}

const report = JSON.parse(await readFile(evidence, "utf8"));
const producerHashes = report.verificationD3d11PixelHashes ?? [];
const consumerHashes = report.verificationPixelHashes ?? [];
const checks = {
  nativeDecision: report.decision === "GREEN",
  dx12Backend: report.backend === "Dx12",
  thirtyFramesDecoded: report.decodedDxgiFrames === 30,
  thirtyFramesShared: report.sharedTextureFrames === 30,
  thirtyFramesConsumed: report.wgpuConsumedFrames === 30,
  allFramesDroppedAfterIdle: report.droppedAfterGpuIdleFrames === 30,
  noDecodePathCpuPixelCopy: report.decodePathCpuPixelCopies === 0,
  boundedGpuPasses: report.gpuProcessingPassesPerFrame === 2,
  visibleFramePreserved: report.width === 960 && report.height === 540,
  surfacePaddingAccountedFor: report.decoderSurfaceWidth >= report.width && report.decoderSurfaceHeight >= report.height,
  producerConsumerParity:
    producerHashes.length === 30
    && consumerHashes.length === 30
    && producerHashes.every((hash, index) => hash === consumerHashes[index]),
  temporalFramesChanged: new Set(consumerHashes).size > 1,
};
const decision = Object.values(checks).every(Boolean) ? "GREEN" : "BLOCK";
const wrapper = {
  schema: "hao.video-decode-interop-wrapper/v1",
  decision,
  checks,
  nativeReport: evidence,
  stderrTail: (gate.stderr ?? "").split(/\r?\n/).slice(-12),
};
await writeFile(resolve(dirname(evidence), "wrapper-report.json"), `${JSON.stringify(wrapper, null, 2)}\n`);
console.log(JSON.stringify(wrapper, null, 2));
if (decision !== "GREEN") process.exitCode = 1;
