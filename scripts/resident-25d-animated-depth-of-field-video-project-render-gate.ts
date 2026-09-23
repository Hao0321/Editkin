import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import { migrateProject, validateProject } from "../src/domain/editGraph";
import { projectSchema } from "../src/domain/schema";
import type { EditProject } from "../src/domain/types";
import { probeMedia, renderProject } from "../src/render/ffmpeg";
import { buildGpuEngineVideoPreviewGraph } from "../src/render/gpuCompositor";
import { renderResidentSceneLinearVideoSequence, type ResidentSceneLinearVideoSequenceReceipt } from "../src/render/residentSceneLinearVideoSequence";
import { comparePixels, createLensProject, ensureLensDetailSources, farFocus, farSource, ffprobe, fps, frameCount,
  lensRouteAccepted, nearFocus, nearSource, root, setLens, type PixelDelta } from "./resident25dLensGateFixture";

const evidenceRoot = resolve(root, "..", "..", ".rd", "benchmarks", "editkin-resident-25d-animated-depth-of-field-video-project-render");
const reportPath = join(evidenceRoot, "report.json");
const baselinePath = join(evidenceRoot, "baseline-report.json");
const executable = join(root, "native/bin/win32-x64/editkin-gpu-compositor.exe");
const frozenExecutable = join(evidenceRoot, "frozen-before-animated-lens.exe");
const selfTest = process.argv.includes("--self-test");
const baseline = process.argv.includes("--baseline");
const lastFrame = frameCount - 1;
const midFrame = 6;
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

type LensReceipt = NonNullable<ResidentSceneLinearVideoSequenceReceipt["depthOfField"]>;
interface ResourcePlan { sceneDepthBytes: number; depthOfFieldAdditionalWorkingBytes: number; maximumFullFramePassesPerPresent: number; requiredBytes: number }
interface GateReport {
  schema: "editkin.resident-25d-animated-depth-of-field-video-project-render-gate/v1";
  measuredAt?: string; status: "GREEN" | "BLOCK"; frozenRedBaseline: boolean; baselineExecutableSha256: string; executableSha256: string;
  planner: string; frameCount: number; depthReceiptFrames: number; depthOfFieldReceiptFrames: number; animatedFrameTransitions: number;
  firstLens: LensReceipt; lastLens: LensReceipt; resourcePlan: ResourcePlan; productPathCpuPixelCopies: number; verificationReadback: boolean;
  endpointNearDelta: PixelDelta; endpointFarDelta: PixelDelta; midpointNearDelta: PixelDelta; midpointFarDelta: PixelDelta;
  resourcePlanStableAcrossControls: boolean; bt709Tagged: boolean; audioPresent: boolean; rejectedNegativeControls: string[];
  inputSha256: [string, string]; outputSha256: string;
}

function assertGreen(report: GateReport): void {
  if (report.schema !== "editkin.resident-25d-animated-depth-of-field-video-project-render-gate/v1" || report.status !== "GREEN") throw new Error("animated lens report is not GREEN");
  if (!report.frozenRedBaseline || !/^[a-f0-9]{64}$/.test(report.baselineExecutableSha256) || report.baselineExecutableSha256 === report.executableSha256) throw new Error("animated lens baseline is not independently frozen");
  if (report.planner !== "editkin-resident-video-scene-linear-aces2-formal-sequence/v1" || report.frameCount !== frameCount
    || report.depthReceiptFrames !== frameCount || report.depthOfFieldReceiptFrames !== frameCount || report.animatedFrameTransitions < frameCount - 2) throw new Error("animated lens frame receipts are incomplete");
  const first = report.firstLens; const last = report.lastLens;
  if (first.animationContract !== "timeline-keyframes/v1" || last.animationContract !== "timeline-keyframes/v1"
    || first.keyframeCount !== 1 || last.keyframeCount !== 1 || first.sampledTimelineFrame !== 0 || last.sampledTimelineFrame !== lastFrame
    || Math.abs(first.focusDistance - nearFocus) > .0001 || Math.abs(last.focusDistance - farFocus) > .0001
    || first.aperture !== 3.5 || last.aperture !== 3.5 || first.maxBlurRadius !== 14 || last.maxBlurRadius !== 14) throw new Error("animated lens endpoint receipts do not match authored focus keyframes");
  const resources = report.resourcePlan;
  if (resources.sceneDepthBytes !== 2_073_600 || resources.depthOfFieldAdditionalWorkingBytes !== 0
    || resources.maximumFullFramePassesPerPresent !== 3 || resources.requiredBytes !== 51_840_000 || !report.resourcePlanStableAcrossControls) throw new Error("animated lens changed the closed resource plan");
  if (report.productPathCpuPixelCopies !== 0 || !report.verificationReadback) throw new Error("animated lens left the resident GPU product route");
  if (report.endpointNearDelta.changed !== 0 || report.endpointFarDelta.changed !== 0) throw new Error("animated lens endpoints differ from static decoded controls");
  if (report.midpointNearDelta.changed < 8_000 || report.midpointFarDelta.changed < 8_000
    || report.midpointNearDelta.high < 1_000 || report.midpointFarDelta.high < 1_000
    || report.midpointNearDelta.maximum < 24 || report.midpointFarDelta.maximum < 24) throw new Error("animated lens midpoint is not visually distinct from both static controls");
  if (!report.bt709Tagged || !report.audioPresent) throw new Error("animated lens formal delivery metadata is incomplete");
  const negatives = "zero-time,duplicate-frame,end-frame,focus-at-near,focus-at-far,zero-aperture,oversized-radius,seventeenth-keyframe,unknown-easing";
  if (report.rejectedNegativeControls.join() !== negatives) throw new Error("animated lens negative controls are incomplete");
  for (const identity of [report.baselineExecutableSha256, report.executableSha256, ...report.inputSha256, report.outputSha256]) if (!/^[a-f0-9]{64}$/.test(identity)) throw new Error("animated lens artifact identity is incomplete");
}

