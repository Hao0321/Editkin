import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { PNG } from "pngjs";
import { createEmptyProject } from "../src/domain/editGraph";
import { createTransformMotionBlurInstance } from "../src/domain/transformMotionBlur";
import {
  DEFAULT_COLOR,
  DEFAULT_PARTICLE_SIMULATION,
  DEFAULT_TRANSFORM,
  type EditProject,
  type NativeEffectInstance,
} from "../src/domain/types";
import { probeMedia, renderProject } from "../src/render/ffmpeg";
import { buildGpuEngineVideoPreviewGraph } from "../src/render/gpuCompositor";

const runFile = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const evidenceRoot = resolve(root, "..", "..", ".rd", "benchmarks", "editkin-resident-scene-linear-converged-project-render");
const reportPath = join(evidenceRoot, "report.json");
const baselinePath = join(evidenceRoot, "baseline-report.json");
const executable = join(root, "spikes/gpu-compositor/target/release/editkin-gpu-compositor.exe");
const ffmpeg = join(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const ffprobe = join(root, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const source = join(root, "public/demo-source.mp4");
const audioPath = join(evidenceRoot, "tone.wav");
const fps = 30;
const frameCount = 15;
const sampleFrame = 8;
const selfTest = process.argv.includes("--self-test");
const baseline = process.argv.includes("--baseline");
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

interface GateReport {
  schema: "editkin.resident-scene-linear-converged-project-render-gate/v1";
  measuredAt?: string;
  status: "GREEN" | "BLOCK";
  baselineProductRouteRejected: boolean;
  planner: string;
  frameCount: number;
  productPathCpuPixelCopies: number;
  verificationReadback: boolean;
  effectExecutionMode: string;
  gpuEffectProgramCount: number;
  gpuEffectOperationCount: number;
  builtInEffectCount: number;
  matteExecutionMode: string;
  mattePassCount: number;
  temporalExecutionMode: string;
  temporalLayerCount: number;
  temporalFramesWithReceipt: number;
  temporalSampleCount: number;
  particleExecutionMode: string;
  framesWithActiveParticles: number;
  totalParticleEmitterPasses: number;
  maximumActiveParticleEmitterCount: number;
  effectChangedPixels: number;
  effectHighDeltaPixels: number;
  matteChangedPixels: number;
  matteHighDeltaPixels: number;
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
  if (report.schema !== "editkin.resident-scene-linear-converged-project-render-gate/v1" || report.status !== "GREEN") throw new Error("converged scene-linear report is not GREEN");
  if (!report.baselineProductRouteRejected || report.planner !== "editkin-resident-video-scene-linear-aces2-formal-sequence/v1") throw new Error("converged product route or RED baseline is incomplete");
  if (report.frameCount !== frameCount || report.productPathCpuPixelCopies !== 0 || !report.verificationReadback) throw new Error("converged sequence boundary receipt is incomplete");
  if (report.effectExecutionMode !== "scene-linear-bounded-effect-stack/v1" || report.gpuEffectProgramCount !== 1
    || report.gpuEffectOperationCount !== 4 || report.builtInEffectCount !== 1) throw new Error("converged effect receipt is incomplete");
  if (report.matteExecutionMode !== "sampled-track-matte-scene-linear/v1" || report.mattePassCount !== 1) throw new Error("converged matte receipt is incomplete");
  if (report.temporalExecutionMode !== "decoded-temporal-shutter-scene-linear/v1" || report.temporalLayerCount !== 1
    || report.temporalFramesWithReceipt !== frameCount || report.temporalSampleCount !== 8) throw new Error("converged temporal receipt is incomplete");
  if (report.particleExecutionMode !== "wgpu-resident-video-particle-overlay/v1" || report.framesWithActiveParticles !== 6
    || report.totalParticleEmitterPasses !== 6 || report.maximumActiveParticleEmitterCount !== 1) throw new Error("converged particle receipt is incomplete");
  for (const [label, changed, high] of [
    ["effect", report.effectChangedPixels, report.effectHighDeltaPixels],
    ["matte", report.matteChangedPixels, report.matteHighDeltaPixels],
    ["temporal", report.temporalChangedPixels, report.temporalHighDeltaPixels],
    ["particle", report.particleChangedPixels, report.particleHighDeltaPixels],
  ] as const) if (changed < 10 || high < 5) throw new Error(`${label} decoded ablation is not independently visible`);
  if (!report.audioRetained || !report.bt709Tagged
    || report.rejectedNegativeControls.join() !== "temporal-matte-source,nine-temporal-samples,particle-budget,stale-plugin-identity,pq-input") throw new Error("converged delivery or calibrated negatives are incomplete");
  for (const identity of [report.executableSha256, report.outputSha256]) if (!/^[a-f0-9]{64}$/.test(identity)) throw new Error("converged artifact identity is incomplete");
}

function syntheticSelfTest(): void {
  const valid: GateReport = {
    schema: "editkin.resident-scene-linear-converged-project-render-gate/v1", status: "GREEN", baselineProductRouteRejected: true,
    planner: "editkin-resident-video-scene-linear-aces2-formal-sequence/v1", frameCount, productPathCpuPixelCopies: 0, verificationReadback: true,
    effectExecutionMode: "scene-linear-bounded-effect-stack/v1", gpuEffectProgramCount: 1, gpuEffectOperationCount: 4, builtInEffectCount: 1,
    matteExecutionMode: "sampled-track-matte-scene-linear/v1", mattePassCount: 1,
    temporalExecutionMode: "decoded-temporal-shutter-scene-linear/v1", temporalLayerCount: 1, temporalFramesWithReceipt: frameCount, temporalSampleCount: 8,
    particleExecutionMode: "wgpu-resident-video-particle-overlay/v1", framesWithActiveParticles: 6, totalParticleEmitterPasses: 6, maximumActiveParticleEmitterCount: 1,
    effectChangedPixels: 100, effectHighDeltaPixels: 50, matteChangedPixels: 100, matteHighDeltaPixels: 50,
    temporalChangedPixels: 100, temporalHighDeltaPixels: 50, particleChangedPixels: 100, particleHighDeltaPixels: 50,
    audioRetained: true, bt709Tagged: true,
    rejectedNegativeControls: ["temporal-matte-source", "nine-temporal-samples", "particle-budget", "stale-plugin-identity", "pq-input"],
    executableSha256: "a".repeat(64), outputSha256: "b".repeat(64),
  };
  assertGreen(valid);
  const negatives: GateReport[] = [
    { ...valid, gpuEffectProgramCount: 0 }, { ...valid, mattePassCount: 0 },
    { ...valid, temporalFramesWithReceipt: frameCount - 1 }, { ...valid, framesWithActiveParticles: 0 },
    { ...valid, effectChangedPixels: 0 }, { ...valid, matteChangedPixels: 0 },
    { ...valid, temporalChangedPixels: 0 }, { ...valid, particleChangedPixels: 0 },
    { ...valid, productPathCpuPixelCopies: 1 }, { ...valid, rejectedNegativeControls: [] },
  ];
  for (const candidate of negatives) {
    let rejected = false;
    try { assertGreen(candidate); } catch { rejected = true; }
    if (!rejected) throw new Error("converged evaluator accepted a calibrated negative report");
  }
  process.stdout.write(`${JSON.stringify({ status: "GREEN", evaluator: valid.schema, calibratedNegatives: negatives.length })}\n`);
}

async function createPlugin(pluginRoot: string): Promise<{ manifest: Record<string, any>; manifestSha256: string }> {
  const directory = join(pluginRoot, "scene-linear-converged-look");
  await mkdir(directory, { recursive: true });
  const manifest = {
    schema: "editkin.plugin/v1", id: "editkin.gate.scene-linear-converged", name: "Scene-linear Converged Gate", version: "1.0.0", minimumHostVersion: "0.15.0",
    publisher: { name: "Editkin Gate" }, license: { spdx: "MIT", commercialUse: true }, permissions: ["render.effect"],
    capabilities: [{
      id: "filmic", name: "Filmic", description: "Bounded scene-linear GPU convergence fixture", kind: "effect", automation: "manual", semanticRoles: [], formats: ["any"], requires: [], avoidWhen: [],
      parameters: [
        { id: "gain", name: "Gain", type: "number", default: .82, min: 0, max: 2 },
        { id: "invert", name: "Invert", type: "number", default: .18, min: 0, max: 1 },
        { id: "gray", name: "Gray", type: "number", default: .28, min: 0, max: 1 },
        { id: "contrast", name: "Contrast", type: "number", default: 1.18, min: 0, max: 2 },
        { id: "pivot", name: "Pivot", type: "number", default: .45, min: 0, max: 1 },
      ],
      runtime: { type: "gpu_effect_graph", abiVersion: 1, supportedFormats: ["rgba16_float"], maxTemporalRadius: 0, operations: [
        { op: "gain", args: ["$parameter.gain"] }, { op: "invert", args: ["$parameter.invert"] },
        { op: "grayscale", args: ["$parameter.gray"] }, { op: "contrast", args: ["$parameter.contrast", "$parameter.pivot"] },
      ] },
    }],
  };
  const text = JSON.stringify(manifest);
  await writeFile(join(directory, "editkin-plugin.json"), text, "utf8");
  return { manifest, manifestSha256: sha256(text) };
}

function project(instance: NativeEffectInstance, options: { effects?: boolean; matte?: boolean; temporal?: boolean; particles?: boolean } = {}): EditProject {
  const { effects = true, matte = true, temporal = true, particles = true } = options;
  const value = createEmptyProject("Resident scene-linear converged export", { width: 960, height: 540, fps });
  value.assets.push(
    { id: "matte-video", name: "Static matte source", kind: "video", uri: source, duration: 4, width: 960, height: 540, color: { interpretation: "rec709" } },
    { id: "target-video", name: "Temporal target", kind: "video", uri: source, duration: 4, width: 960, height: 540, color: { interpretation: "rec709" } },
    { id: "tone", name: "tone.wav", kind: "audio", uri: audioPath, duration: frameCount / fps },
  );
  const sourceClip = {
    id: "matte-clip", assetId: "matte-video", trackId: value.tracks[0].id, timelineStart: 0, sourceStart: 0,
    duration: frameCount / fps, volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
    creative: { effectPresetIds: effects ? ["mono_halftone"] : [], nativeEffectInstances: [] },
    layer: { enabled: true, blendMode: "normal" as const, role: "content" as const },
  };
  const motion = createTransformMotionBlurInstance();
  motion.parameters.shutter_angle = 360; motion.parameters.samples = 8;
  const targetClip = {
    id: "target-clip", assetId: "target-video", trackId: "target-track", timelineStart: 0, sourceStart: 1,
    duration: frameCount / fps, volume: 0,
    transform: { ...DEFAULT_TRANSFORM, x: -180, scale: .65, rotation: -6 },
    color: { ...DEFAULT_COLOR, exposure: .18 },
    keyframes: [{ id: "target-motion", time: 14 / fps, transform: { ...DEFAULT_TRANSFORM, x: 180, scale: .65, rotation: 6 }, color: { ...DEFAULT_COLOR, exposure: .18 }, easing: "linear" as const }],
    creative: { effectPresetIds: [], nativeEffectInstances: [...(effects ? [instance] : []), ...(temporal ? [motion] : [])] },
    layer: { enabled: true, blendMode: "normal" as const, role: "content" as const,
      ...(matte ? { trackMatte: { sourceClipId: "matte-clip", mode: "luma" as const } } : {}) },
  };
  if (matte) {
    value.tracks[0].clips.push(sourceClip);
    value.tracks.push({ id: "target-track", name: "Temporal target", kind: "video", locked: false, muted: false, clips: [targetClip] });
  } else {
    targetClip.trackId = value.tracks[0].id;
    sourceClip.trackId = "matte-track";
    sourceClip.transform.opacity = 0;
    sourceClip.creative.effectPresetIds = [];
    value.tracks[0].clips.push(targetClip);
    value.tracks.push({ id: "matte-track", name: "Disabled matte control", kind: "video", locked: false, muted: false, clips: [sourceClip] });
  }
  const audioTrack = value.tracks.find((track) => track.kind === "audio")!;
  audioTrack.clips.push({
    id: "tone-clip", assetId: "tone", trackId: audioTrack.id, timelineStart: 0, sourceStart: 0,
    duration: frameCount / fps, volume: .5, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
  });
  if (particles) value.particleSimulation = {
    ...structuredClone(DEFAULT_PARTICLE_SIMULATION), ratePerSecond: 72, maxParticles: 48,
    timeline: { start: 4 / fps, duration: 6 / fps }, color: [.66, 1, .24, .92],
  };
  value.colorManagement = { ...value.colorManagement!, mode: "aces2", outputTransform: "rec709_sdr" };
  return value;
}

function clip(value: EditProject, id: string) {
  const found = value.tracks.flatMap((track) => track.clips).find((candidate) => candidate.id === id);
  if (!found) throw new Error(`fixture clip ${id} is missing`);
  return found;
}

function motionInstance(value: EditProject): NativeEffectInstance {
  const found = clip(value, "target-clip").creative?.nativeEffectInstances?.find((instance) => instance.capabilityId === "transform_motion_blur");
  if (!found) throw new Error("temporal fixture has no motion-blur instance");
  return found;
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
  const temporary = await mkdtemp(join(tmpdir(), "editkin-scene-linear-converged-"));
  try {
    const pluginRoot = join(temporary, "plugins");
    const plugin = await createPlugin(pluginRoot);
    const instance: NativeEffectInstance = {
      id: "scene-linear-converged-gpu", pluginId: String(plugin.manifest.id), capabilityId: "filmic", pluginVersion: String(plugin.manifest.version),
      manifestSha256: plugin.manifestSha256, runtimeType: "gpu_effect_graph", enabled: true,
      parameters: { gain: .82, invert: .18, gray: .28, contrast: 1.18, pivot: .45 },
    };
    const candidate = project(instance);
    const productRouteRejected = buildGpuEngineVideoPreviewGraph(candidate, 0) === undefined;
    if (baseline) {
      if (!productRouteRejected) throw new Error("baseline unexpectedly admitted the converged scene-linear product route");
      const report = {
        schema: "editkin.resident-scene-linear-converged-project-render-baseline/v1", measuredAt: new Date().toISOString(), status: "BLOCK",
        productRouteRejected, executableSha256: sha256(await readFile(executable)),
      };
      await writeFile(baselinePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    const frozen = JSON.parse(await readFile(baselinePath, "utf8")) as { status?: string; productRouteRejected?: boolean };
    if (productRouteRejected) throw new Error("candidate product route still rejects the converged scene-linear project");
    await runFile(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `sine=frequency=587:sample_rate=48000:duration=${frameCount / fps}`, "-c:a", "pcm_s16le", audioPath], { windowsHide: true, timeout: 30_000 });
    const output = join(evidenceRoot, "resident-scene-linear-converged.mp4");
    const options = { ffmpegPath: ffmpeg, ffprobePath: ffprobe, gpuCompositorPath: executable, preferGpu: false, fontRoot: join(root, "public/fonts"), pluginRoots: [pluginRoot], timeoutMs: 120_000 };
    const rendered = await renderProject(candidate, output, options);
    const controls = new Map<string, string>();
    for (const [name, controlProject] of [
      ["effect", project(instance, { effects: false })],
      ["matte", project(instance, { matte: false })],
      ["temporal", project(instance, { temporal: false })],
      ["particle", project(instance, { particles: false })],
    ] as const) {
      const controlOutput = join(evidenceRoot, `control-no-${name}.mp4`);
      controls.set(name, (await renderProject(controlProject, controlOutput, options)).outputPath);
    }
    const pipeline = rendered.residentVideoPipeline as (NonNullable<typeof rendered.residentVideoPipeline> & {
      gpuEffectPrograms: Array<{ shaderOpCount: number }>;
      effectExecutionMode: string; builtInEffectCount: number; matteExecutionMode: string; mattePassCount: number;
      temporalExecutionMode: string; temporalLayerCount: number; temporalFramesWithReceipt: number; temporalSampleCount: number;
      particleExecutionMode: string; framesWithActiveParticles: number; totalParticleEmitterPasses: number; maximumActiveParticleEmitterCount: number;
    }) | undefined;
    if (!pipeline) throw new Error("converged formal render omitted resident pipeline receipt");
    const deltas = Object.fromEntries(await Promise.all([...controls].map(async ([name, controlOutput]) => [name, await changedPixels(output, controlOutput, temporary, name)])));
    const rejectedNegativeControls: string[] = [];
    const rejectRoute = (name: string, value: EditProject) => {
      if (buildGpuEngineVideoPreviewGraph(value, 0) !== undefined) throw new Error(`${name} negative was admitted`);
      rejectedNegativeControls.push(name);
    };
    const temporalMatteSource = project(instance, { particles: false });
    const sourceClip = clip(temporalMatteSource, "matte-clip"); const targetClip = clip(temporalMatteSource, "target-clip");
    const sourceMotion = motionInstance(temporalMatteSource);
    targetClip.creative!.nativeEffectInstances = targetClip.creative!.nativeEffectInstances!.filter((candidate) => candidate.id !== sourceMotion.id);
    targetClip.keyframes = [];
    sourceClip.transform = { ...targetClip.transform };
    sourceClip.keyframes = [{ ...structuredClone(project(instance).tracks.find((track) => track.id === "target-track")!.clips[0].keyframes[0]), id: "matte-source-motion" }];
    sourceClip.creative!.nativeEffectInstances = [sourceMotion];
    rejectRoute("temporal-matte-source", temporalMatteSource);
    const tooManySamples = project(instance); motionInstance(tooManySamples).parameters.samples = 9; rejectRoute("nine-temporal-samples", tooManySamples);
    const overBudget = project(instance); overBudget.particleSimulation!.maxParticles = 193; rejectRoute("particle-budget", overBudget);
    const stalePlugin = project({ ...instance, manifestSha256: "0".repeat(64) });
    await renderProject(stalePlugin, join(temporary, "stale-plugin.mp4"), options).then(
      () => { throw new Error("stale-plugin-identity negative was rendered"); },
      () => { rejectedNegativeControls.push("stale-plugin-identity"); },
    );
    const pqInput = project(instance); pqInput.assets.find((asset) => asset.id === "target-video")!.color = { interpretation: "pq" }; rejectRoute("pq-input", pqInput);
    const probe = await probeMedia(output, ffprobe);
    const report: GateReport = {
      schema: "editkin.resident-scene-linear-converged-project-render-gate/v1", measuredAt: new Date().toISOString(), status: "GREEN",
      baselineProductRouteRejected: frozen.status === "BLOCK" && frozen.productRouteRejected === true,
      planner: rendered.planner, frameCount: pipeline.frameCount, productPathCpuPixelCopies: pipeline.productPathCpuPixelCopies, verificationReadback: pipeline.verificationReadback,
      effectExecutionMode: pipeline.effectExecutionMode, gpuEffectProgramCount: pipeline.gpuEffectPrograms.length,
      gpuEffectOperationCount: pipeline.gpuEffectPrograms.reduce((sum, program) => sum + program.shaderOpCount, 0), builtInEffectCount: pipeline.builtInEffectCount,
      matteExecutionMode: pipeline.matteExecutionMode, mattePassCount: pipeline.mattePassCount,
      temporalExecutionMode: pipeline.temporalExecutionMode, temporalLayerCount: pipeline.temporalLayerCount,
      temporalFramesWithReceipt: pipeline.temporalFramesWithReceipt, temporalSampleCount: pipeline.temporalSampleCount,
      particleExecutionMode: pipeline.particleExecutionMode, framesWithActiveParticles: pipeline.framesWithActiveParticles,
      totalParticleEmitterPasses: pipeline.totalParticleEmitterPasses, maximumActiveParticleEmitterCount: pipeline.maximumActiveParticleEmitterCount,
      effectChangedPixels: deltas.effect.changed, effectHighDeltaPixels: deltas.effect.high,
      matteChangedPixels: deltas.matte.changed, matteHighDeltaPixels: deltas.matte.high,
      temporalChangedPixels: deltas.temporal.changed, temporalHighDeltaPixels: deltas.temporal.high,
      particleChangedPixels: deltas.particle.changed, particleHighDeltaPixels: deltas.particle.high,
      audioRetained: probe.hasAudio, bt709Tagged: probe.colorPrimaries === "bt709" && probe.colorTransfer === "bt709" && probe.colorMatrix === "bt709",
      rejectedNegativeControls, executableSha256: sha256(await readFile(executable)), outputSha256: sha256(await readFile(output)),
    };
    assertGreen(report);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

await main();
