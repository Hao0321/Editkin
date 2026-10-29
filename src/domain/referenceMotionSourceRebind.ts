import type { EditProject } from "./types";
import type { EditorCommand } from "./commandTypes";
import type { ReferenceMotionTemplateInstance } from "./referenceMotionInstance";
import { EditGraphError } from "./editGraphError";
import { getSourceWindowError, getSourceAnalysisBindingError } from "./clipSourceReplacement";
import { referenceMotionClipOwner, referenceMotionSourceSlots } from "./referenceMotionSourceSlots";
import { canonicalJson } from "../shared/canonicalJson";

export type ReferenceMotionSourceRebindCommand = Extract<EditorCommand, { type: "rebind_reference_motion_clip_source" }>;
export const REFERENCE_MOTION_SOURCE_REBIND_BATCH_MESSAGE = "模板換片必須與同一模板的新版本一起提交。";
export const REFERENCE_MOTION_SOURCE_LINK_MESSAGE = "模板影片有連結片段，請先解除連結再更換。";
const validId = (value: string) => typeof value === "string" && value.length > 0 && value.length <= 160
  && value.trim() === value && !/[\u0000\r\n]/.test(value);
const clipOf = (project: EditProject, id: string) => project.tracks.flatMap(track => track.clips).find(clip => clip.id === id);
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

/** Shrinking must not invalidate a neighbour's transition through global normalization. */
export function referenceMotionSourceShrinkError(project: EditProject, instance: ReferenceMotionTemplateInstance, duration: number): string | undefined {
  const primary = clipOf(project, instance.input.clipId);
  if (!primary || duration >= primary.duration) return undefined;
  const track = project.tracks.find(track => track.id === primary.trackId)!;
  const next = [...track.clips].filter(clip => clip.id !== primary.id && clip.timelineStart >= primary.timelineStart)
    .sort((a, b) => a.timelineStart - b.timelineStart)[0];
  const hasTransition = (clip: typeof primary) => Boolean(clip?.creative?.transitionIn || clip?.creative?.transitionOut);
  if (hasTransition(primary) || hasTransition(next) || next && Math.abs(primary.timelineStart + primary.duration - next.timelineStart) <= .5 / project.fps) {
    return "後面緊接著片段或有轉場，不能縮短模板；請先留出間隔。";
  }
  return undefined;
}

