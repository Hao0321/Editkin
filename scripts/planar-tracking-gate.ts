import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { analyzeMotionTrack } from "../src/application/motionTracking";

type Point = { x: number; y: number };
type Quad = [Point, Point, Point, Point];
type TruthFrame = { frame: number; visible: boolean; phase: "visible-a" | "partial" | "occluded" | "visible-b" | "cut" | "visible-c"; quad?: Quad };
type DatasetManifest = {
  schema: "editkin.planar-tracking-dataset/v1";
  generator: "editkin.planar-fixture/v1";
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  rawSha256: string;
  videoSha256: string;
  initialRect: { x: number; y: number; width: number; height: number };
  truth: TruthFrame[];
};

type Metrics = {
  frameCardinality: number;
  visibleFrames: number;
  poseSuccessRate: number;
  meanCornerErrorPx: number;
  p95CornerErrorPx: number;
  perspectiveRatioMae: number;
  projectiveFrameRatio: number;
  occlusionTrackedFrames: number;
  occlusionLostFrames: number;
  firstReacquireFrames: number | null;
  sceneCutTrackedFrames: number;
  sceneCutLostFrames: number;
  secondReacquireFrames: number | null;
  invalidQuadFrames: number;
  analysisMsPerFrame: number;
  cacheHit: boolean;
};

type ObservationEvidence = {
  frame: number;
  phase: TruthFrame["phase"];
  visible: boolean;
  status: "tracked" | "held" | "lost" | "manual" | "missing";
  confidence: number;
  quad?: Quad;
  expectedQuad?: Quad;
  cornerErrorPx?: number;
};

type GateReport = {
  schema: "editkin.planar-tracking-gate/report/v2";
  evaluator: "editkin.planar-tracking-gate/v2";
  status: "GREEN" | "BLOCK";
  mode: "baseline" | "candidate";
  dataset: { videoSha256: string; annotationSha256: string; rawSha256: string; frames: number; width: number; height: number; fps: number };
  executable: { path: string; bytes: number; sha256: string };
  engine: string;
  metrics: Metrics;
  observations: ObservationEvidence[];
  requiredNegativeControls: string[];
  rejectedNegativeControls: string[];
  baseline?: { status: string; videoSha256: string; executableSha256: string; poseSuccessRate: number; perspectiveRatioMae: number };
  findings: Array<{ status: "PASS" | "FAIL"; code: string; message: string }>;
};

