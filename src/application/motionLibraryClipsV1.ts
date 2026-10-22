import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import type { EditorCommand } from "../domain/commandTypes";
import { MOTION_LIBRARY_AUTO_TRACKS_V1 } from "../domain/motionLibraryCommandsV1";
import { MOTION_LIBRARY_CLIP_SCHEMA_V1, type MotionLibraryClipV1, type TimelineTransitionMotionLibraryV1 } from "../domain/motionLibraryFieldsV1";
import { motionLibraryAssetFileNameV1, motionLibraryFrameRateV1, type MotionLibraryAssetRoleV1 } from "../domain/motionLibraryV1";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type MediaAsset, type TimelineClip } from "../domain/types";
import { getMotionLibraryItem } from "../motionLibrary/catalog";
import { renderMotionLibraryItem, type MotionLibraryRenderProgress, type MotionLibraryRenderResult } from "../motionLibrary/render/renderItem";
import type { MotionLibraryItem } from "../motionLibrary/types";

/**
 * Motion Library Phase 3 service layer (PHASE3_CORE_BRIEF decision 3): render before dispatch, then build pure commands.
 *
 * Cache root: `<workspace>/.editkin-media-cache`, the existing project media cache that freeze/retime derivatives use
 * (mcp/clipRetimeTools.ts). Rendered clips become project assets, and project files only admit assets inside the
 * workspace (mcp/storage.ts writeProject), so the cache stays inside it, on the project's own volume. It is refused when
 * it would land on another volume than the project (never C: for a D: project), inside the OS temp folder for a project
 * that is not itself there, or behind a link or junction. SVG frames are generated under `<cacheRoot>/.motionlib-work`,
 * never in the system Temp.
 */

export const MOTION_LIBRARY_CACHE_DIRECTORY_V1 = ".editkin-media-cache";
export const MOTION_LIBRARY_WORK_DIRECTORY_V1 = ".motionlib-work";

export class MotionLibraryCacheRootRefusalV1 extends Error {
  readonly code = "MOTION_LIBRARY_CACHE_ROOT_REFUSED" as const;
  constructor(detail: string) { super(`MOTION_LIBRARY_CACHE_ROOT_REFUSED: ${detail}`); this.name = "MotionLibraryCacheRootRefusalV1"; }
}

const volume = (path: string) => parse(resolve(path)).root.toLowerCase();
const inside = (root: string, path: string) => {
  const relation = relative(resolve(root), resolve(path));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
};

