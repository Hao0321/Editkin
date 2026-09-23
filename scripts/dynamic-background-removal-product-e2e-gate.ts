import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeProductAutoRoto, PRODUCT_AUTO_ROTO_ENGINE } from "../src/application/autoRotoNativeProduct";
import { createEmptyProject } from "../src/domain/editGraph";
import { createClipMask } from "../src/domain/masks";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type RotoMatteSequence, type TimelineClip } from "../src/domain/types";
import { verifyFrozenRotoMatte } from "../src/render/autoRotoMatteIntegrity";
import { probeMedia, renderProject } from "../src/render/ffmpeg";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportRoot = join(appRoot, ".rd", "benchmarks", "editkin-dynamic-background-removal-product-e2e");
const fixtureRoot = join(reportRoot, "fixture");
const cacheRoot = join(reportRoot, "cache");
const ffmpegPath = join(appRoot, "vendor", "ffmpeg", "win32-x64", "ffmpeg.exe");
const ffprobePath = join(appRoot, "vendor", "ffmpeg", "win32-x64", "ffprobe.exe");
const nativeCorePath = join(appRoot, "native", "bin", "win32-x64", "hao-core.exe");
const width = 160;
const height = 90;
const fps = 12;
const frameCount = 24;
const duration = frameCount / fps;

interface Facts {
  engine: string;
  routeSchema: string;
  routeProductOnly: boolean;
  frameCount: number;
  meanRegionJ: number;
  minimumRegionJ: number;
  uniqueAlphaFrames: number;
  normalizedCentroidTravel: number;
  cacheReplay: boolean;
  formalOutputHasVideo: boolean;
  formalOutputHasAudio: boolean;
  formalBackgroundSuppression: number;
  formalSubjectRetention: number;
  formalMatteVerified: boolean;
  staleMatteRejected: boolean;
  researchReceiptAbsent: boolean;
}

function evaluate(facts: Facts): string[] {
  const failures: string[] = [];
  if (facts.engine !== PRODUCT_AUTO_ROTO_ENGINE) failures.push("engine");
  if (facts.routeSchema !== "editkin.auto-roto-product-route-receipt/v2" || !facts.routeProductOnly) failures.push("route");
  if (facts.frameCount !== frameCount) failures.push("frame-count");
  if (facts.meanRegionJ < .9) failures.push("mean-region-j");
  if (facts.minimumRegionJ < .82) failures.push("minimum-region-j");
  if (facts.uniqueAlphaFrames < 8) failures.push("dynamic-alpha");
  if (facts.normalizedCentroidTravel < .1) failures.push("motion-following");
  if (!facts.cacheReplay) failures.push("cache-replay");
  if (!facts.formalOutputHasVideo || !facts.formalOutputHasAudio) failures.push("formal-output");
  if (facts.formalBackgroundSuppression < .82) failures.push("background-suppression");
  if (facts.formalSubjectRetention < .72) failures.push("subject-retention");
  if (!facts.formalMatteVerified) failures.push("formal-matte-integrity");
  if (!facts.staleMatteRejected) failures.push("stale-matte-rejection");
  if (!facts.researchReceiptAbsent) failures.push("research-receipt");
  return failures;
}

const valid: Facts = {
  engine: PRODUCT_AUTO_ROTO_ENGINE,
  routeSchema: "editkin.auto-roto-product-route-receipt/v2",
  routeProductOnly: true,
  frameCount,
  meanRegionJ: .95,
  minimumRegionJ: .9,
  uniqueAlphaFrames: 12,
  normalizedCentroidTravel: .15,
  cacheReplay: true,
  formalOutputHasVideo: true,
  formalOutputHasAudio: true,
  formalBackgroundSuppression: .95,
  formalSubjectRetention: .9,
  formalMatteVerified: true,
  staleMatteRejected: true,
  researchReceiptAbsent: true,
};

