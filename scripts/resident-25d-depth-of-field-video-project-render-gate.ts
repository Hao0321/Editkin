import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PNG } from "pngjs";
import type { EditProject } from "../src/domain/types";
import { probeMedia, renderProject } from "../src/render/ffmpeg";
import { comparePixels, createLensProject, ensureLensDetailSources, farFocus, farSource, ffmpeg, ffprobe, fps, frameCount,
  lensEvidenceRoot as evidenceRoot, lensRouteAccepted as routeAccepted, nearFocus, nearSource, root, setLens, type PixelDelta } from "./resident25dLensGateFixture";

const runFile = promisify(execFile);
const reportPath = join(evidenceRoot, "report.json");
const baselinePath = join(evidenceRoot, "baseline-report.json");
const executable = join(root, "native/bin/win32-x64/editkin-gpu-compositor.exe");
const executionMode = "scene-linear-depth32f-gather-dof/v1";
const selfTest = process.argv.includes("--self-test");
const baseline = process.argv.includes("--baseline");
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

interface FocusEvidence { nearFocusedEnergy: number; nearDefocusedEnergy: number; farFocusedEnergy: number; farDefocusedEnergy: number; nearFocusRatio: number; farFocusRatio: number; focusFlipPixels: PixelDelta }
interface DepthOfFieldReceipt {
  contract: "camera_depth_of_field/v1"; nodeId: string; focusDistance: number; aperture: number; maxBlurRadius: number;
  executionMode: string; depthSource: string; executor: string; passCount: number;
}
interface LensResourcePlan {
  schema: string; sceneDepthAttachmentCount: number; sceneDepthBytes: number; depthOfFieldPassCount: number;
  depthOfFieldAdditionalWorkingBytes: number; maximumFullFramePassesPerPresent: number;
  requiredBytes: number; budgetBytes: number; remainingBytes: number;
}
interface GateReport {
  schema: "editkin.resident-25d-depth-of-field-video-project-render-gate/v1";
  measuredAt?: string; status: "GREEN" | "BLOCK"; frozenRedBaseline: boolean; baselineExecutableSha256: string;
  planner: string; frameCount: number; depthReceiptFrames: number; depthOfFieldReceiptFrames: number;
  productPathCpuPixelCopies: number; verificationReadback: boolean; compositeFullFramePassCount: number;
  depthOfField: DepthOfFieldReceipt; resourcePlan: LensResourcePlan; focusEvidence: FocusEvidence; orderDelta: PixelDelta;
  lensOffDelta: PixelDelta; bt709Tagged: boolean; audioPresent: boolean; rejectedNegativeControls: string[];
  executableSha256: string; inputSha256: [string, string]; outputSha256: string;
}

function assertGreen(report: GateReport): void {
  if (report.schema !== "editkin.resident-25d-depth-of-field-video-project-render-gate/v1" || report.status !== "GREEN") throw new Error("resident 2.5D depth-of-field report is not GREEN");
  if (!report.frozenRedBaseline || !/^[a-f0-9]{64}$/.test(report.baselineExecutableSha256) || report.baselineExecutableSha256 === report.executableSha256) throw new Error("depth-of-field baseline is not independently frozen");
  if (report.planner !== "editkin-resident-video-scene-linear-aces2-formal-sequence/v1" || report.frameCount !== frameCount || report.depthReceiptFrames !== frameCount || report.depthOfFieldReceiptFrames !== frameCount) throw new Error("depth-of-field formal sequence receipts are incomplete");
  if (report.productPathCpuPixelCopies !== 0 || !report.verificationReadback || report.compositeFullFramePassCount !== 3) throw new Error("depth-of-field product execution is not the bounded three-pass GPU route");
  const resources = report.resourcePlan;
  if (resources.schema !== "editkin.resident-video-resource-plan/v1" || resources.sceneDepthAttachmentCount !== 1
    || resources.sceneDepthBytes !== 2_073_600 || resources.depthOfFieldPassCount !== 1
    || resources.depthOfFieldAdditionalWorkingBytes !== 0 || resources.maximumFullFramePassesPerPresent !== 3
    || resources.requiredBytes > resources.budgetBytes || resources.remainingBytes !== resources.budgetBytes - resources.requiredBytes) {
    throw new Error("depth-of-field resource plan does not charge its Depth32Float attachment and bounded lens pass");
  }
  const dof = report.depthOfField;
  if (dof.contract !== "camera_depth_of_field/v1" || dof.nodeId !== "scene25d:depth-of-field" || dof.executionMode !== executionMode
    || dof.depthSource !== "depth32_float" || dof.executor !== "wgpu-depth-aware-gather/v1" || dof.passCount !== 1
    || dof.focusDistance !== nearFocus || dof.aperture !== 3.5 || dof.maxBlurRadius !== 14) throw new Error("typed depth-of-field coverage is incomplete");
  const focus = report.focusEvidence;
  if (focus.nearFocusRatio < 1.08 || focus.farFocusRatio < 1.08 || focus.focusFlipPixels.changed < 12_000
    || focus.focusFlipPixels.high < 2_000 || focus.focusFlipPixels.maximum < 36) throw new Error("decoded focus-plane pixels do not prove a reversible focus pull");
  if (report.orderDelta.changed > 24 || report.orderDelta.high > 0 || report.orderDelta.maximum > 24) throw new Error("depth-of-field output depends on authored layer order");
  if (report.lensOffDelta.changed < 12_000 || report.lensOffDelta.high < 2_000 || report.lensOffDelta.maximum < 36) throw new Error("lens-off control is not visually distinct from enabled depth-of-field");
  if (!report.bt709Tagged || !report.audioPresent) throw new Error("formal depth-of-field delivery metadata is incomplete");
  const negatives = "focus-at-near,focus-at-far,zero-aperture,zero-radius,oversized-radius,ninth-plane,translucent-plane,effect-mix,particle-mix,pq-input";
  if (report.rejectedNegativeControls.join() !== negatives) throw new Error("depth-of-field negative controls are incomplete");
  for (const identity of [...report.inputSha256, report.executableSha256, report.outputSha256]) if (!/^[a-f0-9]{64}$/.test(identity)) throw new Error("depth-of-field artifact identity is incomplete");
}

