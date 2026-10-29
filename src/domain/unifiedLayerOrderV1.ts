import type { CaptionCue, EditProject, MotionGraphic, TimelineClip, TimelineTrack } from "./types";

export type UnifiedLayerProjectV1 = Pick<EditProject,
  "tracks" | "captions" | "motionTracks" | "motionGraphics" | "motionScenes" | "referenceMotionInstances" | "unifiedLayerOrderV1" | "templateApplication">;

export type UnifiedLayerRefV1 = { kind: "clip" | "caption" | "graphic"; id: string };
export interface UnifiedLayerOrderV1 {
  schema: "editkin.unified-layer-order/v1";
  /** Back to front. Audio is not a picture layer; controllers retain their transform dependencies. */
  layers: readonly UnifiedLayerRefV1[];
}
export type ResolvedUnifiedLayerV1 =
  | { kind: "clip"; id: string; clip: TimelineClip; track: TimelineTrack }
  | { kind: "caption"; id: string; caption: CaptionCue }
  | { kind: "graphic"; id: string; graphic: MotionGraphic };

export const MAX_UNIFIED_LAYER_COUNT_V1 = 100_000;
const key = (ref: UnifiedLayerRefV1) => `${ref.kind}\0${ref.id}`;
function refuse(code: string): never { throw Object.assign(new Error(code), { code }); }

/** The native legacy order is an inventory, not a migration or a rewrite of persisted project arrays. */
export function projectVisualLayersV1(project: UnifiedLayerProjectV1): ResolvedUnifiedLayerV1[] {
  return [
    ...project.tracks.filter(track => track.kind === "video").flatMap(track => track.clips.map(clip => ({ kind: "clip" as const, id: clip.id, clip, track }))),
    ...project.captions.map(caption => ({ kind: "caption" as const, id: caption.id, caption })),
    ...project.motionGraphics.map(graphic => ({ kind: "graphic" as const, id: graphic.id, graphic })),
  ];
}

/** Validate a complete draw order once, in O(N), retaining the project's actual objects.
 * A partial list may not silently drop a picture, caption or graphic. No project mutation or hidden reindexing. */
export function resolveUnifiedLayerOrderStateV1(project: UnifiedLayerProjectV1, order: UnifiedLayerOrderV1): ResolvedUnifiedLayerV1[] {
  if (!order || typeof order !== "object" || Array.isArray(order)
    || Object.keys(order).length !== 2 || order.schema !== "editkin.unified-layer-order/v1" || !Array.isArray(order.layers)
    || order.layers.length > MAX_UNIFIED_LAYER_COUNT_V1) refuse("UNIFIED_LAYER_ORDER_INVALID");
  const visualCount = project.captions.length + project.motionGraphics.length
    + project.tracks.reduce((count, track) => count + (track.kind === "video" ? track.clips.length : 0), 0);
  if (visualCount > MAX_UNIFIED_LAYER_COUNT_V1) refuse("UNIFIED_LAYER_ORDER_CAPACITY");
  const existing = projectVisualLayersV1(project);
  if (existing.length > MAX_UNIFIED_LAYER_COUNT_V1) refuse("UNIFIED_LAYER_ORDER_CAPACITY");
  const byKey = new Map(existing.map(layer => [key(layer), layer]));
  if (byKey.size !== existing.length) refuse("UNIFIED_LAYER_SOURCE_IDENTITIES_INVALID");
  if (order.layers.length !== existing.length) refuse("UNIFIED_LAYER_ORDER_INCOMPLETE");
  const seen = new Set<string>();
  const resolved = order.layers.map(ref => {
    if (!ref || typeof ref !== "object" || Array.isArray(ref) || Object.keys(ref).length !== 2
      || !["clip", "caption", "graphic"].includes(ref.kind) || typeof ref.id !== "string"
      || ref.id.length === 0 || ref.id.length > 512 || ref.id !== ref.id.trim() || ref.id.includes("\0")) refuse("UNIFIED_LAYER_IDENTITY_INVALID");
    const identity = key(ref);
    if (seen.has(identity)) refuse("UNIFIED_LAYER_ORDER_DUPLICATE");
    const layer = byKey.get(identity);
    if (!layer) refuse("UNIFIED_LAYER_TARGET_MISSING");
    seen.add(identity);
    return layer;
  });
  return resolved;
}

/** Editing guards compare against the saved order; a valid moved layer may be locked and reopened later. */
export function resolveUnifiedLayerOrderV1(project: UnifiedLayerProjectV1, order: UnifiedLayerOrderV1): ResolvedUnifiedLayerV1[] {
  const resolved = resolveUnifiedLayerOrderStateV1(project, order);
  const existing = project.unifiedLayerOrderV1 === undefined ? projectVisualLayersV1(project)
    : resolveUnifiedLayerOrderStateV1(project, project.unifiedLayerOrderV1);
  const previousIndex = new Map(existing.map((layer, index) => [key(layer), index]));
  const protectedLayers = new Set<string>();
  for (const instance of project.referenceMotionInstances ?? []) for (const role of instance.roles) {
    if (role.kind === "clip" || role.kind === "graphic") protectedLayers.add(key({ kind: role.kind, id: role.id }));
  }
  for (const scene of project.motionScenes ?? []) for (const id of scene.graphicIds) protectedLayers.add(key({ kind: "graphic", id }));
  // A clip carries no templateOwner: the movie template's receipt lists the picture clips it generated. Like a
  // template-owned caption or graphic, those leave with the template, so their draw position is the template's.
  // (Clips it only restyled stay the user's own clips and remain freely orderable.) Compositions have no receipt.
  for (const generated of project.templateApplication?.generatedClips ?? []) protectedLayers.add(key({ kind: "clip", id: generated.clipId }));
  for (const layer of existing) if ((layer.kind === "caption" && layer.caption.templateOwner)
    || (layer.kind === "graphic" && layer.graphic.templateOwner)) protectedLayers.add(key(layer));
  const captionLocked = project.tracks.some(track => track.kind === "caption" && track.locked);
  const lockedClips = new Set(project.tracks.filter(track => track.locked).flatMap(track => track.clips.map(clip => clip.id)));
  const trackedClips = new Map(project.motionTracks.map(track => [track.id, track.clipId]));
  for (const [index, layer] of resolved.entries()) {
    if (previousIndex.get(key(layer)) === index) continue;
    if (layer.kind === "clip" && layer.track.locked || layer.kind === "caption" && captionLocked
      || layer.kind === "graphic" && layer.graphic.trackId && lockedClips.has(trackedClips.get(layer.graphic.trackId) ?? "")) refuse("UNIFIED_LAYER_TRACK_LOCKED");
    if (protectedLayers.has(key(layer))) refuse("UNIFIED_LAYER_OWNER_GROUP_REQUIRED");
  }
  return resolved;
}

/** A requested order cannot flatten a camera, simulation or post-display paint group.
 * These boundaries need explicit group compilation before the mixed-order option can consume them. */
export function assertNativeUnifiedLayerProfileV1(project: EditProject): void {
  if (project.scene3d?.enabled || project.scene25d?.enabled) refuse("UNIFIED_LAYER_3D_GROUP_REQUIRED");
  if (project.particleSimulation?.enabled) refuse("UNIFIED_LAYER_PARTICLE_GROUP_REQUIRED");
  if (project.timelineTransitions?.length) refuse("UNIFIED_LAYER_PAIR_GROUP_REQUIRED");
  if (project.motionGraphics.some(graphic => graphic.paintV1?.schema === "editkin.motion-paint/v2")) refuse("UNIFIED_LAYER_DISPLAY_PAINT_GROUP_REQUIRED");
}
