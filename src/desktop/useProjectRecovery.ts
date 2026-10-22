import { useEffect, useRef, useState } from "react";
import type { EditProject } from "../domain/types";
import type { HaoDesktopApi, OpenProjectResult } from "./types";
import { createRecoveryQueue } from "./recoveryQueue";
import type { ProjectFileIdentityV1 } from "../domain/projectFileIdentityV1";

export function preventDirtyProjectUnload(event: Pick<BeforeUnloadEvent, "preventDefault" | "returnValue">, dirty: boolean): boolean {
  if (!dirty) return false;
  event.preventDefault();
  event.returnValue = "";
  return true;
}

export type RecoveryState = "idle" | "waiting" | "saving" | "saved" | "error";
export const RECOVERY_AUTOSAVE_DELAY_MS = 500;

export function recoveryFailureMessage(error: unknown, prefix: string): string {
  const detail = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return detail.trim() ? `${prefix}：${detail}` : `${prefix}；請立即手動儲存`;
}

/** 打開找回的版本 / 打開上次存的檔案 / 不要了 (the last only after a second confirmation in the dialog). */
export type RecoveryChoice = "restore" | "open-saved" | "discard";

export interface RecoveryChoiceRequest {
  /** Local date and time of the recovered changes. */
  savedAt: string;
  projectName: string;
  projectPath?: string;
  /** The last saved file exists and can be opened instead. */
  savedFileAvailable: boolean;
  /** The raw reason the last saved file could not be opened (shown under 「查看原因」). */
  failure?: string;
  choose: (choice: RecoveryChoice) => void;
}

export interface ProjectRecoveryState {
  dirty: boolean;
  ready: boolean;
  recoveryState: RecoveryState;
  /** Set while the startup question waits for the creator. */
  pendingChoice?: RecoveryChoiceRequest;
}

interface ProjectRecoveryOptions {
  api?: HaoDesktopApi;
  project: EditProject;
  projectPath?: string;
  cleanUpdatedAt: string;
  dirty: boolean;
  recoveryOwner: object;
  diskFileIdentity?: Readonly<ProjectFileIdentityV1>;
  isRecoveryOwnerCurrent: (owner: object) => boolean;
  onRestore: (project: EditProject, projectPath: string | undefined, cleanUpdatedAt: string, runtimeUrls: Record<string, string>, baseFileIdentity?: Readonly<ProjectFileIdentityV1>) => void;
  /** Loads the last saved file when the creator picks it instead of the recovered copy. */
  onOpenSaved?: (opened: OpenProjectResult) => void;
  onStatus: (message: string) => void;
}