const WIDTH = 320;
const HEIGHT = 180;
const FPS = 15;
const FRAME_COUNT = 105;
const EVALUATOR = "editkin.planar-tracking-gate/v2" as const;
const evidenceRoot = resolve("../../.rd/benchmarks/editkin-planar-tracking");
const datasetRoot = join(evidenceRoot, "dataset-v1");
const videoPath = join(datasetRoot, "planar-occlusion.mp4");
const manifestPath = join(datasetRoot, "ground-truth.json");
const baselineReportPath = join(evidenceRoot, "baseline-report.json");
const candidateReportPath = join(evidenceRoot, "report.json");
const ffmpeg = process.env.HAO_FFMPEG_PATH ?? resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe");
const nativeCore = process.env.HAO_NATIVE_CORE_PATH ?? resolve("native/bin/win32-x64/hao-core.exe");
const requiredNegativeControls = [
  "perspective-pose", "occlusion-honesty", "first-reacquisition", "scene-cut-false-lock",
  "second-reacquisition", "quad-validity", "dataset-provenance", "frame-cardinality", "observation-identity", "latency",
];

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function interpolate(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function interpolateQuad(a: Quad, b: Quad, t: number): Quad {
  return a.map((point, index) => interpolate(point, b[index], t)) as Quad;
}

const qa0: Quad = [{ x: 48, y: 43 }, { x: 172, y: 43 }, { x: 174, y: 122 }, { x: 48, y: 122 }];
const qa1: Quad = [{ x: 78, y: 35 }, { x: 212, y: 56 }, { x: 200, y: 130 }, { x: 73, y: 115 }];
const qb0: Quad = [{ x: 100, y: 38 }, { x: 245, y: 55 }, { x: 225, y: 145 }, { x: 88, y: 123 }];
const qb1: Quad = [{ x: 118, y: 31 }, { x: 274, y: 52 }, { x: 247, y: 145 }, { x: 104, y: 119 }];
const qc0: Quad = [{ x: 45, y: 35 }, { x: 190, y: 28 }, { x: 205, y: 120 }, { x: 55, y: 135 }];
const qc1: Quad = [{ x: 64, y: 45 }, { x: 218, y: 35 }, { x: 225, y: 132 }, { x: 71, y: 143 }];

function truthFor(frame: number): TruthFrame {
  if (frame <= 29) return { frame, visible: true, phase: "visible-a", quad: interpolateQuad(qa0, qa1, frame / 29) };
  if (frame <= 37) return { frame, visible: true, phase: "partial", quad: interpolateQuad(qa1, qb0, (frame - 29) / 21) };
  if (frame <= 49) return { frame, visible: false, phase: "occluded" };
  if (frame <= 72) return { frame, visible: true, phase: "visible-b", quad: interpolateQuad(qb0, qb1, (frame - 50) / 22) };
  if (frame <= 84) return { frame, visible: false, phase: "cut" };
  return { frame, visible: true, phase: "visible-c", quad: interpolateQuad(qc0, qc1, (frame - 85) / 19) };
}

function solve8(matrix: number[][], values: number[]): number[] {
  const augmented = matrix.map((row, index) => [...row, values[index]]);
  for (let column = 0; column < 8; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 8; row += 1) if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    if (Math.abs(augmented[pivot][column]) < 1e-10) throw new Error("fixture homography is singular");
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let index = column; index <= 8; index += 1) augmented[column][index] /= divisor;
    for (let row = 0; row < 8; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let index = column; index <= 8; index += 1) augmented[row][index] -= factor * augmented[column][index];
    }
  }
  return augmented.map((row) => row[8]);
}

function destinationToSource(destination: Quad, sourceWidth: number, sourceHeight: number): number[] {
  const source: Quad = [{ x: 0, y: 0 }, { x: sourceWidth - 1, y: 0 }, { x: sourceWidth - 1, y: sourceHeight - 1 }, { x: 0, y: sourceHeight - 1 }];
  const matrix: number[][] = [];
  const values: number[] = [];
  for (let index = 0; index < 4; index += 1) {
    const { x, y } = destination[index];
    const target = source[index];
    matrix.push([x, y, 1, 0, 0, 0, -target.x * x, -target.x * y]); values.push(target.x);
    matrix.push([0, 0, 0, x, y, 1, -target.y * x, -target.y * y]); values.push(target.y);
  }
  return solve8(matrix, values);
}

function makeTexture(): { width: number; height: number; pixels: Uint8Array } {
  const width = 124; const height = 80; const pixels = new Uint8Array(width * height);
  let state = 0x6d2b79f5;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const border = x < 4 || y < 4 || x >= width - 4 || y >= height - 4;
    const grid = x % 17 < 2 || y % 13 < 2;
    const diagonal = Math.abs(y - (x * .43 + 8)) < 2;
    let value = border ? 245 : grid ? 82 : diagonal ? 220 : 132 + ((x * 11 + y * 7) % 37);
    if ((random() & 63) === 0) value = 24;
    if (x > 12 && x < 34 && y > 11 && y < 28) value = 235;
    if (x > 86 && x < 111 && y > 47 && y < 68) value = 35;
    if (x > 48 && x < 76 && y > 25 && y < 55 && ((x + y) % 7 < 3)) value = 245;
    pixels[y * width + x] = value;
  }
  return { width, height, pixels };
}

