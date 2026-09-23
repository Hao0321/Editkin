import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { findMotionGraphicPreset } from "../src/creative/motionGraphicPresets";
import { createEmptyProject } from "../src/domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../src/domain/types";
import { createMotionGraphic } from "../src/motion/composition";
import { motionGraphicV2FrameReceipt, motionGraphicV2LayoutReceipt } from "../src/motion/compositionV2";
import { writeAssContent, renderProject } from "../src/render/ffmpeg";
import { buildEngineRenderGraph } from "../src/render/engineGraph";
import { commonVideoMotionGraphicsSupported } from "../src/render/gpuCompositorAdmission";

const appRoot = resolve(".");
const reportRoot = resolve(appRoot, ".rd/benchmarks/editkin-motion-composition-v2");
const ffmpeg = resolve(appRoot, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const ffprobe = resolve(appRoot, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const nativeCore = resolve(appRoot, "native/bin/win32-x64/hao-core.exe");
const source = resolve(reportRoot, "fixture-source.mp4");

interface SampleEvidence {
  time: number;
  changedPixels: number;
  changedBounds?: { x: number; y: number; width: number; height: number };
  insideSafeArea: boolean;
}

interface GateInput {
  planner: string;
  assCarriesLayoutReceipt: boolean;
  samples: SampleEvidence[];
  nativeRejected: boolean;
  acesRejected: boolean;
  hdrRejected: boolean;
  gpuAdmissionRejected: boolean;
  decodedVideo: boolean;
  decodedAudio: boolean;
}

function evaluate(input: GateInput) {
  const findings: string[] = [];
  if (!input.planner.startsWith("typescript-motion-composition-v2-ass-frame-receipt/v2")) findings.push("formal planner did not declare v2 shared-receipt route");
  if (!input.assCarriesLayoutReceipt) findings.push("ASS did not carry the shared layout receipt identity");
  if (!input.samples.length || input.samples.some((sample) => sample.changedPixels < 100)) findings.push("decoded overlay was not visible at every entrance/hold/exit sample");
  if (input.samples.some((sample) => !sample.insideSafeArea)) findings.push("decoded overlay delta escaped the authored safe area");
  if (!input.nativeRejected || !input.acesRejected || !input.hdrRejected || !input.gpuAdmissionRejected) findings.push("an unsupported route silently accepted motion-composition/v2");
  if (!input.decodedVideo || !input.decodedAudio) findings.push("formal artifact is missing independently decoded video/audio");
  return { status: findings.length ? "BLOCK" as const : "GREEN" as const, findings };
}

function selfTest(): void {
  const positive: GateInput = {
    planner: "typescript-motion-composition-v2-ass-frame-receipt/v2", assCarriesLayoutReceipt: true,
    samples: [{ time: .5, changedPixels: 1_000, changedBounds: { x: 50, y: 50, width: 100, height: 40 }, insideSafeArea: true }],
    nativeRejected: true, acesRejected: true, hdrRejected: true, gpuAdmissionRejected: true, decodedVideo: true, decodedAudio: true,
  };
  if (evaluate(positive).status !== "GREEN") throw new Error("motion v2 gate positive control failed");
  const negatives: Array<[string, (fixture: GateInput) => void]> = [
    ["planner", (fixture) => { fixture.planner = "typescript-fallback"; }],
    ["receipt", (fixture) => { fixture.assCarriesLayoutReceipt = false; }],
    ["decoded visibility", (fixture) => { fixture.samples[0].changedPixels = 0; }],
    ["safe area", (fixture) => { fixture.samples[0].insideSafeArea = false; }],
    ["native downgrade", (fixture) => { fixture.nativeRejected = false; }],
    ["ACES downgrade", (fixture) => { fixture.acesRejected = false; }],
    ["HDR downgrade", (fixture) => { fixture.hdrRejected = false; }],
    ["GPU admission", (fixture) => { fixture.gpuAdmissionRejected = false; }],
    ["stream", (fixture) => { fixture.decodedAudio = false; }],
  ];
  for (const [name, mutate] of negatives) {
    const fixture = structuredClone(positive);
    mutate(fixture);
    if (evaluate(fixture).status !== "BLOCK") throw new Error(`motion v2 gate missed negative control: ${name}`);
  }
  process.stdout.write(`${JSON.stringify({ status: "GREEN", detectedNegativeControls: negatives.map(([name]) => name) })}\n`);
}

function makeProject(withGraphic: boolean): EditProject {
  const project = createEmptyProject(withGraphic ? "Motion v2" : "Baseline", { id: withGraphic ? "motion-v2" : "baseline", width: 640, height: 360, fps: 30 });
  project.assets.push({ id: "source", name: "source", kind: "video", uri: source, duration: 12, width: 960, height: 540 });
  project.tracks[0].clips.push({
    id: "clip", assetId: "source", trackId: "video-main", timelineStart: 0, sourceStart: 0, duration: 2,
    volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
  });
  if (withGraphic) {
    const preset = findMotionGraphicPreset("v2-word-cascade");
    project.motionGraphics.push(createMotionGraphic("motion-v2-title", "title", "ONE TWO THREE", .1, 1.6, undefined, preset.seed));
  }
  return project;
}

async function run(executable: string, args: string[]): Promise<{ stdout: string }> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolvePromise({ stdout }) : reject(new Error(stderr.slice(-4_000))));
  });
}