export function useProjectRecovery({ api, project, projectPath, cleanUpdatedAt, dirty, recoveryOwner, diskFileIdentity, isRecoveryOwnerCurrent, onRestore, onOpenSaved, onStatus }: ProjectRecoveryOptions): ProjectRecoveryState {
  const [ready, setReady] = useState(!api);
  const [state, setState] = useState<RecoveryState>("idle");
  const [pendingChoice, setPendingChoice] = useState<RecoveryChoiceRequest>();
  const onOpenSavedRef = useRef(onOpenSaved);
  onOpenSavedRef.current = onOpenSaved;
  const [queue] = useState(createRecoveryQueue);
  const autosaveReadyPass = useRef(false);
  const initializing = useRef(Boolean(api));
  const onRestoreRef = useRef(onRestore);
  const onStatusRef = useRef(onStatus);
  onRestoreRef.current = onRestore;
  onStatusRef.current = onStatus;

  useEffect(() => {
    if (!api) return;
    let canceled = false;
    initializing.current = true;
    setReady(false);
    const token = queue.invalidate();
    const owner = recoveryOwner;
    const current = () => !canceled && isRecoveryOwnerCurrent(owner);
    const clearInitialRecovery = () => queue.enqueue(token, () => api.clearRecovery(), current);
    // Nothing is deleted without the creator's confirmed 「不要了」: other data is moved to recovery/kept.
    const keepInitialRecoveryAside = () => api.keepRecoveryAside
      ? queue.enqueue(token, async () => { await api.keepRecoveryAside!(); }, current)
      : Promise.resolve(false);
    const ask = (request: Omit<RecoveryChoiceRequest, "choose">) => new Promise<RecoveryChoice>(resolve => {
      setPendingChoice({ ...request, choose: choice => { setPendingChoice(undefined); resolve(choice); } });
    });
    void api.loadRecovery().then(async (result) => {
      if (!current()) return;
      if (!result.found) {
        if (result.reason !== "missing") {
          if (api.keepRecoveryAside) {
            if (await keepInitialRecoveryAside()) onStatusRef.current(result.reason === "stale" ? "超過 30 天的當機復原資料已移到復原資料夾保存，不會再提示。" : "偵測到損壞的當機復原資料，已移到復原資料夾保存。正常專案檔不受影響。");
          } else if (await clearInitialRecovery()) onStatusRef.current(result.reason === "stale" ? "已清除超過 30 天的自動復原資料。" : "偵測到損壞的自動復原資料，已安全清除。正常專案檔不受影響。");
        }
        return;
      }
      const savedAt = new Date(result.snapshot.savedAt).toLocaleString();
      const integrationAutoRestore = await api.integrationSmokeEnabled?.().catch(() => false) ?? false;
      if (!current()) return;
      if (!integrationAutoRestore) {
        const savedPath = result.snapshot.projectPath;
        const savedFileAvailable = Boolean(savedPath && api.openProjectPath && onOpenSavedRef.current)
          && (await api.inspectProjectFile?.(savedPath!).then(file => file.exists, () => false) ?? true);
        if (!current()) return;
        let failure: string | undefined;
        for (;;) {
          const choice = await ask({ savedAt, projectName: result.snapshot.project.name, projectPath: savedPath, savedFileAvailable, failure });
          if (!current()) return;
          if (choice === "discard") {
            if (await clearInitialRecovery()) onStatusRef.current("已丟掉找回的版本。");
            return;
          }
          if (choice !== "open-saved" || !savedPath || !api.openProjectPath || !onOpenSavedRef.current) break;
          try {
            const opened = await api.openProjectPath(savedPath);
            if (!current()) return;
            if (opened.canceled || !opened.project) throw new Error("沒有讀到專案內容");
            // The recovered copy is kept (recovery/kept) before the saved file replaces the editor state.
            const kept = await keepInitialRecoveryAside();
            if (!current()) return;
            onOpenSavedRef.current(opened);
            onStatusRef.current(kept ? "已打開上次存的檔案；找回的版本另外保留在 Editkin 的復原資料夾。" : "已打開上次存的檔案。");
            return;
          } catch (error) {
            if (!current()) return;
            failure = error instanceof Error ? error.message : String(error);
          }
        }
      }
      let runtimeUrls: Record<string, string> = {};
      try { runtimeUrls = await api.previewUrls(result.snapshot.project.assets); }
      catch { /* missing media stays visible in the graph and can be relinked later */ }
      if (current()) {
        onRestoreRef.current(result.snapshot.project, result.snapshot.projectPath, result.snapshot.cleanUpdatedAt, runtimeUrls, result.snapshot.baseFileIdentity);
        onStatusRef.current(result.source === "previous" ? "主要復原資料損壞，已從上一個有效的當機復原備份恢復。請儲存專案。" : "已恢復未儲存的工作。請確認後儲存專案。");
      }
    }).catch((error) => {
      if (current()) onStatusRef.current(recoveryFailureMessage(error, "讀取自動復原資料失敗"));
    }).finally(() => { if (!canceled) { initializing.current = false; setReady(true); } });
    return () => { canceled = true; queue.invalidate(); };
    // Owner changes must invalidate old work, never restart startup restoration.
  }, [api, queue, isRecoveryOwnerCurrent]);

  useEffect(() => {
    if (!api || !ready || initializing.current) return;
    const initialReadyPass = !autosaveReadyPass.current;
    autosaveReadyPass.current = true;
    const currentGeneration = queue.invalidate();
    const owner = recoveryOwner;
    const current = () => queue.current() === currentGeneration && isRecoveryOwnerCurrent(owner);
    if (!dirty) {
      if (initialReadyPass) {
        setState("idle");
        return;
      }
      void queue.enqueue(currentGeneration, () => api.clearRecovery(), current).then((applied) => {
        if (applied) setState("idle");
      }).catch((error) => {
        if (current()) { setState("error"); onStatusRef.current(recoveryFailureMessage(error, "清理已儲存專案的復原資料失敗")); }
      });
      return;
    }
    setState("waiting");
    const timer = window.setTimeout(() => {
      if (!current()) return;
      setState("saving");
      void queue.enqueue(currentGeneration, () => api.saveRecovery(project, projectPath, cleanUpdatedAt, diskFileIdentity), current).then((applied) => {
        if (applied) setState("saved");
      }).catch((error) => {
        if (current()) {
          setState("error");
          // This snapshot is crash recovery, not a save of the project file.
          onStatusRef.current(recoveryFailureMessage(error, "當機復原備份失敗"));
        }
      });
    }, RECOVERY_AUTOSAVE_DELAY_MS);
    return () => { window.clearTimeout(timer); queue.invalidate(); };
  }, [api, cleanUpdatedAt, dirty, queue, project, projectPath, ready, recoveryOwner, diskFileIdentity, isRecoveryOwnerCurrent]);

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      preventDirtyProjectUnload(event, dirty);
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  useEffect(() => {
    document.title = `${dirty ? "● " : ""}${project.name} — Editkin`;
  }, [dirty, project.name]);

  return { dirty, ready, recoveryState: state, pendingChoice };
}
