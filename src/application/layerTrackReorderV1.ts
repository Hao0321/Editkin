import type { EditorCommand } from "../domain/commandTypes";
import type { EditProject } from "../domain/types";

export const LAYER_TRACK_LOCKED = "圖層已鎖定，請先解鎖。";
export const LAYER_TRACK_KIND_MISMATCH = "請在相同類型的圖層之間調整順序。";

/**
 * Dragging a track in the 圖層 panel onto another track of its kind: the dragged track takes that track's place and the
 * tracks in between shift by one (array order is the composite order; later tracks draw on top). The result is the
 * existing reorder_tracks command over only the tracks that move, so lock, kind and identity checks stay the domain's.
 * Undefined when nothing moves.
 */
export function planLayerTrackMoveV1(project: Pick<EditProject, "tracks">, trackId: string, targetTrackId: string): Extract<EditorCommand, { type: "reorder_tracks" }> | undefined {
  const track = project.tracks.find(item => item.id === trackId), target = project.tracks.find(item => item.id === targetTrackId);
  if (!track || !target) throw new Error("指定的圖層已不存在，請重新選取。");
  if (track.id === target.id) return undefined;
  if (track.kind !== target.kind) throw new Error(LAYER_TRACK_KIND_MISMATCH);
  const peers = project.tracks.filter(item => item.kind === track.kind);
  const from = peers.indexOf(track), to = peers.indexOf(target);
  const moved = [...peers]; moved.splice(from, 1); moved.splice(to, 0, track);
  const low = Math.min(from, to), high = Math.max(from, to);
  const affected = moved.slice(low, high + 1);
  if (affected.some(item => item.locked)) throw new Error(LAYER_TRACK_LOCKED);
  return { type: "reorder_tracks", trackIds: affected.map(item => item.id) };
}
