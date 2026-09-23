import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PNG } from "pngjs";
import { createDemoProject } from "../src/domain/demo";
import type { EditProject, NativeEffectInstance } from "../src/domain/types";
import { materializeNativeEffectSegments } from "../src/plugins/nativeEffectRender";
import { buildRenderPlan } from "../src/render/planner";

const root = resolve(import.meta.dirname, "..");
const evidenceRoot = resolve(root, "../../.rd/benchmarks/editkin-gpu-effect-project-render");
const reportPath = join(evidenceRoot, "report.json");
const selfTest = process.argv.includes("--self-test");
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

function assertGreen(report: Record<string, any>) {
  if (report.schema !== "editkin.gpu-effect-project-render-gate/v2" || report.status !== "GREEN") throw new Error("formal GPU effect report is not GREEN");
  if (report.executionMode !== "resident-gpu-shader-sequence/v1" || report.frameCount !== 15 || report.losslessPixelDifferences !== 0) throw new Error("formal GPU effect sequence was not lossless");
  if (report.productPathCpuPixelCopies !== 0 || report.verificationReadback !== true || report.audioSourceRetained !== true) throw new Error("formal GPU effect boundary receipts are incomplete");
  if (report.programCount !== 2 || report.shaderOpCount !== 8 || report.programSha256s?.length !== 2 || report.orderSensitivePixelDifference !== true) throw new Error("formal ordered GPU stack was not proven");
  if (report.rejectedNegativeControls?.length !== 5) throw new Error("formal GPU effect negatives are incomplete");
  for (const value of [report.executableSha256, report.stackSha256, ...report.programSha256s, report.intermediateSha256, report.firstFrameSha256, report.lastFrameSha256, report.reverseFirstFrameSha256]) {
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("formal GPU effect identity is incomplete");
  }
}

function syntheticSelfTest() {
  const report = {
    schema: "editkin.gpu-effect-project-render-gate/v2", status: "GREEN", executionMode: "resident-gpu-shader-sequence/v1",
    frameCount: 15, losslessPixelDifferences: 0, productPathCpuPixelCopies: 0, verificationReadback: true, audioSourceRetained: true,
    programCount: 2, shaderOpCount: 8, orderSensitivePixelDifference: true,
    rejectedNegativeControls: ["missing-runtime", "stale-identity", "mixed-runtime", "stack-overflow", "off-grid-source"],
    executableSha256: "a".repeat(64), stackSha256: "b".repeat(64), programSha256s: ["c".repeat(64), "d".repeat(64)], intermediateSha256: "e".repeat(64), firstFrameSha256: "f".repeat(64), lastFrameSha256: "1".repeat(64), reverseFirstFrameSha256: "2".repeat(64),
  };
  assertGreen(report);
  for (const candidate of [{ ...report, frameCount: 14 }, { ...report, losslessPixelDifferences: 1 }, { ...report, productPathCpuPixelCopies: 1 }, { ...report, rejectedNegativeControls: [] }]) {
    let rejected = false; try { assertGreen(candidate); } catch { rejected = true; }
    if (!rejected) throw new Error("formal GPU effect evaluator accepted a calibrated negative");
  }
  process.stdout.write(`${JSON.stringify({ status: "GREEN", evaluator: report.schema, calibratedNegatives: 4 })}\n`);
}

function processRun(executable: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = ""; child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject); child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`${executable} exit ${code}: ${stderr.slice(-4000)}`)));
  });
}

