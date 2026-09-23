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
const reportPath = resolve(root, "../../.rd/benchmarks/editkin-gpu-effect-sdk-project-render/report.json");
const selfTest = process.argv.includes("--self-test");
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

function assertGreen(report: Record<string, any>) {
  if (report.schema !== "editkin.gpu-effect-sdk-project-render-gate/v1" || report.status !== "GREEN") throw new Error("formal GPU SDK report is not GREEN");
  if (report.executionMode !== "resident-gpu-shader-sequence/v1" || report.frameCount !== 15 || report.losslessPixelDifferences !== 0) throw new Error("formal GPU SDK sequence was not lossless");
  if (report.productPathCpuPixelCopies !== 0 || report.verificationReadback !== true || report.audioSourceRetained !== true) throw new Error("formal GPU SDK receipts are incomplete");
  if (report.authoringRuntime !== "gpu_effect_module" || report.programCount !== 1 || report.shaderOpCount !== 4 || report.opcodes.join(",") !== "12,10,9,11") throw new Error("formal GPU SDK program was not executed");
  if (report.rejectedNegativeControls?.length !== 4) throw new Error("formal GPU SDK negatives are incomplete");
  for (const value of [report.manifestSha256, report.executableSha256, report.stackSha256, report.programSha256, report.intermediateSha256, report.firstFrameSha256, report.lastFrameSha256]) {
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("formal GPU SDK identity is incomplete");
  }
}

