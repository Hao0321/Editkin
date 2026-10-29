import type { EditProject, MediaAsset } from "../domain/types";
import type { ReferenceMotionTemplateInstance } from "../domain/referenceMotionInstance";
import type { PickedMedia } from "../desktop/mediaTypes";
import { referenceMotionSourceSlots, sourceReplacementMinimumFrames, referenceMotionSourceReplacementRequestSchema,
  type ReferenceMotionSourceReplacementRequest } from "../application/referenceMotionSourceReplacement";
import { referenceMotionSourceShrinkError } from "../domain/referenceMotionSourceRebind";
import { referenceMotionReuseSourceIdentity } from "../application/referenceMotionTemplateReuse";
import { referenceMotionTemplateSourceColorAdmitted } from "../application/referenceMotionTemplateCommands";
import { isNativeReferenceMotionPresentation } from "../motion/referenceMotionTemplates";

export interface ReferenceMotionSourceDraft {
  selectedSlot: number; slots: Array<{ assetId: string; sourceStart: string; label: string }>;
  durationMode: "keep" | "change"; duration: string;
  primaryAudio: "keep_level" | "mute" | "unity";
  keepFocus: boolean; keepText: boolean; purpose: string; confirmed: boolean; picked?: PickedMedia;
}
export function referenceMotionSourceDraft(project: EditProject, instance: ReferenceMotionTemplateInstance, clipId?: string): ReferenceMotionSourceDraft {
  const slots = referenceMotionSourceSlots(project, instance), primary = project.tracks.flatMap(track => track.clips).find(clip => clip.id === instance.input.clipId)!;
  return { selectedSlot: Math.max(0, slots.findIndex(slot => slot.clipIds.includes(clipId ?? instance.input.clipId))),
    slots: slots.map(slot => ({ assetId: slot.assetId, sourceStart: String(slot.sourceStart), label: slot.label ?? "" })),
    durationMode: "keep", duration: String(instance.input.durationFrames / project.fps), primaryAudio: primary.volume === 0 ? "mute" : "keep_level",
    keepFocus: false, keepText: false, purpose: "", confirmed: false };
}
const identity = (asset: MediaAsset) => referenceMotionReuseSourceIdentity(asset.uri);
export function referenceMotionSourceAssetAdmitted(project: EditProject, instance: ReferenceMotionTemplateInstance, asset: MediaAsset): boolean {
  if (asset.kind !== "video" || asset.compositionId || asset.imageSequence || /^editkin-composition:/i.test(asset.uri)) return false;
  if (!Number.isSafeInteger(asset.width) || !Number.isSafeInteger(asset.height) || asset.width! <= 0 || asset.height! <= 0 || !asset.uri.trim()) return false;
  if (instance.input.mediaPresentation === "source_soft_v2" && (!asset.displayAspectRatio || ![undefined, "auto", "rec709"].includes(asset.color?.interpretation))) return false;
  try { identity(asset); } catch { return false; }
  return referenceMotionTemplateSourceColorAdmitted(project, asset, isNativeReferenceMotionPresentation(instance.input.graphicPresentation));
}
export function referenceMotionSourceChoices(project: EditProject, instance: ReferenceMotionTemplateInstance, draft: ReferenceMotionSourceDraft): MediaAsset[] {
  const assets = [...project.assets, ...(draft.picked ? [draft.picked.asset] : [])];
  const others = draft.slots.filter((_slot, index) => index !== draft.selectedSlot).map(slot => assets.find(asset => asset.id === slot.assetId)).filter((asset): asset is MediaAsset => Boolean(asset));
  return assets.filter(asset => referenceMotionSourceAssetAdmitted(project, instance, asset) && !others.some(other => other.id === asset.id
    || identity(other) === identity(asset) || other.derivatives?.sourceSha256 && other.derivatives.sourceSha256.toLowerCase() === asset.derivatives?.sourceSha256?.toLowerCase()));
}
export function referenceMotionSourceDraftAsset(project: EditProject, draft: ReferenceMotionSourceDraft, slot = draft.selectedSlot): MediaAsset | undefined {
  const id = draft.slots[slot]?.assetId;
  return draft.picked?.asset.id === id ? draft.picked.asset : project.assets.find(asset => asset.id === id);
}
export function selectReferenceMotionDraftAsset(draft: ReferenceMotionSourceDraft, assetId: string): ReferenceMotionSourceDraft {
  const picked = draft.picked?.asset.id === draft.slots[draft.selectedSlot].assetId && assetId !== draft.picked.asset.id ? undefined : draft.picked;
  return { ...draft, picked, confirmed: false, slots: draft.slots.map((slot, index) => index !== draft.selectedSlot || slot.assetId === assetId ? slot
    : { assetId, sourceStart: "0", label: index ? "" : slot.label }) };
}
export function snappedReferenceMotionSourceTime(value: string, fps: number): { seconds: number; frame: number } | undefined {
  if (!value.trim()) return undefined;
  const requested = Number(value), frame = Math.round(requested * fps);
  return Number.isFinite(requested) && requested >= 0 && Number.isSafeInteger(frame) ? { seconds: frame / fps, frame } : undefined;
}
export function referenceMotionSourceDurationLimit(project: EditProject, instance: ReferenceMotionTemplateInstance, draft: ReferenceMotionSourceDraft): number {
  const primary = project.tracks.flatMap(track => track.clips).find(clip => clip.id === instance.input.clipId)!;
  const next = project.tracks.find(track => track.id === primary.trackId)!.clips.filter(clip => clip.id !== primary.id && clip.timelineStart >= primary.timelineStart)
    .sort((a, b) => a.timelineStart - b.timelineStart)[0];
  return Math.max(0, Math.floor(Math.min(60, next ? next.timelineStart - primary.timelineStart : 60,
    ...draft.slots.map((_slot, index) => (referenceMotionSourceDraftAsset(project, draft, index)?.duration ?? 0)
      - (snappedReferenceMotionSourceTime(draft.slots[index].sourceStart, project.fps)?.seconds ?? Infinity))) * project.fps + 1e-7) / project.fps);
}
export function referenceMotionSourceDraftRequest(project: EditProject, instance: ReferenceMotionTemplateInstance,
  draft: ReferenceMotionSourceDraft, evidenceId: string): ReferenceMotionSourceReplacementRequest {
  if (!draft.confirmed || !draft.purpose.trim()) throw new Error("請確認影片內容與取景，並填寫新影片用途。");
  const windows = draft.slots.map((slot, index) => {
    const asset = referenceMotionSourceDraftAsset(project, draft, index), at = snappedReferenceMotionSourceTime(slot.sourceStart, project.fps);
    if (!asset || !at || !referenceMotionSourceAssetAdmitted(project, instance, asset)) throw new Error("請選擇有效影片與起點。");
    return { assetId: asset.id, sourceStart: at.seconds, ...(index ? { label: slot.label.trim() } : {}) };
  });
  const durationFrames = draft.durationMode === "keep" ? instance.input.durationFrames : snappedReferenceMotionSourceTime(draft.duration, project.fps)?.frame;
  if (!durationFrames || durationFrames < sourceReplacementMinimumFrames(project, instance)
    || durationFrames / project.fps > referenceMotionSourceDurationLimit(project, instance, draft) + 1e-7) throw new Error("新影片的可用長度不足，請調整起點或長度。");
  const shrink = referenceMotionSourceShrinkError(project, instance, durationFrames / project.fps); if (shrink) throw new Error(shrink);
  const ids = windows.map(window => window.assetId), assets = windows.map((_slot, index) => referenceMotionSourceDraftAsset(project, draft, index)!);
  const pins = assets.flatMap(asset => asset.derivatives?.sourceSha256 ? [asset.derivatives.sourceSha256.toLowerCase()] : []);
  if (new Set(ids).size !== ids.length || new Set(assets.map(identity)).size !== ids.length || new Set(pins).size !== pins.length) throw new Error("同一個影片不能同時放在模板的兩個位置。");
  return referenceMotionSourceReplacementRequestSchema.parse({ instanceId: instance.id, expectedInstanceRevision: instance.instanceRevision,
    expectedProjectRevision: project.revision, primary: windows[0], sources: windows.slice(1), durationFrames,
    audio: { primary: draft.primaryAudio, extra: windows.slice(1).map(() => "muted") },
    focusRegion: draft.keepFocus ? instance.input.focusRegion ?? null : null, textRegion: draft.keepText ? instance.input.textRegion ?? null : null,
    purpose: draft.purpose.trim(), evidenceRefs: [`manual:template-source-selection:${evidenceId}`] });
}
