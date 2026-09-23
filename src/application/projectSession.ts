import { createHistory, type EditorHistory } from "../domain/history";
import {synchronizeHistoricalDerivatives, type AcceptedDerivativeUpdate} from "./mediaDerivativeHistory";
import { applyCommand } from "../domain/commands";
import type { EditProject, MediaDerivatives } from "../domain/types";

export interface ProjectSessionSnapshot {
  sessionId: number;
  history: EditorHistory;
  projectPath?: string;
  cleanUpdatedAt: string;
  dirty: boolean;
  diskRevision: number;
  savePending: boolean;
  recoveryOwner: object;
  contentOwner: object;
}

export interface ProjectTask {
  isCurrent: () => boolean;
  isSessionCurrent: () => boolean;
}

export interface SaveRequest {
  readonly sessionId: number;
  readonly project: EditProject;
  readonly submittedProject: EditProject;
  readonly projectPath?: string;
  readonly saveAs: boolean;
}

export interface ProjectSaveResult {
  canceled?: boolean;
  path?: string;
  project?: EditProject;
}

/** One synchronous window-local owner: async I/O never owns later editor content. */
export function createProjectSession(initial: EditProject, initialPath?: string) {
  let cleanProject: EditProject | undefined = initial;
  let snapshot: ProjectSessionSnapshot = {
    sessionId: 1, history: createHistory(initial), projectPath: initialPath,
    cleanUpdatedAt: initial.updatedAt, dirty: false, diskRevision: initial.revision,
    savePending: false, recoveryOwner: {}, contentOwner: {},
  };
  let pending: { request: SaveRequest; completed: boolean } | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: ProjectSessionSnapshot) => {
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };
  const session = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    isCurrentSession: (sessionId: number) => snapshot.sessionId === sessionId,
    isRecoveryOwnerCurrent: (owner: object) => snapshot.recoveryOwner === owner,
    beginTask: (expectedProject?: EditProject): ProjectTask => {
      const started = snapshot;
      const capturedCurrentContent = !expectedProject || expectedProject === started.history.present;
      return {
        isCurrent: () => capturedCurrentContent && snapshot.sessionId === started.sessionId && snapshot.contentOwner === started.contentOwner,
        isSessionCurrent: () => snapshot.sessionId === started.sessionId,
      };
    },
    setHistory: (update: EditorHistory | ((current: EditorHistory) => EditorHistory)) => {
      const next = typeof update === "function" ? update(snapshot.history) : update;
      if (next === snapshot.history) return;
      publish({ ...snapshot, history: next, dirty: next.present !== cleanProject, recoveryOwner: {}, contentOwner: {} });
    },
    applyMediaDerivatives: (updates: Array<{ assetId: string; sourceUri: string; derivatives: MediaDerivatives }>) => {
      let present = snapshot.history.present;
      let sourceChanged = false;
      const accepted: AcceptedDerivativeUpdate[] = [];
      for (const update of updates) {
        const asset = present.assets.find(item => item.id === update.assetId);
        if (!asset || asset.uri !== update.sourceUri) continue;
        const changedSource = Boolean(asset.derivatives?.sourceSha256 && asset.derivatives.sourceSha256 !== update.derivatives.sourceSha256);
        if (changedSource) sourceChanged = true;
        present = applyCommand(present, { type: "set_asset_derivatives", assetId: update.assetId, derivatives: update.derivatives });
        if (!changedSource) accepted.push({ ...update, derivatives: present.assets.find(item => item.id === update.assetId)!.derivatives! });
      }
      if (present === snapshot.history.present) return;
      // Proxy/thumbnail metadata is persisted, but does not change what an analysis
      // is editing or consume Undo/Redo. A known source hash change is not metadata.
      const synchronizeProjects = (projects: EditProject[]): EditProject[] => {
        if (!accepted.length) return projects;
        // Derivatives are cache metadata, not an undoable content decision. Keep
        // the history containers stable while refreshing their matching cache
        // records so background work cannot manufacture an Undo/Redo entry.
        for (let index = 0; index < projects.length; index += 1) {
          projects[index] = synchronizeHistoricalDerivatives(projects[index], accepted);
        }
        return projects;
      };
      publish({ ...snapshot, history: { ...snapshot.history, present,
        past: synchronizeProjects(snapshot.history.past),
        future: synchronizeProjects(snapshot.history.future),
      }, dirty: present !== cleanProject, recoveryOwner: {}, contentOwner: sourceChanged ? {} : snapshot.contentOwner });
    },
    replaceProject: (project: EditProject, path?: string, options: { dirty?: boolean; cleanUpdatedAt?: string } = {}) => {
      cleanProject = options.dirty ? undefined : project;
      publish({
        sessionId: snapshot.sessionId + 1, history: createHistory(project), projectPath: path,
        cleanUpdatedAt: options.cleanUpdatedAt ?? project.updatedAt,
        dirty: project !== cleanProject, diskRevision: project.revision,
        savePending: Boolean(pending), recoveryOwner: {}, contentOwner: {},
      });
    },
    beginSave: (saveAs = false): SaveRequest | undefined => {
      if (pending) return undefined;
      const submittedProject = snapshot.history.present;
      const project = structuredClone(submittedProject);
      // Undo/Redo and a just-completed save must use the acknowledged disk version.
      project.revision = snapshot.diskRevision;
      const request = Object.freeze({ sessionId: snapshot.sessionId, project, submittedProject, projectPath: snapshot.projectPath, saveAs });
      pending = { request, completed: false };
      publish({ ...snapshot, savePending: true });
      return request;
    },
    completeSave: (request: SaveRequest, saved: ProjectSaveResult): boolean => {
      if (pending?.request !== request || pending.completed || snapshot.sessionId !== request.sessionId || saved.canceled) return false;
      if (!saved.path?.trim() || !saved.project || saved.project.id !== request.submittedProject.id
        || !Number.isSafeInteger(saved.project.revision) || saved.project.revision <= request.project.revision) {
        throw new Error("儲存回應缺少有效的專案路徑、內容或新版本；目前修改仍保留，請再試一次。");
      }
      pending.completed = true;
      cleanProject = saved.project;
      const current = snapshot.history;
      const present = current.present === request.submittedProject
        ? saved.project
        : { ...current.present, revision: saved.project.revision };
      publish({
        ...snapshot, history: { ...current, present }, projectPath: saved.path,
        cleanUpdatedAt: saved.project.updatedAt, diskRevision: saved.project.revision,
        dirty: present !== cleanProject, recoveryOwner: {},
      });
      return true;
    },
    finishSave: (request: SaveRequest) => {
      if (pending?.request !== request) return;
      pending = undefined;
      publish({ ...snapshot, savePending: false });
    },
  };
  return session;
}

export type ProjectSession = ReturnType<typeof createProjectSession>;
