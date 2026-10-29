import type { CaptionCue, MotionGraphic, TimelineTrack } from "../domain/types";
import { adjacentTrackLayerCommandV1 } from "../domain/trackLayerOrderV1";
import type { EditingLayerSelectionV1 } from "./editingWorkspaceV1";

export const EDITING_LAYER_PAGE_SIZE_V1 = 20;
export interface EditingLayerPageNavigationV1 { anchor: string; offset: number }
export interface EditingLayerDisclosureV1 { anchor: string | object; open: boolean }
/** Read-only references, rebuilt only when the project's track array changes. No project mutation. */
export function createEditingTrackIndexV1(tracks: readonly TimelineTrack[]) {
  const clips = new Map<string, { track: TimelineTrack; index: number }>();
  const peers = new Map<TimelineTrack["kind"], TimelineTrack[]>();
  for (const track of tracks) {
    const group = peers.get(track.kind) ?? []; group.push(track); peers.set(track.kind, group);
    track.clips.forEach((clip, index) => clips.set(clip.id, { track, index }));
  }
  const positions = new Map<string, { group: TimelineTrack[]; index: number }>();
  for (const group of peers.values()) group.forEach((track, index) => positions.set(track.id, { group, index }));
  return {
    displayTracks: [...tracks].reverse(), clips,
    adjacentCommand(trackId: string, direction: "up" | "down") {
      const position = positions.get(trackId);
      // Reuse the original guard, lock policy and command bytes with only the true adjacent peers.
      const nearby = position ? position.group.slice(Math.max(0, position.index - 1), position.index + 2) : [];
      return adjacentTrackLayerCommandV1({ tracks: nearby }, trackId, direction);
    },
  };
}
export function editingLayerLocationV1(index: ReturnType<typeof createEditingTrackIndexV1>, captions: readonly CaptionCue[],
  graphics: readonly MotionGraphic[], selection?: EditingLayerSelectionV1) {
  if (!selection) return undefined;
  if (selection.kind === "clip") {
    const found = index.clips.get(selection.id);
    return found ? { ...selection, trackId: found.track.id, index: found.index } : undefined;
  }
  const selectedIndex = (selection.kind === "caption" ? captions : graphics).findIndex(item => item.id === selection.id);
  return selectedIndex >= 0 ? { ...selection, trackId: undefined, index: selectedIndex } : undefined;
}
/** Manual browsing lasts until the selected identity or position changes. Old callbacks cannot override a new anchor. */
export function editingLayerPageV1(count: number, selectedId: string | undefined, selectedIndex: number, navigation?: EditingLayerPageNavigationV1) {
  const anchor = JSON.stringify([selectedId ?? null, selectedIndex]);
  const validCount = Number.isSafeInteger(count) && count > 0 ? count : 0;
  const maxStart = validCount ? Math.floor((validCount - 1) / EDITING_LAYER_PAGE_SIZE_V1) * EDITING_LAYER_PAGE_SIZE_V1 : 0;
  const follow = selectedId !== undefined && Number.isSafeInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < validCount
    ? Math.floor(selectedIndex / EDITING_LAYER_PAGE_SIZE_V1) * EDITING_LAYER_PAGE_SIZE_V1 : 0;
  const requested = navigation?.anchor === anchor && Number.isSafeInteger(navigation.offset) ? navigation.offset : follow;
  const start = Math.min(maxStart, Math.max(0, Math.floor(requested / EDITING_LAYER_PAGE_SIZE_V1) * EDITING_LAYER_PAGE_SIZE_V1));
  return { anchor, start };
}
export function editingLayerDisclosureOpenV1(saved: EditingLayerDisclosureV1 | undefined, anchor: string | object, containsSelection: boolean): boolean {
  return saved?.anchor === anchor ? saved.open : containsSelection || saved?.open === true;
}
