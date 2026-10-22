import type { EditorCommand } from "../domain/commandTypes";
import type { ProjectSessionSnapshot } from "./projectSession";
import { findClip } from "../domain/editGraph";
import { findEffectPreset } from "../creative/corePack";

/** Existing project validation limit; changing this requires the corresponding execution/resource work. */
export const MAX_PRESET_EFFECTS_PER_CLIP_V1 = 4;
export type PresetEffectEditV1 = { type: "add" | "remove"; effectId: string }
  | { type: "move"; effectId: string; direction: "earlier" | "later" };
export interface ClipPresetEffectScopeV1 { sessionId: number; projectId: string; clipId: string }
interface Host {
  getSnapshot: () => Pick<ProjectSessionSnapshot, "sessionId" | "history">;
  /** Original synchronous editor command runner reading and publishing this same ProjectSession. */
  runCommand: (command: EditorCommand, message?: string) => boolean | void;
  setStatus: (message: string) => void;
}
/** Saved execution order, never catalogue order. Undefined refuses; the original array is an accepted no-op. */
export function presetEffectOrderPatchV1(current: readonly string[], edit: PresetEffectEditV1): readonly string[] | undefined {
  if (!Array.isArray(current) || current.length > MAX_PRESET_EFFECTS_PER_CLIP_V1 || new Set(current).size !== current.length
    || current.some(id => typeof id !== "string" || !id) || !edit || typeof edit.effectId !== "string") return undefined;
  const index = current.indexOf(edit.effectId);
  if (edit.type === "add") {
    try { findEffectPreset(edit.effectId); } catch { return undefined; }
    if (index >= 0) return current;
    return current.length < MAX_PRESET_EFFECTS_PER_CLIP_V1 ? [...current, edit.effectId] : undefined;
  }
  if (index < 0) return undefined;
  if (edit.type === "remove") return current.filter(id => id !== edit.effectId);
  if (edit.type !== "move" || !["earlier", "later"].includes(edit.direction)) return undefined;
  const nextIndex = index + (edit.direction === "earlier" ? -1 : 1);
  if (nextIndex < 0 || nextIndex >= current.length) return current;
  const next = [...current]; [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
  return next;
}
/** Only the preset stack is compared. Current looks, native instances and transitions remain owned by the canonical command. */
export function createClipPresetEffectEditActionsV1(host: Host) {
  return {
    apply(scope: ClipPresetEffectScopeV1, expectedIds: readonly string[], edit: PresetEffectEditV1): boolean {
      const stale = () => { host.setStatus("此效果或專案已變更；請重新選取後再修改。"); return false; };
      try {
        const snapshot = host.getSnapshot(), project = snapshot.history.present;
        if (scope.sessionId !== snapshot.sessionId || scope.projectId !== project.id) return stale();
        const clip = findClip(project, scope.clipId), current = clip.creative?.effectPresetIds ?? [];
        if (!Array.isArray(expectedIds) || current.length !== expectedIds.length || current.some((id, index) => id !== expectedIds[index])) return stale();
        const next = presetEffectOrderPatchV1(current, edit);
        if (!next) { host.setStatus("無法更新畫面特效堆疊。"); return false; }
        const beforeCommit = host.getSnapshot();
        if (beforeCommit.sessionId !== snapshot.sessionId || beforeCommit.history !== snapshot.history) return stale();
        if (next === current) return true;
        return host.runCommand({ type: "set_clip_creative", clipId: scope.clipId, patch: { effectPresetIds: [...next] } },
          "已更新畫面特效堆疊，可復原。") !== false;
      } catch (error) { host.setStatus(error instanceof Error ? error.message : "無法更新畫面特效堆疊。"); return false; }
    },
  };
}
