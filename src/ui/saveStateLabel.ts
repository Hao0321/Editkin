import type { InterfaceMode } from "./i18n/interfacePreferences";
import type { RecoveryState } from "../desktop/useProjectRecovery";

export interface SaveStateInput {
  mode: InterfaceMode;
  isDesktop: boolean;
  dirty: boolean;
  recoveryState: RecoveryState;
  hasProjectFile: boolean;
}

/**
 * The footer's save state as a zh-TW interface message key. Advanced mode keeps the detailed wording (crash-recovery
 * backup, Autosave); simple mode says only what a beginner needs: 「已儲存」 or 「還沒儲存」, and whether a backup exists.
 */
export function saveStateMessage({ mode, isDesktop, dirty, recoveryState, hasProjectFile }: SaveStateInput): string {
  if (mode === "advanced") {
    if (!isDesktop) return dirty ? "未儲存 · 請下載專案 · 無 Autosave" : "專案未變更 · 瀏覽器無 Autosave";
    if (dirty) return recoveryState === "saved" ? "未儲存 · 當機復原已備份" : recoveryState === "error" ? "未儲存 · 當機復原備份失敗" : "未儲存 · 正在備份當機復原…";
    return hasProjectFile ? "所有變更已儲存" : "還沒存成專案檔";
  }
  if (!isDesktop) return dirty ? "還沒儲存，請下載專案" : "還沒有修改";
  if (dirty) return recoveryState === "saved" ? "還沒儲存（已自動備份）" : recoveryState === "error" ? "還沒儲存，自動備份也失敗了" : "還沒儲存";
  return hasProjectFile ? "已儲存" : "還沒存成專案檔";
}

/** Every key saveStateMessage can return (the i18n test checks each has translations). */
export function saveStateMessageKeys(): string[] {
  const keys = new Set<string>();
  for (const mode of ["simple", "advanced"] as const) for (const isDesktop of [true, false]) for (const dirty of [true, false])
    for (const recoveryState of ["idle", "waiting", "saving", "saved", "error"] as const) for (const hasProjectFile of [true, false])
      keys.add(saveStateMessage({ mode, isDesktop, dirty, recoveryState, hasProjectFile }));
  return [...keys];
}