function syntheticSelfTest() {
  const report = {
    schema: "editkin.gpu-effect-sdk-project-render-gate/v1", status: "GREEN", executionMode: "resident-gpu-shader-sequence/v1",
    frameCount: 15, losslessPixelDifferences: 0, productPathCpuPixelCopies: 0, verificationReadback: true, audioSourceRetained: true,
    authoringRuntime: "gpu_effect_module", programCount: 1, shaderOpCount: 4, opcodes: [12, 10, 9, 11],
    rejectedNegativeControls: ["missing-runtime", "stale-identity", "mixed-runtime", "off-grid-source"],
    manifestSha256: "a".repeat(64), executableSha256: "b".repeat(64), stackSha256: "c".repeat(64), programSha256: "d".repeat(64),
    intermediateSha256: "e".repeat(64), firstFrameSha256: "f".repeat(64), lastFrameSha256: "1".repeat(64),
  };
  assertGreen(report);
  for (const candidate of [{ ...report, shaderOpCount: 3 }, { ...report, losslessPixelDifferences: 1 }, { ...report, productPathCpuPixelCopies: 1 }, { ...report, rejectedNegativeControls: [] }]) {
    let rejected = false; try { assertGreen(candidate); } catch { rejected = true; }
    if (!rejected) throw new Error("formal GPU SDK evaluator accepted a calibrated negative");
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

function projectWithEffect(instance: NativeEffectInstance): EditProject {
  const project = createDemoProject(); project.width = 960; project.height = 540; project.fps = 30;
  project.assets[0].uri = resolve(root, "public/demo-source.mp4"); project.assets[0].width = 960; project.assets[0].height = 540;
  project.tracks[0].clips[0].duration = .5; project.tracks[0].clips[0].creative = { effectPresetIds: [], nativeEffectInstances: [instance] };
  return project;
}

async function main() {
  if (selfTest) return syntheticSelfTest();
  const temporary = await mkdtemp(join(tmpdir(), "editkin-formal-gpu-sdk-"));
  try {
    const manifestText = await readFile(resolve(root, "plugins/gpu-color-lab/editkin-plugin.json"), "utf8");
    const manifest = JSON.parse(manifestText);
    const manifestSha256 = sha256(manifestText);
    const instance: NativeEffectInstance = {
      id: "formal-gpu-sdk", pluginId: manifest.id, capabilityId: "soft-skin-filmic", pluginVersion: manifest.version,
      manifestSha256, runtimeType: "gpu_effect_graph", enabled: true,
      parameters: { temperature: .08, tint: .02, lift: .012, gamma: 1.04, gain: 1.01, hue: .015, curve: .28, toe: .12, shoulder: .22 },
    };
    const project = projectWithEffect(instance); const plan = buildRenderPlan(project, (uri) => uri); const workspace = join(temporary, "workspace");
    const runtime = { ffmpegPath: resolve(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe"), nativeCorePath: resolve(root, "native/bin/win32-x64/hao-core.exe"), gpuCompositorPath: resolve(root, "native/bin/win32-x64/editkin-gpu-compositor.exe"), pluginRoots: [resolve(root, "plugins")], workspace, timeoutMs: 120_000 };
    const receipt = await materializeNativeEffectSegments(project, plan, runtime); const clip = receipt?.clips[0];
    if (!clip?.gpu || clip.gpu.programs.length !== 1 || clip.instances.map((item) => (item.worker as { nodeId?: string }).nodeId).join(",") !== "effect:0") throw new Error("formal GPU SDK receipt missing");
    const intermediate = plan.videoLayers[0].segments.find((segment) => segment.kind === "clip")!; if (intermediate.kind !== "clip") throw new Error("formal GPU SDK intermediate missing");
    const extracted = join(temporary, "extracted"); await mkdir(extracted);
    await processRun(runtime.ffmpegPath, ["-y", "-hide_banner", "-loglevel", "error", "-i", intermediate.assetPath, "-vsync", "0", "-start_number", "0", join(extracted, "frame-%08d.png")]);
    let losslessPixelDifferences = 0;
    for (let frame = 0; frame < clip.frameCount; frame += 1) {
      const name = `frame-${String(frame).padStart(8, "0")}.png`; const rendered = PNG.sync.read(await readFile(join(workspace, "clip-demo-0-gpu-frames", name))); const decoded = PNG.sync.read(await readFile(join(extracted, name)));
      if (rendered.width !== decoded.width || rendered.height !== decoded.height) throw new Error("formal GPU SDK frame dimensions changed");
      for (let index = 0; index < rendered.data.length; index += 1) if (rendered.data[index] !== decoded.data[index]) losslessPixelDifferences += 1;
    }
    const rejectedNegativeControls: string[] = [];
    const reject = async (name: string, candidate: EditProject, overrides: Partial<typeof runtime>, marker: RegExp) => {
      const candidatePlan = buildRenderPlan(candidate, (uri) => uri);
      await materializeNativeEffectSegments(candidate, candidatePlan, { ...runtime, workspace: join(temporary, `negative-${name}`), ...overrides })
        .then(() => { throw new Error(`${name} negative was accepted`); }, (error) => { if (!marker.test(String(error))) throw error; rejectedNegativeControls.push(name); });
    };
    await reject("missing-runtime", projectWithEffect(instance), { gpuCompositorPath: undefined }, /缺少 GPU compositor runtime/);
    await reject("stale-identity", projectWithEffect({ ...instance, manifestSha256: "0".repeat(64) }), {}, /identity/);
    await reject("mixed-runtime", (() => { const value = projectWithEffect(instance); value.tracks[0].clips[0].creative!.nativeEffectInstances!.push({ ...instance, id: "cpu", runtimeType: "native_effect" }); return value; })(), {}, /不可混用 CPU ABI/);
    await reject("off-grid-source", (() => { const value = projectWithEffect(instance); value.tracks[0].clips[0].sourceStart = .01; return value; })(), {}, /frame grid/);
    const program = clip.gpu.programs[0];
    const report = {
      schema: "editkin.gpu-effect-sdk-project-render-gate/v1", measuredAt: new Date().toISOString(), status: "GREEN",
      authoringRuntime: "gpu_effect_module", executionMode: clip.executionMode, frameCount: clip.frameCount, losslessPixelDifferences,
      productPathCpuPixelCopies: clip.gpu.productPathCpuPixelCopies, verificationReadback: clip.gpu.verificationReadback, audioSourceRetained: true, rejectedNegativeControls,
      programCount: 1, shaderOpCount: program.shaderOpCount, opcodes: [12, 10, 9, 11], manifestSha256, executableSha256: clip.gpu.executableSha256,
      stackSha256: clip.gpu.stackSha256, programSha256: program.programSha256, intermediateSha256: clip.intermediateSha256, intermediateBytes: (await stat(intermediate.assetPath)).size,
      firstFrameSha256: clip.gpu.firstFrameSha256, lastFrameSha256: clip.gpu.lastFrameSha256,
    };
    await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); assertGreen(report); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

await main();