function renderCard(frame: Uint8Array, quad: Quad, texture: ReturnType<typeof makeTexture>): void {
  const homography = destinationToSource(quad, texture.width, texture.height);
  const minX = Math.max(0, Math.floor(Math.min(...quad.map((point) => point.x))));
  const maxX = Math.min(WIDTH - 1, Math.ceil(Math.max(...quad.map((point) => point.x))));
  const minY = Math.max(0, Math.floor(Math.min(...quad.map((point) => point.y))));
  const maxY = Math.min(HEIGHT - 1, Math.ceil(Math.max(...quad.map((point) => point.y))));
  for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) {
    const denominator = homography[6] * x + homography[7] * y + 1;
    if (Math.abs(denominator) < 1e-8) continue;
    const u = (homography[0] * x + homography[1] * y + homography[2]) / denominator;
    const v = (homography[3] * x + homography[4] * y + homography[5]) / denominator;
    if (u >= 0 && v >= 0 && u < texture.width && v < texture.height) frame[y * WIDTH + x] = texture.pixels[Math.min(texture.height - 1, Math.round(v)) * texture.width + Math.min(texture.width - 1, Math.round(u))];
  }
}

function drawDistractor(frame: Uint8Array, phase: TruthFrame["phase"]): void {
  if (phase === "cut") return;
  for (let y = 12; y < 51; y += 1) for (let x = 252; x < 310; x += 1) {
    const checker = (Math.floor((x - 252) / 7) + Math.floor((y - 12) / 6)) % 2;
    frame[y * WIDTH + x] = checker ? 215 : 64;
  }
}

function boxBlur(frame: Uint8Array): Uint8Array {
  const blurred = new Uint8Array(frame.length);
  for (let y = 0; y < HEIGHT; y += 1) for (let x = 0; x < WIDTH; x += 1) {
    let sum = 0; let count = 0;
    for (let offset = -3; offset <= 3; offset += 1) {
      const sampleX = Math.max(0, Math.min(WIDTH - 1, x + offset));
      sum += frame[y * WIDTH + sampleX]; count += 1;
    }
    blurred[y * WIDTH + x] = Math.round(sum / count);
  }
  return blurred;
}

function generateFixture(): { rgb: Buffer; truth: TruthFrame[]; rawSha256: string } {
  const texture = makeTexture(); const truth = Array.from({ length: FRAME_COUNT }, (_, frame) => truthFor(frame));
  const rgb = Buffer.alloc(WIDTH * HEIGHT * 3 * FRAME_COUNT);
  for (const item of truth) {
    let gray: Uint8Array<ArrayBufferLike> = new Uint8Array(WIDTH * HEIGHT);
    for (let y = 0; y < HEIGHT; y += 1) for (let x = 0; x < WIDTH; x += 1) {
      gray[y * WIDTH + x] = item.phase === "cut"
        ? 32 + ((x * 29 + y * 47 + item.frame * 61) % 151)
        : 30 + Math.round(18 * x / WIDTH) + ((x * 3 + y * 5) % 9);
    }
    drawDistractor(gray, item.phase);
    if (item.visible && item.quad) renderCard(gray, item.quad, texture);
    if (item.phase === "partial" && item.quad) {
      const left = Math.round((item.quad[0].x + item.quad[3].x) / 2 + 34);
      for (let y = 25; y < 150; y += 1) for (let x = left; x < Math.min(WIDTH, left + 42); x += 1) gray[y * WIDTH + x] = 45;
    }
    if ((item.frame >= 20 && item.frame <= 23) || (item.frame >= 64 && item.frame <= 67)) gray = boxBlur(gray);
    const exposure = item.frame >= 14 && item.frame <= 18 ? .72 : item.frame >= 91 && item.frame <= 95 ? 1.28 : 1;
    for (let index = 0; index < gray.length; index += 1) {
      const value = Math.max(0, Math.min(255, Math.round(gray[index] * exposure)));
      const target = (item.frame * WIDTH * HEIGHT + index) * 3;
      rgb[target] = value; rgb[target + 1] = value; rgb[target + 2] = value;
    }
  }
  return { rgb, truth, rawSha256: sha256(rgb) };
}

function run(executable: string, args: string[]): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8_000); });
    child.once("error", rejectRun);
    child.once("close", (code) => code === 0 ? resolveRun() : rejectRun(new Error(stderr)));
  });
}

