import type { EditorCommand } from "./commandTypes";
import type { EditComposition, EditProject } from "./types";
import { projectVisualLayersV1, resolveUnifiedLayerOrderV1, resolveUnifiedLayerOrderStateV1, type UnifiedLayerOrderV1, type UnifiedLayerRefV1 } from "./unifiedLayerOrderV1";

const identity = (ref: UnifiedLayerRefV1) => `${ref.kind}\0${ref.id}`;
const identityEdits: ReadonlySet<EditorCommand["type"]> = new Set([
  "add_clip", "delete_clip", "ripple_delete_clip", "split_clip", "smart_cut_clip", "add_track", "delete_track", "delete_asset",
  "move_clip_to_track", "add_caption", "delete_caption", "add_motion_graphic", "delete_motion_graphic", "delete_motion_scene",
  "clear_template_application", "precompose_clips", "reorder_tracks", "reorder_motion_graphics",
]);
function refuse(code: string): never { throw Object.assign(new Error(code), { code }); }
function defaultOrder(project: EditProject | EditComposition): UnifiedLayerOrderV1 {
  return { schema: "editkin.unified-layer-order/v1", layers: projectVisualLayersV1(project).map(({ kind, id }) => ({ kind, id })) };
}

export function assertUnifiedLayerOrderEditInputV1(project: EditProject, command: EditorCommand): void {
  if (project.unifiedLayerOrderV1 && (identityEdits.has(command.type) || command.type === "batch" || command.type === "set_unified_layer_order")) {
    resolveUnifiedLayerOrderStateV1(project, project.unifiedLayerOrderV1);
  }
}

/** Revision is a file revision. The monotonic in-memory updatedAt stamp is required as well. */
export function applyUnifiedLayerOrderCommandV1(project: EditProject, command: EditorCommand): boolean {
  if (command.type !== "set_unified_layer_order") return false;
  const expected = command.expected;
  if (!expected || expected.projectId !== project.id || expected.revision !== project.revision || expected.updatedAt !== project.updatedAt
    || !Number.isSafeInteger(expected.revision) || expected.revision < 0) refuse("UNIFIED_LAYER_EDIT_STALE");
  const target = command.compositionId === undefined ? project : project.compositions.find(item => item.id === command.compositionId);
  if (!target) refuse("UNIFIED_LAYER_COMPOSITION_MISSING");
  if (target.unifiedLayerOrderV1) resolveUnifiedLayerOrderStateV1(target, target.unifiedLayerOrderV1);
  if (command.order === null) {
    if (target.unifiedLayerOrderV1) resolveUnifiedLayerOrderV1(target, defaultOrder(target));
    delete target.unifiedLayerOrderV1;
  } else {
    resolveUnifiedLayerOrderV1(target, command.order);
    target.unifiedLayerOrderV1 = structuredClone(command.order);
    project.schemaVersion = 11;
  }
  return true;
}

function replaceSelectedSlots(layers: readonly UnifiedLayerRefV1[], requested: readonly UnifiedLayerRefV1[]): UnifiedLayerRefV1[] {
  const selected = new Set(requested.map(identity)); let index = 0;
  return layers.map(ref => selected.has(identity(ref)) ? requested[index++] : ref);
}

function precomposedOrder(project: EditProject, command: Extract<EditorCommand, { type: "precompose_clips" }>, layers: readonly UnifiedLayerRefV1[]): UnifiedLayerRefV1[] {
  const composition = project.compositions.find(item => item.id === command.compositionId);
  if (!composition) refuse("UNIFIED_LAYER_COMPOSITION_MISSING");
  const children = new Set(projectVisualLayersV1(composition).map(identity));
  const slots = layers.flatMap((ref, index) => children.has(identity(ref)) ? [index] : []);
  if (!slots.length && layers.some(ref => ref.kind === "clip" && ref.id === command.replacementClipId) && composition.unifiedLayerOrderV1) return [...layers];
  if (!slots.length || slots.length !== children.size || slots.at(-1)! - slots[0] + 1 !== slots.length) refuse("UNIFIED_LAYER_PRECOMPOSE_GROUP_NOT_CONTIGUOUS");
  composition.unifiedLayerOrderV1 = { schema: "editkin.unified-layer-order/v1", layers: layers.filter(ref => children.has(identity(ref))).map(ref => ({ ...ref })) };
  resolveUnifiedLayerOrderStateV1(composition, composition.unifiedLayerOrderV1);
  return [...layers.slice(0, slots[0]), { kind: "clip", id: command.replacementClipId }, ...layers.slice(slots.at(-1)! + 1)];
}

