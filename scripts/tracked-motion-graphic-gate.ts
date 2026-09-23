import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { PNG } from "pngjs";
import { analyzeMotionTrack } from "../src/application/motionTracking";
import { createEmptyProject } from "../src/domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type MotionTrack } from "../src/domain/types";
import { createMotionGraphic } from "../src/motion/composition";
import { buildGpuEngineVideoPreviewGraph, type GpuEngineVideoPreviewGraph } from "../src/render/gpuCompositor";

const root = resolve(import.meta.dirname, "..");
const ffmpeg = resolve(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const nativeCore = resolve(root, "native/bin/win32-x64/hao-core.exe");
const compositorArgument = process.argv.indexOf("--compositor");
const compositor = compositorArgument >= 0 && process.argv[compositorArgument + 1]
  ? resolve(process.argv[compositorArgument + 1])
  : resolve(root, "native/bin/win32-x64/editkin-gpu-compositor.exe");
const fontRoot = resolve(root, "public/fonts");
const evidenceRoot = resolve(root, "../..", ".rd/benchmarks/editkin-tracked-motion-graphic");
const baseline = process.argv.includes("--baseline");
const selfTest = process.argv.includes("--self-test");
const reportPath = join(evidenceRoot, baseline ? "quad-composed-baseline-report.json" : "report.json");

interface GateReport {
  schema: "editkin.tracked-motion-graphic-gate/v6";
  status: "GREEN" | "BLOCK";
  productAdmissionSelected: boolean;
  trackerFrames: number;
  trackerLostRatio: number;
  trackerTranslationError: number;
  trackerRotationError: number;
  trackerScaleError: number;
  directExecution: boolean;
  trackingReceipt: boolean;
  trackingSampleCount: number;
  graphicTextureUploads: number;
  translationOracle: boolean;
  transformReceiptOracle: boolean;
  pixelMovementOracle: boolean;
  pixelRotationOracle: boolean;
  pixelScaleOracle: boolean;
  quadTransportOracle: boolean;
  quadReceiptOracle: boolean;
  pixelPerspectiveOracle: boolean;
  lostStateOracle: boolean;
  safeAreaOracle: boolean;
  presentedFrames: number;
  presentP95Ms: number;
  productPathCpuPixelCopies: number;
  rejectedNegativeControls: string[];
  releaseFences: { pendingFenceCount: number };
  [key: string]: unknown;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertGreen(report: GateReport): void {
  if (report.schema !== "editkin.tracked-motion-graphic-gate/v6" || report.status !== "GREEN") throw new Error("tracked motion graphic report is not GREEN");
  if (!report.productAdmissionSelected || !report.directExecution || !report.trackingReceipt || report.trackingSampleCount < 45 || report.graphicTextureUploads !== 1) throw new Error("tracked motion graphic transport or receipt is incomplete");
  if (!report.translationOracle || !report.transformReceiptOracle || !report.pixelMovementOracle || !report.pixelRotationOracle || !report.pixelScaleOracle || !report.quadTransportOracle || !report.quadReceiptOracle || !report.pixelPerspectiveOracle || !report.lostStateOracle || !report.safeAreaOracle) throw new Error("tracked motion graphic visual oracle failed");
  if (report.trackerFrames < 44 || report.trackerLostRatio > .25 || report.trackerTranslationError > .08 || report.trackerRotationError > 12 || report.trackerScaleError > .25) throw new Error("tracked motion graphic source tracker evidence failed");
  if (report.presentedFrames < 60 || report.presentP95Ms > 20 || report.productPathCpuPixelCopies !== 0 || report.rejectedNegativeControls.length !== 9 || report.releaseFences.pendingFenceCount !== 0) throw new Error("tracked motion graphic performance, negative-control, zero-copy, or release evidence failed");
}

function syntheticSelfTest(): void {
  const valid: GateReport = {
    schema: "editkin.tracked-motion-graphic-gate/v6", status: "GREEN", productAdmissionSelected: true,
    trackerFrames: 45, trackerLostRatio: 0, trackerTranslationError: .01, trackerRotationError: 8, trackerScaleError: .1, directExecution: true,
    trackingReceipt: true, trackingSampleCount: 90, graphicTextureUploads: 1, translationOracle: true,
    transformReceiptOracle: true, pixelMovementOracle: true, pixelRotationOracle: true, pixelScaleOracle: true,
    quadTransportOracle: true, quadReceiptOracle: true, pixelPerspectiveOracle: true,
    lostStateOracle: true, safeAreaOracle: true, presentedFrames: 60,
    presentP95Ms: 16, productPathCpuPixelCopies: 0, rejectedNegativeControls: ["empty", "order", "bounds", "status", "scale", "rotation", "quad-bounds", "quad-order", "quad-degenerate"],
    releaseFences: { pendingFenceCount: 0 },
  };
  assertGreen(valid);
  let calibratedNegatives = 0;
  for (const negative of [
    { ...valid, productAdmissionSelected: false },
    { ...valid, trackingReceipt: false },
    { ...valid, translationOracle: false },
    { ...valid, transformReceiptOracle: false },
    { ...valid, pixelRotationOracle: false },
    { ...valid, pixelScaleOracle: false },
    { ...valid, quadTransportOracle: false },
    { ...valid, quadReceiptOracle: false },
    { ...valid, pixelPerspectiveOracle: false },
    { ...valid, lostStateOracle: false },
    { ...valid, productPathCpuPixelCopies: 1 },
  ]) {
    try { assertGreen(negative); } catch { calibratedNegatives += 1; }
  }
  if (calibratedNegatives !== 11) throw new Error("tracked motion graphic evaluator accepted a calibrated negative");
  process.stdout.write(`${JSON.stringify({ status: "GREEN", evaluator: valid.schema, calibratedNegatives })}\n`);
}

function run(executable: string, args: string[]): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", rejectRun);
    child.once("close", (code) => code === 0 ? resolveRun() : rejectRun(new Error(stderr)));
  });
}

