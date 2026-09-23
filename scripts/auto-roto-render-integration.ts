import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { analyzeAutoRoto } from "../src/application/autoRoto";
import { AUTO_ROTO_ONNX_ENGINE } from "../src/application/autoRotoModelRouter";
import { createEmptyProject } from "../src/domain/editGraph";
import { createClipMask } from "../src/domain/masks";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type TimelineClip } from "../src/domain/types";
import { probeMedia, renderProject } from "../src/render/ffmpeg";
import { createNativeAutoRoto, type NativeAutoRotoRequest, type NativeOnnxRotoPackRequest } from "../src/render/nativeCore";

const root = resolve(".");
const ffmpeg = resolve(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const ffprobe = resolve(root, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const candidateCore = resolve(root, "native/hao-core/target/debug/hao-core.exe");
const baselineCore = resolve(root, "native/bin/win32-x64/hao-core.exe");
const vendorRoot = resolve(root, "vendor");
const vendorManifest = resolve(vendorRoot, "auto-roto-models/onnx-logit-calibrator-fixture/manifest.json");
const evidenceRoot = resolve(root, "../../.rd/benchmarks/editkin-auto-roto-onnx-slice29");
const fixtureRoot = join(evidenceRoot, "fixture");
const source = join(fixtureRoot, "source.mp4");
const rawSource = join(fixtureRoot, "source.rgb24");
const analysisRaw = join(fixtureRoot, "analysis.rgb24");
const width = 160; const height = 90; const fps = 30; const duration = 2; const analysisFps = 12; const analysisFrameCount = 24;
const debugOnnxRoute = { mode: "debug", requestedEngine: AUTO_ROTO_ONNX_ENGINE } as const;
const analysisRequest = {
  sourcePath: source, sourceStart: 0, duration, fps, sourceWidth: width, sourceHeight: height, initialTime: 0,
  initialRect: { x: 18 / width, y: 24 / height, width: 42 / width, height: 46 / height }, temporalStability: .18,
  corrections: [
    { id: "remove-same-color-distractor", frame: 12, mode: "background" as const, radius: .09, points: [{ x: 129 / width, y: 45 / height }] },
    { id: "keep-subject-edge", frame: 12, mode: "foreground" as const, radius: .04, points: [{ x: 44 / width, y: 45 / height }, { x: 48 / width, y: 45 / height }] },
  ],
};

function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
async function sha256File(path: string): Promise<string> { return sha256(await readFile(path)); }

async function run(executable: string, args: string[]): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8_000); });
    child.on("error", rejectRun);
    child.on("exit", (code) => code === 0 ? resolveRun() : rejectRun(new Error(stderr)));
  });
}

async function decodeFrame(video: string, time: number, output: string): Promise<Buffer> {
  await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(time), "-i", video, "-frames:v", "1", "-vf", "scale=160:90,format=rgb24", "-f", "rawvideo", output]);
  return readFile(output);
}

function rgbAt(frame: Buffer, x: number, y: number): [number, number, number] {
  const offset = (y * width + x) * 3;
  return [frame[offset], frame[offset + 1], frame[offset + 2]];
}

async function createFrozenFixture(): Promise<void> {
  await mkdir(fixtureRoot, { recursive: true });
  const raw = Buffer.alloc(width * height * fps * duration * 3);
  for (let frame = 0; frame < fps * duration; frame += 1) {
    const left = 18 + Math.round(frame * 22 / (fps * duration));
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const offset = (frame * width * height + y * width + x) * 3;
      const subject = x >= left && x < left + 42 && y >= 24 && y < 70;
      const distractor = x >= 120 && x < 138 && y >= 35 && y < 56;
      raw[offset] = subject || distractor ? 238 : 18;
      raw[offset + 1] = subject || distractor ? 28 : 176;
      raw[offset + 2] = subject || distractor ? 26 : 34;
    }
  }
  await writeFile(rawSource, raw);
  await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", `${width}x${height}`, "-framerate", String(fps), "-i", rawSource, "-c:v", "libx264", "-crf", "10", "-pix_fmt", "yuv420p", source]);
  await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", source, "-vf", `fps=${analysisFps},scale=${width}:${height}:flags=bilinear,format=rgb24`, "-f", "rawvideo", "-pix_fmt", "rgb24", analysisRaw]);
}

interface BaselineReport { status: "GREEN"; sourceSha256: string; engine: string; sequencePath: string; sequenceSha256: string; frames: number; baselineCoreSha256: string }

