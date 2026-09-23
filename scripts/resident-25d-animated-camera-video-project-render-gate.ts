import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import { migrateProject, validateProject } from "../src/domain/editGraph";
import { projectSchema } from "../src/domain/schema";
import type { EditProject, Scene25dCameraKeyframe } from "../src/domain/types";
import { probeMedia, renderProject } from "../src/render/ffmpeg";
import { buildGpuEngineVideoPreviewGraph } from "../src/render/gpuCompositor";
import { renderResidentSceneLinearVideoSequence, type ResidentSceneLinearVideoSequenceReceipt } from "../src/render/residentSceneLinearVideoSequence";
import { comparePixels, createLensProject, ensureLensDetailSources, farSource, ffprobe, fps, frameCount,
  lensRouteAccepted, nearSource, root, type PixelDelta } from "./resident25dLensGateFixture";

const evidenceRoot = resolve(root, "..", "..", ".rd", "benchmarks", "editkin-resident-25d-animated-camera-video-project-render");
const reportPath = join(evidenceRoot, "report.json");
const baselinePath = join(evidenceRoot, "baseline-report.json");
const executable = join(root, "native/bin/win32-x64/editkin-gpu-compositor.exe");
const frozenExecutable = join(evidenceRoot, "frozen-before-camera-animation.exe");
const selfTest = process.argv.includes("--self-test");
const baseline = process.argv.includes("--baseline");
const lastFrame = frameCount - 1;
const midFrame = 6;
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const radians = (degrees: number) => degrees * Math.PI / 180;
const close = (left: number, right: number) => Math.abs(left - right) <= .0001;
const startCamera = { position: [-.65, .05, 4.2] as [number, number, number], target: [-.18, 0, 0] as [number, number, number], verticalFovDegrees: 64 };
const endCamera = { position: [.75, -.08, 5.1] as [number, number, number], target: [.25, .04, 0] as [number, number, number], verticalFovDegrees: 46 };

type CameraReceipt = NonNullable<ResidentSceneLinearVideoSequenceReceipt["scene25d"]>;
interface ResourcePlan { sceneDepthBytes: number; depthOfFieldAdditionalWorkingBytes: number; maximumFullFramePassesPerPresent: number; requiredBytes: number }
interface GateReport {
  schema: "editkin.resident-25d-animated-camera-video-project-render-gate/v1";
  measuredAt?: string; status: "GREEN" | "BLOCK"; frozenRedBaseline: boolean; baselineExecutableSha256: string; executableSha256: string;
  planner: string; frameCount: number; sceneReceiptFrames: number; depthReceiptFrames: number; animatedFrameTransitions: number;
  firstCamera: CameraReceipt; lastCamera: CameraReceipt; resourcePlan: ResourcePlan; productPathCpuPixelCopies: number; verificationReadback: boolean;
  endpointStartDelta: PixelDelta; endpointEndDelta: PixelDelta; midpointStartDelta: PixelDelta; midpointEndDelta: PixelDelta;
  resourcePlanStableAcrossControls: boolean; bt709Tagged: boolean; audioPresent: boolean; rejectedNegativeControls: string[];
  inputSha256: [string, string]; outputSha256: string;
}

function cameraMatches(receipt: CameraReceipt, expected: typeof startCamera, sampledFrame: number): boolean {
  return receipt.cameraAnimationContract === "timeline-keyframes/v1" && receipt.cameraKeyframeCount === 1
    && receipt.sampledTimelineFrame === sampledFrame
    && receipt.cameraPosition.every((value, index) => close(value, expected.position[index]))
    && receipt.cameraTarget.every((value, index) => close(value, expected.target[index]))
    && close(receipt.cameraVerticalFovRadians, radians(expected.verticalFovDegrees));
}

