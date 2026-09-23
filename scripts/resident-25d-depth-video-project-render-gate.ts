import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { PNG } from "pngjs";
import { createEmptyProject, validateProject } from "../src/domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_SCENE_25D, DEFAULT_TRANSFORM, type EditProject } from "../src/domain/types";
import { probeMedia, renderProject } from "../src/render/ffmpeg";
import { buildGpuEngineVideoPreviewGraph } from "../src/render/gpuCompositor";

const runFile = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const evidenceRoot = resolve(root, "..", "..", ".rd", "benchmarks", "editkin-resident-25d-depth-video-project-render");
const reportPath = join(evidenceRoot, "report.json");
const baselinePath = join(evidenceRoot, "baseline-report.json");
const executable = join(root, "native/bin/win32-x64/editkin-gpu-compositor.exe");
const ffmpeg = join(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const ffprobe = join(root, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const source = join(root, "public/demo-source.mp4");
const redSource = join(evidenceRoot, "red-plane-h264.mp4");
const blueSource = join(evidenceRoot, "blue-plane-h264.mp4");
const fps = 30;
const frameCount = 12;
const desiredDepthMode = "per_pixel_opaque_plane_depth32float";
const desiredPixelExecutor = "wgpu-projective-plane-depth-compositor/v1";
const selfTest = process.argv.includes("--self-test");
const baseline = process.argv.includes("--baseline");
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

interface Scene25dReceipt {
  sceneContract: "single_camera_textured_planes/v1";
  planeCount: number;
  videoPlaneCount: number;
  parentedPlaneCount: number;
  cameraNodeId: string;
  ambientLightCount: number;
  directionalLightCount: number;
  depthMode: string;
  depthFormat: string;
  depthTestedPlaneCount: number;
  depthPassCount: number;
  geometryExecutor: string;
  pixelExecutor: string;
}

interface PixelDelta { changed: number; high: number; maximum: number }
interface CrossingEvidence { leftRedScore: number; rightRedScore: number; oppositeDominance: boolean }

interface GateReport {
  schema: "editkin.resident-25d-depth-video-project-render-gate/v1";
  measuredAt?: string;
  status: "GREEN" | "BLOCK";
  frozenRedBaseline: boolean;
  baselineExecutableSha256: string;
  planner: string;
  frameCount: number;
  scene25d: Scene25dReceipt;
  sceneReceiptFrames: number;
  depthReceiptFrames: number;
  productPathCpuPixelCopies: number;
  verificationReadback: boolean;
  crossing: CrossingEvidence;
  orderDeltaOutsideIntersection: PixelDelta;
  lightingDelta: PixelDelta;
  bt709Tagged: boolean;
  audioPresent: boolean;
  rejectedNegativeControls: string[];
  executableSha256: string;
  inputSha256: [string, string];
  outputSha256: string;
}

function assertGreen(report: GateReport): void {
  if (report.schema !== "editkin.resident-25d-depth-video-project-render-gate/v1" || report.status !== "GREEN") throw new Error("resident 2.5D depth report is not GREEN");
  if (!report.frozenRedBaseline || !/^[a-f0-9]{64}$/.test(report.baselineExecutableSha256) || report.baselineExecutableSha256 === report.executableSha256) throw new Error("resident 2.5D depth baseline is not independently frozen");
  if (report.planner !== "editkin-resident-video-scene-linear-aces2-formal-sequence/v1" || report.frameCount !== frameCount || report.sceneReceiptFrames !== frameCount || report.depthReceiptFrames !== frameCount) throw new Error("resident 2.5D depth formal sequence is incomplete");
  if (report.productPathCpuPixelCopies !== 0 || !report.verificationReadback) throw new Error("resident 2.5D depth product path copied pixels through the CPU");
  const scene = report.scene25d;
  if (scene.sceneContract !== "single_camera_textured_planes/v1" || scene.planeCount !== 2 || scene.videoPlaneCount !== 2
    || scene.parentedPlaneCount !== 1 || scene.cameraNodeId !== "scene25d:camera" || scene.ambientLightCount !== 1
    || scene.directionalLightCount !== 1 || scene.depthMode !== desiredDepthMode || scene.depthFormat !== "depth32_float"
    || scene.depthTestedPlaneCount !== 2 || scene.depthPassCount !== 1
    || scene.geometryExecutor !== "hao-core-native-camera-matrix-depth-plane/v1" || scene.pixelExecutor !== desiredPixelExecutor) throw new Error("resident 2.5D depth coverage is incomplete");
  if (!report.crossing.oppositeDominance || Math.abs(report.crossing.leftRedScore) < 500 || Math.abs(report.crossing.rightRedScore) < 500) throw new Error("crossing planes did not exchange front-most ownership");
  if (report.orderDeltaOutsideIntersection.changed > 16 || report.orderDeltaOutsideIntersection.high > 0 || report.orderDeltaOutsideIntersection.maximum > 24) throw new Error("per-pixel depth output still depends on authored layer order");
  if (report.lightingDelta.changed < 5_000 || report.lightingDelta.high < 1_000 || report.lightingDelta.maximum < 24) throw new Error("directional lighting is not independently visible in decoded pixels");
  if (!report.bt709Tagged || !report.audioPresent) throw new Error("formal 2.5D depth delivery metadata is incomplete");
  const expectedNegatives = "missing-transform,zero-scale,translucent-plane,non-normal-blend,ninth-plane,parent-cycle,particle-mix,pq-input";
  if (report.rejectedNegativeControls.join() !== expectedNegatives) throw new Error("resident 2.5D depth negatives are incomplete");
  for (const identity of [...report.inputSha256, report.executableSha256, report.outputSha256]) if (!/^[a-f0-9]{64}$/.test(identity)) throw new Error("resident 2.5D depth artifact identity is incomplete");
}

function syntheticSelfTest(): void {
  const valid: GateReport = {
    schema: "editkin.resident-25d-depth-video-project-render-gate/v1", status: "GREEN", frozenRedBaseline: true,
    baselineExecutableSha256: "a".repeat(64), planner: "editkin-resident-video-scene-linear-aces2-formal-sequence/v1",
    frameCount, sceneReceiptFrames: frameCount, depthReceiptFrames: frameCount, productPathCpuPixelCopies: 0, verificationReadback: true,
    scene25d: { sceneContract: "single_camera_textured_planes/v1", planeCount: 2, videoPlaneCount: 2, parentedPlaneCount: 1,
      cameraNodeId: "scene25d:camera", ambientLightCount: 1, directionalLightCount: 1, depthMode: desiredDepthMode,
      depthFormat: "depth32_float", depthTestedPlaneCount: 2, depthPassCount: 1,
      geometryExecutor: "hao-core-native-camera-matrix-depth-plane/v1", pixelExecutor: desiredPixelExecutor },
    crossing: { leftRedScore: 2_000, rightRedScore: -2_000, oppositeDominance: true },
    orderDeltaOutsideIntersection: { changed: 0, high: 0, maximum: 0 }, lightingDelta: { changed: 20_000, high: 8_000, maximum: 80 },
    bt709Tagged: true, audioPresent: true,
    rejectedNegativeControls: ["missing-transform", "zero-scale", "translucent-plane", "non-normal-blend", "ninth-plane", "parent-cycle", "particle-mix", "pq-input"],
    executableSha256: "b".repeat(64), inputSha256: ["c".repeat(64), "d".repeat(64)], outputSha256: "e".repeat(64),
  };
  assertGreen(valid);
  const mutations: GateReport[] = [
    { ...valid, frozenRedBaseline: false },
    { ...valid, sceneReceiptFrames: frameCount - 1 },
    { ...valid, depthReceiptFrames: frameCount - 1 },
    { ...valid, productPathCpuPixelCopies: 1 },
    { ...valid, scene25d: { ...valid.scene25d, depthMode: "average" } },
    { ...valid, scene25d: { ...valid.scene25d, depthFormat: "none" } },
    { ...valid, crossing: { ...valid.crossing, oppositeDominance: false } },
    { ...valid, orderDeltaOutsideIntersection: { changed: 40, high: 4, maximum: 90 } },
    { ...valid, lightingDelta: { changed: 0, high: 0, maximum: 0 } },
    { ...valid, rejectedNegativeControls: [] },
    { ...valid, bt709Tagged: false },
  ];
  for (const candidate of mutations) {
    let rejected = false;
    try { assertGreen(candidate); } catch { rejected = true; }
    if (!rejected) throw new Error("resident 2.5D depth evaluator accepted a calibrated mutation");
  }
  process.stdout.write(`${JSON.stringify({ status: "GREEN", evaluator: valid.schema, calibratedMutations: mutations.length })}\n`);
}

async function ensureTintedSources(): Promise<void> {
  await mkdir(evidenceRoot, { recursive: true });
  const create = async (output: string, matrix: string) => runFile(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", source,
    "-t", "1.2", "-vf", `scale=960:540:force_original_aspect_ratio=increase,crop=960:540,colorchannelmixer=${matrix},format=yuv420p`,
    "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-c:a", "aac", "-b:a", "128k",
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-movflags", "+faststart", output], { windowsHide: true, timeout: 60_000 });
  await Promise.all([create(redSource, "rr=1.75:gg=.18:bb=.18"), create(blueSource, "rr=.18:gg=.18:bb=1.75")]);
}

function project(order: "red-blue" | "blue-red" = "red-blue", directionalIntensity = 1.15): EditProject {
  const value = createEmptyProject("Resident per-pixel 2.5D depth", { width: 960, height: 540, fps });
  value.assets.push(
    { id: "red-video", name: "Red H.264 plane", kind: "video", uri: redSource, duration: 1.2, width: 960, height: 540, color: { interpretation: "rec709" } },
    { id: "blue-video", name: "Blue H.264 plane", kind: "video", uri: blueSource, duration: 1.2, width: 960, height: 540, color: { interpretation: "rec709" } },
  );
  const base = { timelineStart: 0, sourceStart: 0, duration: frameCount / fps, volume: .5, transform: { ...DEFAULT_TRANSFORM },
    color: { ...DEFAULT_COLOR }, keyframes: [], creative: { effectPresetIds: [], nativeEffectInstances: [] },
    layer: { enabled: true, blendMode: "normal" as const, role: "content" as const } };
  const red = { ...structuredClone(base), id: "red-plane", assetId: "red-video", trackId: "red-track",
    transform3d: { position: [0, 0, 0] as [number, number, number], rotationDegrees: [0, 35, 0] as [number, number, number], scale: [1.18, 1.18, 1] as [number, number, number] } };
  const blue = { ...structuredClone(base), id: "blue-plane", assetId: "blue-video", trackId: "blue-track",
    transform3d: { position: [0, 0, 0] as [number, number, number], rotationDegrees: [0, -70, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] },
    layer: { enabled: true, blendMode: "normal" as const, role: "content" as const, parentClipId: "red-plane" } };
  const tracks = {
    red: { id: "red-track", name: "Red crossing plane", kind: "video" as const, locked: false, muted: false, clips: [red] },
    blue: { id: "blue-track", name: "Blue crossing plane", kind: "video" as const, locked: false, muted: false, clips: [blue] },
  };
  value.tracks = order === "red-blue" ? [tracks.red, tracks.blue] : [tracks.blue, tracks.red];
  value.scene25d = structuredClone(DEFAULT_SCENE_25D);
  value.scene25d.ambientLight.intensity = .24;
  value.scene25d.directionalLight = { color: [1, .92, .78], intensity: directionalIntensity, direction: [.35, -.2, 1], keyframes: [] };
  value.colorManagement = { ...value.colorManagement!, mode: "aces2", outputTransform: "rec709_sdr" };
  return value;
}

function routeAccepted(value: EditProject): boolean {
  try { return Boolean(buildGpuEngineVideoPreviewGraph(validateProject(value), 0)?.scene25dExpectation); } catch { return false; }
}

async function decodeFrame(input: string, output: string): Promise<PNG> {
  await runFile(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(6 / fps), "-i", input, "-frames:v", "1", output], { windowsHide: true, timeout: 30_000 });
  return PNG.sync.read(await readFile(output));
}

function comparePixels(left: PNG, right: PNG, excludeCenterBand = false): PixelDelta {
  let changed = 0; let high = 0; let maximum = 0;
  for (let y = 0; y < left.height; y += 1) for (let x = 0; x < left.width; x += 1) {
    if (excludeCenterBand && Math.abs(x - left.width / 2) <= 10) continue;
    const offset = (y * left.width + x) * 4;
    const delta = Math.abs(left.data[offset] - right.data[offset]) + Math.abs(left.data[offset + 1] - right.data[offset + 1]) + Math.abs(left.data[offset + 2] - right.data[offset + 2]);
    maximum = Math.max(maximum, delta);
    if (delta > 8) changed += 1;
    if (delta > 32) high += 1;
  }
  return { changed, high, maximum };
}

function crossingEvidence(image: PNG): CrossingEvidence {
  const score = (x0: number, x1: number) => {
    let red = 0; let blue = 0;
    for (let y = Math.floor(image.height * .2); y < Math.floor(image.height * .8); y += 1) for (let x = x0; x < x1; x += 1) {
      const offset = (y * image.width + x) * 4;
      if (image.data[offset] > image.data[offset + 2] + 28) red += 1;
      if (image.data[offset + 2] > image.data[offset] + 28) blue += 1;
    }
    return red - blue;
  };
  const leftRedScore = score(Math.floor(image.width * .18), Math.floor(image.width * .43));
  const rightRedScore = score(Math.floor(image.width * .57), Math.floor(image.width * .82));
  return { leftRedScore, rightRedScore, oppositeDominance: Math.sign(leftRedScore) !== 0 && Math.sign(leftRedScore) === -Math.sign(rightRedScore) };
}

async function render(value: EditProject, output: string) {
  return renderProject(value, output, { ffmpegPath: ffmpeg, ffprobePath: ffprobe, gpuCompositorPath: executable, preferGpu: false, timeoutMs: 180_000 });
}

async function main(): Promise<void> {
  if (selfTest) return syntheticSelfTest();
  await ensureTintedSources();
  const candidate = project();
  if (!routeAccepted(candidate)) throw new Error("candidate product route rejects crossing 2.5D H.264 planes");
  if (baseline) {
    const output = join(evidenceRoot, "red-baseline.mp4");
    const rendered = await render(candidate, output);
    const pipeline = rendered.residentVideoPipeline as (NonNullable<typeof rendered.residentVideoPipeline> & { scene25d?: Partial<Scene25dReceipt> }) | undefined;
    const oldDepthMode = pipeline?.scene25d?.depthMode ?? "missing";
    if (oldDepthMode === desiredDepthMode && pipeline?.scene25d?.depthFormat === "depth32_float") throw new Error("baseline executable unexpectedly passes the new per-pixel depth contract");
    const report = { schema: "editkin.resident-25d-depth-video-project-render-baseline/v1", measuredAt: new Date().toISOString(), status: "BLOCK",
      evaluatorRejection: "missing_per_pixel_depth32f_contract", oldDepthMode, executableSha256: sha256(await readFile(executable)), outputSha256: sha256(await readFile(output)) };
    await writeFile(baselinePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const frozen = JSON.parse(await readFile(baselinePath, "utf8")) as { status?: string; evaluatorRejection?: string; executableSha256?: string };
  const temporary = await mkdtemp(join(tmpdir(), "editkin-resident-25d-depth-"));
  try {
    const output = join(evidenceRoot, "resident-25d-depth.mp4");
    const orderOutput = join(evidenceRoot, "resident-25d-depth-order-swap.mp4");
    const ambientOutput = join(evidenceRoot, "resident-25d-depth-ambient-only.mp4");
    const [rendered] = await Promise.all([render(candidate, output), render(project("blue-red"), orderOutput), render(project("red-blue", 0), ambientOutput)]);
    const [candidateFrame, orderFrame, ambientFrame] = await Promise.all([
      decodeFrame(output, join(evidenceRoot, "preview-frame.png")),
      decodeFrame(orderOutput, join(temporary, "order.png")),
      decodeFrame(ambientOutput, join(temporary, "ambient.png")),
    ]);
    const pipeline = rendered.residentVideoPipeline as (NonNullable<typeof rendered.residentVideoPipeline> & { scene25d?: Scene25dReceipt; sceneReceiptFrames?: number; depthReceiptFrames?: number }) | undefined;
    if (!pipeline?.scene25d) throw new Error("formal resident sequence omitted 2.5D depth coverage");
    const rejectedNegativeControls: string[] = [];
    const reject = (name: string, value: EditProject) => { if (routeAccepted(value)) throw new Error(`${name} negative was admitted`); rejectedNegativeControls.push(name); };
    const missing = project(); missing.tracks[1].clips[0].transform3d = undefined; reject("missing-transform", missing);
    const zeroScale = project(); zeroScale.tracks[0].clips[0].transform3d!.scale = [0, 1, 1]; reject("zero-scale", zeroScale);
    const translucent = project(); translucent.tracks[0].clips[0].transform.opacity = .5; reject("translucent-plane", translucent);
    const blend = project(); blend.tracks[0].clips[0].layer!.blendMode = "screen"; reject("non-normal-blend", blend);
    const ninth = project(); for (let index = 2; index < 9; index += 1) { const item = structuredClone(ninth.tracks[0].clips[0]); item.id = `plane-${index}`; item.trackId = `track-${index}`; item.layer = { enabled: true, blendMode: "normal", role: "content" }; ninth.tracks.push({ id: item.trackId, name: item.id, kind: "video", locked: false, muted: false, clips: [item] }); } reject("ninth-plane", ninth);
    const cycle = project(); cycle.tracks[0].clips[0].layer!.parentClipId = "blue-plane"; reject("parent-cycle", cycle);
    const particles = project(); particles.particleSimulation = { schema: "editkin.particle-simulation/v1", enabled: true, seed: 7, ratePerSecond: 20, lifetimeSeconds: 1, initialVelocity: [0, -40], gravity: [0, 20], maxParticles: 16, emitterPosition: [.5, .5], radiusPixels: 4, color: [1, 1, 1, 1] }; reject("particle-mix", particles);
    const pq = project(); pq.assets[0].color = { interpretation: "pq" }; reject("pq-input", pq);
    const probe = await probeMedia(output, ffprobe);
    const report: GateReport = {
      schema: "editkin.resident-25d-depth-video-project-render-gate/v1", measuredAt: new Date().toISOString(), status: "GREEN",
      frozenRedBaseline: frozen.status === "BLOCK" && frozen.evaluatorRejection === "missing_per_pixel_depth32f_contract",
      baselineExecutableSha256: frozen.executableSha256 ?? "", planner: rendered.planner, frameCount: pipeline.frameCount,
      scene25d: pipeline.scene25d, sceneReceiptFrames: pipeline.sceneReceiptFrames ?? 0, depthReceiptFrames: pipeline.depthReceiptFrames ?? 0,
      productPathCpuPixelCopies: pipeline.productPathCpuPixelCopies, verificationReadback: pipeline.verificationReadback,
      crossing: crossingEvidence(candidateFrame), orderDeltaOutsideIntersection: comparePixels(candidateFrame, orderFrame, true),
      lightingDelta: comparePixels(candidateFrame, ambientFrame), bt709Tagged: probe.colorPrimaries === "bt709" && probe.colorTransfer === "bt709" && probe.colorMatrix === "bt709",
      audioPresent: probe.hasAudio, rejectedNegativeControls, executableSha256: sha256(await readFile(executable)),
      inputSha256: [sha256(await readFile(redSource)), sha256(await readFile(blueSource))], outputSha256: sha256(await readFile(output)),
    };
    assertGreen(report);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

await main();
