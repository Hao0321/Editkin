import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BatchAutoEditSession, HaoDesktopApi, OpenProjectResult } from "./types";
import type { EditorialProfileId } from "../domain/types";
import type { ProjectSession } from "../application/projectSession";

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

  const runQueue = useCallback(async (initial: BatchAutoEditSession, onlyJobId?: string) => {
    if (!api || processing.current) return;
    processing.current = true;
    let current = initial;
    try {
      const candidates = onlyJobId
        ? current.jobs.filter((job) => job.id === onlyJobId)
        : current.jobs.filter((job) => job.status === "queued");
      for (const candidate of candidates) {
        onStatus(`批量自動剪輯 ${candidate.sourceName}：正在本機分析、配樂並輸出…`);
        try {
          current = (await api.runBatchAutoEditItem(current.id, candidate.id)).session;
          setSession(current);
        } catch (error) {
          onStatus(error instanceof Error ? `批次項目失敗：${error.message}` : "批次項目失敗");
          const refreshed = await api.getBatchSession();
          if (refreshed.session) {
            current = refreshed.session;
            setSession(current);
          }
        }
      }
      const completed = current.jobs.filter((job) => job.status === "completed").length;
      const failed = current.jobs.filter((job) => job.status === "failed").length;
      onStatus(`批量處理完成：${completed} 支成片可繼續編輯${failed ? ` · ${failed} 支可個別重試` : ""}。`);
    } finally {
      processing.current = false;
    }
  }, [api, onStatus]);

  useEffect(() => {
    let active = true;
    if (!api) return;
    void api.getBatchSession().then(({ session: restored }) => {
      if (!active || !restored) return;
      setSession(restored);
      if (restored.jobs.some((job) => job.status === "queued" || job.status === "running")) {
        setShow(true);
        void runQueue(restored);
      }
    }).catch(() => undefined);
    return () => { active = false; };
  }, [api, runQueue]);

  const start = useCallback(async (editorialProfile: EditorialProfileId) => {
    if (!api || processing.current) return;
    try {
      const picked = await api.pickBatchMedia(editorialProfile);
      if (picked.canceled || !picked.session) return;
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
    running: session.jobs.some((job) => job.status === "running" || job.status === "queued"),
  } : undefined, [session]);

  return { session, summary, show, setShow, start, retry, openProject };
}