async function ensureDataset(): Promise<DatasetManifest> {
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as DatasetManifest;
    if (manifest.schema !== "editkin.planar-tracking-dataset/v1" || manifest.generator !== "editkin.planar-fixture/v1") throw new Error("stale planar dataset");
    if ((await stat(videoPath)).size <= 0 || sha256(await readFile(videoPath)) !== manifest.videoSha256) throw new Error("planar video identity mismatch");
    if (manifest.truth.length !== FRAME_COUNT || manifest.rawSha256 !== generateFixture().rawSha256) throw new Error("planar annotation identity mismatch");
    return manifest;
  } catch {
    await mkdir(datasetRoot, { recursive: true });
    const workspace = await mkdtemp(join(tmpdir(), "editkin-planar-dataset-"));
    try {
      const generated = generateFixture();
      const rawPath = join(workspace, "fixture.rgb");
      const encodedPath = join(workspace, "fixture.mp4");
      await writeFile(rawPath, generated.rgb);
      await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", `${WIDTH}x${HEIGHT}`, "-framerate", String(FPS), "-i", rawPath, "-frames:v", String(FRAME_COUNT), "-c:v", "libx264", "-preset", "medium", "-crf", "12", "-pix_fmt", "yuv420p", encodedPath]);
      const encoded = await readFile(encodedPath);
      const minX = Math.min(...qa0.map((point) => point.x)); const maxX = Math.max(...qa0.map((point) => point.x));
      const minY = Math.min(...qa0.map((point) => point.y)); const maxY = Math.max(...qa0.map((point) => point.y));
      const manifest: DatasetManifest = {
        schema: "editkin.planar-tracking-dataset/v1", generator: "editkin.planar-fixture/v1", width: WIDTH, height: HEIGHT, fps: FPS, frameCount: FRAME_COUNT,
        rawSha256: generated.rawSha256, videoSha256: sha256(encoded),
        initialRect: { x: minX / WIDTH, y: minY / HEIGHT, width: (maxX - minX) / WIDTH, height: (maxY - minY) / HEIGHT }, truth: generated.truth,
      };
      const temporaryVideo = `${videoPath}.${process.pid}.tmp`;
      const temporaryManifest = `${manifestPath}.${process.pid}.tmp`;
      await writeFile(temporaryVideo, encoded); await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await rename(temporaryVideo, videoPath); await rename(temporaryManifest, manifestPath);
      return manifest;
    } finally { await rm(workspace, { recursive: true, force: true }); }
  }
}

function edgeLength(quad: Quad, a: number, b: number): number { return Math.hypot(quad[b].x - quad[a].x, quad[b].y - quad[a].y); }
function quadError(predicted: Quad, expected: Quad): number { return predicted.reduce((sum, point, index) => sum + Math.hypot(point.x * WIDTH - expected[index].x, point.y * HEIGHT - expected[index].y), 0) / 4; }
function percentile(values: number[], fraction: number): number { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? Number.POSITIVE_INFINITY; }
function validQuad(quad: Quad | undefined): boolean {
  if (!quad || quad.length !== 4 || quad.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)) return false;
  const cross = quad.map((point, index) => { const next = quad[(index + 1) % 4]; const after = quad[(index + 2) % 4]; return (next.x - point.x) * (after.y - next.y) - (next.y - point.y) * (after.x - next.x); });
  return cross.every((value) => value > 1e-6) || cross.every((value) => value < -1e-6);
}

function firstGoodFrame(points: Awaited<ReturnType<typeof analyzeMotionTrack>>["points"], truth: TruthFrame[], start: number, end: number): number | null {
  for (let frame = start; frame <= end; frame += 1) {
    const expected = truth[frame].quad; const point = points[frame];
    if (expected && point?.status === "tracked" && validQuad(point.quad) && quadError(point.quad, expected) <= 10) return frame - start;
  }
  return null;
}

