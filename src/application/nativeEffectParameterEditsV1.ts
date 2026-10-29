import type { NativeEffectInstance } from "../domain/types";
import type { EditorCommand } from "../domain/commandTypes";
import type { PluginRegistrySummary } from "../desktop/pluginTypes";
import type { ProjectSessionSnapshot } from "./projectSession";
import { findClip } from "../domain/editGraph";
import { nativeEffectInstanceSchema } from "../domain/clipCreativeSchema";
import { nativeEffectParameterViewV1, nativeEffectParameterValuesPatchV1 } from "./nativeEffectParametersV1";

export const EFFECT_PARAMETER_EDIT_STALE_V1 = "此效果或專案已變更；請重新選取後再修改。";
export const EFFECT_PARAMETER_EDIT_INVALID_V1 = "無法更新特效參數。";
export interface NativeEffectParameterEditScopeV1 { sessionId: number; projectId: string; clipId: string }
interface Host {
  getSnapshot: () => Pick<ProjectSessionSnapshot, "sessionId" | "history">;
  getRegistry?: () => PluginRegistrySummary | undefined;
  /** The existing synchronous editor runner. It reads/publishes this same live session without yielding. */
  runCommand: (command: EditorCommand, message?: string) => boolean | void;
  setStatus: (message: string) => void;
}
function sameIdentity(current: NativeEffectInstance, expected: NativeEffectInstance): boolean {
  return current.id === expected.id && current.pluginId === expected.pluginId && current.capabilityId === expected.capabilityId
    && current.pluginVersion === expected.pluginVersion && current.manifestSha256 === expected.manifestSha256
    && (current.runtimeType ?? "native_effect") === (expected.runtimeType ?? "native_effect");
}
/** A synchronous current-owner edit: changed-key CAS, original command/history, no parallel project state. */
export function createNativeEffectParameterEditActionsV1(host: Host) {
  return {
    apply(scope: NativeEffectParameterEditScopeV1, expected: NativeEffectInstance, values: Readonly<NativeEffectInstance["parameters"]>): boolean {
      const stale = () => { host.setStatus(EFFECT_PARAMETER_EDIT_STALE_V1); return false; };
      try {
        const snapshot = host.getSnapshot(), project = snapshot.history.present;
        if (snapshot.sessionId !== scope.sessionId || project.id !== scope.projectId) return stale();
        const clip = findClip(project, scope.clipId);
        const current = clip.creative?.nativeEffectInstances?.find(instance => instance.id === expected.id);
        if (!current || !sameIdentity(current, expected)) return stale();
        const parsed = nativeEffectInstanceSchema.shape.parameters.safeParse(values);
        if (!parsed.success || Object.keys(parsed.data).length > 64) { host.setStatus(EFFECT_PARAMETER_EDIT_INVALID_V1); return false; }
        const ids = Object.keys(parsed.data);
        for (const id of ids) {
          if (Object.hasOwn(current.parameters, id) !== Object.hasOwn(expected.parameters, id)
            || current.parameters[id] !== expected.parameters[id]) return stale();
        }
        const view = nativeEffectParameterViewV1(current, host.getRegistry?.());
        const parameters = nativeEffectParameterValuesPatchV1(current, view.rows, parsed.data);
        if (!parameters) { host.setStatus(EFFECT_PARAMETER_EDIT_INVALID_V1); return false; }
        const beforeCommit = host.getSnapshot();
        if (beforeCommit.sessionId !== snapshot.sessionId || beforeCommit.history !== snapshot.history) return stale();
        if (parameters === current.parameters) return true;
        // No await/queued update: the host's canonical runner consumes the same current session now.
        return host.runCommand({ type: "update_native_effect", clipId: scope.clipId, instanceId: current.id, patch: { parameters } },
          "已更新原生效果；正式輸出會使用這組參數。") !== false;
      } catch (error) { host.setStatus(error instanceof Error ? error.message : EFFECT_PARAMETER_EDIT_INVALID_V1); return false; }
    },
  };
}
