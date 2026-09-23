import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { analyzeAutoRoto } from "../src/application/autoRoto";
import { AUTO_ROTO_SAM21_ENGINE } from "../src/application/autoRotoModelRouter";

const appRoot = resolve(import.meta.dirname, ".."); const repoRoot = resolve(appRoot, "../..");
const packRoot = join(repoRoot, ".rd/model-packs/editkin-auto-roto-sam21-tiny-windows-cuda-1.0.3");
const sourcePath = join(appRoot, ".rd/benchmarks/editkin-auto-roto-synthetic-hardcase/translucent-occlusion.mp4");
const reportRoot = join(appRoot, ".rd/benchmarks/editkin-auto-roto-non-nvidia-fallback"); const reportPath = join(reportRoot, "report.json");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function main(): Promise<void> {
  await rm(reportRoot, { recursive: true, force: true }); await mkdir(reportRoot, { recursive: true });
  const previous = process.env.CUDA_VISIBLE_DEVICES; process.env.CUDA_VISIBLE_DEVICES = "-1";
  try {
    const result = await analyzeAutoRoto({
      sourcePath, sourceStart: 0, duration: 1, fps: 24, sourceWidth: 480, sourceHeight: 270, initialTime: 0,
      initialRect: { x: 24 / 480, y: 70 / 270, width: 140 / 480, height: 130 / 270 }, sourceSha256: sha256(await readFile(sourcePath)),
    }, {
      ffmpegPath: join(appRoot, "vendor/ffmpeg/win32-x64/ffmpeg.exe"), nativeCorePath: join(appRoot, "native/bin/win32-x64/hao-core.exe"),
      cacheRoot: join(reportRoot, "cache"), sam21Pack: { trustedRoot: packRoot, manifestPath: join(packRoot, "manifest.json"), hostScriptPath: join(packRoot, "host/auto-roto-sam21-video-host.py") },
      routePolicy: { mode: "research", requestedEngine: AUTO_ROTO_SAM21_ENGINE },
    });
    const sequence = await readFile(result.sequencePath);
    const checks = {
      productionPackRequested: result.runtimeFallback?.requestedEngine === "editkin-sam21-video-memory-roto/v1",
      cudaActuallyHidden: result.runtimeFallback?.probe.available === false && /cuda[- ]unavailable/i.test(result.runtimeFallback?.probe.reason ?? ""),
      nativeEngineExecuted: result.engine === "editkin-native-color-temporal-roto/v1" && result.runtimeFallback?.executedEngine === result.engine,
      truthBoundary: result.qualityState === "diagnostic" && result.sam2Model === undefined,
      formalSequence: sequence.length === result.width * result.height * result.frames.length && sequence.some((value) => value > 0) && sequence.some((value) => value < 255),
    };
    const status = Object.values(checks).every(Boolean) ? "GREEN_NATIVE_FALLBACK" : "FAIL";
    const report = {
      schema: "editkin.auto-roto-non-nvidia-fallback-gate/v1", status, checks, runtimeFallback: result.runtimeFallback,
      result: { engine: result.engine, qualityState: result.qualityState, frames: result.frames.length, elapsedMs: result.elapsedMs },
      artifact: { path: result.sequencePath, bytes: (await stat(result.sequencePath)).size, sha256: sha256(sequence) },
      claimBoundary: "Proves the exact production selection path sees CUDA unavailable and executes Editkin's native CPU fallback with an honest diagnostic receipt. It does not benchmark a separate physical non-NVIDIA GPU.",
    };
    await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
    process.stdout.write(`AUTO_ROTO_NATIVE_FALLBACK status=${status} report=${reportPath}\n`); if (status === "FAIL") process.exitCode = 1;
  } finally {
    if (previous === undefined) delete process.env.CUDA_VISIBLE_DEVICES; else process.env.CUDA_VISIBLE_DEVICES = previous;
  }
}
await main();
