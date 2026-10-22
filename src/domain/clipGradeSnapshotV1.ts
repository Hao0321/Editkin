import type { EditProject, TimelineClip } from "./types";
import type { EditorCommand } from "./commandTypes";
import { animatedClipState, findAsset, findClip, findTrack } from "./editGraph";
import { EditGraphError } from "./editGraphError";
import { TRACK_LOCKED_MESSAGE } from "./trackLock";
import { clipGradeSnapshotV1Schema, type ClipGradeSnapshotV1 } from "./clipGradeSnapshotV1Schema";
import { combineLookColor } from "../creative/corePack";
import { findFilmLookV2 } from "../creative/filmLooksV2";
export const CLIP_GRADE_SNAPSHOT_BYTES_V1 = 128 * 1024;
export function assertClipGradeSnapshotV1(value: unknown): ClipGradeSnapshotV1 {
  const parsed = clipGradeSnapshotV1Schema.safeParse(value);
  if (!parsed.success) throw new EditGraphError("調色快照不合法。");
  if (parsed.data.gradeV2?.look && !findFilmLookV2(parsed.data.gradeV2.look.id)) throw new EditGraphError("調色快照引用不存在的 Look。");
  if (new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength > CLIP_GRADE_SNAPSHOT_BYTES_V1) throw new EditGraphError("調色快照超過大小上限。");
  return parsed.data;
}
function gradeClip(project: EditProject, clipId: string) {
  const clip = findClip(project, clipId), track = findTrack(project, clip.trackId), asset = findAsset(project, clip.assetId);
  if (track.kind !== "video" || !["image", "video"].includes(asset.kind) || (clip.layer?.role ?? "content") !== "content") throw new EditGraphError("目前只能複製或貼上影像內容片段的調色。");
  return { clip, track, asset };
}
export function captureClipGradeSnapshotV1(project: EditProject, clipId: string, playhead: number) {
  if (!Number.isFinite(playhead)) throw new EditGraphError("調色取樣時間不合法。");
  const { clip, asset } = gradeClip(project, clipId), localTime = Math.max(0, Math.min(clip.duration, playhead - clip.timelineStart));
  const color = combineLookColor(animatedClipState(clip, localTime, project.fps).color, clip.creative?.lookPresetId);
  return { snapshot: assertClipGradeSnapshotV1({ schema: "editkin.clip-grade-snapshot/v1", color, ...(clip.gradeV2 ? { gradeV2: clip.gradeV2 } : {}) }), sourceName: asset.name, localTime };
}
/** Change only colour fields, in one linear pass. Target transform/timing/audio/source references remain exact. */
export function assertClipGradePasteTargetV1(project: EditProject, clipId: string) {
  const target = gradeClip(project, clipId);
  if (target.track.locked) throw new EditGraphError(TRACK_LOCKED_MESSAGE);
  return target;
}
export function pasteClipGradeSnapshotV1(project: EditProject, clipId: string, value: unknown): TimelineClip {
  const snapshot = assertClipGradeSnapshotV1(value), { clip } = assertClipGradePasteTargetV1(project, clipId);
  const color = snapshot.color, next: TimelineClip = { ...clip, color: { ...color }, keyframes: clip.keyframes.map(k => ({ ...k, color: { ...color } })) };
  if (snapshot.gradeV2) next.gradeV2 = structuredClone(snapshot.gradeV2); else delete next.gradeV2;
  if (clip.creative?.lookPresetId) { next.creative = { ...clip.creative }; delete next.creative.lookPresetId; }
  return next;
}
/** Dispatcher fallback for a batch uses the same mutation on its already-cloned project. */
export function applyClipGradeSnapshotInPlaceV1(project: EditProject, command: Extract<EditorCommand, { type: "paste_clip_grade_v1" }>): void {
  const next = pasteClipGradeSnapshotV1(project, command.clipId, command.snapshot), track = findTrack(project, next.trackId);
  track.clips[track.clips.findIndex(c => c.id === command.clipId)] = next;
}
/** Copy-on-write path: do not clone every clip of a long project for a one-clip grade paste. */
export function applyClipGradeSnapshotFastV1(input: EditProject, command: Extract<EditorCommand, { type: "paste_clip_grade_v1" }>): EditProject {
  const nextClip = pasteClipGradeSnapshotV1(input, command.clipId, command.snapshot), tracks = [...input.tracks], index = tracks.findIndex(t => t.id === nextClip.trackId), track = tracks[index];
  const clips = [...track.clips], clipIndex = clips.findIndex(c => c.id === command.clipId); clips[clipIndex] = nextClip; tracks[index] = { ...track, clips };
  const previous = Date.parse(input.updatedAt);
  return { ...input, tracks, updatedAt: new Date(Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0)).toISOString() };
}