/** Called only after an actual canonical identity edit. Defaults never acquire this field. */
export function reconcileUnifiedLayerOrderInPlaceV1(project: EditProject, command: EditorCommand): void {
  const previous = project.unifiedLayerOrderV1;
  if (!previous || !identityEdits.has(command.type)) return;
  let layers = previous.layers;
  if (command.type === "split_clip" && !layers.some(ref => ref.kind === "clip" && ref.id === command.newClipId)) {
    layers = layers.flatMap(ref => ref.kind === "clip" && ref.id === command.clipId ? [ref, { kind: "clip" as const, id: command.newClipId }] : [ref]);
  } else if (command.type === "smart_cut_clip") {
    layers = layers.flatMap(ref => ref.kind === "clip" && ref.id === command.clipId
      ? command.segmentIds.map(id => ({ kind: "clip" as const, id })) : [ref]);
  } else if (command.type === "precompose_clips") {
    layers = precomposedOrder(project, command, layers);
  } else if (command.type === "reorder_motion_graphics") {
    layers = replaceSelectedSlots(layers, command.graphicIds.map(id => ({ kind: "graphic", id })));
  } else if (command.type === "reorder_tracks") {
    const tracks = new Map(project.tracks.map(track => [track.id, track]));
    const clipTrack = new Map(project.tracks.flatMap(track => track.clips.map(clip => [clip.id, track.id] as const)));
    const groups = new Map(command.trackIds.map(id => [id, [] as UnifiedLayerRefV1[]]));
    for (const ref of layers) if (ref.kind === "clip") groups.get(clipTrack.get(ref.id) ?? "")?.push(ref);
    layers = replaceSelectedSlots(layers, command.trackIds.filter(id => tracks.get(id)?.kind === "video").flatMap(id => groups.get(id) ?? []));
  }
  const live = defaultOrder(project).layers, liveKeys = new Set(live.map(identity)), seen = new Set<string>();
  const complete: UnifiedLayerRefV1[] = [];
  for (const ref of [...layers, ...live]) {
    const key = identity(ref);
    if (liveKeys.has(key) && !seen.has(key)) { seen.add(key); complete.push({ ...ref }); }
  }
  const next: UnifiedLayerOrderV1 = { schema: "editkin.unified-layer-order/v1", layers: complete };
  if (command.type === "reorder_tracks" || command.type === "reorder_motion_graphics") resolveUnifiedLayerOrderV1(project, next);
  else resolveUnifiedLayerOrderStateV1(project, next);
  if (complete.length !== previous.layers.length || complete.some((ref, index) => identity(ref) !== identity(previous.layers[index]))) project.unifiedLayerOrderV1 = next;
}

/** Fast commands may share the input's metadata object; only a fresh result receives a reconciled field. */
export function reconcileUnifiedLayerOrderFastV1(project: EditProject, command: EditorCommand): EditProject {
  if (command.type === "batch") {
    if (!project.unifiedLayerOrderV1) return project;
    const next = { ...project };
    for (const child of command.commands) reconcileUnifiedLayerOrderInPlaceV1(next, child);
    return next;
  }
  if (!project.unifiedLayerOrderV1 || !identityEdits.has(command.type)) return project;
  const next = { ...project };
  reconcileUnifiedLayerOrderInPlaceV1(next, command);
  return next;
}
