import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createNativeSmartCutPlan, type NativeSmartCutPlan, type SmartCutRequest } from "../render/nativeCore";
import { assertLocalMediaPath } from "../shared/localMediaPath";
import { DEFAULT_SMART_CUT_OPTIONS, planSmartCutReference, type SmartCutOptions, type SmartCutResult } from "./smartCutPlan";

export interface AnalyzeSmartCutRequest {
  sourcePath: string;
  sourceStart: number;
  duration: number;
  fps: number;
  sourceSha256?: string;
  options?: Partial<SmartCutOptions>;
}

const SMART_CUT_CACHE_SCHEMA = 2;
const SMART_CUT_NATIVE_ENGINE = "hao-core-rust-0.4";

export function parseSilenceDetect(stderr: string, duration: number): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let openStart: number | undefined;
  for (const match of stderr.matchAll(/silence_(start|end):\s*([-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?)/gi)) {
    const value = Number(match[2]);
    if (!Number.isFinite(value)) continue;
    if (match[1].toLowerCase() === "start") openStart = Math.max(0, value);
    else {
      const start = openStart ?? 0;
      const end = Math.min(duration, Math.max(start, value));
      if (end > start) ranges.push({ start, end });
      openStart = undefined;
    }
  }
  if (openStart !== undefined && duration > openStart) ranges.push({ start: openStart, end: duration });
  return ranges;
}

function detectSilences(request: AnalyzeSmartCutRequest, options: SmartCutOptions, ffmpegPath: string): Promise<Array<{ start: number; end: number }>> {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner", "-nostdin", "-ss", String(request.sourceStart), "-t", String(request.duration), "-i", request.sourcePath,
      "-map", "0:a:0", "-af", `asetpts=PTS-STARTPTS,silencedetect=noise=${options.thresholdDb}dB:d=${options.minSilence}`,
      "-f", "null", "-",
    ];
    const child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Smart Cut 音訊分析逾時")); }, 15 * 60_000);
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4_000_000); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(parseSilenceDetect(stderr, request.duration));
      else reject(new Error(/matches no streams|does not contain any stream/i.test(stderr)
        ? "這個素材沒有可分析的聲音軌"
        : `FFmpeg Smart Cut 分析失敗：${stderr.trim().slice(-2_000)}`));
    });
  });
}

export async function analyzeSmartCut(
  request: AnalyzeSmartCutRequest,
  runtime: { ffmpegPath: string; nativeCorePath?: string; cacheRoot?: string },
): Promise<SmartCutResult> {
  assertLocalMediaPath(request.sourcePath);
  const options = { ...DEFAULT_SMART_CUT_OPTIONS, ...request.options };
  if (!request.sourcePath || !Number.isFinite(request.sourceStart) || request.sourceStart < 0) throw new Error("Smart Cut 素材範圍不合法");
  await access(request.sourcePath);
  const sourceStat = await stat(request.sourcePath);
  const cacheIdentity = {
    schemaVersion: SMART_CUT_CACHE_SCHEMA,
    nativeEngine: SMART_CUT_NATIVE_ENGINE,
    source: request.sourceSha256 ?? { path: request.sourcePath, bytes: sourceStat.size, modifiedMs: sourceStat.mtimeMs },
    sourceStart: request.sourceStart,
    duration: request.duration,
    fps: request.fps,
    options,
  };
  const cacheKey = createHash("sha256").update(JSON.stringify(cacheIdentity)).digest("hex");
  const cachePath = runtime.cacheRoot ? join(runtime.cacheRoot, "smart-cut", `${cacheKey}.json`) : undefined;
  if (cachePath) {
    try {
      const cached = JSON.parse(await readFile(cachePath, "utf8")) as { schemaVersion?: number; result?: Omit<SmartCutResult, "cacheHit"> };
      if (cached.schemaVersion === SMART_CUT_CACHE_SCHEMA && cached.result?.engine === SMART_CUT_NATIVE_ENGINE
        && cached.result.sourceFrames === Math.round(request.duration * request.fps)
        && Array.isArray(cached.result.ranges) && cached.result.ranges.length > 0) {
        return { ...cached.result, cacheHit: true };
      }
    } catch { /* cache miss or corrupt cache: recompute from source */ }
  }
  const silences = await detectSilences(request, options, runtime.ffmpegPath);
  const nativeRequest: SmartCutRequest = {
    fps: request.fps,
    duration: request.duration,
    silences,
    options: { padding: options.padding, minSilence: options.minSilence, minKeep: options.minKeep },
  };
  let plan: NativeSmartCutPlan;
  try {
    if (!runtime.nativeCorePath) throw new Error("native core unavailable");
    await access(runtime.nativeCorePath);
    plan = await createNativeSmartCutPlan(nativeRequest, runtime.nativeCorePath);
  } catch {
    plan = planSmartCutReference(nativeRequest);
  }
  const result: SmartCutResult = {
    ...plan, silenceCount: silences.length, thresholdDb: options.thresholdDb, analyzedSeconds: request.duration, cacheHit: false,
  };
  if (cachePath && plan.engine.startsWith("hao-core-rust-")) {
    await mkdir(join(runtime.cacheRoot!, "smart-cut"), { recursive: true });
    const temporary = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ schemaVersion: SMART_CUT_CACHE_SCHEMA, result: { ...result, cacheHit: undefined } })}\n`, "utf8");
    try { await rename(temporary, cachePath); } catch {
      try { await access(cachePath); } catch (error) { throw error; }
    } finally { await rm(temporary, { force: true }); }
  }
  return result;
}