async function linkedAncestor(path: string): Promise<string | undefined> {
  const root = parse(path).root;
  for (let current = resolve(path); ; current = dirname(current)) {
    try { if ((await lstat(current)).isSymbolicLink()) return current; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (current === root || dirname(current) === current) return undefined;
  }
}

/** Resolves (and creates) the motion library cache root for a project inside `workspaceRoot`. */
export async function resolveMotionLibraryCacheRootV1(input: { projectPath: string; workspaceRoot: string; systemTemp?: string }): Promise<string> {
  const projectPath = resolve(input.projectPath), workspace = resolve(input.workspaceRoot), temp = resolve(input.systemTemp ?? tmpdir());
  if (!isAbsolute(input.projectPath) || !isAbsolute(input.workspaceRoot)) throw new MotionLibraryCacheRootRefusalV1("project and workspace paths must be absolute");
  if (!inside(workspace, projectPath)) throw new MotionLibraryCacheRootRefusalV1("the project is outside the workspace");
  const root = join(workspace, MOTION_LIBRARY_CACHE_DIRECTORY_V1);
  if (volume(root) !== volume(projectPath)) throw new MotionLibraryCacheRootRefusalV1(`cache volume ${volume(root)} differs from the project volume ${volume(projectPath)}`);
  if (inside(temp, root) && !inside(temp, projectPath)) throw new MotionLibraryCacheRootRefusalV1("the cache would sit in the system temp folder");
  const linked = await linkedAncestor(root);
  if (linked) throw new MotionLibraryCacheRootRefusalV1(`the cache path passes through a link or junction (${linked})`);
  await mkdir(root, { recursive: true });
  const [realRoot, realProject] = await Promise.all([realpath(root), realpath(dirname(projectPath))]);
  if (volume(realRoot) !== volume(realProject)) throw new MotionLibraryCacheRootRefusalV1("the resolved cache is on another volume than the project");
  return root;
}

export interface MotionLibraryProjectRenderV1 {
  readonly item: MotionLibraryItem;
  readonly result: MotionLibraryRenderResult;
}

/** Renders one item at the project's (or composition's) size and fps into the cache; cache hits return at once. */
export async function renderMotionLibraryForProjectV1(input: {
  project: Pick<EditProject, "width" | "height" | "fps">; cacheRoot: string; itemId: string; params?: unknown;
  signal?: AbortSignal; onProgress?: (progress: MotionLibraryRenderProgress) => void; ffmpegPath?: string; ffprobePath?: string;
}): Promise<MotionLibraryProjectRenderV1> {
  const item = getMotionLibraryItem(input.itemId);
  const result = await renderMotionLibraryItem({ item, params: input.params, size: { width: input.project.width, height: input.project.height },
    fps: input.project.fps, cacheRoot: input.cacheRoot, preview: false, tempRoot: join(input.cacheRoot, MOTION_LIBRARY_WORK_DIRECTORY_V1),
    signal: input.signal, onProgress: input.onProgress, ffmpegPath: input.ffmpegPath, ffprobePath: input.ffprobePath });
  // The domain recomputes this key from the project's own fps; a renderer that rounded the rate differently is a bug.
  if (result.fps !== motionLibraryFrameRateV1(input.project.fps).text) throw new Error(`Motion library render fps ${result.fps} differs from the project clock`);
  return { item, result };
}

/** The project asset record of one rendered output (deterministic id: re-adding the same render reuses the asset). */
export function motionLibraryAssetRecordV1(render: MotionLibraryProjectRenderV1, role: MotionLibraryAssetRoleV1): MediaAsset {
  const { item, result } = render;
  const output = result.outputs[role === "clip" ? "clip" : role];
  if (!output) throw new Error(`Motion library ${item.id} has no ${role} output`);
  const expectedName = motionLibraryAssetFileNameV1(result.cacheKey, role);
  if (!output.path.replace(/\\/g, "/").endsWith(`/motionlib/${item.id}/${expectedName}`)) throw new Error(`Motion library ${role} output is not ${expectedName}`);
  return {
    id: `motionlib-${item.id}-${role}-${result.cacheKey.slice(0, 16)}`,
    name: `${item.names.zh}${role === "clip" ? "" : role === "matte" ? "（轉場遮罩）" : "（轉場色層）"}`,
    kind: "video", uri: output.path,
    // frameCount · den / num, the same expression the domain checks (motionLibraryClipSecondsV1).
    duration: result.durationSeconds,
    width: result.width, height: result.height,
    alphaMode: role === "clip" && item.kind === "background" ? "opaque" : "straight",
    color: { interpretation: "rec709", primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" },
  };
}

function clipField(render: MotionLibraryProjectRenderV1): MotionLibraryClipV1 {
  const { item, result } = render;
  if (item.kind === "transition") throw new Error(`${item.id} is a transition; use motionLibraryTransitionCommandsV1`);
  return { schema: MOTION_LIBRARY_CLIP_SCHEMA_V1, itemId: item.id, kind: item.kind, itemRevision: result.itemRevision,
    params: structuredClone(result.params) as Record<string, unknown>, engineVersion: result.engineVersion, cacheKey: result.cacheKey };
}

const frameAligned = (frames: number, fps: number) => frames / fps;

/**
 * add_motion_library_clip for a rendered text or background item, `startFrame` on `trackId`. Without `trackId` the command
 * places the clip itself (`autoTrack`): on the first Motion Library track of its kind where it fits, or on a new one.
 */
export function motionLibraryAddClipCommandV1(project: Pick<EditProject, "fps">, render: MotionLibraryProjectRenderV1,
  placement: { clipId: string; trackId?: string; startFrame: number; durationFrames?: number }): Extract<EditorCommand, { type: "add_motion_library_clip" }> {
  const asset = motionLibraryAssetRecordV1(render, "clip");
  const frames = placement.durationFrames ?? render.result.frameCount;
  if (!Number.isSafeInteger(placement.startFrame) || placement.startFrame < 0 || !Number.isSafeInteger(frames) || frames < 1 || frames > render.result.frameCount) {
    throw new Error(`Motion library clip window must be whole frames within the ${render.result.frameCount}-frame render`);
  }
  if (render.item.kind === "transition") throw new Error(`${render.item.id} is a transition; use motionLibraryTransitionCommandsV1`);
  const trackId = placement.trackId ?? MOTION_LIBRARY_AUTO_TRACKS_V1[render.item.kind].base;
  const clip: TimelineClip = { id: placement.clipId, assetId: asset.id, trackId, timelineStart: frameAligned(placement.startFrame, project.fps),
    sourceStart: 0, duration: frameAligned(frames, project.fps), volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
    motionLibrary: clipField(render) };
  return { type: "add_motion_library_clip", asset, clip, ...(placement.trackId === undefined ? { autoTrack: true as const } : {}) };
}

/** update_motion_library_clip: swaps `clip` to a new render and, by default, fits its duration to the render. */
export function motionLibraryUpdateClipCommandV1(project: Pick<EditProject, "fps">, clip: TimelineClip, render: MotionLibraryProjectRenderV1,
  options: { keepTiming?: boolean } = {}): Extract<EditorCommand, { type: "update_motion_library_clip" }> {
  if (!clip.motionLibrary) throw new Error(`${clip.id} is not a motion library clip`);
  const asset = motionLibraryAssetRecordV1(render, "clip");
  return { type: "update_motion_library_clip", clipId: clip.id, expected: { assetId: clip.assetId, cacheKey: clip.motionLibrary.cacheKey }, asset,
    motionLibrary: clipField(render), ...(options.keepTiming ? {} : { sourceStart: 0, duration: frameAligned(render.result.frameCount, project.fps) }) };
}

/** import_asset for the matte (and overlay) unless the same render is registered, then set_timeline_transition (matte). */
export function motionLibraryTransitionCommandsV1(project: Pick<EditProject, "assets">, render: MotionLibraryProjectRenderV1,
  cut: { transitionId: string; trackId: string; fromClipId: string; toClipId: string; beforeFrames: number; afterFrames: number }): EditorCommand[] {
  const { item, result } = render;
  if (item.kind !== "transition") throw new Error(`${item.id} is not a transition`);
  if (result.frameCount !== cut.beforeFrames + cut.afterFrames) throw new Error(`Matte has ${result.frameCount} frames; the cut window has ${cut.beforeFrames + cut.afterFrames}`);
  const matte = motionLibraryAssetRecordV1(render, "matte"), overlay = result.outputs.overlay ? motionLibraryAssetRecordV1(render, "overlay") : undefined;
  const imports = [matte, ...(overlay ? [overlay] : [])].filter(asset => !project.assets.some(existing => existing.id === asset.id))
    .map(asset => ({ type: "import_asset" as const, asset }));
  const motionLibrary: TimelineTransitionMotionLibraryV1 = { itemId: item.id, itemRevision: result.itemRevision, params: structuredClone(result.params) as Record<string, unknown>,
    engineVersion: result.engineVersion, cacheKey: result.cacheKey, matteAssetId: matte.id, ...(overlay ? { overlayAssetId: overlay.id } : {}) };
  return [...imports, { type: "set_timeline_transition", transition: { schema: "editkin.timeline-transition/v1", id: cut.transitionId, trackId: cut.trackId,
    fromClipId: cut.fromClipId, toClipId: cut.toClipId, beforeFrames: cut.beforeFrames, afterFrames: cut.afterFrames, kernel: "matte", motionLibrary } }];
}

/**
 * Pre-dispatch file check: every asset a motion library clip or matte transition references exists as a regular file
 * whose size matches the cache manifest written beside it. The pure commands cannot see the disk; the service layer
 * runs this before dispatching them (prepare does, after rendering).
 */
export async function assertMotionLibraryProjectFilesV1(project: EditProject, resolvePath: (uri: string) => string | Promise<string> = uri => uri): Promise<number> {
  const ids = new Map<string, string>();
  for (const container of [project, ...project.compositions]) {
    for (const clip of container.tracks.flatMap(track => track.clips)) if (clip.motionLibrary) ids.set(clip.assetId, clip.motionLibrary.cacheKey);
    for (const transition of container.timelineTransitions ?? []) if (transition.motionLibrary) {
      ids.set(transition.motionLibrary.matteAssetId, transition.motionLibrary.cacheKey);
      if (transition.motionLibrary.overlayAssetId) ids.set(transition.motionLibrary.overlayAssetId, transition.motionLibrary.cacheKey);
    }
  }
  for (const [assetId, cacheKey] of ids) {
    const asset = project.assets.find(candidate => candidate.id === assetId);
    if (!asset) throw new Error(`MOTION_LIBRARY_ASSET_MISSING: ${assetId}`);
    const path = await resolvePath(asset.uri);
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile() || info.size < 1) throw new Error(`MOTION_LIBRARY_ASSET_MISSING: ${assetId} has no rendered file at ${path}`);
    let manifest: { cacheKey?: string; outputs?: Record<string, { file?: string; bytes?: number }> } | undefined;
    try { manifest = JSON.parse(await readFile(join(dirname(path), `${cacheKey}.json`), "utf8")); } catch { manifest = undefined; }
    const output = manifest?.cacheKey === cacheKey ? Object.values(manifest.outputs ?? {}).find(entry => entry.file === parse(path).base) : undefined;
    if (!output || output.bytes !== info.size) throw new Error(`MOTION_LIBRARY_ASSET_BINDING_MISMATCH: ${assetId} does not match its cache manifest`);
  }
  return ids.size;
}
