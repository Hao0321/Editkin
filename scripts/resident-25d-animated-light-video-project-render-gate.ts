import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import { migrateProject, validateProject } from "../src/domain/editGraph";
import { projectSchema } from "../src/domain/schema";
import type { EditProject, Scene25dAmbientLightKeyframe, Scene25dDirectionalLightKeyframe } from "../src/domain/types";
import { probeMedia, renderProject } from "../src/render/ffmpeg";
import { buildGpuEngineVideoPreviewGraph } from "../src/render/gpuCompositor";
import { renderResidentSceneLinearVideoSequence, type ResidentSceneLinearVideoSequenceReceipt } from "../src/render/residentSceneLinearVideoSequence";
import { comparePixels, createLensProject, ensureLensDetailSources, farSource, ffprobe, fps, frameCount,
  lensRouteAccepted, nearSource, root, type PixelDelta } from "./resident25dLensGateFixture";

const evidenceRoot = resolve(root, "..", "..", ".rd", "benchmarks", "editkin-resident-25d-animated-light-video-project-render");
const reportPath = join(evidenceRoot, "report.json");
const baselinePath = join(evidenceRoot, "baseline-report.json");
const executable = join(root, "native/bin/win32-x64/editkin-gpu-compositor.exe");
const frozenExecutable = join(evidenceRoot, "frozen-before-light-animation.exe");
const selfTest = process.argv.includes("--self-test");
const baseline = process.argv.includes("--baseline");
const lastFrame = frameCount - 1;
const midFrame = 6;
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const close = (left: number, right: number) => Math.abs(left - right) <= .0001;
const startLight = { ambient: .18, color: [1, .55, .25] as [number, number, number], intensity: .65, direction: [.75, -.15, 1] as [number, number, number] };
const endLight = { ambient: .48, color: [.2, .55, 1] as [number, number, number], intensity: 1.45, direction: [-.9, .1, 1] as [number, number, number] };

type LightReceipt = NonNullable<ResidentSceneLinearVideoSequenceReceipt["scene25d"]>;
interface ResourcePlan { sceneDepthBytes: number; depthOfFieldAdditionalWorkingBytes: number; maximumFullFramePassesPerPresent: number; requiredBytes: number }
interface GateReport {
  schema: "editkin.resident-25d-animated-light-video-project-render-gate/v1";
  measuredAt?: string; status: "GREEN" | "BLOCK"; frozenRedBaseline: boolean; baselineExecutableSha256: string; executableSha256: string;
  planner: string; frameCount: number; sceneReceiptFrames: number; depthReceiptFrames: number; animatedFrameTransitions: number;
  firstLight: LightReceipt; lastLight: LightReceipt; resourcePlan: ResourcePlan; productPathCpuPixelCopies: number; verificationReadback: boolean;
  endpointStartDelta: PixelDelta; endpointEndDelta: PixelDelta; midpointStartDelta: PixelDelta; midpointEndDelta: PixelDelta;
  resourcePlanStableAcrossControls: boolean; bt709Tagged: boolean; audioPresent: boolean; rejectedNegativeControls: string[];
  inputSha256: [string, string]; outputSha256: string;
}

function vectorMatches(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => close(value, right[index]));
}

function lightMatches(receipt: LightReceipt, expected: typeof startLight, sampledFrame: number): boolean {
  return receipt.lightAnimationContract === "timeline-keyframes/v1" && receipt.ambientLightKeyframeCount === 1
    && receipt.directionalLightKeyframeCount === 1 && receipt.sampledLightTimelineFrame === sampledFrame
    && vectorMatches(receipt.ambientLightColor, [1, 1, 1]) && close(receipt.ambientLightIntensity, expected.ambient)
    && vectorMatches(receipt.directionalLightColor, expected.color) && close(receipt.directionalLightIntensity, expected.intensity)
    && vectorMatches(receipt.directionalLightDirection, expected.direction);
}