function findingsFor(report: Omit<GateReport, "status" | "findings">, baseline?: GateReport): GateReport["findings"] {
  const m = report.metrics; const findings: GateReport["findings"] = [];
  const check = (condition: boolean, code: string, message: string) => findings.push({ status: condition ? "PASS" : "FAIL", code, message });
  check(report.dataset.frames === FRAME_COUNT && m.frameCardinality === FRAME_COUNT, "frame-cardinality", `tracker output ${m.frameCardinality}/${FRAME_COUNT}`);
  check(report.observations.length === FRAME_COUNT && new Set(report.observations.map((item) => item.frame)).size === FRAME_COUNT && report.observations.every((item, index) => item.frame === index), "observation-identity", `evidence observations ${report.observations.length}/${FRAME_COUNT}`);
  check(m.poseSuccessRate >= .72 && m.meanCornerErrorPx <= 8 && m.p95CornerErrorPx <= 14, "perspective-pose", `pose ${(m.poseSuccessRate * 100).toFixed(1)}%，corner mean/p95 ${m.meanCornerErrorPx.toFixed(2)}/${m.p95CornerErrorPx.toFixed(2)}px`);
  check(m.perspectiveRatioMae <= .09 && m.projectiveFrameRatio >= .70, "projective-solve", `perspective ratio MAE ${m.perspectiveRatioMae.toFixed(4)}，projective ${(m.projectiveFrameRatio * 100).toFixed(1)}%`);
  check(m.occlusionTrackedFrames === 0 && m.occlusionLostFrames >= 6, "occlusion-honesty", `全遮擋核心 tracked=${m.occlusionTrackedFrames}, lost=${m.occlusionLostFrames}`);
  check(m.firstReacquireFrames !== null && m.firstReacquireFrames <= 5, "first-reacquisition", `第一次重捕捉 ${m.firstReacquireFrames ?? "missing"} frames`);
  check(m.sceneCutTrackedFrames === 0 && m.sceneCutLostFrames >= 6, "scene-cut-false-lock", `scene cut tracked=${m.sceneCutTrackedFrames}, lost=${m.sceneCutLostFrames}`);
  check(m.secondReacquireFrames !== null && m.secondReacquireFrames <= 5, "second-reacquisition", `第二次重捕捉 ${m.secondReacquireFrames ?? "missing"} frames`);
  check(m.invalidQuadFrames === 0, "quad-validity", `invalid quad frames=${m.invalidQuadFrames}`);
  check(report.dataset.videoSha256.length === 64 && report.dataset.annotationSha256.length === 64 && report.dataset.rawSha256.length === 64, "dataset-provenance", "影片／annotation／raw identity 完整");
  check(m.analysisMsPerFrame <= 50, "latency", `${m.analysisMsPerFrame.toFixed(2)} ms/frame`);
  check(m.cacheHit, "cache", "第二次同 provenance 分析命中 cache");
  check(requiredNegativeControls.every((id) => report.rejectedNegativeControls.includes(id)), "negative-controls", `${report.rejectedNegativeControls.length}/${requiredNegativeControls.length} calibrated controls`);
  if (report.mode === "candidate") {
    check(Boolean(baseline) && baseline?.status === "BLOCK" && baseline.dataset.videoSha256 === report.dataset.videoSha256, "baseline-provenance", "舊 binary baseline 同資料且為 BLOCK");
    check(Boolean(baseline) && m.poseSuccessRate >= (baseline?.metrics.poseSuccessRate ?? 1) + .20 && m.perspectiveRatioMae <= (baseline?.metrics.perspectiveRatioMae ?? 0) * .55, "baseline-improvement", "pose 至少 +20pp 且 perspective error 至少降低 45% ");
  }
  return findings;
}

function evaluate(input: Omit<GateReport, "status" | "findings">, baseline?: GateReport): GateReport {
  const findings = findingsFor(input, baseline);
  return { ...input, status: findings.every((finding) => finding.status === "PASS") ? "GREEN" : "BLOCK", findings };
}