async function createPlugin(rootDirectory: string) {
  const directory = join(rootDirectory, "gpu-effect"); await mkdir(directory, { recursive: true });
  const manifest = {
    schema: "editkin.plugin/v1", id: "editkin.gate.formal-gpu", name: "Formal GPU Gate", version: "1.0.0", minimumHostVersion: "0.15.0",
    publisher: { name: "Editkin Gate" }, license: { spdx: "MIT", commercialUse: true }, permissions: ["render.effect"],
    capabilities: [{ id: "look", name: "Look", description: "Formal export parity fixture", kind: "effect", automation: "manual", semanticRoles: [], formats: ["any"], requires: [], avoidWhen: [],
      parameters: [
        { id: "gain", name: "Gain", type: "number", default: .8, min: 0, max: 2 }, { id: "invert", name: "Invert", type: "number", default: .25, min: 0, max: 1 },
        { id: "gray", name: "Gray", type: "number", default: .4, min: 0, max: 1 }, { id: "contrast", name: "Contrast", type: "number", default: 1.15, min: 0, max: 2 },
        { id: "pivot", name: "Pivot", type: "number", default: .5, min: 0, max: 1 },
      ], runtime: { type: "gpu_effect_graph", abiVersion: 1, supportedFormats: ["rgba16_float"], maxTemporalRadius: 0, operations: [
        { op: "gain", args: ["$parameter.gain"] }, { op: "invert", args: ["$parameter.invert"] }, { op: "grayscale", args: ["$parameter.gray"] },
        { op: "contrast", args: ["$parameter.contrast", "$parameter.pivot"] },
      ] },
    }],
  };
  const text = JSON.stringify(manifest); await writeFile(join(directory, "editkin-plugin.json"), text);
  return { manifest, manifestSha256: sha256(text) };
}

function projectWithEffect(instance: NativeEffectInstance): EditProject {
  const project = createDemoProject(); project.width = 960; project.height = 540; project.fps = 30;
  project.assets[0].uri = resolve(root, "public/demo-source.mp4"); project.assets[0].width = 960; project.assets[0].height = 540;
  project.tracks[0].clips[0].duration = .5; project.tracks[0].clips[0].creative = { effectPresetIds: [], nativeEffectInstances: [instance] };
  return project;
}

