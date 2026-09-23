import type { Dispatch, SetStateAction } from "react";
import { resolveAestheticSystem } from "./editkinAesthetic";
import type { HaoDesktopApi, OpenProjectResult } from "../desktop/types";
import { createEmptyProject } from "../domain/editGraph";
import type { ProjectSession } from "./projectSession";
import type { TrackingMode } from "../ui/editorShellTypes";

export interface AppProjectFileActionsInput {
  api?: HaoDesktopApi;
  session: ProjectSession;
  loadOpenedProject: (opened: OpenProjectResult) => void;
  setRuntimeUrls: Dispatch<SetStateAction<Record<string, string>>>;
  setSelectedClipId: Dispatch<SetStateAction<string | undefined>>;
  setSelectedCaptionId: Dispatch<SetStateAction<string | undefined>>;
  setPlayhead: Dispatch<SetStateAction<number>>;
  setPlaying: Dispatch<SetStateAction<boolean>>;
  setTrackingMode: Dispatch<SetStateAction<TrackingMode | undefined>>;
  setTrackingSelection: Dispatch<SetStateAction<undefined | { x: number; y: number; width: number; height: number }>>;
  setStatus: Dispatch<SetStateAction<string>>;
}

export function createAppProjectFileActions(input: AppProjectFileActionsInput) {
  const newProject = () => {
    if (input.session.getSnapshot().dirty && !window.confirm("建立新專案會捨棄目前尚未儲存的修改。要繼續嗎？")) return;
    const next = createEmptyProject();
    next.aestheticSystem = resolveAestheticSystem("auto", "longform");
    input.session.replaceProject(next);
    input.setRuntimeUrls({});
    input.setSelectedClipId(undefined);
    input.setSelectedCaptionId(undefined);
    input.setPlayhead(0);
    input.setPlaying(false);
    input.setTrackingMode(undefined);
    input.setTrackingSelection(undefined);
    input.setStatus("新專案已建立。先匯入影片、聲音或圖片吧。");
  };
  const openProject = async () => {
    if (!input.api) return;
    const started = input.session.getSnapshot();
    if (started.dirty && !window.confirm("開啟其他專案會捨棄目前尚未儲存的修改。要繼續嗎？")) return;
    try {
      const opened = await input.api.openProject();
      if (!input.session.isCurrentSession(started.sessionId)) return;
      if (opened.canceled || !opened.project) return;
      const current = input.session.getSnapshot();
      if (current.dirty && current.history.present !== started.history.present
        && !window.confirm("選擇檔案期間又有新的修改。確定捨棄這些修改並開啟其他專案嗎？")) return;
      input.loadOpenedProject(opened);
      input.setStatus(`已開啟 ${opened.path}`);
    } catch (error) {
      if (input.session.isCurrentSession(started.sessionId)) input.setStatus(fileActionError(error, "無法開啟專案"));
    }
  };
  const saveProject = async (saveAs = false) => {
    if (!input.api) return;
    const request = input.session.beginSave(saveAs);
    if (!request) {
      input.setStatus("上一版仍在儲存；你可以繼續編輯，完成後請再儲存目前修改。");
      return;
    }
    try {
      input.setStatus("正在儲存送出時的版本；你可以繼續編輯。");
      const saved = await input.api.saveProject(request.project, request.projectPath, request.saveAs);
      if (!input.session.isCurrentSession(request.sessionId)) return;
      if (saved.canceled) return input.setStatus("已取消儲存，修改仍保留。");
      if (!input.session.completeSave(request, saved)) return;
      input.setStatus(input.session.getSnapshot().dirty
        ? `已儲存送出時的版本：${saved.path}；後續修改已保留，尚未儲存。`
        : `專案已儲存：${saved.path}`);
    } catch (error) {
      if (input.session.isCurrentSession(request.sessionId)) input.setStatus(fileActionError(error, "無法儲存專案"));
    } finally {
      input.session.finishSave(request);
    }
  };
  return { newProject, openProject, saveProject };
}

function fileActionError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : typeof error === "string" && error.trim() ? error : fallback;
}
