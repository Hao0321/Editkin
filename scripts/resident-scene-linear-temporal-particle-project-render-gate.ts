import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { PNG } from "pngjs";
import type { EditProject } from "../src/domain/types";
import { probeMedia, renderProject } from "../src/render/ffmpeg";
import { buildGpuEngineVideoPreviewGraph } from "../src/render/gpuCompositor";
import { addParticleLook, projectWithTemporalLook } from "./temporalLookProjectRenderBaselines";

const runFile = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const evidenceRoot = resolve(root, "..", "..", ".rd", "benchmarks", "editkin-resident-scene-linear-temporal-particle-project-render");
const reportPath = join(evidenceRoot, "report.json");
const baselinePath = join(evidenceRoot, "baseline-report.json");
const executable = join(root, "spikes/gpu-compositor/target/release/editkin-gpu-compositor.exe");
const ffmpeg = join(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const ffprobe = join(root, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const audioPath = join(evidenceRoot, "tone.wav");
const fps = 30;
const frameCount = 15;
const sampleFrame = 8;
const selfTest = process.argv.includes("--self-test");
const baseline = process.argv.includes("--baseline");
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

interface GateReport {
  schema: "editkin.resident-scene-linear-temporal-particle-project-render-gate/v1";
  measuredAt?: string;
  status: "GREEN" | "BLOCK";
  baselineProductRouteRejected: boolean;
  planner: string;
  frameCount: number;
  productPathCpuPixelCopies: number;
  verificationReadback: boolean;
  temporalExecutionMode: string;
  temporalLayerCount: number;
  temporalFramesWithReceipt: number;
  temporalSampleCount: number;
  particleExecutionMode: string;
  framesWithActiveParticles: number;
  totalParticleEmitterPasses: number;
  maximumActiveParticleEmitterCount: number;
  temporalChangedPixels: number;
  temporalHighDeltaPixels: number;
  particleChangedPixels: number;
  particleHighDeltaPixels: number;
  audioRetained: boolean;
  bt709Tagged: boolean;
  rejectedNegativeControls: string[];
  executableSha256: string;
  outputSha256: string;
}

function assertGreen(report: GateReport): void {
  if (report.schema !== "editkin.resident-scene-linear-temporal-particle-project-render-gate/v1" || report.status !== "GREEN") throw new Error("scene-linear temporal/particle report is not GREEN");
  if (!report.baselineProductRouteRejected || report.planner !== "editkin-resident-video-scene-linear-aces2-formal-sequence/v1") throw new Error("scene-linear temporal/particle baseline or product route is incomplete");
  if (report.frameCount !== frameCount || report.productPathCpuPixelCopies !== 0 || report.verificationReadback !== true) throw new Error("scene-linear temporal/particle sequence boundary is incomplete");
  if (report.temporalExecutionMode !== "decoded-temporal-shutter-scene-linear/v1" || report.temporalLayerCount !== 1
    || report.temporalFramesWithReceipt !== frameCount || report.temporalSampleCount !== 8) throw new Error("scene-linear decoded-temporal receipt is incomplete");
  if (report.particleExecutionMode !== "wgpu-resident-video-particle-overlay/v1" || report.framesWithActiveParticles !== 6
    || report.totalParticleEmitterPasses !== 6 || report.maximumActiveParticleEmitterCount !== 1) throw new Error("scene-linear particle receipt is incomplete");
  if (report.temporalChangedPixels < 100 || report.temporalHighDeltaPixels < 20
    || report.particleChangedPixels < 10 || report.particleHighDeltaPixels < 5) throw new Error("decoded controls do not prove independent temporal and particle visibility");
  if (!report.audioRetained || !report.bt709Tagged || report.rejectedNegativeControls.join() !== "nine-temporal-samples,particle-budget,pq-input") throw new Error("delivery or negative controls are incomplete");
  for (const identity of [report.executableSha256, report.outputSha256]) if (!/^[a-f0-9]{64}$/.test(identity)) throw new Error("scene-linear temporal/particle identity is incomplete");
}

function syntheticSelfTest(): void {
  const valid: GateReport = {
    schema: "editkin.resident-scene-linear-temporal-particle-project-render-gate/v1", status: "GREEN",
    baselineProductRouteRejected: true, planner: "editkin-resident-video-scene-linear-aces2-formal-sequence/v1",
    frameCount, productPathCpuPixelCopies: 0, verificationReadback: true,
    temporalExecutionMode: "decoded-temporal-shutter-scene-linear/v1", temporalLayerCount: 1,
    temporalFramesWithReceipt: frameCount, temporalSampleCount: 8,
    particleExecutionMode: "wgpu-resident-video-particle-overlay/v1", framesWithActiveParticles: 6,
    totalParticleEmitterPasses: 6, maximumActiveParticleEmitterCount: 1,
    temporalChangedPixels: 1_000, temporalHighDeltaPixels: 500, particleChangedPixels: 100, particleHighDeltaPixels: 50,
    audioRetained: true, bt709Tagged: true,
    rejectedNegativeControls: ["nine-temporal-samples", "particle-budget", "pq-input"],
    executableSha256: "a".repeat(64), outputSha256: "b".repeat(64),
  };
  assertGreen(valid);
  const negatives: GateReport[] = [
    { ...valid, temporalLayerCount: 0 }, { ...valid, temporalFramesWithReceipt: frameCount - 1 },
    { ...valid, framesWithActiveParticles: 0 }, { ...valid, particleChangedPixels: 0 },
    { ...valid, temporalChangedPixels: 0 }, { ...valid, productPathCpuPixelCopies: 1 },
    { ...valid, rejectedNegativeControls: [] }, { ...valid, bt709Tagged: false },
  ];
  for (const candidate of negatives) {
    let rejected = false;
    try { assertGreen(candidate); } catch { rejected = true; }
    if (!rejected) throw new Error("scene-linear temporal/particle evaluator accepted a calibrated negative");
  }
  process.stdout.write(`${JSON.stringify({ status: "GREEN", evaluator: valid.schema, calibratedNegatives: negatives.length })}\n`);
}

function project({ temporal = true, particles = true } = {}): EditProject {
  let value = projectWithTemporalLook({ typography: false, adjustment: false, overlay: false });
  if (particles) value = addParticleLook(value);
  const clip = value.tracks.find((track) => track.id === "video-main")!.clips[0];
  if (!temporal) clip.creative = { ...clip.creative, effectPresetIds: clip.creative?.effectPresetIds ?? [], nativeEffectInstances: [] };
  value.assets[0].color = { interpretation: "rec709" };
  value.assets.push({ id: "tone", name: "tone.wav", kind: "audio", uri: audioPath, duration: frameCount / fps });
  const audioTrack = value.tracks.find((track) => track.kind === "audio")!;
  audioTrack.clips.push({
    id: "tone-clip", assetId: "tone", trackId: audioTrack.id, timelineStart: 0, sourceStart: 0,
    duration: frameCount / fps, volume: .5, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1, hue: 0, exposure: 0, temperature: 0, tint: 0, whiteBalanceRed: 0, whiteBalanceGreen: 0, whiteBalanceBlue: 0, pivot: .5, shadows: 0, highlights: 0, blacks: 0, whites: 0 }, keyframes: [],
  });
  value.colorManagement = { ...value.colorManagement!, mode: "aces2", outputTransform: "rec709_sdr" };
  return value;
}

function motionInstance(value: EditProject) {
  const instance = value.tracks.find((track) => track.id === "video-main")!.clips[0].creative?.nativeEffectInstances?.[0];
  if (!instance) throw new Error("temporal fixture has no motion-blur instance");
  return instance;
}

async function decodeFrame(input: string, output: string): Promise<PNG> {
  await runFile(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(sampleFrame / fps), "-i", input, "-frames:v", "1", output], { windowsHide: true, timeout: 30_000 });
  return PNG.sync.read(await readFile(output));
}