async function decodedFrame(path: string, time: number): Promise<Buffer> {
  const output = resolve(reportRoot, `${path.endsWith("baseline.mp4") ? "baseline" : "candidate"}-${String(time).replace(".", "-")}.rgba`);
  await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(time), "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", output]);
  return readFile(output);
}

function difference(left: Buffer, right: Buffer, width: number, height: number, safe: { x: number; y: number; width: number; height: number }): Omit<SampleEvidence, "time"> {
  if (left.length !== right.length || left.length !== width * height * 4) throw new Error("decoded RGBA frame size mismatch");
  let changedPixels = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const offset = pixel * 4;
    const delta = Math.abs(left[offset] - right[offset]) + Math.abs(left[offset + 1] - right[offset + 1]) + Math.abs(left[offset + 2] - right[offset + 2]);
    if (delta <= 48) continue;
    changedPixels += 1;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const changedBounds = changedPixels ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : undefined;
  const tolerance = 20;
  const insideSafeArea = Boolean(changedBounds && changedBounds.x >= safe.x - tolerance && changedBounds.y >= safe.y - tolerance
    && changedBounds.x + changedBounds.width <= safe.x + safe.width + tolerance && changedBounds.y + changedBounds.height <= safe.y + safe.height + tolerance);
  return { changedPixels, changedBounds, insideSafeArea };
}

