import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PNG } from "pngjs";
import { createDemoProject } from "../src/domain/demo";
import { createTransformMotionBlurInstance } from "../src/domain/transformMotionBlur";
import type { EditProject } from "../src/domain/types";
import { materializeNativeEffectSegments } from "../src/plugins/nativeEffectRender";
import { buildGpuEngineVideoPreviewGraph } from "../src/render/gpuCompositor";
import { buildRenderPlan } from "../src/render/planner";

const root = resolve(import.meta.dirname, "..");
const evidenceRoot = resolve(root, "../../.rd/benchmarks/editkin-temporal-typography-project-render");
const reportPath = join(evidenceRoot, "report.json");
const selfTest = process.argv.includes("--self-test");
const positional = process.argv.find((value, index) => index > 1 && !value.startsWith("--"));
const compositor = resolve(positional ?? join(root, "native/bin/win32-x64/editkin-gpu-compositor.exe"));
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

function assertGreen(report: Record<string, any>) {
  if (report.schema !== "editkin.temporal-typography-project-render-gate/v1" || report.status !== "GREEN") throw new Error("temporal typography project render is not GREEN");
  if (report.executionMode !== "resident-gpu-shader-sequence/v1" || report.frameCount !== 15 || report.losslessPixelDifferences !== 0) throw new Error("temporal typography intermediate was not lossless");
  if (report.motionContract !== "decoded-temporal-shutter-accumulation/v1" || report.typographyContract !== "decoded-temporal-typography-overlays/v1") throw new Error("formal temporal typography contracts are incomplete");
  if (report.temporalFramesWithReceipt !== 15 || report.maximumDistinctDecodedTimestampCount < 2 || report.residentFrameRingSize < 8) throw new Error("formal decoded temporal receipt is incomplete");
  if (report.captionCueIds?.join() !== "caption-single-colour" || report.motionGraphicIds?.join() !== "title-card" || !report.singleColourCaptions) throw new Error("formal typography identity or single-colour contract is incomplete");
  if (report.captionTextureUploads !== 1 || report.motionGraphicTextureUploads !== 1 || report.framesWithActiveCaptions !== 9 || report.framesWithActiveMotionGraphics !== 8) throw new Error("formal typography timeline or upload receipt is incomplete");
  if (report.typographyChangedPixels < 1000 || report.typographyHighDeltaPixels < 500 || report.firstFrameSha256 === report.lastFrameSha256) throw new Error("formal typography artifact oracle is incomplete");
  if (!report.captionPlanSuppressed || !report.materializedClipReset || report.retainedAudioClipCount !== 1 || report.productPathCpuPixelCopies !== 0 || report.verificationReadback !== true) throw new Error("formal typography RenderPlan convergence is incomplete");
  if (report.programCount !== 0 || report.rejectedNegativeControls?.length !== 4) throw new Error("formal typography fail-closed evidence is incomplete");
  for (const value of [report.executableSha256, report.stackSha256, report.intermediateSha256, report.firstFrameSha256, report.lastFrameSha256]) if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("formal identity is incomplete");
}

function syntheticSelfTest() {
  const report = {
    schema: "editkin.temporal-typography-project-render-gate/v1", status: "GREEN", executionMode: "resident-gpu-shader-sequence/v1",
    frameCount: 15, losslessPixelDifferences: 0, motionContract: "decoded-temporal-shutter-accumulation/v1", typographyContract: "decoded-temporal-typography-overlays/v1",
    temporalFramesWithReceipt: 15, maximumDistinctDecodedTimestampCount: 2, residentFrameRingSize: 8,
    captionCueIds: ["caption-single-colour"], motionGraphicIds: ["title-card"], singleColourCaptions: true,
    captionTextureUploads: 1, motionGraphicTextureUploads: 1, framesWithActiveCaptions: 9, framesWithActiveMotionGraphics: 8,
    typographyChangedPixels: 3000, typographyHighDeltaPixels: 2000, captionPlanSuppressed: true, materializedClipReset: true,
    retainedAudioClipCount: 1, productPathCpuPixelCopies: 0, verificationReadback: true, programCount: 0,
    rejectedNegativeControls: ["missing-runtime", "translation", "outside-range", "missing-font-root"],
    executableSha256: "a".repeat(64), stackSha256: "b".repeat(64), intermediateSha256: "c".repeat(64), firstFrameSha256: "d".repeat(64), lastFrameSha256: "e".repeat(64),
  };
  assertGreen(report); let calibratedNegatives = 0;
  for (const candidate of [{ ...report, status: "BLOCK" }, { ...report, losslessPixelDifferences: 1 }, { ...report, framesWithActiveCaptions: 8 }, { ...report, typographyChangedPixels: 0 }, { ...report, captionPlanSuppressed: false }, { ...report, singleColourCaptions: false }]) {
    let rejected = false; try { assertGreen(candidate); } catch { rejected = true; calibratedNegatives += 1; } if (!rejected) throw new Error("temporal typography evaluator accepted a calibrated negative");
  }
  process.stdout.write(`${JSON.stringify({ status: "GREEN", evaluator: report.schema, calibratedNegatives })}\n`);
}