async function movingSubjectFixture(workspace: string): Promise<string> {
  const width = 320; const height = 180; const fps = 30; const frameCount = 90;
  const raw = Buffer.alloc(width * height * 3 * frameCount, 24);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const progress = frame / (frameCount - 1);
    const centerX = 90 + progress * 60;
    const centerY = 92 + Math.sin(progress * Math.PI) * 8;
    const scale = 1 + progress * .22;
    const angle = progress * 32 * Math.PI / 180;
    const cosine = Math.cos(angle); const sine = Math.sin(angle);
    const subjectWidth = 50 * scale; const subjectHeight = 36 * scale;
    for (let y = Math.max(0, Math.floor(centerY - 50)); y < Math.min(height, Math.ceil(centerY + 50)); y += 1) {
      for (let x = Math.max(0, Math.floor(centerX - 50)); x < Math.min(width, Math.ceil(centerX + 50)); x += 1) {
        const dx = x - centerX; const dy = y - centerY;
        const localX = dx * cosine + dy * sine; const localY = -dx * sine + dy * cosine;
        if (Math.abs(localX) > subjectWidth / 2 || Math.abs(localY) > subjectHeight / 2) continue;
        const checker = (Math.floor((localX + subjectWidth / 2) / 7) + Math.floor((localY + subjectHeight / 2) / 6)) % 2;
        const accent = localX < -subjectWidth * .18 && localY < 0;
        const value = accent ? [245, 72, 44] : checker ? [230, 226, 62] : [55, 184, 238];
        const offset = (frame * width * height + y * width + x) * 3;
        raw[offset] = value[0]; raw[offset + 1] = value[1]; raw[offset + 2] = value[2];
      }
    }
    if (frame >= 40 && frame <= 46) {
      for (let y = 70; y < 116; y += 1) for (let x = Math.round(centerX); x < Math.min(width, Math.round(centerX + 20)); x += 1) {
        const offset = (frame * width * height + y * width + x) * 3;
        raw[offset] = 24; raw[offset + 1] = 24; raw[offset + 2] = 24;
      }
    }
  }
  const rawPath = join(workspace, "moving-subject.rgb");
  const videoPath = join(workspace, "moving-subject.mp4");
  await writeFile(rawPath, raw);
  await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", `${width}x${height}`, "-framerate", String(fps), "-i", rawPath, "-c:v", "libx264", "-pix_fmt", "yuv420p", videoPath]);
  return videoPath;
}

