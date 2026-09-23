import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PNG } from "pngjs";
import { createDemoProject } from "../src/domain/demo";
import { createTransformMotionBlurInstance } from "../src/domain/transformMotionBlur";
import type { EditProject } from "../src/domain/types";
import { materializeNativeEffectSegments } from "../src/plugins/nativeEffectRender";
import { buildRenderPlan } from "../src/render/planner";

const root = resolve(import.meta.dirname, "..");
const evidenceRoot = resolve(root, "../../.rd/benchmarks/editkin-transform-motion-blur-project-render");
const reportPath = join(evidenceRoot, "report.json");
const selfTest = process.argv.includes("--self-test");
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

function assertGreen(report: Record<string, any>) {
  if (report.schema !== "editkin.transform-motion-blur-project-render-gate/v1" || report.status !== "GREEN") throw new Error("transform motion-blur project render is not GREEN");
  if (report.executionMode !== "resident-gpu-shader-sequence/v1" || report.frameCount !== 15 || report.losslessPixelDifferences !== 0) throw new Error("transform motion-blur intermediate was not lossless");
  if (report.motionContract !== "decoded-temporal-shutter-accumulation/v1" || report.sourceSampling !== "decoded_temporal" || report.shutterAngle !== 360 || report.sampleCount !== 8 || report.programCount !== 0) throw new Error("typed decoded temporal motion-blur receipt is incomplete");
  if (report.temporalFramesWithReceipt !== 15 || report.maximumDistinctDecodedTimestampCount < 2 || report.residentFrameRingSize < 8 || report.residentBytes <= 0) throw new Error("formal decoded temporal resident receipt is incomplete");
  if (!report.noPluginInstallRequired || report.productPathCpuPixelCopies !== 0 || report.verificationReadback !== true || !report.audioSourceRetained || !report.materializedClipReset) throw new Error("formal product-path boundaries are incomplete");
  if (report.firstFrameSha256 === report.lastFrameSha256 || report.rejectedNegativeControls?.length !== 6) throw new Error("animation or fail-closed evidence is incomplete");
  for (const value of [report.executableSha256, report.stackSha256, report.intermediateSha256, report.firstFrameSha256, report.lastFrameSha256]) if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("formal identity is incomplete");
}

function syntheticSelfTest() {
  const report = { schema: "editkin.transform-motion-blur-project-render-gate/v1", status: "GREEN", executionMode: "resident-gpu-shader-sequence/v1", frameCount: 15, losslessPixelDifferences: 0, motionContract: "decoded-temporal-shutter-accumulation/v1", sourceSampling: "decoded_temporal", shutterAngle: 360, sampleCount: 8, temporalFramesWithReceipt: 15, maximumDistinctDecodedTimestampCount: 2, residentFrameRingSize: 8, residentBytes: 49_766_400, programCount: 0, noPluginInstallRequired: true, productPathCpuPixelCopies: 0, verificationReadback: true, audioSourceRetained: true, materializedClipReset: true, rejectedNegativeControls: ["missing-runtime", "invalid-samples", "invalid-shutter", "opacity-animation", "mixed-runtime", "outer-effect"], executableSha256: "a".repeat(64), stackSha256: "b".repeat(64), intermediateSha256: "c".repeat(64), firstFrameSha256: "d".repeat(64), lastFrameSha256: "e".repeat(64) };
  assertGreen(report); let calibratedNegatives = 0;
  for (const candidate of [{ ...report, status: "BLOCK" }, { ...report, losslessPixelDifferences: 1 }, { ...report, sampleCount: 1 }, { ...report, firstFrameSha256: report.lastFrameSha256 }, { ...report, rejectedNegativeControls: [] }]) { let rejected = false; try { assertGreen(candidate); } catch { rejected = true; calibratedNegatives += 1; } if (!rejected) throw new Error("project-render evaluator accepted a calibrated negative"); }
  process.stdout.write(`${JSON.stringify({ status: "GREEN", evaluator: report.schema, calibratedNegatives })}\n`);
}

function projectWithMotionBlur(): EditProject {
  const project = createDemoProject(); project.width = 960; project.height = 540; project.fps = 30;
  project.assets[0].uri = resolve(root, "public/demo-source.mp4"); project.assets[0].width = 960; project.assets[0].height = 540;
  const clip = project.tracks[0].clips[0]; clip.duration = .5; clip.transform = { x: -180, y: 0, scale: .65, rotation: -6, opacity: 1 };
  clip.keyframes = [{ id: "motion", time: 14 / 30, transform: { x: 180, y: 0, scale: .65, rotation: 6, opacity: 1 }, color: { ...clip.color }, easing: "linear" }];
  const motion = createTransformMotionBlurInstance(); motion.parameters.shutter_angle = 360;
  clip.creative = { effectPresetIds: [], nativeEffectInstances: [motion] };
  return project;
}