function projectWithTemporalTypography(includeTypography = true): EditProject {
  const project = createDemoProject(); project.width = 960; project.height = 540; project.fps = 30; project.captions = []; project.motionGraphics = [];
  project.assets[0].uri = resolve(root, "public/demo-source.mp4"); project.assets[0].width = 960; project.assets[0].height = 540;
  const base = project.tracks[0].clips[0]; base.duration = .5; base.transform = { x: -180, y: 0, scale: .65, rotation: -6, opacity: 1 };
  base.keyframes = [{ id: "motion", time: 14 / 30, transform: { x: 180, y: 0, scale: .65, rotation: 6, opacity: 1 }, color: { ...base.color }, easing: "linear" }];
  const motion = createTransformMotionBlurInstance(); motion.parameters.shutter_angle = 360; base.creative = { effectPresetIds: [], nativeEffectInstances: [motion] };
  if (!includeTypography) return project;
  project.captions.push({ id: "caption-single-colour", text: "字幕保持單色", start: 3 / 30, duration: 9 / 30 });
  project.motionGraphics.push({
    schema: "hao.motion-composition/v1", id: "title-card", name: "Title", kind: "card", text: "關鍵重點",
    timelineStart: 4 / 30, duration: 8 / 30, x: .08, y: .09, width: .48, fontSize: 54,
    fontFamily: "Noto Sans TC", fontWeight: 800, letterSpacing: 0, outlineWidth: 3, shadowDepth: 3, cornerRadius: 18,
    textColor: "#FFFFFFFF", backgroundColor: "#10151FEE", accentColor: "#A8FF3EFF", animation: "slide_up", offsetX: 0, offsetY: 0,
  });
  return project;
}

async function extractFrames(ffmpeg: string, input: string, outputDirectory: string) {
  await mkdir(outputDirectory, { recursive: true });
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", input, "-vsync", "0", "-start_number", "0", join(outputDirectory, "frame-%08d.png")], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = ""; child.stderr.on("data", (chunk) => { stderr += String(chunk); }); child.once("error", reject); child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(stderr)));
  });
}

function changedStats(left: Buffer, right: Buffer) {
  const a = PNG.sync.read(left); const b = PNG.sync.read(right); let typographyChangedPixels = 0; let typographyHighDeltaPixels = 0;
  for (let pixel = 0; pixel < a.width * a.height; pixel += 1) { let delta = 0; for (let channel = 0; channel < 4; channel += 1) delta += Math.abs(a.data[pixel * 4 + channel] - b.data[pixel * 4 + channel]); if (delta > 8) typographyChangedPixels += 1; if (delta > 32) typographyHighDeltaPixels += 1; }
  return { typographyChangedPixels, typographyHighDeltaPixels };
}