function syntheticSelfTest(): void {
  const lens = (focusDistance: number, sampledTimelineFrame: number): LensReceipt => ({ contract: "camera_depth_of_field/v1", nodeId: "scene25d:depth-of-field",
    focusDistance, aperture: 3.5, maxBlurRadius: 14, executionMode: "scene-linear-depth32f-gather-dof/v1", depthSource: "depth32_float",
    executor: "wgpu-depth-aware-gather/v1", passCount: 1, animationContract: "timeline-keyframes/v1", keyframeCount: 1, sampledTimelineFrame });
  const valid: GateReport = { schema: "editkin.resident-25d-animated-depth-of-field-video-project-render-gate/v1", status: "GREEN", frozenRedBaseline: true,
    baselineExecutableSha256: "a".repeat(64), executableSha256: "b".repeat(64), planner: "editkin-resident-video-scene-linear-aces2-formal-sequence/v1",
    frameCount, depthReceiptFrames: frameCount, depthOfFieldReceiptFrames: frameCount, animatedFrameTransitions: 11,
    firstLens: lens(nearFocus, 0), lastLens: lens(farFocus, lastFrame), resourcePlan: { sceneDepthBytes: 2_073_600, depthOfFieldAdditionalWorkingBytes: 0, maximumFullFramePassesPerPresent: 3, requiredBytes: 51_840_000 },
    productPathCpuPixelCopies: 0, verificationReadback: true, endpointNearDelta: { changed: 0, high: 0, maximum: 0 }, endpointFarDelta: { changed: 0, high: 0, maximum: 0 },
    midpointNearDelta: { changed: 20_000, high: 5_000, maximum: 80 }, midpointFarDelta: { changed: 21_000, high: 6_000, maximum: 90 },
    resourcePlanStableAcrossControls: true, bt709Tagged: true, audioPresent: true,
    rejectedNegativeControls: ["zero-time", "duplicate-frame", "end-frame", "focus-at-near", "focus-at-far", "zero-aperture", "oversized-radius", "seventeenth-keyframe", "unknown-easing"],
    inputSha256: ["c".repeat(64), "d".repeat(64)], outputSha256: "e".repeat(64) };
  assertGreen(valid);
  const mutations: GateReport[] = [
    { ...valid, frozenRedBaseline: false }, { ...valid, depthReceiptFrames: 11 }, { ...valid, depthOfFieldReceiptFrames: 11 }, { ...valid, animatedFrameTransitions: 0 },
    { ...valid, firstLens: { ...valid.firstLens, animationContract: "static/v1" } }, { ...valid, lastLens: { ...valid.lastLens, focusDistance: nearFocus } },
    { ...valid, resourcePlan: { ...valid.resourcePlan, sceneDepthBytes: 0 } }, { ...valid, productPathCpuPixelCopies: 1 },
    { ...valid, endpointNearDelta: { changed: 1, high: 0, maximum: 9 } }, { ...valid, endpointFarDelta: { changed: 1, high: 0, maximum: 9 } },
    { ...valid, midpointNearDelta: { changed: 0, high: 0, maximum: 0 } }, { ...valid, midpointFarDelta: { changed: 0, high: 0, maximum: 0 } },
    { ...valid, resourcePlanStableAcrossControls: false }, { ...valid, bt709Tagged: false }, { ...valid, rejectedNegativeControls: [] },
  ];
  for (const candidate of mutations) { let rejected = false; try { assertGreen(candidate); } catch { rejected = true; } if (!rejected) throw new Error("animated lens evaluator accepted a calibrated mutation"); }
  process.stdout.write(`${JSON.stringify({ status: "GREEN", evaluator: valid.schema, calibratedMutations: mutations.length })}\n`);
}