function assertGreen(report: GateReport): void {
  if (report.schema !== "editkin.resident-25d-animated-camera-video-project-render-gate/v1" || report.status !== "GREEN") throw new Error("animated camera report is not GREEN");
  if (!report.frozenRedBaseline || !/^[a-f0-9]{64}$/.test(report.baselineExecutableSha256)
    || report.baselineExecutableSha256 === report.executableSha256) throw new Error("animated camera baseline is not independently frozen");
  if (report.planner !== "editkin-resident-video-scene-linear-aces2-formal-sequence/v1" || report.frameCount !== frameCount
    || report.sceneReceiptFrames !== frameCount || report.depthReceiptFrames !== frameCount
    || report.animatedFrameTransitions < frameCount - 2) throw new Error("animated camera frame receipts are incomplete");
  if (!cameraMatches(report.firstCamera, startCamera, 0) || !cameraMatches(report.lastCamera, endCamera, lastFrame)) {
    throw new Error("animated camera endpoint receipts do not match authored camera keyframes");
  }
  const resources = report.resourcePlan;
  if (resources.sceneDepthBytes !== 2_073_600 || resources.depthOfFieldAdditionalWorkingBytes !== 0
    || resources.maximumFullFramePassesPerPresent !== 2 || resources.requiredBytes !== 51_840_000
    || !report.resourcePlanStableAcrossControls) throw new Error("animated camera changed the closed resource plan");
  if (report.productPathCpuPixelCopies !== 0 || !report.verificationReadback) throw new Error("animated camera left the resident GPU product route");
  if (report.endpointStartDelta.changed !== 0 || report.endpointEndDelta.changed !== 0) throw new Error("animated camera endpoints differ from static decoded controls");
  if (report.midpointStartDelta.changed < 8_000 || report.midpointEndDelta.changed < 8_000
    || report.midpointStartDelta.high < 1_000 || report.midpointEndDelta.high < 1_000
    || report.midpointStartDelta.maximum < 24 || report.midpointEndDelta.maximum < 24) {
    throw new Error("animated camera midpoint is not visually distinct from both static controls");
  }
  if (!report.bt709Tagged || !report.audioPresent) throw new Error("animated camera formal delivery metadata is incomplete");
  const negatives = "zero-time,duplicate-frame,end-frame,coincident-position-target,fov-zero,fov-180,seventeenth-keyframe,unknown-easing";
  if (report.rejectedNegativeControls.join() !== negatives) throw new Error("animated camera negative controls are incomplete");
  for (const identity of [report.baselineExecutableSha256, report.executableSha256, ...report.inputSha256, report.outputSha256]) {
    if (!/^[a-f0-9]{64}$/.test(identity)) throw new Error("animated camera artifact identity is incomplete");
  }
}

function syntheticSelfTest(): void {
  const camera = (expected: typeof startCamera, sampledTimelineFrame: number): CameraReceipt => ({
    sceneContract: "single_camera_textured_planes/v1", planeCount: 2, videoPlaneCount: 2, parentedPlaneCount: 0,
    cameraNodeId: "scene25d:camera", depthMode: "per_pixel_opaque_plane_depth32float", depthFormat: "depth32_float",
    ambientLightCount: 1, directionalLightCount: 1,
    depthTestedPlaneCount: 2, depthPassCount: 1, geometryExecutor: "hao-core-native-camera-matrix-depth-plane/v1",
    pixelExecutor: "wgpu-projective-plane-depth-compositor/v1", cameraAnimationContract: "timeline-keyframes/v1", cameraKeyframeCount: 1,
    sampledTimelineFrame, cameraPosition: [...expected.position], cameraTarget: [...expected.target], cameraVerticalFovRadians: radians(expected.verticalFovDegrees),
    lightAnimationContract: "static/v1", ambientLightKeyframeCount: 0, directionalLightKeyframeCount: 0, sampledLightTimelineFrame: 0,
    ambientLightColor: [1, 1, 1], ambientLightIntensity: .28,
    directionalLightColor: [1, .92, .78], directionalLightIntensity: .92, directionalLightDirection: [.2, -.25, 1],
  });
  const valid: GateReport = {
    schema: "editkin.resident-25d-animated-camera-video-project-render-gate/v1", status: "GREEN", frozenRedBaseline: true,
    baselineExecutableSha256: "a".repeat(64), executableSha256: "b".repeat(64), planner: "editkin-resident-video-scene-linear-aces2-formal-sequence/v1",
    frameCount, sceneReceiptFrames: frameCount, depthReceiptFrames: frameCount, animatedFrameTransitions: 11,
    firstCamera: camera(startCamera, 0), lastCamera: camera(endCamera, lastFrame),
    resourcePlan: { sceneDepthBytes: 2_073_600, depthOfFieldAdditionalWorkingBytes: 0, maximumFullFramePassesPerPresent: 2, requiredBytes: 51_840_000 },
    productPathCpuPixelCopies: 0, verificationReadback: true,
    endpointStartDelta: { changed: 0, high: 0, maximum: 0 }, endpointEndDelta: { changed: 0, high: 0, maximum: 0 },
    midpointStartDelta: { changed: 20_000, high: 5_000, maximum: 80 }, midpointEndDelta: { changed: 21_000, high: 6_000, maximum: 90 },
    resourcePlanStableAcrossControls: true, bt709Tagged: true, audioPresent: true,
    rejectedNegativeControls: ["zero-time", "duplicate-frame", "end-frame", "coincident-position-target", "fov-zero", "fov-180", "seventeenth-keyframe", "unknown-easing"],
    inputSha256: ["c".repeat(64), "d".repeat(64)], outputSha256: "e".repeat(64),
  };
  assertGreen(valid);
  const mutations: GateReport[] = [
    { ...valid, frozenRedBaseline: false }, { ...valid, sceneReceiptFrames: 11 }, { ...valid, depthReceiptFrames: 11 }, { ...valid, animatedFrameTransitions: 0 },
    { ...valid, firstCamera: { ...valid.firstCamera, cameraAnimationContract: "static/v1" } },
    { ...valid, lastCamera: { ...valid.lastCamera, cameraPosition: startCamera.position } },
    { ...valid, resourcePlan: { ...valid.resourcePlan, sceneDepthBytes: 0 } }, { ...valid, productPathCpuPixelCopies: 1 },
    { ...valid, endpointStartDelta: { changed: 1, high: 0, maximum: 9 } }, { ...valid, endpointEndDelta: { changed: 1, high: 0, maximum: 9 } },
    { ...valid, midpointStartDelta: { changed: 0, high: 0, maximum: 0 } }, { ...valid, midpointEndDelta: { changed: 0, high: 0, maximum: 0 } },
    { ...valid, resourcePlanStableAcrossControls: false }, { ...valid, bt709Tagged: false }, { ...valid, rejectedNegativeControls: [] },
  ];
  for (const candidate of mutations) {
    let rejected = false; try { assertGreen(candidate); } catch { rejected = true; }
    if (!rejected) throw new Error("animated camera evaluator accepted a calibrated mutation");
  }
  process.stdout.write(`${JSON.stringify({ status: "GREEN", evaluator: valid.schema, calibratedMutations: mutations.length })}\n`);
}