async function main() {
  if (selfTest) return syntheticSelfTest();
  const temporary = await mkdtemp(join(tmpdir(), "editkin-formal-temporal-typography-"));
  try {
    const ffmpegPath = resolve(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
    const runtime = { ffmpegPath, nativeCorePath: resolve(root, "native/bin/win32-x64/hao-core.exe"), gpuCompositorPath: compositor, pluginRoots: [] as string[], fontRoot: resolve(root, "public/fonts"), workspace: join(temporary, "mixed"), timeoutMs: 120_000 };
    const project = projectWithTemporalTypography(); const plan = buildRenderPlan(project, (uri) => uri);
    const receipt = await materializeNativeEffectSegments(project, plan, runtime); const clip = receipt?.clips[0];
    if (!clip?.gpu || clip.instances.length !== 1 || !clip.gpu.typography) throw new Error("formal temporal typography receipt missing");
    const worker = clip.instances[0].worker as { runtime?: string; typographyContract?: string };
    const intermediate = plan.videoLayers[0].segments.find((segment) => segment.kind === "clip"); if (!intermediate || intermediate.kind !== "clip") throw new Error("materialized temporal typography clip missing");
    const renderedDirectory = join(runtime.workspace, "clip-demo-0-gpu-temporal-typography-frames");
    const extractedDirectory = join(temporary, "extracted"); await extractFrames(ffmpegPath, intermediate.assetPath, extractedDirectory);
    let losslessPixelDifferences = 0;
    for (let frame = 0; frame < clip.frameCount; frame += 1) { const name = `frame-${String(frame).padStart(8, "0")}.png`; const rendered = PNG.sync.read(await readFile(join(renderedDirectory, name))); const decoded = PNG.sync.read(await readFile(join(extractedDirectory, name))); for (let index = 0; index < rendered.data.length; index += 1) if (rendered.data[index] !== decoded.data[index]) losslessPixelDifferences += 1; }
    const controlProject = projectWithTemporalTypography(false); const controlPlan = buildRenderPlan(controlProject, (uri) => uri); const controlRuntime = { ...runtime, workspace: join(temporary, "control") };
    await materializeNativeEffectSegments(controlProject, controlPlan, controlRuntime);
    const mixedFrame = await readFile(join(renderedDirectory, "frame-00000007.png")); const controlFrame = await readFile(join(controlRuntime.workspace, "clip-demo-0-gpu-frames/frame-00000007.png"));
    const typographyDelta = changedStats(controlFrame, mixedFrame);
    const rejectedNegativeControls: string[] = [];
    try { await materializeNativeEffectSegments(projectWithTemporalTypography(), buildRenderPlan(projectWithTemporalTypography(), (uri) => uri), { ...runtime, gpuCompositorPath: undefined, workspace: join(temporary, "missing-runtime") }); } catch (error) { if (!/缺少 GPU compositor runtime/.test(String(error))) throw error; rejectedNegativeControls.push("missing-runtime"); }
    const translation = projectWithTemporalTypography(); translation.captions[0].translation = { text: "Second colour", language: "en" }; if (buildGpuEngineVideoPreviewGraph(translation, 0) === undefined) rejectedNegativeControls.push("translation");
    const outside = projectWithTemporalTypography(); outside.captions[0].start = .45; outside.captions[0].duration = .2; if (buildGpuEngineVideoPreviewGraph(outside, 0) === undefined) rejectedNegativeControls.push("outside-range");
    try { await materializeNativeEffectSegments(projectWithTemporalTypography(), buildRenderPlan(projectWithTemporalTypography(), (uri) => uri), { ...runtime, fontRoot: undefined, workspace: join(temporary, "missing-font") }); } catch (error) { if (!/font root|EDITKIN_FONT_ROOT/i.test(String(error))) throw error; rejectedNegativeControls.push("missing-font-root"); }
    const typography = clip.gpu.typography; const materializedClipReset = intermediate.clip.sourceStart === 0 && !intermediate.clip.keyframes.length && intermediate.clip.transform.x === 0 && intermediate.clip.creative?.nativeEffectInstances?.length === 0;
    const report = {
      schema: "editkin.temporal-typography-project-render-gate/v1", measuredAt: new Date().toISOString(), status: "GREEN", executionMode: clip.executionMode,
      frameCount: clip.frameCount, losslessPixelDifferences, motionContract: worker.runtime, typographyContract: worker.typographyContract,
      temporalFramesWithReceipt: clip.gpu.temporalSampling?.framesWithReceipt, maximumDistinctDecodedTimestampCount: clip.gpu.temporalSampling?.maximumDistinctDecodedTimestampCount,
      residentFrameRingSize: clip.gpu.temporalSampling?.residentFrameRingSize, residentBytes: clip.gpu.temporalSampling?.residentBytes,
      captionCueIds: typography.captionCueIds, motionGraphicIds: typography.motionGraphicIds, captionTextureUploads: typography.captionTextureUploads,
      motionGraphicTextureUploads: typography.motionGraphicTextureUploads, framesWithActiveCaptions: typography.framesWithActiveCaptions,
      framesWithActiveMotionGraphics: typography.framesWithActiveMotionGraphics, singleColourCaptions: typography.singleColourCaptions,
      ...typographyDelta, captionPlanSuppressed: plan.captions.length === 0, materializedClipReset, retainedAudioClipCount: plan.audioClips.length,
      programCount: clip.gpu.programs.length, productPathCpuPixelCopies: clip.gpu.productPathCpuPixelCopies, verificationReadback: clip.gpu.verificationReadback,
      rejectedNegativeControls, executableSha256: clip.gpu.executableSha256, stackSha256: clip.gpu.stackSha256, intermediateSha256: clip.intermediateSha256,
      intermediateBytes: (await stat(intermediate.assetPath)).size, firstFrameSha256: clip.gpu.firstFrameSha256, lastFrameSha256: clip.gpu.lastFrameSha256,
      sourceSha256: sha256(await readFile(project.assets[0].uri)),
    };
    await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); assertGreen(report); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

await main();