function evaluatorSelfTest(): number {
  if (evaluate(structuredClone(valid)).length) throw new Error("Dynamic-removal evaluator rejected valid control");
  const mutations: Array<[string, (facts: Facts) => void]> = [
    ["engine", (facts) => { facts.engine = "external"; }],
    ["route", (facts) => { facts.routeProductOnly = false; }],
    ["frame-count", (facts) => { facts.frameCount -= 1; }],
    ["mean-j", (facts) => { facts.meanRegionJ = .89; }],
    ["minimum-j", (facts) => { facts.minimumRegionJ = .81; }],
    ["dynamic", (facts) => { facts.uniqueAlphaFrames = 1; }],
    ["motion", (facts) => { facts.normalizedCentroidTravel = .01; }],
    ["cache", (facts) => { facts.cacheReplay = false; }],
    ["video", (facts) => { facts.formalOutputHasVideo = false; }],
    ["audio", (facts) => { facts.formalOutputHasAudio = false; }],
    ["background", (facts) => { facts.formalBackgroundSuppression = .8; }],
    ["subject", (facts) => { facts.formalSubjectRetention = .7; }],
    ["integrity", (facts) => { facts.formalMatteVerified = false; }],
    ["stale", (facts) => { facts.staleMatteRejected = false; }],
    ["research", (facts) => { facts.researchReceiptAbsent = false; }],
  ];
  for (const [name, mutate] of mutations) {
    const facts = structuredClone(valid);
    mutate(facts);
    if (!evaluate(facts).length) throw new Error(`Dynamic-removal evaluator accepted mutation: ${name}`);
  }
  return mutations.length;
}

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  return sha256(await readFile(path));
}

async function run(executable: string, args: string[], timeoutMs = 180_000): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(executable, args, { cwd: appRoot, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timeout = setTimeout(() => { child.kill(); rejectRun(new Error(`${executable} timed out`)); }, timeoutMs);
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8_000); });
    child.once("error", (error) => { clearTimeout(timeout); rejectRun(error); });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      code === 0 ? resolveRun() : rejectRun(new Error(`${executable} exit ${code}: ${stderr}`));
    });
  });
}

function subjectLeft(frame: number): number {
  return 18 + Math.round(frame * 24 / (frameCount - 1));
}

async function materializeFixture(): Promise<{ sourcePath: string; truthPath: string }> {
  await mkdir(fixtureRoot, { recursive: true });
  const rgb = Buffer.alloc(width * height * frameCount * 3);
  const truth = Buffer.alloc(width * height * frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const left = subjectLeft(frame);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const subject = x >= left && x < left + 42 && y >= 22 && y < 69;
        const index = frame * width * height + y * width + x;
        const rgbIndex = index * 3;
        if (subject) {
          rgb[rgbIndex] = 235;
          rgb[rgbIndex + 1] = 36 + ((x + y) % 7);
          rgb[rgbIndex + 2] = 28;
          truth[index] = 255;
        } else {
          rgb[rgbIndex] = 22 + (x % 11);
          rgb[rgbIndex + 1] = 92 + (y % 13);
          rgb[rgbIndex + 2] = 214 - (x % 17);
        }
      }
    }
  }
  const rawPath = join(fixtureRoot, "moving-subject.rgb24");
  const truthPath = join(fixtureRoot, "truth-alpha8.bin");
  const sourcePath = join(fixtureRoot, "moving-subject.mp4");
  await Promise.all([writeFile(rawPath, rgb), writeFile(truthPath, truth)]);
  await run(ffmpegPath, [
    "-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pixel_format", "rgb24",
    "-video_size", `${width}x${height}`, "-framerate", String(fps), "-i", rawPath,
    "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "8", "-pix_fmt", "yuv444p", sourcePath,
  ]);
  return { sourcePath, truthPath };
}

function regionJ(alpha: Buffer, truth: Buffer, frame: number): number {
  const offset = frame * width * height;
  let intersection = 0;
  let union = 0;
  for (let index = 0; index < width * height; index += 1) {
    const predicted = alpha[offset + index] >= 128;
    const expected = truth[offset + index] >= 128;
    if (predicted && expected) intersection += 1;
    if (predicted || expected) union += 1;
  }
  return union === 0 ? 1 : intersection / union;
}