async function changedPixels(left: string, right: string, temporary: string, label: string): Promise<{ changed: number; high: number }> {
  const [a, b] = await Promise.all([
    decodeFrame(left, join(temporary, `${label}-candidate.png`)),
    decodeFrame(right, join(temporary, `${label}-control.png`)),
  ]);
  if (a.width !== b.width || a.height !== b.height) throw new Error(`${label} decoded dimensions differ`);
  let changed = 0; let high = 0;
  for (let offset = 0; offset < a.data.length; offset += 4) {
    const delta = Math.abs(a.data[offset] - b.data[offset]) + Math.abs(a.data[offset + 1] - b.data[offset + 1]) + Math.abs(a.data[offset + 2] - b.data[offset + 2]);
    if (delta > 8) changed += 1;
    if (delta > 32) high += 1;
  }
  return { changed, high };
}

async function main(): Promise<void> {
  if (selfTest) return syntheticSelfTest();
  await mkdir(evidenceRoot, { recursive: true });
  const candidate = project();
  const productRouteRejected = buildGpuEngineVideoPreviewGraph(candidate, 0) === undefined;
  if (baseline) {
    if (!productRouteRejected) throw new Error("baseline unexpectedly admitted scene-linear temporal/particle project");
    const report = { schema: "editkin.resident-scene-linear-temporal-particle-project-render-baseline/v1", measuredAt: new Date().toISOString(), status: "BLOCK", productRouteRejected, executableSha256: sha256(await readFile(executable)) };
    await writeFile(baselinePath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const frozen = JSON.parse(await readFile(baselinePath, "utf8")) as { status?: string; productRouteRejected?: boolean };
  if (productRouteRejected) throw new Error("candidate product route still rejects scene-linear temporal/particle project");
  const temporary = await mkdtemp(join(tmpdir(), "editkin-scene-linear-temporal-particle-"));
  try {
    await runFile(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `sine=frequency=523:sample_rate=48000:duration=${frameCount / fps}`, "-c:a", "pcm_s16le", audioPath], { windowsHide: true, timeout: 30_000 });
    const output = join(evidenceRoot, "resident-scene-linear-temporal-particle.mp4");
    const noTemporalOutput = join(evidenceRoot, "control-no-temporal.mp4");
    const noParticleOutput = join(evidenceRoot, "control-no-particles.mp4");
    const options = { ffmpegPath: ffmpeg, ffprobePath: ffprobe, gpuCompositorPath: executable, preferGpu: false, fontRoot: join(root, "public/fonts"), timeoutMs: 120_000 };
    const [rendered, noTemporal, noParticles] = await Promise.all([
      renderProject(candidate, output, options),
      renderProject(project({ temporal: false }), noTemporalOutput, options),
      renderProject(project({ particles: false }), noParticleOutput, options),
    ]);
    const pipeline = rendered.residentVideoPipeline as NonNullable<typeof rendered.residentVideoPipeline> | undefined;
    if (!pipeline) throw new Error("formal scene-linear temporal/particle render omitted resident pipeline receipt");
    const temporalDelta = await changedPixels(output, noTemporal.outputPath, temporary, "temporal");
    const particleDelta = await changedPixels(output, noParticles.outputPath, temporary, "particle");
    const probe = await probeMedia(output, ffprobe);
    const rejectedNegativeControls: string[] = [];
    const reject = (name: string, value: EditProject) => {
      if (buildGpuEngineVideoPreviewGraph(value, 0) !== undefined) throw new Error(`${name} negative was admitted`);
      rejectedNegativeControls.push(name);
    };
    const tooManySamples = project(); motionInstance(tooManySamples).parameters.samples = 9; reject("nine-temporal-samples", tooManySamples);
    const overBudget = project(); overBudget.particleSimulation!.maxParticles = 193; reject("particle-budget", overBudget);
    const pqInput = project(); pqInput.assets[0].color = { interpretation: "pq" }; reject("pq-input", pqInput);
    const extended = pipeline as typeof pipeline & {
      temporalExecutionMode: string; temporalLayerCount: number; temporalFramesWithReceipt: number; temporalSampleCount: number;
      particleExecutionMode: string; framesWithActiveParticles: number; totalParticleEmitterPasses: number; maximumActiveParticleEmitterCount: number;
    };
    const report: GateReport = {
      schema: "editkin.resident-scene-linear-temporal-particle-project-render-gate/v1", measuredAt: new Date().toISOString(), status: "GREEN",
      baselineProductRouteRejected: frozen.status === "BLOCK" && frozen.productRouteRejected === true,
      planner: rendered.planner, frameCount: pipeline.frameCount, productPathCpuPixelCopies: pipeline.productPathCpuPixelCopies,
      verificationReadback: pipeline.verificationReadback, temporalExecutionMode: extended.temporalExecutionMode,
      temporalLayerCount: extended.temporalLayerCount, temporalFramesWithReceipt: extended.temporalFramesWithReceipt,
      temporalSampleCount: extended.temporalSampleCount, particleExecutionMode: extended.particleExecutionMode,
      framesWithActiveParticles: extended.framesWithActiveParticles, totalParticleEmitterPasses: extended.totalParticleEmitterPasses,
      maximumActiveParticleEmitterCount: extended.maximumActiveParticleEmitterCount,
      temporalChangedPixels: temporalDelta.changed, temporalHighDeltaPixels: temporalDelta.high,
      particleChangedPixels: particleDelta.changed, particleHighDeltaPixels: particleDelta.high,
      audioRetained: probe.hasAudio, bt709Tagged: probe.colorPrimaries === "bt709" && probe.colorTransfer === "bt709" && probe.colorMatrix === "bt709",
      rejectedNegativeControls, executableSha256: sha256(await readFile(executable)), outputSha256: sha256(await readFile(output)),
    };
    assertGreen(report);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

await main();
