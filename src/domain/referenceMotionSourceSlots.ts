import type { EditProject } from "./types";
import type { ReferenceMotionTemplateInstance } from "./referenceMotionInstance";

export const REFERENCE_MOTION_SOURCE_VIEW_MESSAGES = {
  edited: "模板圖層已被手動修改或缺少素材，無法自動更換影片；可先解除模板連結再一般替換。",
  topology: "新影片的比例會改變模板結構；請選相同比例的影片，或先解除模板連結。",
} as const;
export interface ReferenceMotionSourceSlotView {
  slot: number; clipIds: string[]; assetId: string; sourceStart: number; durationFrames: number;
  label?: string; audio: "primary" | "muted";
}
/** Graph lookup only; no current-instance, file-byte, probe, source-area or rights assertion. */
export function referenceMotionSourceSlots(project: EditProject, instance: ReferenceMotionTemplateInstance): ReferenceMotionSourceSlotView[] {
  const clips = project.tracks.flatMap(track => track.clips), primary = clips.find(clip => clip.id === instance.input.clipId);
  if (!primary) throw new Error(REFERENCE_MOTION_SOURCE_VIEW_MESSAGES.edited);
  const result: ReferenceMotionSourceSlotView[] = [{ slot: 0, clipIds: [primary.id], assetId: primary.assetId, sourceStart: primary.sourceStart,
    durationFrames: instance.input.durationFrames, label: instance.input.primaryLabel, audio: "primary" },
    ...instance.input.sources.map((source, index) => ({ slot: index + 1, clipIds: [] as string[], assetId: source.assetId,
      sourceStart: source.sourceStart, durationFrames: instance.input.durationFrames, label: source.label, audio: "muted" as const }))];
  const assigned = new Map<string, number>([[primary.id, 0]]);
  for (const role of instance.roles.filter(role => role.kind === "clip")) {
    if (role.id === primary.id) {
      if (role.key !== "source:0:clip" || role.parentId !== primary.trackId) throw new Error(REFERENCE_MOTION_SOURCE_VIEW_MESSAGES.topology);
      continue;
    }
    const match = /^source:(\d+)(?::[a-z0-9-]+)*:clip$/.exec(role.key), slot = match ? Number(match[1]) : -1;
    const clip = clips.find(clip => clip.id === role.id);
    if (!Number.isSafeInteger(slot) || !result[slot] || !clip || role.parentId !== clip.trackId || assigned.has(role.id)) {
      throw new Error(REFERENCE_MOTION_SOURCE_VIEW_MESSAGES.topology);
    }
    result[slot].clipIds.push(role.id); assigned.set(role.id, slot);
  }
  return result;
}
export function referenceMotionClipOwner(project: EditProject, clipId: string): { instance: ReferenceMotionTemplateInstance; slot: number } | undefined {
  const candidates = (project.referenceMotionInstances ?? []).filter(instance => instance.input.clipId === clipId
    || instance.roles.some(role => role.kind === "clip" && role.id === clipId));
  if (!candidates.length) return undefined;
  if (candidates.length !== 1) throw new Error(REFERENCE_MOTION_SOURCE_VIEW_MESSAGES.topology);
  const instance = candidates[0], slot = referenceMotionSourceSlots(project, instance).find(item => item.clipIds.includes(clipId));
  if (!slot) throw new Error(REFERENCE_MOTION_SOURCE_VIEW_MESSAGES.topology);
  return { instance, slot: slot.slot };
}
