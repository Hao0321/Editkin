import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BatchAutoEditSession, HaoDesktopApi, OpenProjectResult } from "./types";
import type { EditorialProfileId } from "../domain/types";
import type { ProjectSession } from "../application/projectSession";
import type { DesktopBatchEngineTaskProgressV1 } from "../application/engineTaskContractV1";

interface UseBatchAutoEditOptions {
  api?: HaoDesktopApi;
  projectSession: ProjectSession;
  onOpenProject: (opened: OpenProjectResult) => void;
  onStatus: (message: string) => void;
}

export function useBatchAutoEdit({ api, projectSession, onOpenProject, onStatus }: UseBatchAutoEditOptions) {
  const [session, setSession] = useState<BatchAutoEditSession>();
  const [show, setShow] = useState(false);
  const processing = useRef(false);
  const opening = useRef(false);
  const execution = useRef<AbortController | undefined>(undefined);
  const [progress, setProgress] = useState<DesktopBatchEngineTaskProgressV1>();
  const [queueRunning, setQueueRunning] = useState(false);
  const autoResumeAllowed = useRef(true);

  const runQueue = useCallback(async (initial: BatchAutoEditSession, onlyJobId?: string, includeFailed = false) => {
    if (!api || processing.current) return;
    processing.current = true;
    setQueueRunning(true);
    const controller = new AbortController();
    execution.current = controller;
    const sessionId = initial.id;
    let current = initial;
    try {
      const candidates = onlyJobId
        ? current.jobs.filter((job) => job.id === onlyJobId)
        : current.jobs.filter((job) => job.status === "queued" || (includeFailed && job.status === "failed"));
      for (const candidate of candidates) {
        if (controller.signal.aborted || current.id !== sessionId) break;
        onStatus(`批量自動剪輯 ${candidate.sourceName}：正在本機分析、配樂並輸出…`);
        try {
          const reply = await api.runBatchAutoEditItem(sessionId, candidate.id, { signal: controller.signal, onProgress: event => {
            if (!controller.signal.aborted && execution.current === controller && event.progress.sessionId === sessionId && event.progress.jobId === candidate.id) setProgress(structuredClone(event));
          } });
          if (reply.session.id !== sessionId || !reply.session.jobs.some(job => job.id === candidate.id)) throw new Error("批次回應身分不一致");
          current = reply.session;
          setSession(current);
        } catch (error) {
          onStatus(error instanceof Error ? `批次項目失敗：${error.message}` : "批次項目失敗");
          const refreshed = await api.getBatchSession();
          if (refreshed.session?.id === sessionId) {
            current = refreshed.session;
            setSession(current);
          } else if (refreshed.session) { onStatus("批次工作已替換，停止舊工作佇列。"); break; }
        }
      }
      const completed = current.jobs.filter((job) => job.status === "completed").length;
      const failed = current.jobs.filter((job) => job.status === "failed").length;
      onStatus(controller.signal.aborted ? "批次已要求停止；已提交的剪輯會保留，可稍後續跑。" : `批量處理完成：${completed} 支成片可繼續編輯${failed ? ` · ${failed} 支可個別重試` : ""}。`);
    } finally {
      if (execution.current === controller) execution.current = undefined;
      processing.current = false;
      setQueueRunning(false);
    }
  }, [api, onStatus]);
  const cancel = useCallback(() => {
    autoResumeAllowed.current = false;
    if (execution.current) { execution.current.abort(new Error("ENGINE_TASK_CANCELLED")); return; }
    const owners = session?.jobs.filter(job => job.status === "running" && job.operationId) ?? [];
    if (!api?.cancelDesktopBatchTaskV1 || !session || owners.length === 0) {
      onStatus("無法連線到這個批次工作，請重新開啟工作台查詢。"); return;
    }
    const sessionId = session.id;
    void Promise.all(owners.map(job => api.cancelDesktopBatchTaskV1!({ operationId: job.operationId!, sessionId, jobId: job.id })))
      .then(results => onStatus(results.some(result => result.known && result.cancelRequested) ? "已要求停止批次；已提交的剪輯會保留。" : "批次已結束或工作已替換，正在重新查詢。"))
      .catch(error => onStatus(error instanceof Error ? error.message : "無法停止批次"));
  }, [api, onStatus, session]);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    if (!api) return;
    const refresh = async () => {
      try {
        const { session: restored } = await api.getBatchSession();
        if (!active || !restored || processing.current) return;
        setSession(restored);
        if (restored.jobs.some(job => job.status === "queued" || job.status === "running" || job.status === "failed")) setShow(true);
        if (restored.jobs.some(job => job.status === "running")) {
          timer = window.setTimeout(() => { void refresh(); }, 500); return;
        }
        if (autoResumeAllowed.current && restored.jobs.some(job => job.status === "queued")) void runQueue(restored);
      } catch (error) { if (active) onStatus(error instanceof Error ? error.message : "無法恢復批次工作"); }
    };
    void refresh();
    return () => { active = false; if (timer !== undefined) window.clearTimeout(timer); };
  }, [api, onStatus, runQueue]);

  const start = useCallback(async (editorialProfile: EditorialProfileId) => {
    if (!api || processing.current) return;
    try {
      const picked = await api.pickBatchMedia(editorialProfile);
      if (picked.canceled || !picked.session) return;
      autoResumeAllowed.current = true;
      setSession(picked.session);
      setShow(true);
      onStatus(`已建立 ${picked.session.jobs.length} 個獨立批次工作；原始影片保持唯讀。`);
      await runQueue(picked.session);
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "無法建立批量自動剪輯工作");
    }
  }, [api, onStatus, runQueue]);

  const retry = useCallback(async (jobId: string) => {
    if (!session) return;
    await runQueue(session, jobId);
  }, [runQueue, session]);
  const resume = useCallback(async () => { if (session) { autoResumeAllowed.current = true; await runQueue(session, undefined, true); } }, [runQueue, session]);

  const openProject = useCallback(async (jobId: string) => {
    if (!api || !session || opening.current) return;
    opening.current = true;
    const started = projectSession.getSnapshot();
    try {
      if (started.dirty && !window.confirm("目前專案有尚未儲存的修改。要放棄修改並開啟批次成片嗎？")) return;
      if (!projectSession.isCurrentSession(started.sessionId)) return;
      const opened = await api.openBatchProject(session.id, jobId);
      if (!projectSession.isCurrentSession(started.sessionId) || opened.canceled || !opened.project) return;
      const current = projectSession.getSnapshot();
      // Saving only changes metadata; only new content needs renewed consent.
      if (current.dirty && current.contentOwner !== started.contentOwner
        && !window.confirm("開啟批次成片期間，專案又有新的未儲存修改。確定要放棄這些修改並開啟嗎？")) return;
      if (!projectSession.isCurrentSession(started.sessionId)) return;
      onOpenProject(opened);
      setShow(false);
      onStatus(`已開啟批次成片的可編輯時間軸：${opened.path}`);
    } catch (error) {
      if (projectSession.isCurrentSession(started.sessionId)) {
        onStatus(error instanceof Error ? error.message : typeof error === "string" && error.trim() ? error : "無法開啟批次專案");
      }
    } finally {
      opening.current = false;
    }
  }, [api, onOpenProject, onStatus, projectSession, session]);

  const summary = useMemo(() => session ? {
    total: session.jobs.length,
    completed: session.jobs.filter((job) => job.status === "completed").length,
    failed: session.jobs.filter((job) => job.status === "failed").length,
    queued: session.jobs.filter((job) => job.status === "queued").length,
    running: queueRunning || session.jobs.some((job) => job.status === "running"),
  } : undefined, [queueRunning, session]);

  const canCancel = Boolean(execution.current && !execution.current.signal.aborted)
    || Boolean(api?.cancelDesktopBatchTaskV1 && session?.jobs.some(job => job.status === "running" && job.operationId));
  return { session, summary, show, setShow, start, retry, openProject, progress, cancel, resume, canCancel };
}