async function main() {
  if (selfTest) return syntheticSelfTest();
  const temporary = await mkdtemp(join(tmpdir(), "editkin-formal-transform-motion-blur-"));
  try {
    const project = projectWithMotionBlur(); const plan = buildRenderPlan(project, (uri) => uri);
    const runtime = { ffmpegPath: resolve(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe"), nativeCorePath: resolve(root, "native/bin/win32-x64/hao-core.exe"), gpuCompositorPath: resolve(root, "native/bin/win32-x64/editkin-gpu-compositor.exe"), pluginRoots: [] as string[], workspace: join(temporary, "workspace"), timeoutMs: 120_000 };
    const receipt = await materializeNativeEffectSegments(project, plan, runtime); const clip = receipt?.clips[0];
    if (!clip?.gpu || clip.instances.length !== 1) throw new Error("formal transform motion-blur receipt missing");
    const worker = clip.instances[0].worker as { runtime?: string; sourceSampling?: string; shutterAngle?: number; samples?: number };
    const intermediate = plan.videoLayers[0].segments.find((segment) => segment.kind === "clip"); if (!intermediate || intermediate.kind !== "clip") throw new Error("materialized clip missing");
    const renderedDirectory = join(runtime.workspace, "clip-demo-0-gpu-frames");
    let losslessPixelDifferences = 0;
    const extractedDirectory = join(temporary, "extracted"); await mkdir(extractedDirectory);
    const { spawn } = await import("node:child_process");
    await new Promise<void>((resolvePromise, reject) => { const child = spawn(runtime.ffmpegPath, ["-y", "-hide_banner", "-loglevel", "error", "-i", intermediate.assetPath, "-vsync", "0", "-start_number", "0", join(extractedDirectory, "frame-%08d.png")], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] }); let stderr = ""; child.stderr.on("data", (chunk) => { stderr += String(chunk); }); child.once("error", reject); child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(stderr))); });
    for (let frame = 0; frame < clip.frameCount; frame += 1) { const name = `frame-${String(frame).padStart(8, "0")}.png`; const rendered = PNG.sync.read(await readFile(join(renderedDirectory, name))); const decoded = PNG.sync.read(await readFile(join(extractedDirectory, name))); for (let index = 0; index < rendered.data.length; index += 1) if (rendered.data[index] !== decoded.data[index]) losslessPixelDifferences += 1; }
    const rejectedNegativeControls: string[] = [];
    const reject = async (name: string, candidate: EditProject, overrides: Partial<typeof runtime>, marker: RegExp) => { try { const candidatePlan = buildRenderPlan(candidate, (uri) => uri); await materializeNativeEffectSegments(candidate, candidatePlan, { ...runtime, workspace: join(temporary, `negative-${name}`), ...overrides }); } catch (error) { if (!marker.test(String(error))) throw error; rejectedNegativeControls.push(name); return; } throw new Error(`${name} negative accepted`); };
    await reject("missing-runtime", projectWithMotionBlur(), { gpuCompositorPath: undefined }, /缺少 GPU compositor runtime/);
    await reject("invalid-samples", (() => { const value = projectWithMotionBlur(); value.tracks[0].clips[0].creative!.nativeEffectInstances![0].parameters.samples = 9; return value; })(), {}, /安全範圍/);
    await reject("invalid-shutter", (() => { const value = projectWithMotionBlur(); value.tracks[0].clips[0].creative!.nativeEffectInstances![0].parameters.shutter_angle = 0; return value; })(), {}, /安全範圍|shutter angle/);
    await reject("opacity-animation", (() => { const value = projectWithMotionBlur(); value.tracks[0].clips[0].keyframes[0].transform.opacity = .5; return value; })(), {}, /透明度必須固定|constant opacity/);
    await reject("mixed-runtime", (() => { const value = projectWithMotionBlur(); value.tracks[0].clips[0].creative!.nativeEffectInstances!.unshift({ id: "cpu", pluginId: "creator.cpu-effect", capabilityId: "gain", pluginVersion: "1.0.0", manifestSha256: "a".repeat(64), runtimeType: "native_effect", enabled: true, parameters: { gain: 1 } }); return value; })(), {}, /混用 CPU ABI/);
    await reject("outer-effect", (() => { const value = projectWithMotionBlur(); value.tracks[0].clips[0].creative!.nativeEffectInstances!.push({ id: "outer", pluginId: "creator.gpu-effect", capabilityId: "gain", pluginVersion: "1.0.0", manifestSha256: "a".repeat(64), runtimeType: "gpu_effect_graph", enabled: true, parameters: { gain: 1 } }); return value; })(), {}, /最後一個視覺效果/);
    const materializedClipReset = intermediate.clip.sourceStart === 0 && !intermediate.clip.keyframes.length && intermediate.clip.transform.x === 0 && intermediate.clip.creative?.nativeEffectInstances?.length === 0;
    const report = { schema: "editkin.transform-motion-blur-project-render-gate/v1", measuredAt: new Date().toISOString(), status: "GREEN", executionMode: clip.executionMode, frameCount: clip.frameCount, losslessPixelDifferences, motionContract: worker.runtime, sourceSampling: worker.sourceSampling, shutterAngle: worker.shutterAngle, sampleCount: worker.samples, temporalFramesWithReceipt: clip.gpu.temporalSampling?.framesWithReceipt, maximumDistinctDecodedTimestampCount: clip.gpu.temporalSampling?.maximumDistinctDecodedTimestampCount, residentFrameRingSize: clip.gpu.temporalSampling?.residentFrameRingSize, residentBytes: clip.gpu.temporalSampling?.residentBytes, programCount: clip.gpu.programs.length, noPluginInstallRequired: true, productPathCpuPixelCopies: clip.gpu.productPathCpuPixelCopies, verificationReadback: clip.gpu.verificationReadback, audioSourceRetained: plan.audioClips.some((audio) => audio.clip.id === project.tracks[0].clips[0].id && audio.assetPath === project.assets[0].uri), materializedClipReset, rejectedNegativeControls, executableSha256: clip.gpu.executableSha256, stackSha256: clip.gpu.stackSha256, intermediateSha256: clip.intermediateSha256, intermediateBytes: (await stat(intermediate.assetPath)).size, firstFrameSha256: clip.gpu.firstFrameSha256, lastFrameSha256: clip.gpu.lastFrameSha256, sourceSha256: sha256(await readFile(project.assets[0].uri)) };
    await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); assertGreen(report); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

await main();