function syntheticSelfTest(): void {
  const valid: GateReport = {
    schema: "editkin.resident-25d-depth-of-field-video-project-render-gate/v1", status: "GREEN", frozenRedBaseline: true,
    baselineExecutableSha256: "a".repeat(64), planner: "editkin-resident-video-scene-linear-aces2-formal-sequence/v1", frameCount,
    depthReceiptFrames: frameCount, depthOfFieldReceiptFrames: frameCount, productPathCpuPixelCopies: 0, verificationReadback: true,
    compositeFullFramePassCount: 3, depthOfField: { contract: "camera_depth_of_field/v1", nodeId: "scene25d:depth-of-field", focusDistance: nearFocus,
      aperture: 3.5, maxBlurRadius: 14, executionMode, depthSource: "depth32_float", executor: "wgpu-depth-aware-gather/v1", passCount: 1 },
    resourcePlan: { schema: "editkin.resident-video-resource-plan/v1", sceneDepthAttachmentCount: 1, sceneDepthBytes: 2_073_600,
      depthOfFieldPassCount: 1, depthOfFieldAdditionalWorkingBytes: 0, maximumFullFramePassesPerPresent: 3,
      requiredBytes: 51_840_000, budgetBytes: 67_108_864, remainingBytes: 15_268_864 },
    focusEvidence: { nearFocusedEnergy: 200_000, nearDefocusedEnergy: 150_000, farFocusedEnergy: 210_000, farDefocusedEnergy: 155_000,
      nearFocusRatio: 1.33, farFocusRatio: 1.35, focusFlipPixels: { changed: 30_000, high: 8_000, maximum: 90 } },
    orderDelta: { changed: 0, high: 0, maximum: 0 }, lensOffDelta: { changed: 25_000, high: 7_000, maximum: 88 },
    bt709Tagged: true, audioPresent: true,
    rejectedNegativeControls: ["focus-at-near", "focus-at-far", "zero-aperture", "zero-radius", "oversized-radius", "ninth-plane", "translucent-plane", "effect-mix", "particle-mix", "pq-input"],
    executableSha256: "b".repeat(64), inputSha256: ["c".repeat(64), "d".repeat(64)], outputSha256: "e".repeat(64),
  };
  assertGreen(valid);
  const mutations: GateReport[] = [
    { ...valid, frozenRedBaseline: false }, { ...valid, depthReceiptFrames: frameCount - 1 }, { ...valid, depthOfFieldReceiptFrames: frameCount - 1 },
    { ...valid, productPathCpuPixelCopies: 1 }, { ...valid, compositeFullFramePassCount: 2 },
    { ...valid, resourcePlan: { ...valid.resourcePlan, sceneDepthAttachmentCount: 0 } },
    { ...valid, depthOfField: { ...valid.depthOfField, executionMode: "none" } },
    { ...valid, depthOfField: { ...valid.depthOfField, depthSource: "synthetic" } },
    { ...valid, focusEvidence: { ...valid.focusEvidence, nearFocusRatio: 1 } },
    { ...valid, focusEvidence: { ...valid.focusEvidence, farFocusRatio: 1 } },
    { ...valid, focusEvidence: { ...valid.focusEvidence, focusFlipPixels: { changed: 0, high: 0, maximum: 0 } } },
    { ...valid, orderDelta: { changed: 100, high: 10, maximum: 90 } },
    { ...valid, lensOffDelta: { changed: 0, high: 0, maximum: 0 } }, { ...valid, rejectedNegativeControls: [] }, { ...valid, bt709Tagged: false },
  ];
  for (const candidate of mutations) {
    let rejected = false; try { assertGreen(candidate); } catch { rejected = true; }
    if (!rejected) throw new Error("resident 2.5D depth-of-field evaluator accepted a calibrated mutation");
  }
  process.stdout.write(`${JSON.stringify({ status: "GREEN", evaluator: valid.schema, calibratedMutations: mutations.length })}\n`);
}