function centroidX(alpha: Buffer, frame: number): number {
  const offset = frame * width * height;
  let sum = 0;
  let count = 0;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    if (alpha[offset + y * width + x] >= 128) { sum += x; count += 1; }
  }
  return count ? sum / count : 0;
}

async function decodeFrame(video: string, time: number, output: string): Promise<Buffer> {
  await run(ffmpegPath, ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(time), "-i", video, "-frames:v", "1", "-vf", `scale=${width}:${height},format=rgb24`, "-f", "rawvideo", output]);
  return readFile(output);
}

function pixel(frame: Buffer, x: number, y: number): [number, number, number] {
  const offset = (y * width + x) * 3;
  return [frame[offset], frame[offset + 1], frame[offset + 2]];
}

async function main(): Promise<void> {
  const mutationCount = evaluatorSelfTest();
  if (process.argv.includes("--self-test")) {
    process.stdout.write(`${JSON.stringify({ status: "GREEN", mutationCount })}\n`);
    return;
  }
  await rm(reportRoot, { recursive: true, force: true });
  const { sourcePath, truthPath } = await materializeFixture();
  const sourceSha256 = await sha256File(sourcePath);
  const request = {
    sourcePath, sourceStart: 0, duration, fps, sourceWidth: width, sourceHeight: height, initialTime: 0,
    initialRect: { x: 18 / width, y: 22 / height, width: 42 / width, height: 47 / height },
    sourceSha256, temporalStability: .2, feather: .01, edgeShift: 0, contrast: 1.7,
  };
  const runtime = { ffmpegPath, nativeCorePath, cacheRoot };
  const first = await analyzeProductAutoRoto(request, runtime);
  const replay = await analyzeProductAutoRoto(request, runtime);
  const [alpha, truth] = await Promise.all([readFile(first.sequencePath), readFile(truthPath)]);
  const frameJ = Array.from({ length: frameCount }, (_, frame) => regionJ(alpha, truth, frame));
  const alphaHashes = Array.from({ length: frameCount }, (_, frame) => sha256(alpha.subarray(frame * width * height, (frame + 1) * width * height)));
  const matte: RotoMatteSequence = {
    schema: "editkin.auto-roto-matte/v1",
    engine: PRODUCT_AUTO_ROTO_ENGINE,
    width: first.width,
    height: first.height,
    analysisFps: first.analysisFps,
    frameCount: first.frames.length,
    sequenceUri: first.sequencePath,
    sequenceSha256: first.sequenceSha256,
    sequenceBytes: first.sequenceBytes,
    manifestUri: first.manifestPath,
    frameArtifactUris: first.frames.map((frame) => frame.alphaPath),
    meanBoundaryChatter: first.meanBoundaryChatter,
    correctionStrokesApplied: first.correctionStrokesApplied,
    correctedFrames: first.correctedFrames,
    alphaRefinement: first.alphaRefinement,
    regionMemoryRouting: {
      schema: "editkin.region-memory-routing/v1", requested: "fixed_baseline", executed: "fixed_baseline",
      candidateAttempted: false, deterministicFallback: false,
    },
    routeReceipt: first.routeReceipt,
    frozen: true as const,
    qualityState: "diagnostic",
  };
  const formalMatteVerified = await verifyFrozenRotoMatte(matte, first.sequencePath, first.manifestPath, cacheRoot)
    .then(() => true, () => false);
  const staleMatteRejected = await verifyFrozenRotoMatte({ ...matte, stale: true }, first.sequencePath, first.manifestPath, cacheRoot)
    .then(() => false, () => true);

  const project = createEmptyProject("Dynamic background removal product E2E", { id: "dynamic-removal-product-e2e", width, height, fps });
  project.assets.push({ id: "source", name: "Moving subject", kind: "video", uri: sourcePath, duration, width, height, role: "primary-source", provenance: "editkin-owned-synthetic-fixture", redistributable: false });
  const clip: TimelineClip = {
    id: "subject", assetId: "source", trackId: project.tracks[0].id, timelineStart: 0, sourceStart: 0,
    duration, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
    layer: { ...DEFAULT_CLIP_LAYER }, expressions: {},
  };
  const mask = createClipMask("dynamic-subject", "subject");
  mask.matteSequence = matte;
  clip.masks = [mask];
  project.tracks[0].clips.push(clip);
  const outputPath = join(reportRoot, "formal-background-removed.mp4");
  await renderProject(project, outputPath, { ffmpegPath, ffprobePath, nativeCorePath, autoRotoCacheRoot: cacheRoot, preferGpu: false, timeoutMs: 180_000 });
  const outputProbe = await probeMedia(outputPath, ffprobePath);
  const sampledFrame = 12;
  const decodedPath = join(reportRoot, "formal-sample.rgb24");
  const decoded = await decodeFrame(outputPath, sampledFrame / fps, decodedPath);
  const background = pixel(decoded, 5, 5);
  const subject = pixel(decoded, subjectLeft(sampledFrame) + 20, 44);
  const backgroundReference = 22 + 92 + 214;
  const facts: Facts = {
    engine: first.engine,
    routeSchema: first.routeReceipt.schema,
    routeProductOnly: first.routeReceipt.mode === "product"
      && first.routeReceipt.boundary.externalResearchRuntime === "disabled"
      && first.routeReceipt.boundary.externalModelWeights === false,
    frameCount: first.frames.length,
    meanRegionJ: frameJ.reduce((sum, value) => sum + value, 0) / frameJ.length,
    minimumRegionJ: Math.min(...frameJ),
    uniqueAlphaFrames: new Set(alphaHashes).size,
    normalizedCentroidTravel: Math.abs(centroidX(alpha, frameCount - 1) - centroidX(alpha, 0)) / width,
    cacheReplay: replay.cacheHit && replay.sequenceSha256 === first.sequenceSha256 && replay.manifestPath === first.manifestPath,
    formalOutputHasVideo: outputProbe.hasVideo,
    formalOutputHasAudio: outputProbe.hasAudio,
    formalBackgroundSuppression: 1 - background.reduce((sum, value) => sum + value, 0) / backgroundReference,
    formalSubjectRetention: subject[0] / 235,
    formalMatteVerified,
    staleMatteRejected,
    researchReceiptAbsent: !/(?:onnx|sam2Model|sam21|external[_-]model)/i.test(JSON.stringify(first)),
  };
  const failures = evaluate(facts);
  const evidenceFiles = [sourcePath, truthPath, first.sequencePath, first.manifestPath, outputPath, fileURLToPath(import.meta.url)];
  const report = {
    schema: "editkin.dynamic-background-removal-product-e2e-gate/v1",
    generatedAt: new Date().toISOString(),
    status: failures.length ? "BLOCK" : "GREEN_BOUNDED_SYNTHETIC_PRODUCT_E2E",
    facts,
    failures,
    frameJ,
    evaluator: { mutationCount, allRejected: true },
    evidence: await Promise.all(evidenceFiles.map(async (path) => ({ path: relative(appRoot, path).replaceAll("\\", "/"), bytes: (await readFile(path)).length, sha256: await sha256File(path) }))),
    claimBoundary: [
      "This proves one retained synthetic moving-subject product journey: native analysis, dynamic matte, cache replay, formal compositing and stale rejection.",
      "It does not prove real hair, transparency, occlusion, long-form memory, macOS parity, installer delivery or superiority over SAM.",
    ],
  };
  await writeFile(join(reportRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ status: report.status, facts, failures, report: relative(appRoot, join(reportRoot, "report.json")).replaceAll("\\", "/") })}\n`);
  if (failures.length) process.exitCode = 1;
}

await main();
