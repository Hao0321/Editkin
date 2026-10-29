import { createHash } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import type { EditProject } from "../domain/types";
import { assertClipVolume, assertAudioGainTarget, planClipAudioGain, type ClipAudioMeasurement } from "../domain/audioGain";
import { runAnalysisProcess } from "./analysisProcess";
import { mediaUtilityInputOptions } from "./mediaUtilityInputPolicy";

export const clipAudioGainRequestSchema = z.object({
  clipId: z.string().trim().min(1).max(128),
  targetLufs: z.number().finite().min(-32).max(-9).default(-18),
  peakCeilingDbtp: z.number().finite().min(-9).max(-1).default(-3),
}).strict();
export type ClipAudioGainRequest = z.input<typeof clipAudioGainRequestSchema>;
export const AUDIO_GAIN_MAX_SOURCE_BYTES = 512 * 1024 * 1024;
export const AUDIO_GAIN_MAX_SECONDS = 300;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const audioGainProjectFingerprint = (project: EditProject) => digest(JSON.stringify(project));

/** FFmpeg emits -inf for silence. No invalid/string infinity becomes a finite gain. */
export function parseClipAudioMeasurement(stderr: string): ClipAudioMeasurement {
  const records = stderr.match(/\{\s*"input_i"\s*:[^{}]*\}/g);
  if (records?.length !== 1) throw new Error("FFmpeg 缺少唯一的響度量測結果");
  const stats = JSON.parse(records[0]) as Record<string, unknown>;
  const number = (name: string) => {
    const value = stats[name];
    if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error("音訊為靜音或響度量測不完整");
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error("響度量測不合法");
    return parsed;
  };
  return { integratedLufs: number("input_i"), truePeakDbtp: number("input_tp"), loudnessRangeLu: number("input_lra") };
}
const identity = (s: Awaited<ReturnType<typeof stat>>) => JSON.stringify({ dev: s.dev, ino: s.ino, size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs });
function inRoot(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== ".." && !child.startsWith("..\\") && !child.startsWith("../") && !isAbsolute(child);
}
async function hashHandle(handle: Awaited<ReturnType<typeof open>>, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256"), chunk = Buffer.allocUnsafe(64 * 1024), start = performance.now();
  let position = 0;
  while (true) {
    signal?.throwIfAborted();
    if (performance.now() - start > 30_000) throw new Error("音訊來源驗證逾時");
    const result = await handle.read(chunk, 0, chunk.length, position);
    if (!result.bytesRead) break;
    position += result.bytesRead;
    if (position > AUDIO_GAIN_MAX_SOURCE_BYTES) throw new Error("音訊來源超出 512 MiB 量測預算");
    hash.update(chunk.subarray(0, result.bytesRead));
  }
  return hash.digest("hex");
}
export interface ClipAudioGainOptions {
  workspaceRoot: string;
  sourcePath: string;
  ffmpegPath: string;
  ffprobePath: string;
  readCurrentProject: () => Promise<EditProject>;
  signal?: AbortSignal;
}
export interface ClipAudioGainDependencies {
  run: typeof runAnalysisProcess;
}