function project(focusDistance = nearFocus, enabled = true, order: "near-far" | "far-near" = "near-far"): EditProject {
  return createLensProject({ focusDistance, enabled, order });
}

async function decodeFrame(input: string, output: string): Promise<PNG> {
  await runFile(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(6 / fps), "-i", input, "-frames:v", "1", output], { windowsHide: true, timeout: 30_000 });
  return PNG.sync.read(await readFile(output));
}

function edgeEnergy(image: PNG, x0: number, x1: number): number {
  const luma = (offset: number) => image.data[offset] * .2126 + image.data[offset + 1] * .7152 + image.data[offset + 2] * .0722;
  let energy = 0;
  for (let y = Math.floor(image.height * .28); y < Math.floor(image.height * .72); y += 1) for (let x = x0 + 1; x < x1; x += 1) {
    const offset = (y * image.width + x) * 4;
    energy += Math.abs(luma(offset) - luma(offset - 4));
  }
  return Math.round(energy);
}

async function render(value: EditProject, output: string) {
  return renderProject(value, output, { ffmpegPath: ffmpeg, ffprobePath: ffprobe, gpuCompositorPath: executable, preferGpu: false, timeoutMs: 180_000 });
}

async function main(): Promise<void> {
  if (selfTest) return syntheticSelfTest();
  await ensureLensDetailSources();
  const candidate = project();
  if (baseline) {
    const output = join(evidenceRoot, "red-baseline.mp4");
    const rendered = await render(candidate, output);
    const pipeline = rendered.residentVideoPipeline as { depthOfField?: unknown } | undefined;
    if (pipeline?.depthOfField) throw new Error("baseline executable unexpectedly passes the new depth-of-field contract");
    const report = { schema: "editkin.resident-25d-depth-of-field-video-project-render-baseline/v1", measuredAt: new Date().toISOString(), status: "BLOCK",
      evaluatorRejection: "missing_native_depth_of_field_contract", executableSha256: sha256(await readFile(executable)), outputSha256: sha256(await readFile(output)) };
    await writeFile(baselinePath, `${JSON.stringify(report, null, 2)}\n`, "utf8"); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); return;
  }
  if (!routeAccepted(candidate)) throw new Error("candidate product route rejects typed 2.5D depth-of-field");
  const frozen = JSON.parse(await readFile(baselinePath, "utf8")) as { status?: string; evaluatorRejection?: string; executableSha256?: string };
  const temporary = await mkdtemp(join(tmpdir(), "editkin-resident-25d-dof-"));
  try {
    const nearOutput = join(evidenceRoot, "focus-near.mp4"); const farOutput = join(evidenceRoot, "focus-far.mp4");
    const orderOutput = join(evidenceRoot, "focus-near-order-swap.mp4"); const offOutput = join(evidenceRoot, "lens-off.mp4");
    const [rendered] = await Promise.all([render(candidate, nearOutput), render(project(farFocus), farOutput), render(project(nearFocus, true, "far-near"), orderOutput), render(project(nearFocus, false), offOutput)]);
    const [nearFrame, farFrame, orderFrame, offFrame] = await Promise.all([
      decodeFrame(nearOutput, join(evidenceRoot, "focus-near.png")), decodeFrame(farOutput, join(evidenceRoot, "focus-far.png")),
      decodeFrame(orderOutput, join(temporary, "order.png")), decodeFrame(offOutput, join(evidenceRoot, "lens-off.png")),
    ]);
    const pipeline = rendered.residentVideoPipeline as { frameCount: number; depthReceiptFrames: number; depthOfFieldReceiptFrames: number;
      productPathCpuPixelCopies: number; verificationReadback: boolean; compositeFullFramePassCount: number;
      depthOfField?: DepthOfFieldReceipt; resourcePlan: LensResourcePlan } | undefined;
    if (!pipeline?.depthOfField) throw new Error("formal resident sequence omitted depth-of-field coverage");
    const rejectedNegativeControls: string[] = [];
    const reject = (name: string, value: EditProject) => { if (routeAccepted(value)) throw new Error(`${name} negative was admitted`); rejectedNegativeControls.push(name); };
    const focusAtNear = project(); setLens(focusAtNear, { focusDistance: focusAtNear.scene25d!.camera.near }); reject("focus-at-near", focusAtNear);
    const focusAtFar = project(); setLens(focusAtFar, { focusDistance: focusAtFar.scene25d!.camera.far }); reject("focus-at-far", focusAtFar);
    const zeroAperture = project(); setLens(zeroAperture, { aperture: 0 }); reject("zero-aperture", zeroAperture);
    const zeroRadius = project(); setLens(zeroRadius, { maxBlurRadius: 0 }); reject("zero-radius", zeroRadius);
    const oversized = project(); setLens(oversized, { maxBlurRadius: 33 }); reject("oversized-radius", oversized);
    const ninth = project(); for (let index = 2; index < 9; index += 1) { const item = structuredClone(ninth.tracks[0].clips[0]); item.id = `plane-${index}`; item.trackId = `track-${index}`; ninth.tracks.push({ id: item.trackId, name: item.id, kind: "video", locked: false, muted: false, clips: [item] }); } reject("ninth-plane", ninth);
    const translucent = project(); translucent.tracks[0].clips[0].transform.opacity = .5; reject("translucent-plane", translucent);
    const effect = project(); effect.tracks[0].clips[0].creative!.effectPresetIds = ["glitch-rgb"]; reject("effect-mix", effect);
    const particles = project(); particles.particleSimulation = { schema: "editkin.particle-simulation/v1", enabled: true, seed: 7, ratePerSecond: 20, lifetimeSeconds: 1, initialVelocity: [0, -40], gravity: [0, 20], maxParticles: 16, emitterPosition: [.5, .5], radiusPixels: 4, color: [1, 1, 1, 1] }; reject("particle-mix", particles);
    const pq = project(); pq.assets[0].color = { interpretation: "pq" }; reject("pq-input", pq);
    const nearFocusedEnergy = edgeEnergy(nearFrame, 90, 430); const nearDefocusedEnergy = edgeEnergy(farFrame, 90, 430);
    const farFocusedEnergy = edgeEnergy(farFrame, 530, 890); const farDefocusedEnergy = edgeEnergy(nearFrame, 530, 890);
    const probe = await probeMedia(nearOutput, ffprobe);
    const report: GateReport = {
      schema: "editkin.resident-25d-depth-of-field-video-project-render-gate/v1", measuredAt: new Date().toISOString(), status: "GREEN",
      frozenRedBaseline: frozen.status === "BLOCK" && frozen.evaluatorRejection === "missing_native_depth_of_field_contract",
      baselineExecutableSha256: frozen.executableSha256 ?? "", planner: rendered.planner, frameCount: pipeline.frameCount,
      depthReceiptFrames: pipeline.depthReceiptFrames, depthOfFieldReceiptFrames: pipeline.depthOfFieldReceiptFrames,
      productPathCpuPixelCopies: pipeline.productPathCpuPixelCopies, verificationReadback: pipeline.verificationReadback,
      compositeFullFramePassCount: pipeline.compositeFullFramePassCount, depthOfField: pipeline.depthOfField, resourcePlan: pipeline.resourcePlan,
      focusEvidence: { nearFocusedEnergy, nearDefocusedEnergy, farFocusedEnergy, farDefocusedEnergy,
        nearFocusRatio: nearFocusedEnergy / Math.max(1, nearDefocusedEnergy), farFocusRatio: farFocusedEnergy / Math.max(1, farDefocusedEnergy), focusFlipPixels: comparePixels(nearFrame, farFrame) },
      orderDelta: comparePixels(nearFrame, orderFrame), lensOffDelta: comparePixels(nearFrame, offFrame),
      bt709Tagged: probe.colorPrimaries === "bt709" && probe.colorTransfer === "bt709" && probe.colorMatrix === "bt709", audioPresent: probe.hasAudio,
      rejectedNegativeControls, executableSha256: sha256(await readFile(executable)), inputSha256: [sha256(await readFile(nearSource)), sha256(await readFile(farSource))], outputSha256: sha256(await readFile(nearOutput)),
    };
    try {
      assertGreen(report);
    } catch (error) {
      report.status = "BLOCK";
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
      throw error;
    }
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

await main();
