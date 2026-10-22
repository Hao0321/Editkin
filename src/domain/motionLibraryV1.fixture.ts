import { getMotionLibraryItem } from "../motionLibrary/catalog";
import { resolveMotionLibraryParams } from "../motionLibrary/params";
import { MOTION_LIBRARY_ENGINE_VERSION, type MotionLibraryParams } from "../motionLibrary/types";
import { applyCommand } from "./commands";
import { createEmptyProject } from "./editGraph";
import { MOTION_LIBRARY_CLIP_SCHEMA_V1, type MotionLibraryClipV1, type TimelineTransitionMotionLibraryV1 } from "./motionLibraryFieldsV1";
import { motionLibraryAssetFileNameV1, motionLibraryCacheKeyV1, motionLibraryClipSecondsV1, motionLibraryFrameCountV1, motionLibraryFrameRateV1, type MotionLibraryAssetRoleV1 } from "./motionLibraryV1";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type MediaAsset, type TimelineClip } from "./types";

/** Test fixture: field + asset records exactly as the service layer writes them, without rendering anything. */
export const FIXTURE_CACHE_ROOT = "D:/fixture-project/.editkin-media-cache";

export function fixtureAsset(itemId: string, cacheKey: string, role: MotionLibraryAssetRoleV1, frameCount: number, project: Pick<EditProject, "width" | "height" | "fps">,
  alphaMode: "straight" | "opaque"): MediaAsset {
  return { id: `motionlib-${role}-${cacheKey.slice(0, 16)}`, name: `${itemId} ${role}`, kind: "video",
    uri: `${FIXTURE_CACHE_ROOT}/motionlib/${itemId}/${motionLibraryAssetFileNameV1(cacheKey, role)}`,
    duration: motionLibraryClipSecondsV1(frameCount, motionLibraryFrameRateV1(project.fps)), width: project.width, height: project.height, alphaMode,
    color: { interpretation: "rec709", primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" } };
}

export function fixtureClipField(project: Pick<EditProject, "width" | "height" | "fps">, itemId = "T01", input: unknown = {}) {
  const item = getMotionLibraryItem(itemId);
  if (item.kind === "transition") throw Error("fixtureClipField takes a text or background item");
  const params = resolveMotionLibraryParams(item, input) as MotionLibraryParams;
  const cacheKey = motionLibraryCacheKeyV1({ itemId, itemRevision: item.revision ?? 1, kind: item.kind, params, width: project.width, height: project.height, fps: project.fps });
  const field: MotionLibraryClipV1 = { schema: MOTION_LIBRARY_CLIP_SCHEMA_V1, itemId, kind: item.kind, itemRevision: item.revision ?? 1,
    params: structuredClone(params) as Record<string, unknown>, engineVersion: MOTION_LIBRARY_ENGINE_VERSION, cacheKey };
  const frameCount = motionLibraryFrameCountV1(params.durationSeconds, motionLibraryFrameRateV1(project.fps));
  return { field, frameCount, asset: fixtureAsset(itemId, cacheKey, "clip", frameCount, project, item.kind === "text" ? "straight" : "opaque") };
}

export function fixtureTransitionField(project: Pick<EditProject, "width" | "height" | "fps">, windowFrames: number, itemId = "X01", overlay = true, input: Record<string, unknown> = {}) {
  const item = getMotionLibraryItem(itemId);
  const rate = motionLibraryFrameRateV1(project.fps);
  const params = resolveMotionLibraryParams(item, { ...input, durationSeconds: motionLibraryClipSecondsV1(windowFrames, rate) }) as MotionLibraryParams;
  const cacheKey = motionLibraryCacheKeyV1({ itemId, itemRevision: item.revision ?? 1, kind: "transition", params, width: project.width, height: project.height, fps: project.fps });
  const matte = fixtureAsset(itemId, cacheKey, "matte", windowFrames, project, "straight");
  const overlayAsset = overlay ? fixtureAsset(itemId, cacheKey, "overlay", windowFrames, project, "straight") : undefined;
  const field: TimelineTransitionMotionLibraryV1 = { itemId, itemRevision: item.revision ?? 1, params: structuredClone(params) as Record<string, unknown>,
    engineVersion: MOTION_LIBRARY_ENGINE_VERSION, cacheKey, matteAssetId: matte.id, ...(overlayAsset ? { overlayAssetId: overlayAsset.id } : {}) };
  return { field, matte, overlay: overlayAsset };
}

export function plainClip(id: string, assetId: string, trackId: string, timelineStart: number, sourceStart: number, duration: number): TimelineClip {
  return { id, assetId, trackId, timelineStart, sourceStart, duration, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] };
}

/** 1080×1920 30 fps: footage cut in two on video-main, plus an empty overlay track. */
export function motionLibraryFixtureProject(): EditProject {
  let project = createEmptyProject("Motion library fixture", { id: "motion-library-fixture", width: 1080, height: 1920, fps: 30 });
  project = applyCommand(project, { type: "import_asset", asset: { id: "footage", name: "Footage", kind: "video", uri: "footage.mp4", duration: 10, width: 1080, height: 1920 } });
  project = applyCommand(project, { type: "add_clip", clip: plainClip("a", "footage", "video-main", 0, 1, 3) });
  project = applyCommand(project, { type: "add_clip", clip: plainClip("b", "footage", "video-main", 3, 5, 3) });
  project = applyCommand(project, { type: "add_track", track: { id: "overlay", name: "Overlay", kind: "video", locked: false, muted: false, clips: [] } });
  return project;
}
