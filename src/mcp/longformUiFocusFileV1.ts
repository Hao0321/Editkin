import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { readProject, resolveWorkspaceMediaPath } from "./storage";
import { findAsset, findClip } from "../domain/editGraph";
import { longformUiFocusFileRequestV1Schema, type LongformUiFocusArtifactV1 } from "../domain/longformUiFocusFileV1";
import { colorDigest, colorFileSha, getMaterialColorRuntimeIdentity } from "../application/materialColorSamplingRuntime";
import { longformSourceSha256V1, resolveLongformSourceV1 } from "../application/longformMaterialIntakeV1";
import { detectLongformUiFocusV1, type LongformUiFocusRuntimeV1 } from "../application/longformUiFocusRuntimeV1";
import { confirmLongformUiFocusV1 } from "../application/longformUiFocusV1";
import { windowsOcrExecutableV1 } from "../application/windowsOcrRuntimeV1";
import { longformUiFocusAlgorithmSha256V1, publishLongformUiFocusArtifactV1, readLongformUiFocusArtifactV1,
  readLongformUiFocusImageV1, sealLongformUiFocusArtifactV1, summarizeLongformUiFocusArtifactV1 } from "../application/longformUiFocusArtifactV1";

export interface LongformUiFocusFileRuntimeV1 extends Omit<LongformUiFocusRuntimeV1, "onFrame" | "color"> { cacheRoot: string }
export interface LongformUiFocusFileDepsV1 { read: typeof readProject; detect: typeof detectLongformUiFocusV1 }
const production: LongformUiFocusFileDepsV1 = { read: readProject, detect: detectLongformUiFocusV1 };
const busyCacheRoots = new Set<string>();
async function context(raw: unknown, deps: LongformUiFocusFileDepsV1) {
  const request = longformUiFocusFileRequestV1Schema.parse(raw), project = await deps.read(request.projectPath);
  if (project.revision !== request.expectedRevision) throw Error("UI_FOCUS_PROJECT_REVISION");
  const clip = findClip(project, request.clipId), asset = findAsset(project, clip.assetId);
  const track = project.tracks.find(track => track.clips.includes(clip));
  if (track?.kind !== "video" || asset.kind !== "video") throw Error("UI_FOCUS_VIDEO_CLIP_REQUIRED");
  if (request.frameTimes.some(t => t >= clip.duration)) throw Error("UI_FOCUS_FRAME_OUTSIDE_CLIP");
  return { request, project, clip, asset };
}
export async function prepareLongformUiFocusFileV1(raw: unknown, runtime: LongformUiFocusFileRuntimeV1,
  onProgress?: (value: { completedFrames: number; totalFrames: number }) => void | Promise<void>, deps = production) {
  longformUiFocusFileRequestV1Schema.parse(raw); runtime.signal?.throwIfAborted();
  if (!isAbsolute(runtime.cacheRoot)) throw Error("UI_FOCUS_ABSOLUTE_CACHE_ROOT_REQUIRED");
  await mkdir(runtime.cacheRoot, { recursive: true });
  const root = await realpath(runtime.cacheRoot);
  if (busyCacheRoots.has(root)) throw Error("UI_FOCUS_CACHE_BUSY");
  busyCacheRoots.add(root);
  try { return await prepare(raw, runtime, onProgress, deps); } finally { busyCacheRoots.delete(root); }
}
async function prepare(raw: unknown, runtime: LongformUiFocusFileRuntimeV1,
  onProgress?: (value: { completedFrames: number; totalFrames: number }) => void | Promise<void>, deps = production) {
  runtime.signal?.throwIfAborted(); const c = await context(raw, deps);
  const sourcePath = await resolveLongformSourceV1(runtime.sourceRoot, await resolveWorkspaceMediaPath(c.asset.uri));
  const before = await longformSourceSha256V1(sourcePath, runtime.signal), algorithmSha256 = await longformUiFocusAlgorithmSha256V1();
  const images = new Map<string, Uint8Array>();
  const draft = await deps.detect({ schema: "editkin.longform-ui-focus-request/v1", recordingId: c.clip.id,
    sourcePath, expectedSourceSha256: before.sha256, sourceStart: c.clip.sourceStart, duration: c.clip.duration,
    language: c.request.language, frameTimes: c.request.frameTimes, targetTexts: c.request.targetTexts },
  { ...runtime, color: c.asset.color, onFrame: async frame => {
    images.set(frame.id, Uint8Array.from(frame.data)); await onProgress?.({ completedFrames: images.size, totalFrames: c.request.frameTimes.length });
  } });
  const artifact = sealLongformUiFocusArtifactV1({ schema: "editkin.longform-ui-focus-artifact/v1", request: c.request, algorithmSha256,
    project: { id: c.project.id, revision: c.project.revision, canonicalSha256: colorDigest(c.project), clipId: c.clip.id, assetId: c.asset.id }, sourcePath, draft });
  await assertCurrent(artifact, runtime, deps); runtime.signal?.throwIfAborted();
  await publishLongformUiFocusArtifactV1(runtime.cacheRoot, artifact, images);
  await assertCurrent(artifact, runtime, deps); runtime.signal?.throwIfAborted();
  return { artifact, summary: summarizeLongformUiFocusArtifactV1(artifact) };
}
async function assertCurrent(artifact: LongformUiFocusArtifactV1, runtime: LongformUiFocusFileRuntimeV1, deps: LongformUiFocusFileDepsV1) {
  runtime.signal?.throwIfAborted(); const c = await context(artifact.request, deps);
  if (colorDigest(c.project) !== artifact.project.canonicalSha256 || c.project.id !== artifact.project.id
    || c.clip.id !== artifact.project.clipId || c.asset.id !== artifact.project.assetId
    || c.clip.sourceStart !== artifact.draft.source.start || c.clip.duration !== artifact.draft.source.duration) throw Error("UI_FOCUS_PROJECT_CHANGED");
  if (artifact.draft.source.recordingId !== c.clip.id
    || artifact.draft.frames.some(frame => frame.ocr.result.language.toLowerCase() !== artifact.request.language.toLowerCase()
      || frame.display.requested.time !== artifact.request.frameTimes[Number(frame.id.replace("focus-frame-", "")) - 1]))
    throw Error("UI_FOCUS_REQUEST_BINDING");
  const path = await resolveLongformSourceV1(runtime.sourceRoot, await resolveWorkspaceMediaPath(c.asset.uri));
  if (await realpath(artifact.sourcePath) !== path || (await longformSourceSha256V1(path, runtime.signal)).sha256 !== artifact.draft.source.sha256)
    throw Error("UI_FOCUS_SOURCE_CHANGED");
  if (await longformUiFocusAlgorithmSha256V1() !== artifact.algorithmSha256) throw Error("UI_FOCUS_ALGORITHM_CHANGED");
  const identity = await getMaterialColorRuntimeIdentity(runtime); runtime.signal?.throwIfAborted();
  if (identity.status !== "verified" || artifact.draft.frames.some(frame => frame.display.runtimeIdentitySha256 !== identity.identitySha256)) throw Error("UI_FOCUS_DECODE_RUNTIME_CHANGED");
  const powershellSha = await colorFileSha(windowsOcrExecutableV1());
  if (artifact.draft.frames.some(frame => frame.ocr.provider.executableSha256 !== powershellSha)) throw Error("UI_FOCUS_OCR_PROVIDER_CHANGED");
}
/** Caller must independently establish this owner produced the artifact ID.
 * Reading a correctly hashed external manifest alone is never confirmation. */
export async function readCurrentLongformUiFocusFileV1(id: string, runtime: LongformUiFocusFileRuntimeV1, deps = production) {
  const artifact = await readLongformUiFocusArtifactV1(runtime.cacheRoot, id); await assertCurrent(artifact, runtime, deps);
  for (const frame of artifact.draft.frames) await readLongformUiFocusImageV1(runtime.cacheRoot, artifact, frame.id);
  await assertCurrent(artifact, runtime, deps); runtime.signal?.throwIfAborted(); return artifact;
}
export async function confirmLongformUiFocusFileV1(artifact: LongformUiFocusArtifactV1, candidateIds: string[], runtime: LongformUiFocusFileRuntimeV1, deps = production) {
  await assertCurrent(artifact, runtime, deps);
  const value = confirmLongformUiFocusV1(artifact.draft, { draftId: artifact.draft.draftId, candidateIds });
  await assertCurrent(artifact, runtime, deps); runtime.signal?.throwIfAborted();
  return { ...value, artifactId: artifact.artifactId, projectRevision: artifact.project.revision,
    artworkStatus: "ART_PENDING_CLAUDE" as const, selectableByDefault: false as const };
}
