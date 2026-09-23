import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { PNG } from "pngjs";
import { createEmptyProject, validateProject } from "../src/domain/editGraph";
import {
  DEFAULT_COLOR,
  DEFAULT_SCENE_25D,
  DEFAULT_TRANSFORM,
  DEFAULT_TRANSFORM_3D,
  type EditProject,
} from "../src/domain/types";
import { probeMedia, renderProject } from "../src/render/ffmpeg";
import { buildGpuEngineVideoPreviewGraph } from "../src/render/gpuCompositor";

const runFile = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const evidenceRoot = resolve(root, "..", "..", ".rd", "benchmarks", "editkin-resident-25d-video-project-render");
const reportPath = join(evidenceRoot, "report.json");
const baselinePath = join(evidenceRoot, "baseline-report.json");
const executable = join(root, "native/bin/win32-x64/editkin-gpu-compositor.exe");
const ffmpeg = join(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const ffprobe = join(root, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const source = join(root, "public/demo-source.mp4");
const fps = 30;
const frameCount = 12;
const selfTest = process.argv.includes("--self-test");
const baseline = process.argv.includes("--baseline");
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

interface Scene25dReceipt {
  sceneContract: "single_camera_textured_planes/v1";
  planeCount: number;
  videoPlaneCount: number;
  parentedPlaneCount: number;
  cameraNodeId: string;
  depthMode: string;
  depthFormat: string;
  depthTestedPlaneCount: number;
  depthPassCount: number;
  geometryExecutor: string;
  pixelExecutor: string;
}

interface GateReport {
  schema: "editkin.resident-25d-video-project-render-gate/v1";
  measuredAt?: string;
  status: "GREEN" | "BLOCK";
  baselineProductRouteRejected: boolean;
  planner: string;
  frameCount: number;
  scene25d: Scene25dReceipt;
  sceneReceiptFrames: number;
  productPathCpuPixelCopies: number;
  verificationReadback: boolean;
  changedPixelsAgainstFlatControl: number;
  highDeltaPixelsAgainstFlatControl: number;
  bt709Tagged: boolean;
  rejectedNegativeControls: string[];
  executableSha256: string;
  outputSha256: string;
}

function assertGreen(report: GateReport): void {
  if (report.schema !== "editkin.resident-25d-video-project-render-gate/v1" || report.status !== "GREEN") throw new Error("resident 2.5D video report is not GREEN");
  if (!report.baselineProductRouteRejected || report.planner !== "editkin-resident-video-scene-linear-aces2-formal-sequence/v1") throw new Error("resident 2.5D video baseline or formal route is incomplete");
  if (report.frameCount !== frameCount || report.sceneReceiptFrames !== frameCount || report.productPathCpuPixelCopies !== 0 || !report.verificationReadback) throw new Error("resident 2.5D video sequence receipt is incomplete");
  if (report.scene25d.sceneContract !== "single_camera_textured_planes/v1" || report.scene25d.planeCount !== 2
    || report.scene25d.videoPlaneCount !== 2 || report.scene25d.parentedPlaneCount !== 1
    || report.scene25d.cameraNodeId !== "scene25d:camera"
    || report.scene25d.depthMode !== "per_pixel_opaque_plane_depth32float" || report.scene25d.depthFormat !== "depth32_float"
    || report.scene25d.depthTestedPlaneCount !== 2 || report.scene25d.depthPassCount !== 1
    || report.scene25d.geometryExecutor !== "hao-core-native-camera-matrix-depth-plane/v1"
    || report.scene25d.pixelExecutor !== "wgpu-projective-plane-depth-compositor/v1") throw new Error("resident 2.5D video coverage is incomplete");
  if (report.changedPixelsAgainstFlatControl < 500 || report.highDeltaPixelsAgainstFlatControl < 100) throw new Error("resident 2.5D video projection is not independently visible");
  if (!report.bt709Tagged || report.rejectedNegativeControls.join() !== "missing-transform,ninth-plane,parent-cycle,particle-mix,pq-input") throw new Error("resident 2.5D video delivery or negatives are incomplete");
  for (const identity of [report.executableSha256, report.outputSha256]) if (!/^[a-f0-9]{64}$/.test(identity)) throw new Error("resident 2.5D video artifact identity is incomplete");
}

function syntheticSelfTest(): void {
  const valid: GateReport = {
    schema: "editkin.resident-25d-video-project-render-gate/v1", status: "GREEN", baselineProductRouteRejected: true,
    planner: "editkin-resident-video-scene-linear-aces2-formal-sequence/v1", frameCount, sceneReceiptFrames: frameCount,
    scene25d: { sceneContract: "single_camera_textured_planes/v1", planeCount: 2, videoPlaneCount: 2, parentedPlaneCount: 1,
      cameraNodeId: "scene25d:camera", depthMode: "per_pixel_opaque_plane_depth32float", depthFormat: "depth32_float",
      depthTestedPlaneCount: 2, depthPassCount: 1,
      geometryExecutor: "hao-core-native-camera-matrix-depth-plane/v1", pixelExecutor: "wgpu-projective-plane-depth-compositor/v1" },
    productPathCpuPixelCopies: 0, verificationReadback: true, changedPixelsAgainstFlatControl: 900,
    highDeltaPixelsAgainstFlatControl: 300, bt709Tagged: true,
    rejectedNegativeControls: ["missing-transform", "ninth-plane", "parent-cycle", "particle-mix", "pq-input"],
    executableSha256: "a".repeat(64), outputSha256: "b".repeat(64),
  };
  assertGreen(valid);
  const negatives: GateReport[] = [
    { ...valid, sceneReceiptFrames: frameCount - 1 }, { ...valid, productPathCpuPixelCopies: 1 },
    { ...valid, scene25d: { ...valid.scene25d, videoPlaneCount: 1 } }, { ...valid, changedPixelsAgainstFlatControl: 0 },
    { ...valid, rejectedNegativeControls: [] }, { ...valid, bt709Tagged: false },
  ];
  for (const candidate of negatives) {
    let rejected = false;
    try { assertGreen(candidate); } catch { rejected = true; }
    if (!rejected) throw new Error("resident 2.5D video evaluator accepted a calibrated negative");
  }
  process.stdout.write(`${JSON.stringify({ status: "GREEN", evaluator: valid.schema, calibratedNegatives: negatives.length })}\n`);
}

function project(): EditProject {
  const value = createEmptyProject("Resident 2.5D video plane", { width: 960, height: 540, fps });
  value.assets.push(
    { id: "back-video", name: "Back video", kind: "video", uri: source, duration: 4, width: 960, height: 540, color: { interpretation: "rec709" } },
    { id: "front-video", name: "Front video", kind: "video", uri: source, duration: 4, width: 960, height: 540, color: { interpretation: "rec709" } },
  );
  const back = {
    id: "back", assetId: "back-video", trackId: value.tracks[0].id, timelineStart: 0, sourceStart: 0,
    duration: frameCount / fps, volume: .5, transform: { ...DEFAULT_TRANSFORM }, transform3d: { ...structuredClone(DEFAULT_TRANSFORM_3D), scale: [1.25, 1.25, 1] as [number, number, number] },
    color: { ...DEFAULT_COLOR }, keyframes: [], creative: { effectPresetIds: [], nativeEffectInstances: [] },
    layer: { enabled: true, blendMode: "normal" as const, role: "content" as const },
  };
  const front = {
    ...structuredClone(back), id: "front", assetId: "front-video", trackId: "front-track", sourceStart: .5,
    transform3d: { position: [.2, -.08, .7] as [number, number, number], rotationDegrees: [-7, 24, 5] as [number, number, number], scale: [.58, .58, 1] as [number, number, number] },
    layer: { enabled: true, blendMode: "normal" as const, role: "content" as const, parentClipId: "back" },
  };
  value.tracks[0].clips.push(back);
  value.tracks.push({ id: "front-track", name: "Front plane", kind: "video", locked: false, muted: false, clips: [front] });
  value.scene25d = structuredClone(DEFAULT_SCENE_25D);
  value.colorManagement = { ...value.colorManagement!, mode: "aces2", outputTransform: "rec709_sdr" };
  return value;
}

function routeAccepted(value: EditProject): boolean {
  try {
    const validated = validateProject(value);
    const route = buildGpuEngineVideoPreviewGraph(validated, 0);
    return Boolean(route?.scene25dExpectation && route.scene25dExpectation.planeCount === 2);
  } catch {
    return false;
  }
}

async function decodedDelta(left: string, right: string, temporary: string): Promise<{ changed: number; high: number }> {
  const outputs = [join(temporary, "candidate.png"), join(temporary, "flat.png")];
  await Promise.all([left, right].map((input, index) => runFile(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(6 / fps), "-i", input, "-frames:v", "1", outputs[index]], { windowsHide: true, timeout: 30_000 })));
  const [a, b] = await Promise.all(outputs.map(async (path) => PNG.sync.read(await readFile(path))));
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
  const productRouteRejected = !routeAccepted(candidate);
  if (baseline) {
    if (!productRouteRejected) throw new Error("baseline unexpectedly admitted decoded 2.5D video planes");
    const report = { schema: "editkin.resident-25d-video-project-render-baseline/v1", measuredAt: new Date().toISOString(), status: "BLOCK", productRouteRejected, executableSha256: sha256(await readFile(executable)) };
    await writeFile(baselinePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const frozen = JSON.parse(await readFile(baselinePath, "utf8")) as { status?: string; productRouteRejected?: boolean };
  if (productRouteRejected) throw new Error("candidate product route still rejects decoded 2.5D video planes");
  const temporary = await mkdtemp(join(tmpdir(), "editkin-resident-25d-video-"));
  try {
    const options = { ffmpegPath: ffmpeg, ffprobePath: ffprobe, gpuCompositorPath: executable, preferGpu: false, timeoutMs: 120_000 };
    const output = join(evidenceRoot, "resident-25d-video.mp4");
    const rendered = await renderProject(candidate, output, options);
    const flat = project();
    flat.scene25d = undefined;
    for (const clip of flat.tracks.flatMap((track) => track.clips)) {
      clip.transform3d = undefined;
      clip.layer = { enabled: clip.layer?.enabled ?? true, blendMode: clip.layer?.blendMode ?? "normal", role: clip.layer?.role ?? "content", trackMatte: clip.layer?.trackMatte, parentClipId: undefined };
    }
    const flatOutput = join(evidenceRoot, "flat-control.mp4");
    await renderProject(flat, flatOutput, options);
    const delta = await decodedDelta(output, flatOutput, temporary);
    const pipeline = rendered.residentVideoPipeline as (NonNullable<typeof rendered.residentVideoPipeline> & { scene25d?: Scene25dReceipt; sceneReceiptFrames?: number }) | undefined;
    if (!pipeline?.scene25d) throw new Error("formal resident sequence omitted 2.5D coverage");
    const rejectedNegativeControls: string[] = [];
    const reject = (name: string, value: EditProject) => { if (routeAccepted(value)) throw new Error(`${name} negative was admitted`); rejectedNegativeControls.push(name); };
    const missing = project(); missing.tracks.at(-1)!.clips[0].transform3d = undefined; reject("missing-transform", missing);
    const ninth = project(); for (let index = 2; index < 9; index += 1) { const item = structuredClone(ninth.tracks[0].clips[0]); item.id = `plane-${index}`; item.trackId = `track-${index}`; item.layer = { enabled: true, blendMode: "normal", role: "content", parentClipId: undefined }; ninth.tracks.push({ id: item.trackId, name: item.id, kind: "video", locked: false, muted: false, clips: [item] }); } reject("ninth-plane", ninth);
    const cycle = project(); cycle.tracks[0].clips[0].layer = { enabled: true, blendMode: "normal", role: "content", parentClipId: "front" }; reject("parent-cycle", cycle);
    const particles = project(); particles.particleSimulation = { schema: "editkin.particle-simulation/v1", enabled: true, seed: 7, ratePerSecond: 20, lifetimeSeconds: 1, initialVelocity: [0, -40], gravity: [0, 20], maxParticles: 16, emitterPosition: [.5, .5], radiusPixels: 4, color: [1, 1, 1, 1] }; reject("particle-mix", particles);
    const pq = project(); pq.assets[0].color = { interpretation: "pq" }; reject("pq-input", pq);
    const probe = await probeMedia(output, ffprobe);
    const report: GateReport = {
      schema: "editkin.resident-25d-video-project-render-gate/v1", measuredAt: new Date().toISOString(), status: "GREEN",
      baselineProductRouteRejected: frozen.status === "BLOCK" && frozen.productRouteRejected === true,
      planner: rendered.planner, frameCount: pipeline.frameCount, scene25d: pipeline.scene25d, sceneReceiptFrames: pipeline.sceneReceiptFrames ?? 0,
      productPathCpuPixelCopies: pipeline.productPathCpuPixelCopies, verificationReadback: pipeline.verificationReadback,
      changedPixelsAgainstFlatControl: delta.changed, highDeltaPixelsAgainstFlatControl: delta.high,
      bt709Tagged: probe.colorPrimaries === "bt709" && probe.colorTransfer === "bt709" && probe.colorMatrix === "bt709",
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