function assertGreen(report: GateReport): void {
  if (report.schema !== "editkin.resident-25d-animated-light-video-project-render-gate/v1" || report.status !== "GREEN") throw new Error("animated light report is not GREEN");
  if (!report.frozenRedBaseline || !/^[a-f0-9]{64}$/.test(report.baselineExecutableSha256)
    || report.baselineExecutableSha256 === report.executableSha256) throw new Error("animated light baseline is not independently frozen");
  if (report.planner !== "editkin-resident-video-scene-linear-aces2-formal-sequence/v1" || report.frameCount !== frameCount
    || report.sceneReceiptFrames !== frameCount || report.depthReceiptFrames !== frameCount
    || report.animatedFrameTransitions < frameCount - 2) throw new Error("animated light frame receipts are incomplete");
  if (!lightMatches(report.firstLight, startLight, 0) || !lightMatches(report.lastLight, endLight, lastFrame)) {
    throw new Error("animated light endpoint receipts do not match authored keyframes");
  }
  const resources = report.resourcePlan;
  if (resources.sceneDepthBytes !== 2_073_600 || resources.depthOfFieldAdditionalWorkingBytes !== 0
    || resources.maximumFullFramePassesPerPresent !== 2 || resources.requiredBytes !== 51_840_000
    || !report.resourcePlanStableAcrossControls) throw new Error("animated light changed the closed resource plan");
  if (report.productPathCpuPixelCopies !== 0 || !report.verificationReadback) throw new Error("animated light left the resident GPU product route");
  if (report.endpointStartDelta.changed !== 0 || report.endpointEndDelta.changed !== 0) throw new Error("animated light endpoints differ from static decoded controls");
  if (report.midpointStartDelta.changed < 8_000 || report.midpointEndDelta.changed < 8_000
    || report.midpointStartDelta.high < 1_000 || report.midpointEndDelta.high < 1_000
    || report.midpointStartDelta.maximum < 20 || report.midpointEndDelta.maximum < 20) {
    throw new Error("animated light midpoint is not visually distinct from both static controls");
  }
  if (!report.bt709Tagged || !report.audioPresent) throw new Error("animated light formal delivery metadata is incomplete");
  const negatives = "zero-time,duplicate-frame,end-frame,negative-ambient,negative-intensity,negative-color,zero-direction,seventeenth-keyframe,unknown-easing";
  if (report.rejectedNegativeControls.join() !== negatives) throw new Error("animated light negative controls are incomplete");
  for (const identity of [report.baselineExecutableSha256, report.executableSha256, ...report.inputSha256, report.outputSha256]) {
    if (!/^[a-f0-9]{64}$/.test(identity)) throw new Error("animated light artifact identity is incomplete");
  }
}

function syntheticSelfTest(): void {
  const light = (expected: typeof startLight, sampledLightTimelineFrame: number): LightReceipt => ({
    sceneContract: "single_camera_textured_planes/v1", planeCount: 2, videoPlaneCount: 2, parentedPlaneCount: 0,
    cameraNodeId: "scene25d:camera", ambientLightCount: 1, directionalLightCount: 1,
    depthMode: "per_pixel_opaque_plane_depth32float", depthFormat: "depth32_float", depthTestedPlaneCount: 2, depthPassCount: 1,
    geometryExecutor: "hao-core-native-camera-matrix-depth-plane/v1", pixelExecutor: "wgpu-projective-plane-depth-compositor/v1",
    cameraAnimationContract: "static/v1", cameraKeyframeCount: 0, sampledTimelineFrame: 0,
    cameraPosition: [0, 0, 4], cameraTarget: [0, 0, 0], cameraVerticalFovRadians: Math.PI / 3,
    lightAnimationContract: "timeline-keyframes/v1", ambientLightKeyframeCount: 1, directionalLightKeyframeCount: 1, sampledLightTimelineFrame,
    ambientLightColor: [1, 1, 1], ambientLightIntensity: expected.ambient, directionalLightColor: [...expected.color],
    directionalLightIntensity: expected.intensity, directionalLightDirection: [...expected.direction],
  });
  const valid: GateReport = {
    schema: "editkin.resident-25d-animated-light-video-project-render-gate/v1", status: "GREEN", frozenRedBaseline: true,
    baselineExecutableSha256: "a".repeat(64), executableSha256: "b".repeat(64), planner: "editkin-resident-video-scene-linear-aces2-formal-sequence/v1",
    frameCount, sceneReceiptFrames: frameCount, depthReceiptFrames: frameCount, animatedFrameTransitions: 11,
    firstLight: light(startLight, 0), lastLight: light(endLight, lastFrame),
    resourcePlan: { sceneDepthBytes: 2_073_600, depthOfFieldAdditionalWorkingBytes: 0, maximumFullFramePassesPerPresent: 2, requiredBytes: 51_840_000 },
    productPathCpuPixelCopies: 0, verificationReadback: true,
    endpointStartDelta: { changed: 0, high: 0, maximum: 0 }, endpointEndDelta: { changed: 0, high: 0, maximum: 0 },
    midpointStartDelta: { changed: 20_000, high: 5_000, maximum: 80 }, midpointEndDelta: { changed: 21_000, high: 6_000, maximum: 90 },
    resourcePlanStableAcrossControls: true, bt709Tagged: true, audioPresent: true,
    rejectedNegativeControls: ["zero-time", "duplicate-frame", "end-frame", "negative-ambient", "negative-intensity", "negative-color", "zero-direction", "seventeenth-keyframe", "unknown-easing"],
    inputSha256: ["c".repeat(64), "d".repeat(64)], outputSha256: "e".repeat(64),
  };
  assertGreen(valid);
  const mutations: GateReport[] = [
    { ...valid, frozenRedBaseline: false }, { ...valid, sceneReceiptFrames: 11 }, { ...valid, depthReceiptFrames: 11 }, { ...valid, animatedFrameTransitions: 0 },
    { ...valid, firstLight: { ...valid.firstLight, lightAnimationContract: "static/v1" } },
    { ...valid, lastLight: { ...valid.lastLight, directionalLightDirection: startLight.direction } },
    { ...valid, resourcePlan: { ...valid.resourcePlan, sceneDepthBytes: 0 } }, { ...valid, productPathCpuPixelCopies: 1 },
    { ...valid, endpointStartDelta: { changed: 1, high: 0, maximum: 9 } }, { ...valid, endpointEndDelta: { changed: 1, high: 0, maximum: 9 } },
    { ...valid, midpointStartDelta: { changed: 0, high: 0, maximum: 0 } }, { ...valid, midpointEndDelta: { changed: 0, high: 0, maximum: 0 } },
    { ...valid, resourcePlanStableAcrossControls: false }, { ...valid, bt709Tagged: false }, { ...valid, rejectedNegativeControls: [] },
  ];
  for (const candidate of mutations) {
    let rejected = false; try { assertGreen(candidate); } catch { rejected = true; }
    if (!rejected) throw new Error("animated light evaluator accepted a calibrated mutation");
  }
  process.stdout.write(`${JSON.stringify({ status: "GREEN", evaluator: valid.schema, calibratedMutations: mutations.length })}\n`);
}

