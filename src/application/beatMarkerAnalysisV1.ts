import { isAbsolute, resolve } from "node:path";
import { resolveMediaPath } from "../render/mediaProcess";
import type { EditProject } from "../domain/types";
import { analyzeMusicBeatsV1, musicBeatFileShaV1, type MusicBeatsRuntimeV1 } from "./musicBeats";
import { beatMarkerJobSourceV1, prepareBeatMarkersV1, type BeatMarkerJobV1, type BeatMarkerOptionsV1 } from "./beatMarkersV1";

/** EG4 package handler, not a new CLI/IPC bridge. Resolve from the live selected asset,
 * verify the expected original/baked source, analyse once, then check current files/project.
 * No proxy URL, alternate source path, model or caller-provided receipt is accepted. */
export async function analyzeBeatMarkersV1(project: EditProject, job: BeatMarkerJobV1, input: {
  assetBase: string; expectedSourceSha256: string; priorBpm?: number;
}, requestedRuntime: MusicBeatsRuntimeV1, options: BeatMarkerOptionsV1) {
  const selected = beatMarkerJobSourceV1(project, job, options), runtime = Object.freeze({ ...requestedRuntime });
  const signal = runtime.signal ?? options.signal;
  if (runtime.signal && options.signal && runtime.signal !== options.signal) throw Error("BEAT_MARKER_SINGLE_OWNER_SIGNAL_REQUIRED");
  signal?.throwIfAborted();
  if (!isAbsolute(input.assetBase) || resolve(input.assetBase) !== input.assetBase || !/^[a-f0-9]{64}$/.test(input.expectedSourceSha256)) throw Error("BEAT_MARKER_HOST_SOURCE_IDENTITY_REQUIRED");
  const sourcePath = resolve(resolveMediaPath(selected.assetUri, input.assetBase));
  const before = await musicBeatFileShaV1(sourcePath, signal);
  if (before.sha256 !== input.expectedSourceSha256) throw Error("BEAT_MARKER_SOURCE_SHA_CHANGED");
  const request = { sourcePath, sourceStartSeconds: selected.sourceStartSeconds, durationSeconds: selected.durationSeconds,
    ...(input.priorBpm === undefined ? {} : { priorBpm: input.priorBpm }) };
  const result = await analyzeMusicBeatsV1(request, { ...runtime, signal });
  for (const [path, expected] of [[sourcePath, result.binding.source], [runtime.ffmpegPath, result.binding.ffmpeg],
    [runtime.ffprobePath, result.binding.ffprobe], [runtime.nativeCorePath, result.binding.core]] as const) {
    const current = await musicBeatFileShaV1(path, signal);
    if (current.sha256 !== expected.sha256 || current.bytes !== expected.bytes) throw Error("BEAT_MARKER_SOURCE_OR_RUNTIME_CHANGED");
  }
  if (result.binding.source.sha256 !== before.sha256 || result.binding.source.bytes !== before.bytes) throw Error("BEAT_MARKER_SOURCE_CHANGED_DURING_ANALYSIS");
  signal?.throwIfAborted();
  const plan = prepareBeatMarkersV1(project, job, { request, source: { assetId: selected.assetId, assetUri: selected.assetUri,
    sourceSha256: before.sha256, sourceBytes: before.bytes, ffmpegSha256: result.binding.ffmpeg.sha256 }, receipt: result.receipt }, { ...options, signal });
  return { plan, analysis: result };
}
