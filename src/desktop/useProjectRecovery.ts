import { useEffect, useRef, useState } from "react";
import type { EditProject } from "../domain/types";
import type { HaoDesktopApi } from "./types";
import { createRecoveryQueue } from "./recoveryQueue";

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

interface ProjectRecoveryOptions {
  api?: HaoDesktopApi;
  project: EditProject;
  projectPath?: string;
  cleanUpdatedAt: string;
  dirty: boolean;
  recoveryOwner: object;
  isRecoveryOwnerCurrent: (owner: object) => boolean;
  onRestore: (project: EditProject, projectPath: string | undefined, cleanUpdatedAt: string, runtimeUrls: Record<string, string>) => void;
  onStatus: (message: string) => void;
}

export function useProjectRecovery({ api, project, projectPath, cleanUpdatedAt, dirty, recoveryOwner, isRecoveryOwnerCurrent, onRestore, onStatus }: ProjectRecoveryOptions) {
  const [ready, setReady] = useState(!api);
  const [state, setState] = useState<RecoveryState>("idle");
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
    void api.loadRecovery().then(async (result) => {
      if (!current()) return;
      if (!result.found) {
        if (result.reason !== "missing") {
          if (await clearInitialRecovery()) onStatusRef.current(result.reason === "stale" ? "已清除超過 30 天的自動復原資料。" : "偵測到損壞的自動復原資料，已安全清除。正常專案檔不受影響。");
        }
        return;
      }
      const savedAt = new Date(result.snapshot.savedAt).toLocaleString();
      const integrationAutoRestore = await api.integrationSmokeEnabled?.().catch(() => false) ?? false;
      if (!current()) return;
      if (!integrationAutoRestore && !window.confirm(`Editkin 找到 ${savedAt} 的未儲存修改。\n要恢復這次工作嗎？`)) {
        await clearInitialRecovery();
        return;
      }
      let runtimeUrls: Record<string, string> = {};
      try { runtimeUrls = await api.previewUrls(result.snapshot.project.assets); }
      catch { /* missing media stays visible in the graph and can be relinked later */ }
      if (current()) {
        onRestoreRef.current(result.snapshot.project, result.snapshot.projectPath, result.snapshot.cleanUpdatedAt, runtimeUrls);
        onStatusRef.current(result.source === "previous" ? "主要復原資料損壞，已從上一個有效 autosave 恢復。請儲存專案。" : "已恢復未儲存的工作。請確認後儲存專案。");
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
      void queue.enqueue(currentGeneration, () => api.saveRecovery(project, projectPath, cleanUpdatedAt), current).then((applied) => {
        if (applied) setState("saved");
      }).catch((error) => {
        if (current()) {
          setState("error");
          onStatusRef.current(recoveryFailureMessage(error, "Autosave 失敗"));
        }
      });
    }, RECOVERY_AUTOSAVE_DELAY_MS);
    return () => { window.clearTimeout(timer); queue.invalidate(); };
  }, [api, cleanUpdatedAt, dirty, queue, project, projectPath, ready, recoveryOwner, isRecoveryOwnerCurrent]);

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

  return { dirty, ready, recoveryState: state };
}
