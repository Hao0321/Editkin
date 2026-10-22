import type { EditProject } from "../domain/types";
import { resolveUnifiedLayerOrderStateV1, type UnifiedLayerRefV1 } from "../domain/unifiedLayerOrderV1";
import type { RenderPlan, RenderSegment } from "./planner";
import { canonicalJson } from "../shared/canonicalJson";

type ClipSegment = Extract<RenderSegment, { kind: "clip" }>;
export interface UnifiedCompositeAssBandV1 {
  kind: "ass";
  compositeLayer: "background" | "foreground";
  refs: UnifiedLayerRefV1[];
  project: EditProject;
}
export type UnifiedCompositeOperationV1 = { kind: "clip"; segment: ClipSegment } | UnifiedCompositeAssBandV1;

/** This compiler consumes display-referred ASS at its requested depth. Other colour/group boundaries require their own consumer. */
export function assertUnifiedLayerCompositeProfileV1(project: EditProject, preserveAlpha = false): void {
  const visualAssets = new Set(project.tracks.filter(track => track.kind === "video" && !track.hidden)
    .flatMap(track => track.clips.filter(clip => clip.layer?.enabled !== false).map(clip => clip.assetId)));
  if (preserveAlpha || project.colorManagement?.mode === "aces2" || project.scene3d?.enabled || project.scene25d?.enabled
    || project.particleSimulation?.enabled || project.timelineTransitions?.length || project.motionScenes?.length
    || project.motionGraphics.some(graphic => graphic.paintV1 || graphic.visualStyle === "native_paint")
    || project.assets.some(asset => visualAssets.has(asset.id) && (asset.imageSequence || asset.color?.interpretation === "linear_rec709"))) {
    throw Object.assign(new Error("此專案的混合圖層排序尚未支援正式輸出；已停止輸出，避免圖層順序改變。"),
      { code: "UNIFIED_LAYER_FORMAL_EXPORT_NOT_ADOPTED" });
  }
}

/** Existing leaf renderers keep every draw parameter. This adapter owns only sequencing and ASS band membership. */
export function buildUnifiedLayerCompositeOperationsV1(project: EditProject, plan: RenderPlan, assSource = project, assStartFrame = 0): UnifiedCompositeOperationV1[] | undefined {
  if (project.unifiedLayerOrderV1 === undefined) return undefined;
  assertUnifiedLayerCompositeProfileV1(project);
  if (plan.width !== project.width || plan.height !== project.height || plan.fps !== project.fps) throw new Error("UNIFIED_LAYER_RENDER_PLAN_SCOPE_MISMATCH");
  const layers = resolveUnifiedLayerOrderStateV1(project, project.unifiedLayerOrderV1);
  const segments = new Map<string, ClipSegment>();
  for (const layer of plan.videoLayers) for (const segment of layer.segments) if (segment.kind === "clip") {
    if (segments.has(segment.clip.id)) throw new Error("UNIFIED_LAYER_RENDER_PLAN_IDENTITIES_INVALID");
    segments.set(segment.clip.id, segment);
  }
  const expected = new Set(layers.flatMap(layer => layer.kind === "clip" && !layer.track.hidden && layer.clip.layer?.enabled !== false ? [layer.id] : []));
  if (expected.size !== segments.size || [...segments.keys()].some(id => !expected.has(id))) throw new Error("UNIFIED_LAYER_RENDER_PLAN_IDENTITIES_INVALID");
  if (assSource.width !== project.width || assSource.height !== project.height || assSource.fps !== project.fps || assSource.id !== project.id
    || !Number.isSafeInteger(assStartFrame) || assStartFrame < 0 || canonicalJson(assSource.captionStyle) !== canonicalJson(project.captionStyle)) {
    throw new Error("UNIFIED_LAYER_ASS_SCOPE_MISMATCH");
  }
  const captions = new Map(assSource.captions.map(caption => [caption.id, caption]));
  const graphics = new Map(assSource.motionGraphics.map(graphic => [graphic.id, graphic]));
  if (captions.size !== assSource.captions.length || graphics.size !== assSource.motionGraphics.length) throw new Error("UNIFIED_LAYER_ASS_SCOPE_MISMATCH");
  const sameClockedRecord = (source: object, target: object, clock: string) => {
    const { [clock]: sourceTime, ...sourceFields } = source as Record<string, unknown>;
    const { [clock]: targetTime, ...targetFields } = target as Record<string, unknown>;
    return typeof sourceTime === "number" && typeof targetTime === "number"
      && Math.abs(sourceTime - targetTime - assStartFrame / project.fps) <= 1e-7 && canonicalJson(sourceFields) === canonicalJson(targetFields);
  };
  const operations: UnifiedCompositeOperationV1[] = [];
  for (const layer of layers) {
    if (layer.kind === "clip") {
      if (layer.track.hidden || layer.clip.layer?.enabled === false || layer.clip.layer?.role === "controller") continue;
      const segment = segments.get(layer.id)!;
      if (segment.clip.assetId !== layer.clip.assetId || (segment.clip.layer?.role ?? "content") !== (layer.clip.layer?.role ?? "content")) throw new Error("UNIFIED_LAYER_RENDER_PLAN_IDENTITIES_INVALID");
      operations.push({ kind: "clip", segment });
      continue;
    }
    const caption = layer.kind === "caption" ? captions.get(layer.id) : undefined;
    const graphic = layer.kind === "graphic" ? graphics.get(layer.id) : undefined;
    if (layer.kind === "caption" ? !caption || !sameClockedRecord(caption, layer.caption, "start")
      : !graphic || !sameClockedRecord(graphic, layer.graphic, "timelineStart")) throw new Error("UNIFIED_LAYER_ASS_SCOPE_MISMATCH");
    const compositeLayer = graphic?.compositeLayer ?? "foreground";
    const previous = operations.at(-1);
    let band: UnifiedCompositeAssBandV1;
    // Consecutive captions or same-plane Motion share one script, retaining requested order and bounding files/filter passes.
    if (previous?.kind === "ass" && previous.refs[0].kind === layer.kind && previous.compositeLayer === compositeLayer) band = previous;
    else {
      band = { kind: "ass", compositeLayer, refs: [], project: { ...assSource, captions: [], motionGraphics: [] } };
      operations.push(band);
    }
    band.refs.push({ kind: layer.kind, id: layer.id });
    if (caption) band.project.captions.push(caption);
    if (graphic) band.project.motionGraphics.push(graphic);
  }
  return operations;
}