function lightProject(endpoint: "animated" | "start" | "end"): EditProject {
  const value = createLensProject({ enabled: false });
  const scene = value.scene25d!;
  const authored = endpoint === "end" ? endLight : startLight;
  scene.ambientLight.intensity = authored.ambient;
  scene.directionalLight.color = [...authored.color]; scene.directionalLight.intensity = authored.intensity;
  scene.directionalLight.direction = [...authored.direction];
  scene.ambientLight.keyframes = endpoint === "animated" ? [{ id: "ambient-rise", time: lastFrame / fps, intensity: endLight.ambient, easing: "ease_in_out" }] : [];
  scene.directionalLight.keyframes = endpoint === "animated" ? [{ id: "light-sweep", time: lastFrame / fps, color: [...endLight.color],
    intensity: endLight.intensity, direction: [...endLight.direction], easing: "ease_in_out" }] : [];
  return value;
}

function preview(value: EditProject) {
  const parsed = validateProject(projectSchema.parse(migrateProject(JSON.parse(JSON.stringify(value)))));
  const result = buildGpuEngineVideoPreviewGraph(parsed, 0);
  if (!result?.scene25dExpectation || result.graph.nodes.filter((node) => node.kind === "light").length !== 2) throw new Error("animated light product route was not admitted");
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
  const candidate = lightProject("animated");
  if (baseline) {
    let evaluatorRejection = "missing_native_light_animation_contract";
    try {
      const receipt = await sequence(candidate, join(evidenceRoot, "red-baseline-frames"), frozenExecutable);
      if (receipt.lightAnimatedFrameTransitions > 0) throw new Error("frozen executable unexpectedly animated the light");
    } catch (error) {
      evaluatorRejection = String(error).includes("unexpectedly") ? "unexpected_native_light_animation" : "missing_native_light_animation_contract";
    }
    if (evaluatorRejection === "unexpected_native_light_animation") throw new Error(evaluatorRejection);
    const report = { schema: "editkin.resident-25d-animated-light-video-project-render-baseline/v1", measuredAt: new Date().toISOString(), status: "BLOCK",
      evaluatorRejection, executableSha256: sha256(await readFile(frozenExecutable)) };
    await writeFile(baselinePath, `${JSON.stringify(report, null, 2)}\n`, "utf8"); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); return;
  }
  if (!lensRouteAccepted(candidate, false)) throw new Error("animated light candidate is outside the product route");
  const frozen = JSON.parse(await readFile(baselinePath, "utf8")) as { status?: string; evaluatorRejection?: string; executableSha256?: string };
  const animatedDirectory = join(evidenceRoot, "animated-frames"); const startDirectory = join(evidenceRoot, "start-control-frames"); const endDirectory = join(evidenceRoot, "end-control-frames");
  const animatedReceipt = await sequence(candidate, animatedDirectory);
  const startReceipt = await sequence(lightProject("start"), startDirectory);
  const endReceipt = await sequence(lightProject("end"), endDirectory);
  const output = join(evidenceRoot, "animated-light-sweep.mp4");
  const rendered = await renderProject(candidate, output, { ffmpegPath: resolve(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobePath: ffprobe,
    gpuCompositorPath: executable, preferGpu: false, timeoutMs: 180_000 });
  const pipeline = rendered.residentVideoPipeline;
  if (!pipeline?.scene25d || !pipeline.scene25dLast) throw new Error("formal animated light pipeline omitted endpoint receipts");
  const [animatedFirst, animatedMid, animatedLast, startFirst, startMid, endMid, endLast] = await Promise.all([
    png(animatedDirectory, 0), png(animatedDirectory, midFrame), png(animatedDirectory, lastFrame), png(startDirectory, 0), png(startDirectory, midFrame), png(endDirectory, midFrame), png(endDirectory, lastFrame),
  ]);
  const rejectedNegativeControls: string[] = [];
  const reject = (name: string, value: EditProject) => { if (lensRouteAccepted(value, false)) throw new Error(`${name} animated light negative was admitted`); rejectedNegativeControls.push(name); };
  const ambient = (value: EditProject): Scene25dAmbientLightKeyframe => value.scene25d!.ambientLight.keyframes[0];
  const directional = (value: EditProject): Scene25dDirectionalLightKeyframe => value.scene25d!.directionalLight.keyframes[0];
  const zeroTime = lightProject("animated"); ambient(zeroTime).time = 0; reject("zero-time", zeroTime);
  const duplicate = lightProject("animated"); duplicate.scene25d!.directionalLight.keyframes = [
    { id: "a", time: .1, color: [1, 1, 1], intensity: .8, direction: [0, 0, 1], easing: "linear" },
    { id: "b", time: .11, color: [.5, .7, 1], intensity: 1.2, direction: [1, 0, 1], easing: "linear" }]; reject("duplicate-frame", duplicate);
  const endFrame = lightProject("animated"); ambient(endFrame).time = frameCount / fps; reject("end-frame", endFrame);
  const negativeAmbient = lightProject("animated"); ambient(negativeAmbient).intensity = -.1; reject("negative-ambient", negativeAmbient);
  const negativeIntensity = lightProject("animated"); directional(negativeIntensity).intensity = -.1; reject("negative-intensity", negativeIntensity);
  const negativeColor = lightProject("animated"); directional(negativeColor).color[0] = -.1; reject("negative-color", negativeColor);
  const zeroDirection = lightProject("animated"); directional(zeroDirection).direction = [0, 0, 0]; reject("zero-direction", zeroDirection);
  const seventeenth = lightProject("animated"); seventeenth.scene25d!.ambientLight.keyframes = Array.from({ length: 17 }, (_, index) => ({
    id: `key-${index}`, time: (index + 1) / 1000, intensity: .2 + index / 100, easing: "linear" as const,
  })); reject("seventeenth-keyframe", seventeenth);
  const unknown = lightProject("animated"); directional(unknown).easing = "cubic_magic" as "linear"; reject("unknown-easing", unknown);
  const resourcePlan = animatedReceipt.resourcePlan as unknown as ResourcePlan;
  const report: GateReport = {
    schema: "editkin.resident-25d-animated-light-video-project-render-gate/v1", measuredAt: new Date().toISOString(), status: "GREEN",
    frozenRedBaseline: frozen.status === "BLOCK" && frozen.evaluatorRejection === "missing_native_light_animation_contract",
    baselineExecutableSha256: frozen.executableSha256 ?? "", executableSha256: sha256(await readFile(executable)), planner: rendered.planner,
    frameCount: pipeline.frameCount, sceneReceiptFrames: pipeline.sceneReceiptFrames ?? 0, depthReceiptFrames: pipeline.depthReceiptFrames,
    animatedFrameTransitions: pipeline.lightAnimatedFrameTransitions, firstLight: pipeline.scene25d, lastLight: pipeline.scene25dLast,
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
