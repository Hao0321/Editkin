import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createNativeMotionTrackPlan, type NativeMotionTrackPlan } from "../render/nativeCore";

export interface AnalyzeMotionTrackRequest {
  sourcePath: string;
  sourceStart: number;
  duration: number;
  fps: number;
  sourceWidth: number;
  sourceHeight: number;
  initialTime: number;
  initialRect: { x: number; y: number; width: number; height: number };
  sourceSha256?: string;
}

export interface MotionTrackAnalysisResult extends NativeMotionTrackPlan {
  analyzedSeconds: number;
  elapsedMs: number;
  cacheHit: boolean;
}

function runFfmpeg(executable: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectRun(error); else resolveRun();
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error("動態追蹤取樣逾時")); }, timeoutMs);
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-12_000); });
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => finish(code === 0 ? undefined : new Error(`FFmpeg 動態追蹤取樣失敗：${stderr.trim().slice(-4_000)}`)));
  });
}

function validRect(rect: AnalyzeMotionTrackRequest["initialRect"]): boolean {
  return Object.values(rect).every(Number.isFinite) && rect.x >= 0 && rect.y >= 0 && rect.width >= 0.02 && rect.height >= 0.02
    && rect.x + rect.width <= 1 && rect.y + rect.height <= 1;
}

function validCached(value: unknown, expectedFrames: number): value is Omit<MotionTrackAnalysisResult, "elapsedMs" | "cacheHit"> {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<MotionTrackAnalysisResult>;
  return typeof result.engine === "string" && result.engine.startsWith("hao-core-rust-motion-track-")
    && Array.isArray(result.points) && result.points.length === expectedFrames && Number.isFinite(result.lostRatio);
}

export async function analyzeMotionTrack(
  request: AnalyzeMotionTrackRequest,
  runtime: { ffmpegPath: string; nativeCorePath: string; cacheRoot?: string },
): Promise<MotionTrackAnalysisResult> {
  const startedAt = Date.now();
  if (!request.sourcePath || !Number.isFinite(request.sourceStart) || request.sourceStart < 0) throw new Error("動態追蹤素材起點不合法");
  if (!Number.isFinite(request.duration) || request.duration <= 0 || request.duration > 4 * 3600) throw new Error("動態追蹤時長不合法");
  if (!Number.isFinite(request.fps) || request.fps <= 0 || request.fps > 240) throw new Error("動態追蹤 fps 不合法");
  if (!Number.isFinite(request.initialTime) || request.initialTime < 0 || request.initialTime > request.duration || !validRect(request.initialRect)) throw new Error("請在片段範圍內框選至少 2% 大小的追蹤區域");
  if (![request.sourceWidth, request.sourceHeight].every((value) => Number.isFinite(value) && value >= 16)) throw new Error("動態追蹤需要有效的素材解析度");
  await Promise.all([access(request.sourcePath), access(runtime.ffmpegPath), access(runtime.nativeCorePath)]);
  const source = await stat(request.sourcePath);
  const analysisFps = Math.min(15, request.fps);
  const analysisWidth = Math.min(640, Math.max(160, Math.round(Math.min(request.sourceWidth, 640) / 2) * 2));
  const analysisHeight = Math.max(90, Math.round((analysisWidth * request.sourceHeight / request.sourceWidth) / 2) * 2);
  const expectedFrames = Math.max(1, Math.ceil(request.duration * analysisFps));
  const identity = {
    schemaVersion: 1,
    source: request.sourceSha256 ?? { path: resolve(request.sourcePath), bytes: source.size, modifiedMs: source.mtimeMs },
    sourceStart: request.sourceStart, duration: request.duration, analysisFps, analysisWidth, analysisHeight,
    initialTime: request.initialTime, initialRect: request.initialRect, engine: "hao-core-rust-motion-track-0.4-planar",
  };
  const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  const cachePath = runtime.cacheRoot ? join(runtime.cacheRoot, "motion-tracking", `${key}.json`) : undefined;
  if (cachePath) {
    try {
      const cached = JSON.parse(await readFile(cachePath, "utf8")) as { schemaVersion?: number; result?: unknown };
      if (cached.schemaVersion === 1 && validCached(cached.result, expectedFrames)) return { ...cached.result, elapsedMs: Date.now() - startedAt, cacheHit: true };
    } catch { /* corrupt or stale cache is a miss */ }
  }
  const workspace = await mkdtemp(join(tmpdir(), "editkin-motion-track-"));
  const rawPath = join(workspace, "frames.gray");
  try {
    const timeoutMs = Math.min(2 * 3600_000, Math.max(5 * 60_000, request.duration * 10_000));
    await runFfmpeg(runtime.ffmpegPath, [
      "-y", "-hide_banner", "-loglevel", "error", "-nostdin", "-ss", String(request.sourceStart), "-t", String(request.duration), "-i", resolve(request.sourcePath),
      "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", `fps=${analysisFps},scale=${analysisWidth}:${analysisHeight}:flags=bilinear,format=gray`,
      "-f", "rawvideo", "-pix_fmt", "gray", rawPath,
    ], timeoutMs);
    const bytes = (await stat(rawPath)).size;
    const frameBytes = analysisWidth * analysisHeight;
    if (bytes % frameBytes !== 0 || bytes === 0) throw new Error("動態追蹤取樣輸出不完整");
    const frameCount = bytes / frameBytes;
    const plan = await createNativeMotionTrackPlan({
      rawPath, width: analysisWidth, height: analysisHeight, frameCount, analysisFps,
      initialFrame: Math.min(frameCount - 1, Math.max(0, Math.round(request.initialTime * analysisFps))), initialRect: request.initialRect,
      searchRadius: 0.65, confidenceThreshold: 0.48, maxHoldFrames: 5, maxRotationStep: 8,
    }, runtime.nativeCorePath, timeoutMs);
    const result: MotionTrackAnalysisResult = { ...plan, analyzedSeconds: request.duration, elapsedMs: Date.now() - startedAt, cacheHit: false };
    if (cachePath) {
      await mkdir(dirname(cachePath), { recursive: true });
      const temporary = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, result: { ...result, elapsedMs: undefined, cacheHit: undefined } })}\n`, "utf8");
      try { await rename(temporary, cachePath); } catch {
        try { await access(cachePath); } catch (error) { throw error; }
      } finally { await rm(temporary, { force: true }); }
    }
    return result;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