function animatedProject(): EditProject {
  return createLensProject({ keyframes: [{ id: "rack-focus", time: lastFrame / fps, focusDistance: farFocus, aperture: 3.5, maxBlurRadius: 14, easing: "ease_in_out" }] });
}

function preview(value: EditProject) {
  const parsed = validateProject(projectSchema.parse(migrateProject(JSON.parse(JSON.stringify(value)))));
  const result = buildGpuEngineVideoPreviewGraph(parsed, 0);
  if (!result?.graph.nodes.some((node) => node.kind === "depth_of_field")) throw new Error("animated lens product route was not admitted");
  return result;
}

async function sequence(value: EditProject, outputDirectory: string, binary = executable) {
  const built = preview(value);
  return renderResidentSceneLinearVideoSequence({ executable: binary, graph: built.graph, assetBindings: built.assetBindings,
    startFrame: 0, frameCount, outputDirectory, timeoutMs: 180_000 });
}

async function png(directory: string, frame: number): Promise<PNG> {
  return PNG.sync.read(await readFile(join(directory, `frame-${String(frame).padStart(8, "0")}.png`)));
}

async function main(): Promise<void> {
  if (selfTest) return syntheticSelfTest();
  await mkdir(evidenceRoot, { recursive: true });
  await ensureLensDetailSources();
  const candidate = animatedProject();
  if (baseline) {
    let evaluatorRejection = "missing_native_lens_animation_contract";
    try {
      const receipt = await sequence(candidate, join(evidenceRoot, "red-baseline-frames"), frozenExecutable);
      if (receipt.depthOfFieldAnimatedFrameTransitions > 0) throw new Error("frozen executable unexpectedly animated the lens");
    } catch (error) {
      evaluatorRejection = String(error).includes("unexpectedly") ? "unexpected_native_lens_animation" : "missing_native_lens_animation_contract";
    }
    if (evaluatorRejection === "unexpected_native_lens_animation") throw new Error(evaluatorRejection);
    const report = { schema: "editkin.resident-25d-animated-depth-of-field-video-project-render-baseline/v1", measuredAt: new Date().toISOString(), status: "BLOCK",
      evaluatorRejection, executableSha256: sha256(await readFile(frozenExecutable)) };
    await writeFile(baselinePath, `${JSON.stringify(report, null, 2)}\n`, "utf8"); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); return;
  }
  if (!lensRouteAccepted(candidate)) throw new Error("animated lens candidate is outside the product route");
  const frozen = JSON.parse(await readFile(baselinePath, "utf8")) as { status?: string; evaluatorRejection?: string; executableSha256?: string };
  const animatedDirectory = join(evidenceRoot, "animated-frames"); const nearDirectory = join(evidenceRoot, "near-control-frames"); const farDirectory = join(evidenceRoot, "far-control-frames");
  const animatedReceipt = await sequence(candidate, animatedDirectory);
  const nearReceipt = await sequence(createLensProject(), nearDirectory);
  const farReceipt = await sequence(createLensProject({ focusDistance: farFocus }), farDirectory);
  const output = join(evidenceRoot, "animated-rack-focus.mp4");
  const rendered = await renderProject(candidate, output, { ffmpegPath: resolve(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobePath: ffprobe, gpuCompositorPath: executable, preferGpu: false, timeoutMs: 180_000 });
  const pipeline = rendered.residentVideoPipeline;
  if (!pipeline?.depthOfField || !pipeline.depthOfFieldLast) throw new Error("formal animated lens pipeline omitted endpoint receipts");
  const [animatedFirst, animatedMid, animatedLast, nearFirst, nearMid, farMid, farLast] = await Promise.all([
    png(animatedDirectory, 0), png(animatedDirectory, midFrame), png(animatedDirectory, lastFrame), png(nearDirectory, 0), png(nearDirectory, midFrame), png(farDirectory, midFrame), png(farDirectory, lastFrame),
  ]);
  const rejectedNegativeControls: string[] = [];
  const reject = (name: string, value: EditProject) => { if (lensRouteAccepted(value)) throw new Error(`${name} animated lens negative was admitted`); rejectedNegativeControls.push(name); };
  const zeroTime = animatedProject(); zeroTime.scene25d!.depthOfField.keyframes[0].time = 0; reject("zero-time", zeroTime);
  const duplicate = animatedProject(); duplicate.scene25d!.depthOfField.keyframes = [
    { id: "a", time: .1, focusDistance: 3.5, aperture: 3, maxBlurRadius: 12, easing: "linear" },
    { id: "b", time: .11, focusDistance: 4, aperture: 4, maxBlurRadius: 14, easing: "linear" }]; reject("duplicate-frame", duplicate);
  const endFrame = animatedProject(); endFrame.scene25d!.depthOfField.keyframes[0].time = frameCount / fps; reject("end-frame", endFrame);
  const focusNear = animatedProject(); focusNear.scene25d!.depthOfField.keyframes[0].focusDistance = focusNear.scene25d!.camera.near; reject("focus-at-near", focusNear);
  const focusFar = animatedProject(); focusFar.scene25d!.depthOfField.keyframes[0].focusDistance = focusFar.scene25d!.camera.far; reject("focus-at-far", focusFar);
  const aperture = animatedProject(); aperture.scene25d!.depthOfField.keyframes[0].aperture = 0; reject("zero-aperture", aperture);
  const radius = animatedProject(); radius.scene25d!.depthOfField.keyframes[0].maxBlurRadius = 33; reject("oversized-radius", radius);
  const seventeenth = animatedProject(); seventeenth.scene25d!.depthOfField.keyframes = Array.from({ length: 17 }, (_, index) => ({ id: `key-${index}`, time: (index + 1) / 1000,
    focusDistance: 3.5, aperture: 3, maxBlurRadius: 12, easing: "linear" as const })); reject("seventeenth-keyframe", seventeenth);
  const unknown = animatedProject(); unknown.scene25d!.depthOfField.keyframes[0].easing = "cubic_magic" as "linear"; reject("unknown-easing", unknown);
  const resourcePlan = animatedReceipt.resourcePlan as unknown as ResourcePlan;
  const report: GateReport = {
    schema: "editkin.resident-25d-animated-depth-of-field-video-project-render-gate/v1", measuredAt: new Date().toISOString(), status: "GREEN",
    frozenRedBaseline: frozen.status === "BLOCK" && frozen.evaluatorRejection === "missing_native_lens_animation_contract", baselineExecutableSha256: frozen.executableSha256 ?? "",
    executableSha256: sha256(await readFile(executable)), planner: rendered.planner, frameCount: pipeline.frameCount,
    depthReceiptFrames: pipeline.depthReceiptFrames, depthOfFieldReceiptFrames: pipeline.depthOfFieldReceiptFrames,
    animatedFrameTransitions: pipeline.depthOfFieldAnimatedFrameTransitions, firstLens: pipeline.depthOfField, lastLens: pipeline.depthOfFieldLast,
    resourcePlan, productPathCpuPixelCopies: pipeline.productPathCpuPixelCopies, verificationReadback: pipeline.verificationReadback,
    endpointNearDelta: comparePixels(animatedFirst, nearFirst), endpointFarDelta: comparePixels(animatedLast, farLast),
    midpointNearDelta: comparePixels(animatedMid, nearMid), midpointFarDelta: comparePixels(animatedMid, farMid),
    resourcePlanStableAcrossControls: JSON.stringify(animatedReceipt.resourcePlan) === JSON.stringify(nearReceipt.resourcePlan) && JSON.stringify(animatedReceipt.resourcePlan) === JSON.stringify(farReceipt.resourcePlan),
    bt709Tagged: false, audioPresent: false, rejectedNegativeControls,
    inputSha256: [sha256(await readFile(nearSource)), sha256(await readFile(farSource))], outputSha256: sha256(await readFile(output)),
  };
  const media = await probeMedia(output, ffprobe); report.bt709Tagged = media.colorPrimaries === "bt709" && media.colorTransfer === "bt709" && media.colorMatrix === "bt709"; report.audioPresent = media.hasAudio;
  try { assertGreen(report); } catch (error) { report.status = "BLOCK"; await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"); process.stderr.write(`${JSON.stringify(report, null, 2)}\n`); throw error; }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