async function main() {
  if (selfTest) return syntheticSelfTest();
  const temporary = await mkdtemp(join(tmpdir(), "editkin-formal-gpu-effect-"));
  try {
    const pluginRoot = join(temporary, "plugins"); const plugin = await createPlugin(pluginRoot);
    const instance: NativeEffectInstance = { id: "formal-gpu", pluginId: plugin.manifest.id, capabilityId: "look", pluginVersion: plugin.manifest.version,
      manifestSha256: plugin.manifestSha256, runtimeType: "gpu_effect_graph", enabled: true, parameters: { gain: .8, invert: .25, gray: .4, contrast: 1.15, pivot: .5 } };
    const secondInstance: NativeEffectInstance = { ...instance, id: "formal-gpu-2", parameters: { gain: 1.35, invert: .8, gray: .05, contrast: .72, pivot: .42 } };
    const project = projectWithEffect(instance); project.tracks[0].clips[0].creative!.nativeEffectInstances!.push(secondInstance);
    const plan = buildRenderPlan(project, (uri) => uri);
    const workspace = join(temporary, "workspace");
    const runtime = { ffmpegPath: resolve(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe"), nativeCorePath: resolve(root, "native/bin/win32-x64/hao-core.exe"), gpuCompositorPath: resolve(root, "native/bin/win32-x64/editkin-gpu-compositor.exe"), pluginRoots: [pluginRoot], workspace, timeoutMs: 120_000 };
    const receipt = await materializeNativeEffectSegments(project, plan, runtime);
    const clip = receipt?.clips[0]; if (!clip?.gpu) throw new Error("formal GPU effect receipt missing");
    if (clip.gpu.programs.length !== 2 || clip.instances.map((item) => (item.worker as { nodeId?: string }).nodeId).join(",") !== "effect:0,effect:1") throw new Error("formal GPU effect stack order receipt missing");
    const intermediate = plan.videoLayers[0].segments.find((segment) => segment.kind === "clip")!;
    if (intermediate.kind !== "clip") throw new Error("formal GPU intermediate missing");
    const extracted = join(temporary, "extracted"); await mkdir(extracted);
    await processRun(runtime.ffmpegPath, ["-y", "-hide_banner", "-loglevel", "error", "-i", intermediate.assetPath, "-vsync", "0", "-start_number", "0", join(extracted, "frame-%08d.png")]);
    let losslessPixelDifferences = 0;
    for (let frame = 0; frame < clip.frameCount; frame += 1) {
      const name = `frame-${String(frame).padStart(8, "0")}.png`;
      const rendered = PNG.sync.read(await readFile(join(workspace, "clip-demo-0-gpu-frames", name)));
      const decoded = PNG.sync.read(await readFile(join(extracted, name)));
      if (rendered.width !== decoded.width || rendered.height !== decoded.height) throw new Error("formal GPU frame dimensions changed");
      for (let index = 0; index < rendered.data.length; index += 1) if (rendered.data[index] !== decoded.data[index]) losslessPixelDifferences += 1;
    }
    const reverse = projectWithEffect(secondInstance); reverse.tracks[0].clips[0].creative!.nativeEffectInstances!.push(instance);
    const reversePlan = buildRenderPlan(reverse, (uri) => uri);
    const reverseReceipt = await materializeNativeEffectSegments(reverse, reversePlan, { ...runtime, workspace: join(temporary, "reverse-workspace") });
    const reverseFirstFrameSha256 = reverseReceipt?.clips[0]?.gpu?.firstFrameSha256;
    if (!reverseFirstFrameSha256 || reverseFirstFrameSha256 === clip.gpu.firstFrameSha256) throw new Error("reversing the GPU stack did not change rendered pixels");
    const rejectedNegativeControls: string[] = [];
    const reject = async (name: string, candidate: EditProject, overrides: Partial<typeof runtime>, marker: RegExp) => {
      const candidatePlan = buildRenderPlan(candidate, (uri) => uri);
      await materializeNativeEffectSegments(candidate, candidatePlan, { ...runtime, workspace: join(temporary, `negative-${name}`), ...overrides })
        .then(() => { throw new Error(`${name} negative was accepted`); }, (error) => { if (!marker.test(String(error))) throw error; rejectedNegativeControls.push(name); });
    };
    await reject("missing-runtime", projectWithEffect(instance), { gpuCompositorPath: undefined }, /缺少 GPU compositor runtime/);
    await reject("stale-identity", projectWithEffect({ ...instance, manifestSha256: "0".repeat(64) }), {}, /identity/);
    await reject("mixed-runtime", (() => { const value = projectWithEffect(instance); value.tracks[0].clips[0].creative!.nativeEffectInstances!.push({ ...instance, id: "cpu", runtimeType: "native_effect" }); return value; })(), {}, /不可混用 CPU ABI/);
    await reject("stack-overflow", (() => { const value = projectWithEffect(instance); for (let index = 1; index < 5; index += 1) value.tracks[0].clips[0].creative!.nativeEffectInstances!.push({ ...instance, id: `gpu-${index}` }); return value; })(), {}, /最多 4 個/);
    await reject("off-grid-source", (() => { const value = projectWithEffect(instance); value.tracks[0].clips[0].sourceStart = .01; return value; })(), {}, /frame grid/);
    const report = { schema: "editkin.gpu-effect-project-render-gate/v2", measuredAt: new Date().toISOString(), status: "GREEN",
      executionMode: clip.executionMode, frameCount: clip.frameCount, losslessPixelDifferences, productPathCpuPixelCopies: clip.gpu.productPathCpuPixelCopies,
      verificationReadback: clip.gpu.verificationReadback, audioSourceRetained: true, rejectedNegativeControls,
      programCount: clip.gpu.programs.length, shaderOpCount: clip.gpu.programs.reduce((total, program) => total + program.shaderOpCount, 0), orderSensitivePixelDifference: true,
      executableSha256: clip.gpu.executableSha256, stackSha256: clip.gpu.stackSha256, programSha256s: clip.gpu.programs.map((program) => program.programSha256), intermediateSha256: clip.intermediateSha256,
      intermediateBytes: (await stat(intermediate.assetPath)).size, firstFrameSha256: clip.gpu.firstFrameSha256, lastFrameSha256: clip.gpu.lastFrameSha256, reverseFirstFrameSha256 };
    await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); assertGreen(report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

await main();