export function getReferenceMotionSourceRebindError(project: EditProject, command: ReferenceMotionSourceRebindCommand): string | undefined {
  if (![command.clipId, command.assetId, command.expected.assetId].every(validId)) return "更換影片的片段或素材識別無效。";
  const track = project.tracks.find(track => track.clips.some(clip => clip.id === command.clipId));
  const clip = track?.clips.find(clip => clip.id === command.clipId);
  if (!track || !clip || clip.assetId !== command.expected.assetId || clip.sourceStart !== command.expected.sourceStart
    || clip.duration !== command.expected.duration) return "模板影片已變更，請重新選擇。";
  try { if (!referenceMotionClipOwner(project, clip.id)) return "這個片段不是模板管理的影片。"; }
  catch (error) { return error instanceof Error ? error.message : REFERENCE_MOTION_SOURCE_REBIND_BATCH_MESSAGE; }
  if (clip.linkGroupId) return REFERENCE_MOTION_SOURCE_LINK_MESSAGE;
  const windowError = getSourceWindowError(project, track, clip, project.assets.find(asset => asset.id === command.assetId), command.sourceStart, command.duration);
  if (windowError) return windowError;
  const analysisError = getSourceAnalysisBindingError(project, clip); if (analysisError) return analysisError;
  const owner = referenceMotionClipOwner(project, clip.id)!.instance;
  const shrinkError = referenceMotionSourceShrinkError(project, owner, command.duration); if (shrinkError) return shrinkError;
  const owned = new Set(referenceMotionSourceSlots(project, owner).flatMap(slot => slot.clipIds));
  if (command.duration > clip.duration && track.clips.some(other => !owned.has(other.id) && other.timelineStart >= clip.timelineStart
    && other.timelineStart < clip.timelineStart + command.duration - 1e-7)) {
    return "新長度會蓋到同一軌後面的片段；請縮短長度或先移開後面的片段。";
  }
  return undefined;
}
export function assertReferenceMotionSourceRebind(project: EditProject, command: ReferenceMotionSourceRebindCommand): void {
  const error = getReferenceMotionSourceRebindError(project, command); if (error) throw new EditGraphError(error);
}
export function containsReferenceMotionSourceRebind(command: EditorCommand): boolean {
  return command.type === "rebind_reference_motion_clip_source" || command.type === "batch" && command.commands.some(containsReferenceMotionSourceRebind);
}
function unchangedContract(before: ReferenceMotionTemplateInstance, next: ReferenceMotionTemplateInstance): boolean {
  const inputContract = (instance: ReferenceMotionTemplateInstance) => {
    const { sources, durationFrames: _duration, focusRegion: _focus, textRegion: _text, purpose: _purpose, evidenceRefs: _evidence, ...rest } = instance.input;
    return { ...rest, slotCount: sources.length };
  };
  const topology = (instance: ReferenceMotionTemplateInstance) => instance.roles.filter(role => role.kind !== "graphic")
    .map(role => ({ ...role })).sort((a, b) => a.key.localeCompare(b.key));
  return before.id === next.id && before.schema === next.schema && before.authoringGeneration === next.authoringGeneration
    && same(before.frameFormat, next.frameFormat) && same(before.primaryBefore, next.primaryBefore)
    && same(inputContract(before), inputContract(next)) && same(topology(before), topology(next));
}
/** A rebind is a top-level sibling of exactly one later owner upsert, never a stand-alone or nested command. */
export function assertReferenceMotionSourceRebindBatch(project: EditProject, command: EditorCommand): string[] {
  if (!containsReferenceMotionSourceRebind(command)) return [];
  if (command.type !== "batch" || command.commands.some(child => child.type === "batch" && containsReferenceMotionSourceRebind(child))) {
    throw new EditGraphError(REFERENCE_MOTION_SOURCE_REBIND_BATCH_MESSAGE);
  }
  const seen = new Set<string>(), owners = new Set<string>();
  for (const [index, child] of command.commands.entries()) {
    if (child.type !== "rebind_reference_motion_clip_source") continue;
    if (seen.has(child.clipId)) throw new EditGraphError("同一個模板片段不能重複換片。"); seen.add(child.clipId);
    let owner: ReturnType<typeof referenceMotionClipOwner>;
    try { owner = referenceMotionClipOwner(project, child.clipId); } catch (error) { throw new EditGraphError(String(error instanceof Error ? error.message : error)); }
    if (!owner) throw new EditGraphError("這個片段不是模板管理的影片。");
    const upserts = command.commands.flatMap((candidate, candidateIndex) => candidate.type === "upsert_reference_motion_instance"
      && candidate.instance.id === owner!.instance.id ? [{ command: candidate, index: candidateIndex }] : []);
    if (upserts.length !== 1 || upserts[0].index <= index || upserts[0].command.expectedInstanceRevision !== owner.instance.instanceRevision
      || upserts[0].command.instance.instanceRevision !== owner.instance.instanceRevision + 1
      || !unchangedContract(owner.instance, upserts[0].command.instance)) {
      throw new EditGraphError(REFERENCE_MOTION_SOURCE_REBIND_BATCH_MESSAGE);
    }
    owners.add(owner.instance.id);
  }
  return [...owners];
}
/** Metadata cannot claim a new source while retained slot clips still play the old asset or window. */
export function assertReferenceMotionSourceRebindConsistency(project: EditProject, instanceIds: readonly string[]): void {
  for (const id of instanceIds) {
    const matches = (project.referenceMotionInstances ?? []).filter(instance => instance.id === id);
    if (matches.length !== 1) throw new EditGraphError("模板換片後缺少唯一的模板版本。");
    const instance = matches[0], start = instance.input.startFrame / project.fps, duration = instance.input.durationFrames / project.fps;
    for (const slot of referenceMotionSourceSlots(project, instance)) {
      if (slot.slot > 0 && !slot.clipIds.length) throw new EditGraphError("模板換片後缺少素材槽片段。");
      for (const clipId of slot.clipIds) {
        const clip = clipOf(project, clipId);
        if (!clip || clip.assetId !== slot.assetId || clip.sourceStart !== slot.sourceStart || Math.abs(clip.timelineStart - start) > 1e-7
          || Math.abs(clip.duration - duration) > 1e-7) throw new EditGraphError("模板影片與素材槽的新來源或時間範圍不一致。");
        if ((slot.slot > 0 && clip.volume !== 0) || (slot.slot === 0 && clipId !== instance.input.clipId && clip.volume !== 0)) {
          throw new EditGraphError("模板素材槽的聲音選擇與片段音量不一致。");
        }
      }
    }
  }
}
