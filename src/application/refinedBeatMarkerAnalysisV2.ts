import { isAbsolute, resolve } from "node:path";
import { resolveMediaPath } from "../render/mediaProcess";
import type { EditProject } from "../domain/types";
import type { BeatMarkerJobV1 } from "./beatMarkersV1";
import { analyzeMusicBeatsV1, musicBeatFileShaV1, type MusicBeatsRuntimeV1 } from "./musicBeats";
import { refinedBeatMarkerJobSourceV2, prepareRefinedBeatMarkersV2, refinedBeatMarkerCommandForProjectV2, type RefinedBeatMarkerOptionsV2 } from "./refinedBeatMarkersV2";

const sourcePlans = new WeakMap<object, { job: BeatMarkerJobV1; options: RefinedBeatMarkerOptionsV2;
  files: ReadonlyArray<Readonly<{ path: string; sha256: string; bytes: number }>>; signal?: AbortSignal }>();

/** Package source operation only. No bridge, model, fallback to observed v1 or project mutation. */
export async function analyzeRefinedBeatMarkersV2(project: EditProject, job: BeatMarkerJobV1, requestedInput: {
  assetBase: string; expectedSourceSha256: string; priorBpm?: number;
}, requestedRuntime: MusicBeatsRuntimeV1, requestedOptions: RefinedBeatMarkerOptionsV2) {
  const input = Object.freeze({ ...requestedInput }), runtime = Object.freeze({ ...requestedRuntime });
  const options = Object.freeze({ ...requestedOptions, labels: Object.freeze({ ...requestedOptions.labels }),
    ...(requestedOptions.timelineRange ? { timelineRange: Object.freeze({ ...requestedOptions.timelineRange }) } : {}) });
  const selected = refinedBeatMarkerJobSourceV2(project, job, options), signal = runtime.signal ?? options.signal;
  if (runtime.signal && options.signal && runtime.signal !== options.signal) throw Error("REFINED_BEAT_MARKER_SINGLE_OWNER_SIGNAL_REQUIRED"); signal?.throwIfAborted();
  if (!isAbsolute(input.assetBase) || resolve(input.assetBase) !== input.assetBase || !/^[a-f0-9]{64}$/.test(input.expectedSourceSha256)) throw Error("REFINED_BEAT_MARKER_HOST_SOURCE_REQUIRED");
  const sourcePath = resolve(resolveMediaPath(selected.assetUri, input.assetBase)), before = await musicBeatFileShaV1(sourcePath, signal);
  if (before.sha256 !== input.expectedSourceSha256) throw Error("REFINED_BEAT_MARKER_SOURCE_SHA_CHANGED");
  const request = { sourcePath, sourceStartSeconds: selected.sourceStartSeconds, durationSeconds: selected.durationSeconds, rhythmRefinementV2: true as const,
    ...(input.priorBpm === undefined ? {} : { priorBpm: input.priorBpm }) };
  const analysis = await analyzeMusicBeatsV1(request, { ...runtime, signal });
  for (const [path, expected] of [[sourcePath, analysis.binding.source], [runtime.ffmpegPath, analysis.binding.ffmpeg],
    [runtime.ffprobePath, analysis.binding.ffprobe], [runtime.nativeCorePath, analysis.binding.core]] as const) {
    const now = await musicBeatFileShaV1(path, signal); if (now.sha256 !== expected.sha256 || now.bytes !== expected.bytes) throw Error("REFINED_BEAT_MARKER_SOURCE_OR_RUNTIME_CHANGED");
  }
  if (analysis.binding.source.sha256 !== before.sha256 || analysis.binding.source.bytes !== before.bytes) throw Error("REFINED_BEAT_MARKER_SOURCE_CHANGED_DURING_ANALYSIS");
  signal?.throwIfAborted();
  const plan = prepareRefinedBeatMarkersV2(project, job, { request, source: { assetId: selected.assetId, assetUri: selected.assetUri,
    sourceSha256: before.sha256, sourceBytes: before.bytes, ffmpegSha256: analysis.binding.ffmpeg.sha256 }, receipt: analysis.receipt }, { ...options, signal });
  const identities = [[sourcePath, analysis.binding.source], [runtime.ffmpegPath, analysis.binding.ffmpeg],
    [runtime.ffprobePath, analysis.binding.ffprobe], [runtime.nativeCorePath, analysis.binding.core]] as const;
  const files = Object.freeze(identities.map(([path, identity]) => Object.freeze({ path, sha256: identity.sha256, bytes: identity.bytes })));
  sourcePlans.set(plan, { job, options: Object.freeze({ ...options, signal }), files, signal });
  return { plan, analysis };
}
/** Host-only final readback after review. Re-read the latest project after the asynchronous file checks.
 * The host dispatches the returned command immediately through its existing history owner. */
export async function refinedBeatMarkerCommandForSourceV2(getCurrentProject: () => EditProject | Promise<EditProject>, plan: object) {
  const owner = sourcePlans.get(plan); if (!owner) throw Error("REFINED_BEAT_MARKER_SOURCE_PLAN_FOREIGN");
  owner.signal?.throwIfAborted(); refinedBeatMarkerJobSourceV2(await getCurrentProject(), owner.job, owner.options);
  for (const file of owner.files) {
    const current = await musicBeatFileShaV1(file.path, owner.signal);
    if (current.sha256 !== file.sha256 || current.bytes !== file.bytes) throw Error("REFINED_BEAT_MARKER_SOURCE_OR_RUNTIME_CHANGED_BEFORE_COMMIT");
  }
  owner.signal?.throwIfAborted(); return refinedBeatMarkerCommandForProjectV2(await getCurrentProject(), plan);
}
