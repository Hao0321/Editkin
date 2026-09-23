import { runAnalysisProcess } from "./analysisProcess";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface SceneDetectionRequest {
  sourcePath: string;
  sourceStart: number;
  duration: number;
  fps: number;
  sourceSha256?: string;
  threshold?: number;
  minSceneDuration?: number;
}

export interface SceneCut {
  time: number;
  score: number;
  frame: number;
}

export interface SceneDetectionResult {
  cuts: SceneCut[];
  engine: "ffmpeg-scdet-8";
  threshold: number;
  minSceneDuration: number;
  analyzedSeconds: number;
  elapsedMs: number;
  cacheHit: boolean;
}

export function parseSceneDetectLog(stderr: string, duration: number, fps: number, minSceneDuration: number): SceneCut[] {
  const candidates = [...stderr.matchAll(/lavfi\.scd\.score:\s*([\d.]+)\s*,\s*lavfi\.scd\.time:\s*([\d.]+)/gi)]
    .map((match) => ({ score: Number(match[1]), time: Number(match[2]) }))
    .filter((cut) => Number.isFinite(cut.score) && Number.isFinite(cut.time) && cut.time > 0 && cut.time < duration)
    .sort((left, right) => left.time - right.time);
  const clustered: Array<{ time: number; score: number }> = [];
  for (const cut of candidates) {
    const previous = clustered.at(-1);
    if (previous && cut.time - previous.time < minSceneDuration) {
      if (cut.score > previous.score) clustered[clustered.length - 1] = cut;
    } else clustered.push(cut);
  }
  return clustered
    .map((cut) => ({ ...cut, frame: Math.round(cut.time * fps), time: Math.round(cut.time * fps) / fps }))
    .filter((cut, index, all) => cut.frame > 0 && cut.time >= minSceneDuration && duration - cut.time >= minSceneDuration
      && (index === 0 || cut.frame > all[index - 1].frame));
}

async function detectScenes(request: SceneDetectionRequest, ffmpegPath: string, threshold: number, minSceneDuration: number, signal?: AbortSignal): Promise<SceneCut[]> {
    const args = [
      "-hide_banner", "-nostdin", "-ss", String(request.sourceStart), "-t", String(request.duration), "-i", resolve(request.sourcePath),
      "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", `setpts=PTS-STARTPTS,scdet=threshold=${threshold}`,
      "-f", "null", "-",
    ];
    const { stderr } = await runAnalysisProcess(ffmpegPath, args, { signal, timeoutMs: Math.min(2 * 3600_000, Math.max(10 * 60_000, request.duration * 5_000)), label: "自動分鏡分析", maximumStderr: 8_000_000 });
    return parseSceneDetectLog(stderr, request.duration, request.fps, minSceneDuration);
}

function validResult(value: unknown, request: SceneDetectionRequest, threshold: number, minSceneDuration: number): value is Omit<SceneDetectionResult, "elapsedMs" | "cacheHit"> {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<SceneDetectionResult>;
  return result.engine === "ffmpeg-scdet-8" && result.threshold === threshold && result.minSceneDuration === minSceneDuration
    && result.analyzedSeconds === request.duration && Array.isArray(result.cuts)
    && result.cuts.every((cut) => cut && Number.isFinite(cut.time) && Number.isInteger(cut.frame) && cut.frame > 0 && Number.isFinite(cut.score));
}

export async function analyzeSceneCuts(
  request: SceneDetectionRequest,
  runtime: { ffmpegPath: string; cacheRoot?: string; signal?: AbortSignal },
): Promise<SceneDetectionResult> {
  const startedAt = Date.now();
  runtime.signal?.throwIfAborted();
  const threshold = request.threshold ?? 10;
  const minSceneDuration = request.minSceneDuration ?? Math.max(1 / request.fps, Math.min(0.5, request.duration / 3));
  if (!request.sourcePath || !Number.isFinite(request.sourceStart) || request.sourceStart < 0) throw new Error("自動分鏡素材起點不合法");
  if (!Number.isFinite(request.duration) || request.duration <= 0 || request.duration > 24 * 3600) throw new Error("自動分鏡素材時長不合法");
  if (!Number.isFinite(request.fps) || request.fps <= 0 || request.fps > 240) throw new Error("自動分鏡 fps 不合法");
  if (!Number.isFinite(threshold) || threshold < 1 || threshold > 100) throw new Error("自動分鏡 threshold 必須介於 1–100");
  if (!Number.isFinite(minSceneDuration) || minSceneDuration < 1 / request.fps || minSceneDuration > request.duration / 2) throw new Error("自動分鏡最短鏡頭長度不合法");
  await access(request.sourcePath);
  await access(runtime.ffmpegPath);
  const sourceStat = await stat(request.sourcePath);
  const identity = {
    schemaVersion: 1,
    source: request.sourceSha256 ?? { path: resolve(request.sourcePath), bytes: sourceStat.size, modifiedMs: sourceStat.mtimeMs },
    sourceStart: request.sourceStart,
    duration: request.duration,
    fps: request.fps,
    threshold,
    minSceneDuration,
  };
  const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  const cachePath = runtime.cacheRoot ? join(runtime.cacheRoot, "scene-detection", `${key}.json`) : undefined;
  if (cachePath) {
    try {
      const cached = JSON.parse(await readFile(cachePath, "utf8")) as { schemaVersion?: number; result?: unknown };
      if (cached.schemaVersion === 1 && validResult(cached.result, request, threshold, minSceneDuration)) {
        return { ...cached.result, elapsedMs: Date.now() - startedAt, cacheHit: true };
      }
    } catch { /* corrupt cache is a miss */ }
  }
  const cuts = await detectScenes(request, runtime.ffmpegPath, threshold, minSceneDuration, runtime.signal);
  runtime.signal?.throwIfAborted();
  const result: SceneDetectionResult = {
    cuts, engine: "ffmpeg-scdet-8", threshold, minSceneDuration,
    analyzedSeconds: request.duration, elapsedMs: Date.now() - startedAt, cacheHit: false,
  };
  if (cachePath) {
    await mkdir(dirname(cachePath), { recursive: true });
    const temporary = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, result: { ...result, elapsedMs: undefined, cacheHit: undefined } })}\n`, "utf8");
    try { await rename(temporary, cachePath); } catch {
      try { await access(cachePath); } catch (error) { throw error; }
    } finally { await rm(temporary, { force: true }); }
  }
  return result;
}
