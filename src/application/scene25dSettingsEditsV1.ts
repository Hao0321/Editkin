import type { EditorCommand } from "../domain/commandTypes";
import type { Scene25dSettings } from "../domain/types";
import type { ProjectSessionSnapshot } from "./projectSession";
import { editorCommandSchema } from "../domain/schema";

export const SCENE_SETTINGS_EDIT_STALE_V1 = "此場景或專案已變更；請重新選取後再修改。";
export const SCENE_SETTINGS_EDIT_INVALID_V1 = "無法更新 2.5D 場景參數。";
export interface Scene25dSettingsEditScopeV1 { sessionId: number; projectId: string }
interface Host {
  getSnapshot: () => Pick<ProjectSessionSnapshot, "sessionId" | "history">;
  runCommand: (command: EditorCommand, message?: string) => boolean | void;
  setStatus: (message: string) => void;
}

function parseSettings(settings: Scene25dSettings): Scene25dSettings | undefined {
  const parsed = editorCommandSchema.safeParse({ type: "set_scene_25d_settings", settings });
  return parsed.success && parsed.data.type === "set_scene_25d_settings" ? parsed.data.settings : undefined;
}

// Schema-parsed finite primitives, fixed numeric tuples and bounded keyframe lists only.
const same = (left: unknown, right: unknown): boolean => Object.is(left, right) || JSON.stringify(left) === JSON.stringify(right);

function mergeGroup<T extends object>(current: T, expected: T, next: T): T {
  const merged = { ...current };
  for (const key of Object.keys(next) as Array<keyof T>) {
    const before = expected[key], value = next[key], live = current[key];
    if (same(before, value)) continue;
    if (key !== "keyframes" && Array.isArray(before) && Array.isArray(value) && Array.isArray(live)) {
      // A new Y coordinate must not restore the X coordinate from an older render.
      merged[key] = value.map((component: unknown, index: number) => {
        if (same(before[index], component)) return live[index];
        if (!same(live[index], before[index])) throw new Error(SCENE_SETTINGS_EDIT_STALE_V1);
        return component;
      }) as T[typeof key];
    } else {
      // A keyframe list is one authored edit, never a speculative per-index merge.
      if (!same(live, before)) throw new Error(SCENE_SETTINGS_EDIT_STALE_V1);
      merged[key] = structuredClone(value);
    }
  }
  return merged;
}

function restartsScene(command: EditorCommand): boolean {
  return command.type === "configure_scene_25d" || command.type === "batch" && command.commands.some(restartsScene);
}

/** Translate rendered settings into a synchronous changed-field edit of the one live ProjectSession. */
export function createScene25dSettingsEditActionsV1(host: Host) {
  // A scene has no persisted instance ID. Use its existing canonical command lineage,
  // not equality with reset defaults, to reject callbacks from an earlier occurrence.
  const rendered = host.getSnapshot(), renderedJournal = rendered.history.journal;
  return {
    apply(scope: Scene25dSettingsEditScopeV1, expected: Scene25dSettings, settings: Scene25dSettings): boolean {
      const stale = () => { host.setStatus(SCENE_SETTINGS_EDIT_STALE_V1); return false; };
      try {
        const snapshot = host.getSnapshot(), project = snapshot.history.present;
        if (snapshot.sessionId !== scope.sessionId || project.id !== scope.projectId || !project.scene25d?.enabled) return stale();
        const journal = snapshot.history.journal;
        if (rendered.sessionId !== scope.sessionId || rendered.history.present.id !== scope.projectId
          || journal.length < renderedJournal.length
          || renderedJournal.length > 0 && journal[renderedJournal.length - 1] !== renderedJournal.at(-1)
          || journal.slice(renderedJournal.length).some(record => restartsScene(record.command))) return stale();
        const before = parseSettings(expected), next = parseSettings(settings), current = parseSettings(project.scene25d);
        // Activation and deactivation remain owned by configure_scene_25d.
        if (!before?.enabled || !next?.enabled || !current) { host.setStatus(SCENE_SETTINGS_EDIT_INVALID_V1); return false; }
        const merged: Scene25dSettings = { ...current,
          camera: mergeGroup(current.camera, before.camera, next.camera),
          depthOfField: mergeGroup(current.depthOfField, before.depthOfField, next.depthOfField),
          ambientLight: mergeGroup(current.ambientLight, before.ambientLight, next.ambientLight),
          directionalLight: mergeGroup(current.directionalLight, before.directionalLight, next.directionalLight),
        };
        const beforeCommit = host.getSnapshot();
        if (beforeCommit.sessionId !== snapshot.sessionId || beforeCommit.history !== snapshot.history) return stale();
        if (same(current, merged)) return true;
        // The original command owns cross-field validation, persistence and the single Undo step.
        return host.runCommand({ type: "set_scene_25d_settings", settings: merged }, "已更新 2.5D 相機／燈光設定。") !== false;
      } catch (error) { host.setStatus(error instanceof Error ? error.message : SCENE_SETTINGS_EDIT_INVALID_V1); return false; }
    },
  };
}