function cameraProject(endpoint: "animated" | "start" | "end"): EditProject {
  const value = createLensProject({ enabled: false });
  const camera = value.scene25d!.camera;
  const authored = endpoint === "end" ? endCamera : startCamera;
  camera.position = [...authored.position]; camera.target = [...authored.target]; camera.verticalFovDegrees = authored.verticalFovDegrees;
  camera.keyframes = endpoint === "animated" ? [{ id: "camera-orbit", time: lastFrame / fps, position: [...endCamera.position],
    target: [...endCamera.target], verticalFovDegrees: endCamera.verticalFovDegrees, easing: "ease_in_out" }] : [];
  return value;
}

function preview(value: EditProject) {
  const parsed = validateProject(projectSchema.parse(migrateProject(JSON.parse(JSON.stringify(value)))));
  const result = buildGpuEngineVideoPreviewGraph(parsed, 0);
  if (!result?.scene25dExpectation || !result.graph.nodes.some((node) => node.kind === "camera")) {
    throw new Error("animated camera product route was not admitted");
  }
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
  const candidate = cameraProject("animated");
  if (baseline) {
    let evaluatorRejection = "missing_native_camera_animation_contract";
    try {
      const receipt = await sequence(candidate, join(evidenceRoot, "red-baseline-frames"), frozenExecutable);
      if (receipt.cameraAnimatedFrameTransitions > 0) throw new Error("frozen executable unexpectedly animated the camera");
    } catch (error) {
      evaluatorRejection = String(error).includes("unexpectedly") ? "unexpected_native_camera_animation" : "missing_native_camera_animation_contract";
    }
    if (evaluatorRejection === "unexpected_native_camera_animation") throw new Error(evaluatorRejection);
    const report = { schema: "editkin.resident-25d-animated-camera-video-project-render-baseline/v1", measuredAt: new Date().toISOString(), status: "BLOCK",
      evaluatorRejection, executableSha256: sha256(await readFile(frozenExecutable)) };
    await writeFile(baselinePath, `${JSON.stringify(report, null, 2)}\n`, "utf8"); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); return;
  }
  if (!lensRouteAccepted(candidate, false)) throw new Error("animated camera candidate is outside the product route");
  const frozen = JSON.parse(await readFile(baselinePath, "utf8")) as { status?: string; evaluatorRejection?: string; executableSha256?: string };
  const animatedDirectory = join(evidenceRoot, "animated-frames"); const startDirectory = join(evidenceRoot, "start-control-frames"); const endDirectory = join(evidenceRoot, "end-control-frames");
  const animatedReceipt = await sequence(candidate, animatedDirectory);
  const startReceipt = await sequence(cameraProject("start"), startDirectory);
  const endReceipt = await sequence(cameraProject("end"), endDirectory);
  const output = join(evidenceRoot, "animated-camera-orbit.mp4");
  const rendered = await renderProject(candidate, output, { ffmpegPath: resolve(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobePath: ffprobe,
    gpuCompositorPath: executable, preferGpu: false, timeoutMs: 180_000 });
  const pipeline = rendered.residentVideoPipeline;
  if (!pipeline?.scene25d || !pipeline.scene25dLast) throw new Error("formal animated camera pipeline omitted endpoint receipts");
  const [animatedFirst, animatedMid, animatedLast, startFirst, startMid, endMid, endLast] = await Promise.all([
    png(animatedDirectory, 0), png(animatedDirectory, midFrame), png(animatedDirectory, lastFrame), png(startDirectory, 0), png(startDirectory, midFrame), png(endDirectory, midFrame), png(endDirectory, lastFrame),
  ]);
  const rejectedNegativeControls: string[] = [];
  const reject = (name: string, value: EditProject) => { if (lensRouteAccepted(value, false)) throw new Error(`${name} animated camera negative was admitted`); rejectedNegativeControls.push(name); };
  const keyframe = (value: EditProject): Scene25dCameraKeyframe => value.scene25d!.camera.keyframes[0];
  const zeroTime = cameraProject("animated"); keyframe(zeroTime).time = 0; reject("zero-time", zeroTime);
  const duplicate = cameraProject("animated"); duplicate.scene25d!.camera.keyframes = [
    { id: "a", time: .1, position: [0, 0, 4.3], target: [0, 0, 0], verticalFovDegrees: 60, easing: "linear" },
    { id: "b", time: .11, position: [.2, 0, 4.4], target: [0, 0, 0], verticalFovDegrees: 58, easing: "linear" }]; reject("duplicate-frame", duplicate);
  const endFrame = cameraProject("animated"); keyframe(endFrame).time = frameCount / fps; reject("end-frame", endFrame);
  const coincident = cameraProject("animated"); keyframe(coincident).target = [...keyframe(coincident).position]; reject("coincident-position-target", coincident);
  const fovZero = cameraProject("animated"); keyframe(fovZero).verticalFovDegrees = 0; reject("fov-zero", fovZero);
  const fov180 = cameraProject("animated"); keyframe(fov180).verticalFovDegrees = 180; reject("fov-180", fov180);
  const seventeenth = cameraProject("animated"); seventeenth.scene25d!.camera.keyframes = Array.from({ length: 17 }, (_, index) => ({
    id: `key-${index}`, time: (index + 1) / 1000, position: [index / 100, 0, 4], target: [0, 0, 0], verticalFovDegrees: 60, easing: "linear" as const,
  })); reject("seventeenth-keyframe", seventeenth);
  const unknown = cameraProject("animated"); keyframe(unknown).easing = "cubic_magic" as "linear"; reject("unknown-easing", unknown);
  const resourcePlan = animatedReceipt.resourcePlan as unknown as ResourcePlan;
  const report: GateReport = {
    schema: "editkin.resident-25d-animated-camera-video-project-render-gate/v1", measuredAt: new Date().toISOString(), status: "GREEN",
    frozenRedBaseline: frozen.status === "BLOCK" && frozen.evaluatorRejection === "missing_native_camera_animation_contract",
    baselineExecutableSha256: frozen.executableSha256 ?? "", executableSha256: sha256(await readFile(executable)), planner: rendered.planner,
    frameCount: pipeline.frameCount, sceneReceiptFrames: pipeline.sceneReceiptFrames ?? 0, depthReceiptFrames: pipeline.depthReceiptFrames,
    animatedFrameTransitions: pipeline.cameraAnimatedFrameTransitions, firstCamera: pipeline.scene25d, lastCamera: pipeline.scene25dLast,
    resourcePlan, productPathCpuPixelCopies: pipeline.productPathCpuPixelCopies, verificationReadback: pipeline.verificationReadback,
    endpointStartDelta: comparePixels(animatedFirst, startFirst), endpointEndDelta: comparePixels(animatedLast, endLast),
    midpointStartDelta: comparePixels(animatedMid, startMid), midpointEndDelta: comparePixels(animatedMid, endMid),
    resourcePlanStableAcrossControls: JSON.stringify(animatedReceipt.resourcePlan) === JSON.stringify(startReceipt.resourcePlan)
      && JSON.stringify(animatedReceipt.resourcePlan) === JSON.stringify(endReceipt.resourcePlan),
    bt709Tagged: false, audioPresent: false, rejectedNegativeControls,
    inputSha256: [sha256(await readFile(nearSource)), sha256(await readFile(farSource))], outputSha256: sha256(await readFile(output)),
  };
  const media = await probeMedia(output, ffprobe); report.bt709Tagged = media.colorPrimaries === "bt709" && media.colorTransfer === "bt709"
    && media.colorMatrix === "bt709"; report.audioPresent = media.hasAudio;
  try { assertGreen(report); } catch (error) {
    report.status = "BLOCK"; await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"); process.stderr.write(`${JSON.stringify(report, null, 2)}\n`); throw error;
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