async function runBaseline(): Promise<void> {
  await rm(evidenceRoot, { recursive: true, force: true });
  await createFrozenFixture();
  const baseline = await analyzeAutoRoto(analysisRequest, { ffmpegPath: ffmpeg, nativeCorePath: baselineCore, cacheRoot: join(evidenceRoot, "baseline-cache") });
  if (baseline.engine !== "editkin-native-color-temporal-roto/v1" || baseline.frames.length !== analysisFrameCount) throw new Error("frozen baseline did not execute the delivered native color-temporal engine");
  const report: BaselineReport = {
    status: "GREEN", sourceSha256: await sha256File(source), engine: baseline.engine, sequencePath: baseline.sequencePath,
    sequenceSha256: await sha256File(baseline.sequencePath), frames: baseline.frames.length, baselineCoreSha256: await sha256File(baselineCore),
  };
  await writeFile(join(evidenceRoot, "slice29-baseline.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

interface PackMutation {
  corruptModel?: boolean; wrongModelHash?: boolean; wrongRuntimeHash?: boolean; wrongLicenseHash?: boolean;
  runtimeVersionContents?: string; inputName?: string; inputShape?: number[]; modelPath?: string;
}

async function materializePack(packRoot: string, mutation: PackMutation = {}): Promise<NativeOnnxRotoPackRequest> {
  await mkdir(packRoot, { recursive: true });
  const modelPath = join(packRoot, "model.onnx"); const runtimePath = join(packRoot, "onnxruntime.dll");
  const versionPath = join(packRoot, "VERSION_NUMBER.txt"); const licensePath = join(packRoot, "LICENSE.txt");
  await Promise.all([
    copyFile(resolve(vendorRoot, "auto-roto-models/onnx-logit-calibrator-fixture/model.onnx"), modelPath),
    copyFile(resolve(vendorRoot, "onnxruntime/win32-x64/onnxruntime.dll"), runtimePath),
    copyFile(resolve(vendorRoot, "onnxruntime/win32-x64/VERSION_NUMBER.txt"), versionPath),
    copyFile(resolve(vendorRoot, "onnxruntime/win32-x64/LICENSE.txt"), licensePath),
  ]);
  if (mutation.modelPath === "../outside.onnx") await copyFile(modelPath, resolve(packRoot, "../outside.onnx"));
  if (mutation.corruptModel) await writeFile(modelPath, Buffer.from("not an onnx model", "utf8"));
  if (mutation.runtimeVersionContents !== undefined) await writeFile(versionPath, `${mutation.runtimeVersionContents}\n`, "utf8");
  const manifest = {
    schema: "editkin.auto-roto-onnx-pack/v1", id: "editkin-onnx-logit-calibrator-fixture", version: "1.0.0", qualityTier: "integration_fixture",
    modelPath: mutation.modelPath ?? "model.onnx", modelSha256: mutation.wrongModelHash ? "0".repeat(64) : await sha256File(modelPath),
    runtimePath: "onnxruntime.dll", runtimeSha256: mutation.wrongRuntimeHash ? "1".repeat(64) : await sha256File(runtimePath), runtimeVersion: "1.28.0",
    runtimeVersionPath: "VERSION_NUMBER.txt", runtimeVersionSha256: await sha256File(versionPath), licensePath: "LICENSE.txt", licenseSha256: mutation.wrongLicenseHash ? "2".repeat(64) : await sha256File(licensePath),
    inputName: mutation.inputName ?? "x", outputName: "y", inputShape: mutation.inputShape ?? [3, 4, 5], featureContract: "foreground-logit", outputContract: "probability",
  };
  const manifestPath = join(packRoot, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { trustedRoot: packRoot, manifestPath, allowIntegrationFixture: true };
}

function nativeRequest(outputDir: string, onnxPack: NativeOnnxRotoPackRequest): NativeAutoRotoRequest {
  return { rawPath: analysisRaw, outputDir, width, height, frameCount: analysisFrameCount, analysisFps, initialFrame: 0, initialRect: analysisRequest.initialRect, temporalStability: .18, feather: .01, edgeShift: 0, contrast: 1.7, corrections: analysisRequest.corrections, onnxPack };
}

async function expectReject(name: string, action: () => Promise<unknown>, expected: RegExp): Promise<{ name: string; passed: boolean; message: string }> {
  try { await action(); return { name, passed: false, message: "unexpectedly accepted" }; }
  catch (error) { const message = error instanceof Error ? error.message : String(error); return { name, passed: expected.test(message), message }; }
}

interface GateFacts {
  baselineEngine: string; candidateEngine: string; qualityState: string; modelReceipt: boolean; cacheHit: boolean;
  maxAlphaDelta: number; meanAlphaDelta: number; subjectRetention: number; backgroundSuppression: number; distractorSuppression: number;
  correctionsApplied: boolean; renderHasVideo: boolean; previewPng: boolean; sequenceComplete: boolean; sourceFrozen: boolean;
  faults: Array<{ passed: boolean }>;
}

function evaluate(facts: GateFacts): { status: "GREEN" | "BLOCK"; failed: string[] } {
  const checks: Record<string, boolean> = {
    baselineEngine: facts.baselineEngine === "editkin-native-color-temporal-roto/v1",
    candidateEngine: facts.candidateEngine === "editkin-native-onnx-assisted-roto/v1",
    diagnosticTruthBoundary: facts.qualityState === "diagnostic", modelReceipt: facts.modelReceipt, cacheBound: facts.cacheHit,
    alphaCompatibility: facts.maxAlphaDelta <= 1 && facts.meanAlphaDelta <= .05, subjectRetention: facts.subjectRetention > .55,
    backgroundSuppression: facts.backgroundSuppression > .75, distractorSuppression: facts.distractorSuppression > .72,
    correctionsApplied: facts.correctionsApplied, renderVideo: facts.renderHasVideo, previewPng: facts.previewPng,
    sequenceComplete: facts.sequenceComplete, sourceFrozen: facts.sourceFrozen,
    negativeControls: facts.faults.length >= 10 && facts.faults.every((fault) => fault.passed),
  };
  const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  return { status: failed.length === 0 ? "GREEN" : "BLOCK", failed };
}

function selfTest(): void {
  const valid: GateFacts = { baselineEngine: "editkin-native-color-temporal-roto/v1", candidateEngine: "editkin-native-onnx-assisted-roto/v1", qualityState: "diagnostic", modelReceipt: true, cacheHit: true, maxAlphaDelta: 0, meanAlphaDelta: 0, subjectRetention: .9, backgroundSuppression: .9, distractorSuppression: .9, correctionsApplied: true, renderHasVideo: true, previewPng: true, sequenceComplete: true, sourceFrozen: true, faults: Array.from({ length: 10 }, () => ({ passed: true })) };
  if (evaluate(valid).status !== "GREEN") throw new Error("evaluator rejected valid fixture");
  for (const key of ["modelReceipt", "cacheHit", "sourceFrozen"] as const) if (evaluate({ ...valid, [key]: false }).status !== "BLOCK") throw new Error(`evaluator failed closed for ${key}`);
  if (evaluate({ ...valid, qualityState: "measured" }).status !== "BLOCK") throw new Error("evaluator permitted synthetic quality promotion");
  if (evaluate({ ...valid, faults: valid.faults.slice(1) }).status !== "BLOCK") throw new Error("evaluator permitted missing negative control");
  if (evaluate({ ...valid, maxAlphaDelta: 3 }).status !== "BLOCK") throw new Error("evaluator permitted incompatible candidate matte");
  process.stdout.write(`${JSON.stringify({ status: "GREEN", evaluatorMutationsRejected: 6 }, null, 2)}\n`);
}

async function runCandidate(): Promise<void> {
  const baseline = JSON.parse(await readFile(join(evidenceRoot, "slice29-baseline.json"), "utf8")) as BaselineReport;
  const frozenSourceSha256 = await sha256File(source);
  const workspace = await mkdtemp(join(tmpdir(), "editkin-auto-roto-onnx-gate-"));
  try {
    const runtime = { ffmpegPath: ffmpeg, nativeCorePath: candidateCore, cacheRoot: join(evidenceRoot, "candidate-cache"), onnxPack: { trustedRoot: vendorRoot, manifestPath: vendorManifest, allowIntegrationFixture: true }, routePolicy: debugOnnxRoute };
    const candidate = await analyzeAutoRoto(analysisRequest, runtime); const cached = await analyzeAutoRoto(analysisRequest, runtime);
    const baselineAlpha = await readFile(baseline.sequencePath); const candidateAlpha = await readFile(candidate.sequencePath);
    let maxAlphaDelta = 0; let totalAlphaDelta = 0;
    for (let index = 0; index < baselineAlpha.length; index += 1) { const delta = Math.abs(baselineAlpha[index] - candidateAlpha[index]); maxAlphaDelta = Math.max(maxAlphaDelta, delta); totalAlphaDelta += delta; }
    const meanAlphaDelta = totalAlphaDelta / Math.max(1, baselineAlpha.length);

    const project = createEmptyProject("Auto Roto ONNX gate", { id: "auto-roto-onnx-gate", width, height, fps });
    project.assets.push({ id: "source", name: "source", kind: "video", uri: source, duration, width, height });
    const clip: TimelineClip = { id: "subject", assetId: "source", trackId: project.tracks[0].id, timelineStart: 0, sourceStart: 0, duration, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], layer: { ...DEFAULT_CLIP_LAYER }, expressions: {} };
    const mask = createClipMask("auto-roto", "subject");
    (mask as unknown as { matteSequence: Record<string, unknown> }).matteSequence = { schema: candidate.schema, engine: candidate.engine, width: candidate.width, height: candidate.height, analysisFps: candidate.analysisFps, frameCount: candidate.frames.length, sequenceUri: candidate.sequencePath, manifestUri: candidate.manifestPath, framePreviewUris: candidate.frames.map((frame) => frame.alphaPath), meanBoundaryChatter: candidate.meanBoundaryChatter, correctionStrokesApplied: candidate.correctionStrokesApplied, correctedFrames: candidate.correctedFrames, onnxModel: candidate.onnxModel, frozen: true, qualityState: candidate.qualityState };
    clip.masks = [mask]; project.tracks[0].clips.push(clip);
    const output = join(evidenceRoot, "auto-roto-onnx-composite.mp4");
    const render = await renderProject(project, output, { ffmpegPath: ffmpeg, ffprobePath: ffprobe, nativeCorePath: candidateCore, preferGpu: false, timeoutMs: 180_000 });
    const sourceFrame = await decodeFrame(source, 1, join(workspace, "source-frame.rgb")); const outputFrame = await decodeFrame(output, 1, join(workspace, "output-frame.rgb"));
    const subject = { source: rgbAt(sourceFrame, 50, 45), output: rgbAt(outputFrame, 50, 45) }; const background = { source: rgbAt(sourceFrame, 140, 10), output: rgbAt(outputFrame, 140, 10) }; const distractor = { source: rgbAt(sourceFrame, 129, 45), output: rgbAt(outputFrame, 129, 45) };
    const subjectRetention = subject.output[0] / Math.max(1, subject.source[0]); const backgroundSuppression = 1 - background.output.reduce((sum, value) => sum + value, 0) / Math.max(1, background.source.reduce((sum, value) => sum + value, 0)); const distractorSuppression = 1 - distractor.output.reduce((sum, value) => sum + value, 0) / Math.max(1, distractor.source.reduce((sum, value) => sum + value, 0));
    const probe = await probeMedia(output, ffprobe); const sequenceBytes = candidateAlpha.length; const previewSignature = (await readFile(candidate.frames[0].alphaPath)).subarray(0, 8).toString("hex");

    const denied = await materializePack(join(workspace, "denied")); denied.allowIntegrationFixture = false;
    const versionMismatch = await materializePack(join(workspace, "version"), { runtimeVersionContents: "9.9.9" });
    const wrongIo = await materializePack(join(workspace, "io"), { inputName: "wrong" });
    const wrongShape = await materializePack(join(workspace, "shape"), { inputShape: [1, 1, 1] });
    const corrupt = await materializePack(join(workspace, "corrupt"), { corruptModel: true });
    const wrongModelHash = await materializePack(join(workspace, "model-hash"), { wrongModelHash: true });
    const wrongRuntimeHash = await materializePack(join(workspace, "runtime-hash"), { wrongRuntimeHash: true });
    const wrongLicenseHash = await materializePack(join(workspace, "license-hash"), { wrongLicenseHash: true });
    const traversal = await materializePack(join(workspace, "traversal"), { modelPath: "../outside.onnx" });
    const nativeFault = (name: string, pack: NativeOnnxRotoPackRequest, expected: RegExp) => expectReject(name, () => createNativeAutoRoto(nativeRequest(join(workspace, `out-${name}`), pack), candidateCore), expected);
    const faults = await Promise.all([
      nativeFault("fixture-denied", denied, /integration-only/i), nativeFault("runtime-version-mismatch", versionMismatch, /version file/i),
      nativeFault("wrong-io-name", wrongIo, /I\/O names/i), nativeFault("wrong-tensor-shape", wrongShape, /invalid.*manifest/i), nativeFault("corrupt-model", corrupt, /load ONNX Auto Roto model/i),
      expectReject("model-hash", () => analyzeAutoRoto(analysisRequest, { ffmpegPath: ffmpeg, nativeCorePath: candidateCore, cacheRoot: join(workspace, "cache-model-hash"), onnxPack: wrongModelHash, routePolicy: debugOnnxRoute }), /modelSha256.*驗證失敗/i),
      expectReject("runtime-hash", () => analyzeAutoRoto(analysisRequest, { ffmpegPath: ffmpeg, nativeCorePath: candidateCore, cacheRoot: join(workspace, "cache-runtime-hash"), onnxPack: wrongRuntimeHash, routePolicy: debugOnnxRoute }), /runtimeSha256.*驗證失敗/i),
      expectReject("license-hash", () => analyzeAutoRoto(analysisRequest, { ffmpegPath: ffmpeg, nativeCorePath: candidateCore, cacheRoot: join(workspace, "cache-license-hash"), onnxPack: wrongLicenseHash, routePolicy: debugOnnxRoute }), /licenseSha256.*驗證失敗/i),
      expectReject("trusted-root-traversal", () => analyzeAutoRoto(analysisRequest, { ffmpegPath: ffmpeg, nativeCorePath: candidateCore, cacheRoot: join(workspace, "cache-traversal"), onnxPack: traversal, routePolicy: debugOnnxRoute }), /超出可信 runtime 根目錄/i),
    ]);

    const staleRoot = join(workspace, "stale"); const stalePack = await materializePack(staleRoot); const staleCache = join(workspace, "cache-stale");
    await analyzeAutoRoto(analysisRequest, { ffmpegPath: ffmpeg, nativeCorePath: candidateCore, cacheRoot: staleCache, onnxPack: stalePack, routePolicy: debugOnnxRoute });
    const staleMutated = await materializePack(staleRoot, { corruptModel: true });
    faults.push(await expectReject("mutated-model-invalidates-cache", () => analyzeAutoRoto(analysisRequest, { ffmpegPath: ffmpeg, nativeCorePath: candidateCore, cacheRoot: staleCache, onnxPack: staleMutated, routePolicy: debugOnnxRoute }), /load ONNX Auto Roto model/i));

    const manifest = JSON.parse(await readFile(vendorManifest, "utf8")) as Record<string, string>; const model = candidate.onnxModel;
    const modelReceipt = Boolean(model && model.schema === "editkin.auto-roto-onnx-pack/v1" && model.qualityTier === "integration_fixture" && model.inferenceCalls > 0 && model.modelSha256 === manifest.modelSha256 && model.runtimeSha256 === manifest.runtimeSha256 && model.runtimeVersionSha256 === manifest.runtimeVersionSha256 && model.licenseSha256 === manifest.licenseSha256);
    const correctionsApplied = candidate.correctionStrokesApplied === 2 && candidate.correctedFrames.length === 1 && candidate.correctedFrames[0] === 12;
    const facts: GateFacts = { baselineEngine: baseline.engine, candidateEngine: candidate.engine, qualityState: candidate.qualityState, modelReceipt, cacheHit: cached.cacheHit && cached.onnxModel?.modelSha256 === model?.modelSha256, maxAlphaDelta, meanAlphaDelta, subjectRetention, backgroundSuppression, distractorSuppression, correctionsApplied, renderHasVideo: probe.hasVideo, previewPng: previewSignature === "89504e470d0a1a0a", sequenceComplete: sequenceBytes === candidate.width * candidate.height * candidate.frames.length, sourceFrozen: frozenSourceSha256 === baseline.sourceSha256, faults };
    const verdict = evaluate(facts);
    const report = { schemaVersion: 2, ...verdict, claimState: "diagnostic", truthBoundary: "This verifies a version-locked ONNX execution adapter, model/runtime provenance, cache binding, and formal matte consumption. It does not establish natural-footage Roto quality or Adobe parity.", facts, faults, engine: candidate.engine, qualityState: candidate.qualityState, onnxModel: candidate.onnxModel, frames: candidate.frames.length, analysisFps: candidate.analysisFps, sequenceBytes, previewSignature, sourceSha256: frozenSourceSha256, baselineSequenceSha256: baseline.sequenceSha256, candidateSequenceSha256: await sha256File(candidate.sequencePath), candidateCoreSha256: await sha256File(candidateCore), ffmpegSha256: await sha256File(ffmpeg), render, probe };
    await writeFile(join(evidenceRoot, "slice29-candidate.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ ...report, evidence: join(evidenceRoot, "slice29-candidate.json") }, null, 2)}\n`);
    if (verdict.status !== "GREEN") process.exitCode = 1;
  } finally { await rm(workspace, { recursive: true, force: true }); }
}

if (process.argv.includes("--self-test")) selfTest();
else if (process.argv.includes("--baseline")) await runBaseline();
else await runCandidate();