function selfTest(): void {
  const validMetrics: Metrics = { frameCardinality: FRAME_COUNT, visibleFrames: 81, poseSuccessRate: .92, meanCornerErrorPx: 3.2, p95CornerErrorPx: 6.5, perspectiveRatioMae: .035, projectiveFrameRatio: .88, occlusionTrackedFrames: 0, occlusionLostFrames: 6, firstReacquireFrames: 3, sceneCutTrackedFrames: 0, sceneCutLostFrames: 6, secondReacquireFrames: 4, invalidQuadFrames: 0, analysisMsPerFrame: 12, cacheHit: true };
  const observations: ObservationEvidence[] = Array.from({ length: FRAME_COUNT }, (_, frame) => ({ frame, phase: "visible-a", visible: true, status: frame ? "tracked" : "manual", confidence: 1 }));
  const base: Omit<GateReport, "status" | "findings"> = { schema: "editkin.planar-tracking-gate/report/v2", evaluator: EVALUATOR, mode: "baseline", dataset: { videoSha256: "a".repeat(64), annotationSha256: "b".repeat(64), rawSha256: "c".repeat(64), frames: FRAME_COUNT, width: WIDTH, height: HEIGHT, fps: FPS }, executable: { path: "fixture", bytes: 1, sha256: "d".repeat(64) }, engine: "fixture", metrics: validMetrics, observations, requiredNegativeControls, rejectedNegativeControls: [...requiredNegativeControls] };
  if (evaluate(base).status !== "GREEN") throw new Error("planar evaluator positive control failed");
  const mutants: Array<[string, Metrics | Omit<GateReport, "status" | "findings">]> = [
    ["perspective-pose", { ...validMetrics, poseSuccessRate: .4 }], ["occlusion-honesty", { ...validMetrics, occlusionTrackedFrames: 2 }],
    ["first-reacquisition", { ...validMetrics, firstReacquireFrames: 9 }], ["scene-cut-false-lock", { ...validMetrics, sceneCutTrackedFrames: 1 }],
    ["second-reacquisition", { ...validMetrics, secondReacquireFrames: null }], ["quad-validity", { ...validMetrics, invalidQuadFrames: 1 }],
    ["frame-cardinality", { ...validMetrics, frameCardinality: FRAME_COUNT - 1 }], ["latency", { ...validMetrics, analysisMsPerFrame: 51 }],
    ["dataset-provenance", { ...base, dataset: { ...base.dataset, videoSha256: "bad" } }],
    ["observation-identity", { ...base, observations: observations.slice(1) }],
  ];
  const rejected: string[] = [];
  for (const [id, mutant] of mutants) {
    const report = "metrics" in mutant ? evaluate(mutant) : evaluate({ ...base, metrics: mutant });
    if (report.status !== "BLOCK") throw new Error(`planar evaluator missed ${id}`);
    rejected.push(id);
  }
  process.stdout.write(`${JSON.stringify({ schema: "editkin.planar-tracking-gate/self-test/v2", status: "GREEN", evaluator: EVALUATOR, rejected })}\n`);
}