async function trackedProject(workspace: string): Promise<{ project: EditProject; source: string; expectedX: number; actualX: number }> {
  const source = await movingSubjectFixture(workspace);
  const result = await analyzeMotionTrack({
    sourcePath: source, sourceStart: 0, duration: 3, fps: 30, sourceWidth: 320, sourceHeight: 180, initialTime: 0,
    initialRect: { x: 65 / 320, y: 74 / 180, width: 50 / 320, height: 36 / 180 },
  }, { ffmpegPath: ffmpeg, nativeCorePath: nativeCore, cacheRoot: join(workspace, "cache") });
  const project = createEmptyProject("追蹤結果驅動字卡", { id: "tracked-motion-graphic", width: 320, height: 180, fps: 30 });
  project.assets.push({ id: "video", name: "moving-subject", kind: "video", uri: source, duration: 3, width: 320, height: 180 });
  project.tracks[0].clips.push({ id: "clip", assetId: "video", trackId: project.tracks[0].id, timelineStart: 0, sourceStart: 0, duration: 3, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
  const points = result.points.map((point, index) => {
    const progress = index / Math.max(1, result.points.length - 1);
    const perspective = progress * .5;
    const base = point.quad!;
    const topCenter = { x: (base[0].x + base[1].x) / 2, y: (base[0].y + base[1].y) / 2 };
    return {
      ...point,
      quad: [
        { x: base[0].x + (topCenter.x - base[0].x) * perspective, y: base[0].y + (topCenter.y - base[0].y) * perspective },
        { x: base[1].x + (topCenter.x - base[1].x) * perspective * .75, y: base[1].y + (topCenter.y - base[1].y) * perspective * .75 },
        { ...base[2] },
        { ...base[3] },
      ] as NonNullable<typeof point.quad>,
    };
  });
  const track: MotionTrack = { id: "subject-track", clipId: "clip", name: "主體", engine: result.engine, analysisFps: result.analysisFps, initialRect: { x: 65 / 320, y: 74 / 180, width: 50 / 320, height: 36 / 180 }, points, lostRatio: result.lostRatio, createdAt: new Date().toISOString() };
  const graphic = createMotionGraphic("tracked-tag", "tag", "重點", 0, 3, track.id, { presetId: "gate-tracked-tag", x: .64, y: .2, width: .32, fontSize: 22, animation: "fade", offsetX: .015, offsetY: -.02, trackingMode: "surface", cornerRadius: 0, shadowDepth: 0, outlineWidth: 0 } as never);
  project.motionTracks.push(track); project.motionGraphics.push(graphic);
  const last = result.points.at(-1)!;
  const progress = Math.min(1, last.time / (89 / 30));
  return { project, source, expectedX: (90 + progress * 60 - (50 * (1 + progress * .22)) / 2) / 320, actualX: last.rect.x };
}

function changedStats(baseBytes: Buffer, styledBytes: Buffer): { changed: number; centroidX: number | null; centroidY: number | null; principalAngleDegrees: number | null; radialRms: number | null; upperWidth: number | null; lowerWidth: number | null; bounds: { x: number; y: number; width: number; height: number } | null } {
  const base = PNG.sync.read(baseBytes); const styled = PNG.sync.read(styledBytes);
  let changed = 0; let xTotal = 0; let yTotal = 0; let minX = base.width; let minY = base.height; let maxX = -1; let maxY = -1;
  const pixels: Array<[number, number]> = [];
  for (let y = 0; y < base.height; y += 1) for (let x = 0; x < base.width; x += 1) {
    const offset = (y * base.width + x) * 4;
    if ([0, 1, 2].some((channel) => Math.abs(base.data[offset + channel] - styled.data[offset + channel]) > 8)) {
      changed += 1; xTotal += x; yTotal += y; pixels.push([x, y]); minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  if (!changed) return { changed, centroidX: null, centroidY: null, principalAngleDegrees: null, radialRms: null, upperWidth: null, lowerWidth: null, bounds: null };
  const centroidX = xTotal / changed; const centroidY = yTotal / changed;
  let covXX = 0; let covYY = 0; let covXY = 0;
  for (const [x, y] of pixels) { const dx = x - centroidX; const dy = y - centroidY; covXX += dx * dx; covYY += dy * dy; covXY += dx * dy; }
  covXX /= changed; covYY /= changed; covXY /= changed;
  const principalAngleDegrees = .5 * Math.atan2(2 * covXY, covXX - covYY) * 180 / Math.PI;
  const cosine = Math.cos(principalAngleDegrees * Math.PI / 180);
  const sine = Math.sin(principalAngleDegrees * Math.PI / 180);
  const rowWidths = new Map<number, { min: number; max: number }>();
  let minLocalY = Number.POSITIVE_INFINITY; let maxLocalY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of pixels) {
    const dx = x - centroidX; const dy = y - centroidY;
    const localX = dx * cosine + dy * sine;
    const localY = -dx * sine + dy * cosine;
    const rowIndex = Math.round(localY);
    minLocalY = Math.min(minLocalY, rowIndex); maxLocalY = Math.max(maxLocalY, rowIndex);
    const row = rowWidths.get(rowIndex);
    if (row) { row.min = Math.min(row.min, localX); row.max = Math.max(row.max, localX); }
    else rowWidths.set(rowIndex, { min: localX, max: localX });
  }
  const height = maxY - minY + 1; const localHeight = maxLocalY - minLocalY + 1;
  const medianWidth = (from: number, to: number): number | null => {
    const widths = [...rowWidths].filter(([y]) => y >= minLocalY + localHeight * from && y <= minLocalY + localHeight * to).map(([, row]) => row.max - row.min + 1).sort((a, b) => a - b);
    return widths.length ? widths[Math.floor(widths.length / 2)] : null;
  };
  return { changed, centroidX, centroidY, principalAngleDegrees, radialRms: Math.sqrt(covXX + covYY), upperWidth: medianWidth(.2, .4), lowerWidth: medianWidth(.6, .8), bounds: { x: minX, y: minY, width: maxX - minX + 1, height } };
}

type Quad = [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }];

function trackingSamples(graph: GpuEngineVideoPreviewGraph["graph"]): Array<{ timelineFrame: number; x: number; y: number; confidence: number; status: string; rotationRadians?: number; scale?: number; destinationQuad?: Quad }> {
  const node = graph.nodes.find((candidate) => candidate.kind === "motion_graphic");
  const tracking = node?.tracking as { samples?: Array<{ timelineFrame: number; x: number; y: number; confidence: number; status: string; rotationRadians?: number; scale?: number; destinationQuad?: Quad }> } | undefined;
  return tracking?.samples ?? [];
}

function quadAt(track: MotionTrack, localTime: number): Quad | undefined {
  const nextIndex = track.points.findIndex((point) => point.time >= localTime);
  const next = nextIndex < 0 ? track.points.at(-1) : track.points[nextIndex];
  if (!next || next.status === "lost" || !next.quad) return undefined;
  if (nextIndex <= 0 || Math.abs(next.time - localTime) <= Number.EPSILON) return structuredClone(next.quad) as Quad;
  const previous = track.points[nextIndex - 1];
  if (previous.status === "lost" || !previous.quad) return undefined;
  if (next.time <= previous.time) return structuredClone(previous.quad) as Quad;
  const ratio = Math.max(0, Math.min(1, (localTime - previous.time) / (next.time - previous.time)));
  return previous.quad.map((corner, index) => ({ x: corner.x + (next.quad![index].x - corner.x) * ratio, y: corner.y + (next.quad![index].y - corner.y) * ratio })) as Quad;
}

function sameQuad(actual: Quad | undefined, expected: Quad | undefined, tolerance = .0001): boolean {
  return Boolean(actual && expected && actual.every((corner, index) => Math.abs(corner.x - expected[index].x) <= tolerance && Math.abs(corner.y - expected[index].y) <= tolerance));
}

async function executeGate(): Promise<GateReport> {
  const workspace = await mkdtemp(join(tmpdir(), "editkin-tracked-motion-graphic-"));
  try {
    const { project, source, expectedX, actualX } = await trackedProject(workspace);
    const preview = buildGpuEngineVideoPreviewGraph(project, 1);
    if (!preview) {
      return {
        schema: "editkin.tracked-motion-graphic-gate/v6", status: "BLOCK", productAdmissionSelected: false,
        trackerFrames: project.motionTracks[0].points.length, trackerLostRatio: project.motionTracks[0].lostRatio,
        trackerTranslationError: Math.abs(actualX - expectedX), trackerRotationError: Number.POSITIVE_INFINITY, trackerScaleError: Number.POSITIVE_INFINITY,
        directExecution: false, trackingReceipt: false,
        trackingSampleCount: 0, graphicTextureUploads: 0, translationOracle: false, pixelMovementOracle: false,
        transformReceiptOracle: false, pixelRotationOracle: false, pixelScaleOracle: false,
        quadTransportOracle: false, quadReceiptOracle: false, pixelPerspectiveOracle: false,
        lostStateOracle: false, safeAreaOracle: false, presentedFrames: 0, presentP95Ms: Number.POSITIVE_INFINITY,
        productPathCpuPixelCopies: -1, rejectedNegativeControls: [], releaseFences: { pendingFenceCount: -1 },
        reason: "product admission does not select tracked motion graphics for the native GPU path",
      };
    }
    const plainProject = structuredClone(project); plainProject.motionGraphics = []; plainProject.motionTracks = [];
    const plainPreview = buildGpuEngineVideoPreviewGraph(plainProject, 1);
    if (!plainPreview) throw new Error("plain native-video control was not admitted");
    const lostProject = structuredClone(project);
    lostProject.motionTracks[0].points = lostProject.motionTracks[0].points.map((point) => point.time >= 1.4 && point.time <= 1.8 ? { ...point, confidence: 0, status: "lost" as const } : point);
    lostProject.motionTracks[0].lostRatio = lostProject.motionTracks[0].points.filter((point) => point.status === "lost").length / lostProject.motionTracks[0].points.length;
    const lostPreview = buildGpuEngineVideoPreviewGraph(lostProject, 1.6);
    if (!lostPreview) throw new Error("lost-state native-video control was not admitted");

    const graphPath = join(workspace, "tracked.json"); const plainPath = join(workspace, "plain.json"); const lostPath = join(workspace, "lost.json"); const bindingsPath = join(workspace, "bindings.json");
    await writeFile(graphPath, JSON.stringify(preview.graph)); await writeFile(plainPath, JSON.stringify(plainPreview.graph)); await writeFile(lostPath, JSON.stringify(lostPreview.graph)); await writeFile(bindingsPath, JSON.stringify({ video: source }));
    const child = spawn(compositor, ["serve"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, EDITKIN_FONT_ROOT: fontRoot } });
    const lines = createInterface({ input: child.stdout }); let stderr = ""; let readyResolve!: () => void; const ready = new Promise<void>((resolveReady) => { readyResolve = resolveReady; }); const pending = new Map<string, (message: any) => void>();
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    lines.on("line", (line) => { const message = JSON.parse(line); if (message.event === "ready") readyResolve(); else pending.get(message.id)?.(message); });
    let sequence = 0;
    const request = (command: string, payload: Record<string, unknown> = {}) => new Promise<any>((resolveRequest, rejectRequest) => {
      const id = `tracked-${++sequence}`; const timer = setTimeout(() => { pending.delete(id); rejectRequest(new Error(`${command} timed out: ${stderr}`)); }, 60_000);
      pending.set(id, (message) => { clearTimeout(timer); pending.delete(id); resolveRequest(message); }); child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`);
    });
    try {
      await Promise.race([ready, new Promise((_, rejectReady) => setTimeout(() => rejectReady(new Error(`sidecar did not become ready: ${stderr}`)), 30_000))]);
      const loaded = await request("engine_video_load", { sessionId: "tracked", graphPath, bindingsPath, timelineFrame: 0 });
      const plainLoaded = await request("engine_video_load", { sessionId: "plain", graphPath: plainPath, bindingsPath, timelineFrame: 0 });
      const lostLoaded = await request("engine_video_load", { sessionId: "lost", graphPath: lostPath, bindingsPath, timelineFrame: 0 });
      if (!loaded.ok || !plainLoaded.ok || !lostLoaded.ok) throw new Error(`tracked graph load failed: ${JSON.stringify({ loaded, plainLoaded, lostLoaded })}`);
      const bound = await request("surface_bind", { parentHwnd: "0", x: 0, y: 0, width: 320, height: 180 }); if (!bound.ok) throw new Error(`surface bind failed: ${JSON.stringify(bound)}`);
      const samples: Record<number, { response: any; stats: ReturnType<typeof changedStats>; bytes: Buffer }> = {};
      for (const frame of [12, 48, 78]) {
        const styledOutput = join(workspace, `tracked-${frame}.png`); const plainOutput = join(workspace, `plain-${frame}.png`);
        const response = await request("engine_video_verify_frame", { sessionId: frame === 48 ? "lost" : "tracked", timelineFrame: frame, toleranceSeconds: 1 / 30, outputPath: styledOutput });
        const plain = await request("engine_video_verify_frame", { sessionId: "plain", timelineFrame: frame, toleranceSeconds: 1 / 30, outputPath: plainOutput });
        if (!response.ok || !plain.ok) throw new Error(`tracked verification failed at ${frame}: ${JSON.stringify({ response, plain })}`);
        const bytes = await readFile(styledOutput); samples[frame] = { response, bytes, stats: changedStats(await readFile(plainOutput), bytes) };
      }
      const times: number[] = []; let last: any;
      for (let index = 0; index < 64; index += 1) { const started = performance.now(); last = await request("engine_video_present_frame", { sessionId: "tracked", timelineFrame: 15 + index % 60, toleranceSeconds: 1 / 30 }); if (!last.ok) throw new Error(`tracked present failed: ${JSON.stringify(last)}`); if (index >= 4) times.push(performance.now() - started); }
      times.sort((a, b) => a - b);
      const rejectedNegativeControls: string[] = [];
      const baseGraph = structuredClone(preview.graph); const graphicNode = baseGraph.nodes.find((node) => node.kind === "motion_graphic")!;
      async function negative(name: string, mutate: (tracking: any) => void): Promise<void> { const graph = structuredClone(baseGraph); const node = graph.nodes.find((candidate) => candidate.kind === "motion_graphic")!; mutate(node.tracking); const path = join(workspace, `negative-${name}.json`); await writeFile(path, JSON.stringify(graph)); const sessionId = `negative-${name}`; const response = await request("engine_video_load", { sessionId, graphPath: path, bindingsPath, timelineFrame: 0 }); if (response.ok) await request("engine_video_release", { sessionId }); else rejectedNegativeControls.push(name); }
      await negative("empty", (tracking) => { tracking.samples = []; });
      await negative("order", (tracking) => { tracking.samples[1].timelineFrame = tracking.samples[0].timelineFrame; });
      await negative("bounds", (tracking) => { tracking.samples[0].x = 2; });
      await negative("status", (tracking) => { tracking.samples[0].status = "invented"; });
      await negative("scale", (tracking) => { tracking.samples[0].scale = 0; });
      await negative("rotation", (tracking) => { tracking.samples[0].rotationRadians = 99; });
      if (graphicNode.tracking && (graphicNode.tracking as any).samples?.[0]?.destinationQuad) {
        await negative("quad-bounds", (tracking) => { tracking.samples[0].destinationQuad[0].x = 2; });
        await negative("quad-order", (tracking) => { [tracking.samples[0].destinationQuad[1], tracking.samples[0].destinationQuad[2]] = [tracking.samples[0].destinationQuad[2], tracking.samples[0].destinationQuad[1]]; });
        await negative("quad-degenerate", (tracking) => { tracking.samples[0].destinationQuad = tracking.samples[0].destinationQuad.map(() => ({ x: .5, y: .5 })); });
      }
      const released = await request("engine_video_release", { sessionId: "tracked" }); await request("engine_video_release", { sessionId: "plain" }); await request("engine_video_release", { sessionId: "lost" }); await request("surface_release"); await request("shutdown");
      await mkdir(evidenceRoot, { recursive: true }); await writeFile(join(evidenceRoot, "moving-subject.mp4"), await readFile(source)); for (const [frame, sample] of Object.entries(samples)) await writeFile(join(evidenceRoot, `frame-${frame}.png`), sample.bytes);
      const node = preview.graph.nodes.find((candidate) => candidate.kind === "motion_graphic")!; const projected = trackingSamples(preview.graph); const earlyProjected = projected.find((sample) => sample.timelineFrame === 12)!; const lateProjected = projected.find((sample) => sample.timelineFrame === 78)!;
      const earlyReceipt = samples[12].response.result.activeMotionGraphics?.[0]; const lateReceipt = samples[78].response.result.activeMotionGraphics?.[0]; const staticReceipt = loaded.result.motionGraphics?.[0];
      const expectedEarlyX = (earlyProjected.x - Number(node.x)) * preview.graph.width; const expectedLateX = (lateProjected.x - Number(node.x)) * preview.graph.width;
      const expectedEarlyRotation = earlyProjected.rotationRadians; const expectedLateRotation = lateProjected.rotationRadians;
      const expectedEarlyScale = earlyProjected.scale; const expectedLateScale = lateProjected.scale;
      const expectedEarlyQuad = quadAt(project.motionTracks[0], 12 / project.fps);
      const expectedLateQuad = quadAt(project.motionTracks[0], 78 / project.fps);
      const earlyProjectedQuad = earlyProjected.destinationQuad;
      const lateProjectedQuad = lateProjected.destinationQuad;
      const earlyReceiptQuad = earlyReceipt?.sampledDestinationQuad as Quad | undefined;
      const lateReceiptQuad = lateReceipt?.sampledDestinationQuad as Quad | undefined;
      const observedAngleDelta = Math.abs((samples[78].stats.principalAngleDegrees ?? 0) - (samples[12].stats.principalAngleDegrees ?? 0));
      const expectedAngleDelta = Math.abs(((expectedLateRotation ?? 0) - (expectedEarlyRotation ?? 0)) * 180 / Math.PI);
      const observedScaleRatio = (samples[78].stats.radialRms ?? 0) / Math.max(.0001, samples[12].stats.radialRms ?? 0);
      const expectedScaleRatio = (expectedLateScale ?? 0) / Math.max(.0001, expectedEarlyScale ?? 0);
      const trackerLast = project.motionTracks[0].points.at(-1)!;
      const allBounds = [samples[12].stats.bounds, samples[78].stats.bounds].filter(Boolean) as Array<{ x: number; y: number; width: number; height: number }>;
      const edgeLength = (quad: Quad | undefined, start: number, end: number): number => quad ? Math.hypot(quad[end].x - quad[start].x, quad[end].y - quad[start].y) : 0;
      const quadArea = (quad: Quad | undefined): number => quad ? Math.abs(quad.reduce((sum, corner, index) => sum + corner.x * quad[(index + 1) % 4].y - quad[(index + 1) % 4].x * corner.y, 0)) / 2 : 0;
      const expectedPerspectiveEdgeRatio = edgeLength(expectedLateQuad, 0, 1) / Math.max(.0001, edgeLength(expectedLateQuad, 3, 2));
      const expectedPerspectiveRatio = (expectedPerspectiveEdgeRatio + (1 - expectedPerspectiveEdgeRatio) * .3) / Math.max(.0001, expectedPerspectiveEdgeRatio + (1 - expectedPerspectiveEdgeRatio) * .7);
      const observedPerspectiveRatio = Number(samples[78].stats.upperWidth) / Math.max(1, Number(samples[78].stats.lowerWidth));
      const expectedProjectedAreaRatio = quadArea(expectedLateQuad) / Math.max(.0001, quadArea(expectedEarlyQuad));
      const observedPixelAreaRatio = samples[78].stats.changed / Math.max(1, samples[12].stats.changed);
      return {
        schema: "editkin.tracked-motion-graphic-gate/v6", status: "GREEN", productAdmissionSelected: true,
        trackerFrames: project.motionTracks[0].points.length, trackerLostRatio: project.motionTracks[0].lostRatio, trackerTranslationError: Math.abs(actualX - expectedX), trackerRotationError: Math.abs(Number(trackerLast.rotationDegrees) - 32), trackerScaleError: Math.abs(Number(trackerLast.scale) - 1.22),
        directExecution: loaded.result.engineGraph.directExecution, trackingReceipt: staticReceipt?.trackId === project.motionTracks[0].id,
        trackingSampleCount: staticReceipt?.trackingSampleCount ?? -1, graphicTextureUploads: loaded.result.motionGraphicTextureUploads,
        translationOracle: Math.abs(earlyReceipt?.sampledTranslateX - expectedEarlyX) < .001 && Math.abs(lateReceipt?.sampledTranslateX - expectedLateX) < .001 && lateReceipt?.sampledTranslateX > earlyReceipt?.sampledTranslateX + 40 && earlyReceipt?.sampledTrackingStatus !== "lost" && lateReceipt?.sampledTrackingStatus !== "lost",
        transformReceiptOracle: Number.isFinite(expectedEarlyRotation) && Number.isFinite(expectedLateRotation) && Number.isFinite(expectedEarlyScale) && Number.isFinite(expectedLateScale)
          && Math.abs(earlyReceipt?.sampledTrackingRotationRadians - expectedEarlyRotation!) < .001 && Math.abs(lateReceipt?.sampledTrackingRotationRadians - expectedLateRotation!) < .001
          && Math.abs(earlyReceipt?.sampledTrackingScale - expectedEarlyScale!) < .001 && Math.abs(lateReceipt?.sampledTrackingScale - expectedLateScale!) < .001
          && Math.abs(earlyReceipt?.sampledRotationRadians - expectedEarlyRotation!) < .001 && Math.abs(lateReceipt?.sampledRotationRadians - expectedLateRotation!) < .001,
        pixelMovementOracle: samples[12].stats.changed > 500 && samples[78].stats.changed > 500 && (samples[78].stats.centroidX ?? 0) > (samples[12].stats.centroidX ?? 0) + 30,
        pixelRotationOracle: expectedAngleDelta >= 8 && observedAngleDelta >= 8 && Math.abs(observedAngleDelta - expectedAngleDelta) <= 12,
        pixelScaleOracle: expectedScaleRatio > 1.04 && expectedProjectedAreaRatio > .8 && expectedProjectedAreaRatio < 1.3 && Math.abs(observedPixelAreaRatio - expectedProjectedAreaRatio) <= .08,
        quadTransportOracle: sameQuad(earlyProjectedQuad, expectedEarlyQuad) && sameQuad(lateProjectedQuad, expectedLateQuad),
        quadReceiptOracle: sameQuad(earlyReceiptQuad, expectedEarlyQuad, .001) && sameQuad(lateReceiptQuad, expectedLateQuad, .001),
        pixelPerspectiveOracle: expectedPerspectiveEdgeRatio < .7 && expectedPerspectiveRatio < .9 && observedPerspectiveRatio < .94 && Math.abs(observedPerspectiveRatio - expectedPerspectiveRatio) <= .12,
        lostStateOracle: samples[48].response.result.activeMotionGraphics?.length === 0 && samples[48].stats.changed === 0,
        safeAreaOracle: allBounds.length === 2 && allBounds.every((bounds) => bounds.x >= Math.floor(preview.graph.width * .02) && bounds.y >= Math.floor(preview.graph.height * .02) && bounds.x + bounds.width <= Math.ceil(preview.graph.width * .98) && bounds.y + bounds.height <= Math.ceil(preview.graph.height * .98)),
        presentedFrames: times.length, presentP95Ms: times[Math.floor((times.length - 1) * .95)],
        productPathCpuPixelCopies: Math.max(samples[12].response.result.productPathCpuPixelCopies, samples[78].response.result.productPathCpuPixelCopies, last.result.frame.decodePathCpuPixelCopies, last.result.frame.stagingCpuPixelReadbacks, last.result.frame.nativeSurfaceCpuPixelReadbacks),
        rejectedNegativeControls, releaseFences: released.result.fences,
        sampleEvidence: { early: { expectedQuad: expectedEarlyQuad, projected: earlyProjected, receipt: earlyReceipt, stats: samples[12].stats }, lost: { stats: samples[48].stats }, late: { expectedQuad: expectedLateQuad, projected: lateProjected, receipt: lateReceipt, stats: samples[78].stats }, expectedAngleDelta, observedAngleDelta, expectedScaleRatio, observedScaleRatio, expectedProjectedAreaRatio, observedPixelAreaRatio, expectedPerspectiveEdgeRatio, expectedPerspectiveRatio, observedPerspectiveRatio },
        artifacts: { sourceSha256: sha256(await readFile(source)), frame12Sha256: sha256(samples[12].bytes), frame48Sha256: sha256(samples[48].bytes), frame78Sha256: sha256(samples[78].bytes) },
        requiredNodeIds: preview.graph.nodes.map((candidate) => candidate.id), executedNodeIds: loaded.result.engineGraph.executedNodeIds,
        sourceExecutableSha256: sha256(await readFile(compositor)), graphicNodeTrackingSamples: (graphicNode.tracking as any)?.samples?.length ?? 0,
      };
    } finally { lines.close(); if (child.exitCode === null) child.kill(); }
  } finally { await rm(workspace, { recursive: true, force: true }); }
}

async function main(): Promise<void> {
  if (selfTest) return syntheticSelfTest();
  const observed = await executeGate();
  const candidate = { measuredAt: new Date().toISOString(), executable: compositor, executableSha256: sha256(await readFile(compositor)), ...observed, status: "GREEN" as const } as GateReport;
  let status: GateReport["status"] = "GREEN";
  try { assertGreen(candidate); } catch { status = "BLOCK"; }
  const report = { ...candidate, status } as GateReport;
  await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (!baseline) assertGreen(report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => { console.error(error.stack ?? error); process.exitCode = 1; });