async function rejectMessage(action: () => Promise<unknown>, expected: RegExp): Promise<boolean> {
  try { await action(); return false; } catch (error) { return expected.test(error instanceof Error ? error.message : String(error)); }
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  selfTest();
  await rm(reportRoot, { recursive: true, force: true });
  await mkdir(reportRoot, { recursive: true });
  await run(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=0x101820:s=640x360:r=30:d=2",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
    "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-shortest", source,
  ]);
  const baselineProject = makeProject(false);
  const candidateProject = makeProject(true);
  const graphic = candidateProject.motionGraphics[0];
  const layout = motionGraphicV2LayoutReceipt(candidateProject, graphic);
  const ass = writeAssContent(candidateProject, candidateProject.captionStyle);
  const baselinePath = resolve(reportRoot, "baseline.mp4");
  const candidatePath = resolve(reportRoot, "candidate.mp4");
  const options = { ffmpegPath: ffmpeg, ffprobePath: ffprobe, nativeCorePath: nativeCore, preferGpu: false, timeoutMs: 120_000 };
  const baseline = await renderProject(baselineProject, baselinePath, options);
  const candidate = await renderProject(candidateProject, candidatePath, options);
  const decodedProbe = JSON.parse((await run(ffprobe, ["-v", "error", "-show_streams", "-of", "json", candidatePath])).stdout) as { streams?: Array<{ codec_type?: string; width?: number; height?: number }> };
  const sampleTimes = [.2, .8, 1.55];
  const samples: SampleEvidence[] = [];
  for (const time of sampleTimes) {
    samples.push({ time, ...difference(await decodedFrame(baselinePath, time), await decodedFrame(candidatePath, time), candidateProject.width, candidateProject.height, layout.safeRect) });
  }
  const timings: number[] = [];
  for (let index = 0; index < 300; index += 1) {
    const start = performance.now();
    motionGraphicV2FrameReceipt(candidateProject, graphic, Math.round((index % 60) + 3), layout);
    timings.push(performance.now() - start);
  }
  timings.sort((left, right) => left - right);
  const acesProject = structuredClone(candidateProject);
  acesProject.colorManagement = { ...acesProject.colorManagement!, mode: "aces2", outputTransform: "rec709_sdr" };
  const hdrProject = structuredClone(candidateProject);
  hdrProject.colorManagement = { ...hdrProject.colorManagement!, mode: "aces2", outputTransform: "rec2100_pq_1000" };
  const input: GateInput = {
    planner: candidate.planner,
    assCarriesLayoutReceipt: ass.includes(`MotionCompositionV2Receipt: ${graphic.id},${layout.receiptId},48`),
    samples,
    nativeRejected: (() => { try { buildEngineRenderGraph(candidateProject); return false; } catch (error) { return /禁止降級成 v1/.test(error instanceof Error ? error.message : String(error)); } })(),
    acesRejected: await rejectMessage(() => renderProject(acesProject, resolve(reportRoot, "unsupported-aces.mp4"), options), /禁止 silently downgrade/),
    hdrRejected: await rejectMessage(() => renderProject(hdrProject, resolve(reportRoot, "unsupported-hdr.mp4"), options), /禁止 silently downgrade/),
    gpuAdmissionRejected: !commonVideoMotionGraphicsSupported(candidateProject),
    decodedVideo: decodedProbe.streams?.some((stream) => stream.codec_type === "video" && stream.width === candidateProject.width && stream.height === candidateProject.height) === true,
    decodedAudio: decodedProbe.streams?.some((stream) => stream.codec_type === "audio") === true,
  };
  const decision = evaluate(input);
  const candidateBytes = await readFile(candidatePath);
  const sourceBytes = await readFile(source);
  const report = {
    schema: "editkin.motion-composition-v2-benchmark/v1",
    ...decision,
    claim: "bounded motion-composition/v2 Rec.709 ASS route shares deterministic layout/frame receipts with DOM preview; no Hyperframe/Remotion superiority claim",
    source: { path: source, provenance: "deterministic FFmpeg lavfi color+sine integration fixture", bytes: sourceBytes.length, sha256: createHash("sha256").update(sourceBytes).digest("hex") },
    output: { path: candidatePath, bytes: candidateBytes.length, sha256: createHash("sha256").update(candidateBytes).digest("hex"), duration: candidate.duration, encoder: candidate.encoder, planner: candidate.planner, ffmpegVersion: candidate.ffmpegVersion },
    baseline: { path: baselinePath, planner: baseline.planner },
    layoutReceipt: layout,
    ass: { layoutReceiptBound: input.assCarriesLayoutReceipt, eventCount: ass.split("\n").filter((line) => line.startsWith("Dialogue:")).length },
    decodedStreams: decodedProbe.streams,
    decodedSamples: samples,
    evaluator: { iterations: timings.length, p95Ms: Number(timings[Math.floor(timings.length * .95)].toFixed(4)), maxMs: Number(timings.at(-1)!.toFixed(4)) },
    unsupportedRoutes: { nativeGpu: input.nativeRejected, aces2: input.acesRejected, hdr: input.hdrRejected, gpuAdmission: input.gpuAdmissionRejected },
    limitations: ["v2 native GPU/scene-linear/HDR/alpha-precomposition routes fail closed", "ASS timing uses subtitle centisecond timestamps", "arbitrary HTML/React component execution is unsupported", "competitor parity remains unmeasured"],
  };
  await writeFile(resolve(reportRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (decision.status !== "GREEN") process.exitCode = 1;
}
