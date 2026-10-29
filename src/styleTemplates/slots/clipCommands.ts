import type { EditorCommand } from "../../domain/commandTypes";
import type { StyleJobClipV1 } from "../../domain/styleJobFieldsV1";
import { STYLE_TEMPLATE_AUTO_TRACK_V1 } from "../../domain/styleTemplateCommandsV1";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type MediaAsset, type TimelineClip } from "../../domain/types";

/**
 * The add/update commands for a rendered template clip (browser-safe: the inspector and the module build the same
 * commands). A render is its `styleJob` field plus the cache asset; picture files a render used that the project does not
 * hold yet (an imported image) ride in the same Undo as `slotAssets`.
 */

export interface RenderedStyleTemplateClipV1 {
  readonly field: StyleJobClipV1;
  readonly asset: MediaAsset;
}

function missingSlotAssets(project: Pick<EditProject, "assets">, rendered: RenderedStyleTemplateClipV1, candidates: readonly MediaAsset[] = []): MediaAsset[] {
  return candidates.filter(asset => asset.kind === "image" && !project.assets.some(existing => existing.id === asset.id)
    && Object.values(rendered.field.slots.image).some(value => value.source.assetId === asset.id));
}

/** add_style_template_clip at `startFrame`; without `trackId` the command places the clip itself (`autoTrack`) on top. */
export function styleTemplateAddClipCommandV1(project: Pick<EditProject, "fps" | "assets">, rendered: RenderedStyleTemplateClipV1,
  placement: { clipId: string; trackId?: string; startFrame: number; slotAssets?: readonly MediaAsset[] }): Extract<EditorCommand, { type: "add_style_template_clip" }> {
  if (!Number.isSafeInteger(placement.startFrame) || placement.startFrame < 0) throw new Error("style template clips start on a whole frame");
  const clip: TimelineClip = { id: placement.clipId, assetId: rendered.asset.id, trackId: placement.trackId ?? STYLE_TEMPLATE_AUTO_TRACK_V1.base,
    timelineStart: placement.startFrame / project.fps, sourceStart: 0, duration: rendered.asset.duration, volume: 0,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], styleJob: structuredClone(rendered.field) };
  const slotAssets = missingSlotAssets(project, rendered, placement.slotAssets);
  return { type: "add_style_template_clip", asset: rendered.asset, clip, ...(slotAssets.length ? { slotAssets } : {}), ...(placement.trackId === undefined ? { autoTrack: true as const } : {}) };
}

/** update_style_template_clip: the clip shows the new render; a new length refits it, an unchanged one keeps the person's trim. */
export function styleTemplateUpdateClipCommandV1(project: Pick<EditProject, "assets">, clip: TimelineClip, rendered: RenderedStyleTemplateClipV1,
  options: { slotAssets?: readonly MediaAsset[] } = {}): Extract<EditorCommand, { type: "update_style_template_clip" }> {
  if (!clip.styleJob) throw new Error(`${clip.id} is not a style template clip`);
  const slotAssets = missingSlotAssets(project, rendered, options.slotAssets);
  const refit = rendered.field.job.frameCount !== clip.styleJob.job.frameCount;
  return { type: "update_style_template_clip", clipId: clip.id, expected: { assetId: clip.assetId, key: clip.styleJob.key }, asset: rendered.asset,
    styleJob: structuredClone(rendered.field), ...(slotAssets.length ? { slotAssets } : {}), ...(refit ? { sourceStart: 0, duration: rendered.asset.duration } : {}) };
}