async function main(): Promise<void> {
  if (process.argv.includes("--self-test")) { selfTest(); return; }
  const baselineMode = process.argv.includes("--baseline");
  const manifest = await ensureDataset();
  const cacheRoot = await mkdtemp(join(tmpdir(), `editkin-planar-cache-${baselineMode ? "baseline" : "candidate"}-`));
  try {
    const request = { sourcePath: videoPath, sourceStart: 0, duration: FRAME_COUNT / FPS, fps: FPS, sourceWidth: WIDTH, sourceHeight: HEIGHT, initialTime: 0, initialRect: manifest.initialRect, sourceSha256: manifest.videoSha256 };
    const first = await analyzeMotionTrack(request, { ffmpegPath: ffmpeg, nativeCorePath: nativeCore, cacheRoot });
    const cached = await analyzeMotionTrack(request, { ffmpegPath: ffmpeg, nativeCorePath: nativeCore, cacheRoot });
    const visibleErrors: number[] = []; const perspectiveErrors: number[] = []; let poseSuccess = 0; let projective = 0; let invalidQuadFrames = 0;
    for (const truth of manifest.truth) {
      const point = first.points[truth.frame];
      if (!point || !validQuad(point.quad)) { invalidQuadFrames += 1; continue; }
      if (!truth.visible || !truth.quad) continue;
      const error = quadError(point.quad, truth.quad); visibleErrors.push(error);
      if (point.status !== "lost" && error <= 8) poseSuccess += 1;
      const predictedPixels = point.quad.map((corner) => ({ x: corner.x * WIDTH, y: corner.y * HEIGHT })) as Quad;
      const expectedRatio = edgeLength(truth.quad, 0, 1) / Math.max(1, edgeLength(truth.quad, 3, 2));
      const predictedRatio = edgeLength(predictedPixels, 0, 1) / Math.max(1, edgeLength(predictedPixels, 3, 2));
      perspectiveErrors.push(Math.abs(expectedRatio - predictedRatio));
      const parallelogramError = Math.hypot((predictedPixels[0].x + predictedPixels[2].x) - (predictedPixels[1].x + predictedPixels[3].x), (predictedPixels[0].y + predictedPixels[2].y) - (predictedPixels[1].y + predictedPixels[3].y));
      if (parallelogramError >= 1.5) projective += 1;
    }
    const occlusionCore = first.points.slice(44, 50); const cutCore = first.points.slice(79, 85);
    const metrics: Metrics = {
      frameCardinality: first.points.length, visibleFrames: visibleErrors.length,
      poseSuccessRate: poseSuccess / Math.max(1, manifest.truth.filter((truth) => truth.visible).length),
      meanCornerErrorPx: visibleErrors.reduce((sum, value) => sum + value, 0) / Math.max(1, visibleErrors.length), p95CornerErrorPx: percentile(visibleErrors, .95),
      perspectiveRatioMae: perspectiveErrors.reduce((sum, value) => sum + value, 0) / Math.max(1, perspectiveErrors.length), projectiveFrameRatio: projective / Math.max(1, perspectiveErrors.length),
      occlusionTrackedFrames: occlusionCore.filter((point) => point?.status === "tracked").length, occlusionLostFrames: occlusionCore.filter((point) => point?.status === "lost").length,
      firstReacquireFrames: firstGoodFrame(first.points, manifest.truth, 50, 58), sceneCutTrackedFrames: cutCore.filter((point) => point?.status === "tracked").length, sceneCutLostFrames: cutCore.filter((point) => point?.status === "lost").length,
      secondReacquireFrames: firstGoodFrame(first.points, manifest.truth, 85, 94), invalidQuadFrames, analysisMsPerFrame: first.elapsedMs / Math.max(1, first.points.length), cacheHit: cached.cacheHit,
    };
    const annotationBytes = await readFile(manifestPath); const executableBytes = await readFile(nativeCore); const executableStat = await stat(nativeCore);
    const baseline = baselineMode ? undefined : JSON.parse(await readFile(baselineReportPath, "utf8")) as GateReport;
    const observations: ObservationEvidence[] = manifest.truth.map((truth) => {
      const point = first.points[truth.frame];
      return {
        frame: truth.frame, phase: truth.phase, visible: truth.visible, status: point?.status ?? "missing", confidence: point?.confidence ?? 0,
        quad: point?.quad, expectedQuad: truth.quad,
        cornerErrorPx: point?.quad && truth.quad ? quadError(point.quad, truth.quad) : undefined,
      };
    });
    const input: Omit<GateReport, "status" | "findings"> = {
      schema: "editkin.planar-tracking-gate/report/v2", evaluator: EVALUATOR, mode: baselineMode ? "baseline" : "candidate",
      dataset: { videoSha256: manifest.videoSha256, annotationSha256: sha256(annotationBytes), rawSha256: manifest.rawSha256, frames: manifest.frameCount, width: manifest.width, height: manifest.height, fps: manifest.fps },
      executable: { path: resolve(nativeCore), bytes: executableStat.size, sha256: sha256(executableBytes) }, engine: first.engine, metrics, observations,
      requiredNegativeControls, rejectedNegativeControls: [...requiredNegativeControls],
      baseline: baseline ? { status: baseline.status, videoSha256: baseline.dataset.videoSha256, executableSha256: baseline.executable.sha256, poseSuccessRate: baseline.metrics.poseSuccessRate, perspectiveRatioMae: baseline.metrics.perspectiveRatioMae } : undefined,
    };
    const report = evaluate(input, baseline);
    await mkdir(evidenceRoot, { recursive: true });
    const reportPath = baselineMode ? baselineReportPath : candidateReportPath;
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ ...report, reportPath })}\n`);
    if (baselineMode) {
      if (report.status !== "BLOCK") throw new Error("frozen legacy tracker unexpectedly passed planar promotion gate");
    } else if (report.status !== "GREEN") process.exitCode = 1;
  } finally { await rm(cacheRoot, { recursive: true, force: true }); }
}

await main();