/** Preparation binds bytes and project only during analysis, never an apply lease. */
export async function prepareClipAudioGain(project: EditProject, request: ClipAudioGainRequest,
  options: ClipAudioGainOptions, dependencies: ClipAudioGainDependencies = { run: runAnalysisProcess }) {
  const input = clipAudioGainRequestSchema.parse(request);
  assertAudioGainTarget(input); options.signal?.throwIfAborted();
  const snapshot = structuredClone(project), projectSha256 = audioGainProjectFingerprint(snapshot);
  const bindings = snapshot.tracks.flatMap(track => track.clips.filter(clip => clip.id === input.clipId).map(clip => ({ track, clip })));
  if (bindings.length !== 1) throw new Error("找不到唯一的音訊片段");
  const { track, clip } = bindings[0], assets = snapshot.assets.filter(asset => asset.id === clip.assetId);
  if (assets.length !== 1) throw new Error("找不到唯一的片段來源");
  const asset = assets[0]; assertClipVolume(clip.volume);
  if (track.locked || track.muted || !["video", "audio"].includes(track.kind) || clip.volume === 0
    || clip.layer?.enabled === false || (clip.layer?.role ?? "content") !== "content") throw new Error("鎖定、靜音或非內容片段不能準備增益");
  if (!["video", "audio"].includes(asset.kind) || asset.compositionId || asset.imageSequence
    || !Number.isFinite(clip.sourceStart) || clip.sourceStart < 0 || !Number.isFinite(clip.duration)
    || clip.duration < 3 || clip.duration > AUDIO_GAIN_MAX_SECONDS) throw new Error("量測只接受 3–300 秒的真實影音來源片段");
  const root = await realpath(options.workspaceRoot), path = await realpath(options.sourcePath);
  if (!inRoot(root, path)) throw new Error("音訊來源超出目前工作區");
  const sourceHandle = await open(path, "r");
  try {
    const before = await sourceHandle.stat();
    if (!before.isFile() || before.size < 1 || before.size > AUDIO_GAIN_MAX_SOURCE_BYTES) throw new Error("音訊來源不是有效檔案或超出 512 MiB 預算");
    const sourceSha256 = await hashHandle(sourceHandle, options.signal);
    const probe = await dependencies.run(options.ffprobePath, ["-v", "error", ...mediaUtilityInputOptions(path), "-select_streams", "a:0", "-show_entries", "stream=channels,sample_rate,duration:format=duration", "-of", "json", path],
      { timeoutMs: 10_000, label: "音訊 probe", signal: options.signal, maximumStdout: 16_384, maximumStderr: 16_384 });
    const info = JSON.parse(probe.stdout.toString("utf8")) as { streams?: Array<{ channels?: number; duration?: string; sample_rate?: string }>; format?: { duration?: string } };
    if (info.streams?.length !== 1 || ![1, 2].includes(info.streams[0].channels ?? 0)) throw new Error("來源沒有單聲道／雙聲道音訊；多聲道需先指定混音方式");
    const available = Number(info.streams[0].duration ?? info.format?.duration);
    if (!Number.isFinite(available) || clip.sourceStart + clip.duration > available + 0.001) throw new Error("選取窗口超出真實音訊長度");
    const filter = `aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${clip.duration},asetpts=PTS-STARTPTS,loudnorm=I=${input.targetLufs}:TP=${input.peakCeilingDbtp}:LRA=11:print_format=json`;
    const measured = await dependencies.run(options.ffmpegPath, ["-hide_banner", "-nostdin", "-nostats", "-ss", String(clip.sourceStart), ...mediaUtilityInputOptions(path), "-i", path, "-map", "0:a:0", "-vn", "-t", String(clip.duration), "-af", filter, "-f", "null", "-"],
      { timeoutMs: 30_000, label: "音訊響度量測", signal: options.signal, maximumStdout: 0, maximumStderr: 32_768 });
    const measurement = parseClipAudioMeasurement(measured.stderr), gain = planClipAudioGain(measurement, input, clip.volume);
    // Re-read the path as well as the open handle: replacing the file must fail too.
    const [after, currentPathStat, currentProject] = await Promise.all([sourceHandle.stat(), stat(path), options.readCurrentProject()]);
    if (identity(before) !== identity(after) || identity(before) !== identity(currentPathStat)
      || sourceSha256 !== await hashHandle(sourceHandle, options.signal)) throw new Error("量測期間音訊來源變動");
    if (projectSha256 !== audioGainProjectFingerprint(currentProject)) throw new Error("量測期間專案已變動，請重新準備");
    options.signal?.throwIfAborted();
    return { schema: "editkin.clip-audio-gain-preparation/v1" as const, status: "PREPARED_NOT_APPLIED" as const,
      mutationPerformed: false as const, projectId: snapshot.id, projectRevision: snapshot.revision, projectSha256,
      clipId: clip.id, assetId: asset.id, source: { path, bytes: before.size, sha256: sourceSha256, audioStream: "0:a:0",
        sourceStart: clip.sourceStart, duration: clip.duration, sourceChannels: info.streams[0].channels,
        measurementChannels: 2, measurementSampleRate: 48_000 },
      measurement, target: { targetLufs: input.targetLufs, peakCeilingDbtp: input.peakCeilingDbtp }, gain,
      command: { type: "set_clip_volume" as const, clipId: clip.id, volume: gain.volume },
      directApplyAllowed: false as const, executionBoundary: "draft_command_requires_same_v4_plan_audit_atomic_apply" as const,
      evidenceBoundary: "preparation-time identity only; not apply lease, final mix, encoded true peak or output approval" as const };
  } finally { await sourceHandle.close(); }
}
