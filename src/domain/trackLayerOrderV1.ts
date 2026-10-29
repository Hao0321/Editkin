import { EditGraphError } from "./editGraphError";
import type { EditProject, TimelineTrack } from "./types";
import type { EditorCommand } from "./commandTypes";

function refuse(code: string, message: string): never {
  throw Object.assign(new EditGraphError(message), { code });
}

/** Array order is the existing preview/export order. Only selected slots move; clip identities and contents stay intact. */
export function reorderedTrackLayersV1(project: Pick<EditProject, "tracks">, trackIds: readonly string[]): TimelineTrack[] {
  if (!Array.isArray(trackIds) || trackIds.length < 2 || trackIds.length > 128 || new Set(trackIds).size !== trackIds.length
    || trackIds.some(id => typeof id !== "string" || !id || id.length > 512 || id !== id.trim())) refuse("TRACK_LAYER_ORDER_IDENTITIES_INVALID", "圖層順序無效，請重新選取圖層。");
  const byId = new Map(project.tracks.map(track => [track.id, track]));
  if (byId.size !== project.tracks.length) refuse("TRACK_LAYER_ORDER_IDENTITIES_INVALID", "圖層順序無效，請重新選取圖層。");
  const ordered = trackIds.map(id => { const track = byId.get(id); if (!track) refuse("TRACK_LAYER_ORDER_TARGET_MISSING", "指定的圖層已不存在，請重新選取。"); return track; });
  if (ordered.some(track => track.locked)) refuse("TRACK_LAYER_ORDER_TRACK_LOCKED", "圖層已鎖定，請先解鎖。");
  if (ordered.some(track => track.kind !== ordered[0].kind)) refuse("TRACK_LAYER_ORDER_KIND_MISMATCH", "請在相同類型的圖層之間調整順序。");
  const selected = new Set(trackIds); let index = 0;
  return project.tracks.map(track => selected.has(track.id) ? ordered[index++] : track);
}

export function adjacentTrackLayerCommandV1(project: Pick<EditProject, "tracks">, trackId: string,
  direction: "up" | "down"): Extract<EditorCommand, { type: "reorder_tracks" }> | undefined {
  if (direction !== "up" && direction !== "down") refuse("TRACK_LAYER_ORDER_DIRECTION_INVALID", "圖層順序無效，請重新選取圖層。");
  const track = project.tracks.find(item => item.id === trackId);
  if (!track) refuse("TRACK_LAYER_ORDER_TARGET_MISSING", "指定的圖層已不存在，請重新選取。");
  const peers = project.tracks.filter(item => item.kind === track.kind), index = peers.indexOf(track);
  // Later tracks composite over earlier tracks; the UI shows this foreground first.
  const neighbor = peers[index + (direction === "up" ? 1 : -1)];
  if (track.locked || !neighbor || neighbor.locked) return undefined;
  return { type: "reorder_tracks", trackIds: direction === "up" ? [neighbor.id, track.id] : [track.id, neighbor.id] };
}
