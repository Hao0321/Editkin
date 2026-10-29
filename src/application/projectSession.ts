import { createHistory, type EditorHistory } from "../domain/history";
import {synchronizeHistoricalDerivatives, type AcceptedDerivativeUpdate} from "./mediaDerivativeHistory";
import { applyCommand } from "../domain/commands";
import type { EditProject, MediaDerivatives } from "../domain/types";
import { isProjectFileIdentityV1, type ProjectFileIdentityV1 } from "../domain/projectFileIdentityV1";

function acceptedDiskIdentity(project: EditProject, value?: ProjectFileIdentityV1 | null, recoveryCleanUpdatedAt?: string): Readonly<ProjectFileIdentityV1> | undefined {
  if (value == null) return undefined;
  const matchesGraph = value.revision === project.revision && value.updatedAt === project.updatedAt;
  const matchesRecoveryBase = recoveryCleanUpdatedAt !== undefined && value.updatedAt === recoveryCleanUpdatedAt
    && Number.isSafeInteger(project.revision) && project.revision >= value.revision;
  if (!isProjectFileIdentityV1(value) || value.projectId !== project.id || !matchesGraph && !matchesRecoveryBase) {
    throw new Error("檔案內容憑證與專案回應不一致；未接納這次磁碟狀態。");
  }
  return Object.freeze({ ...value });
}

export interface ProjectSessionSnapshot {
  sessionId: number;
  history: EditorHistory;
  projectPath?: string;
  cleanUpdatedAt: string;
  dirty: boolean;
  diskRevision: number;
  diskFileIdentity?: Readonly<ProjectFileIdentityV1>;
  savePending: boolean;
  recoveryOwner: object;
  contentOwner: object;
  /** Set when this session began by adopting another program's single-revision write as one Undo step (ROADMAP J4). */
  externalWrite?: { label: string; revisionBefore: number; revisionAfter: number; writtenUpdatedAt: string };
}

/** Label of the one Undo step for an external write that has no committed receipt to name it. */
export const EXTERNAL_WRITE_UNDO_LABEL = "外部修改";

/** The clean content an external write replaced, kept as exactly one Undo step, and that step's label. */
export interface ExternalWriteUndo {
  previous: EditProject;
  label: string;
}

/** Only the same project, exactly one revision later, is a single-revision external write. */
export function isSingleRevisionExternalWrite(previous: EditProject, next: EditProject): boolean {
  return previous.id === next.id && Number.isSafeInteger(previous.revision) && next.revision === previous.revision + 1;
}

/**
 * The adopted write's label while the next Undo would take exactly that write back; otherwise undefined. Undo and Redo
 * keep a state's updatedAt (they only rewrite its revision) and every new command stamps a later one, so the written
 * state is recognised by its updatedAt one step above the bottom of the history.
 */
export function nextUndoExternalWriteLabel(snapshot: ProjectSessionSnapshot): string | undefined {
  const write = snapshot.externalWrite;
  return write && snapshot.history.past.length === 1 && snapshot.history.present.updatedAt === write.writtenUpdatedAt ? write.label : undefined;
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
  readonly expectedFileIdentity?: Readonly<ProjectFileIdentityV1>;
}

export interface ProjectSaveResult {
  canceled?: boolean;
  path?: string;
  project?: EditProject;
  fileIdentity?: ProjectFileIdentityV1 | null;
}

/** One synchronous window-local owner: async I/O never owns later editor content. */
export function createProjectSession(initial: EditProject, initialPath?: string, initialIdentity?: ProjectFileIdentityV1 | null) {
  let cleanProject: EditProject | undefined = initial;
  let snapshot: ProjectSessionSnapshot = {
    sessionId: 1, history: createHistory(initial), projectPath: initialPath,
    cleanUpdatedAt: initial.updatedAt, dirty: false, diskRevision: initial.revision,
    diskFileIdentity: initialPath ? acceptedDiskIdentity(initial, initialIdentity) : undefined,
    savePending: false, recoveryOwner: {}, contentOwner: {},
  };
  let pending: { request: SaveRequest; completed: boolean } | undefined;
  // Armed only while a reload hands this exact opened project to the host's load callback (adoptExternalWrite).
  let armedExternalWrite: (ExternalWriteUndo & { next: EditProject }) | undefined;
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
    replaceProject: (project: EditProject, path?: string, options: { dirty?: boolean; cleanUpdatedAt?: string; undoFrom?: ExternalWriteUndo; fileIdentity?: ProjectFileIdentityV1 | null } = {}) => {
      const diskFileIdentity = path ? acceptedDiskIdentity(project, options.fileIdentity, options.dirty ? options.cleanUpdatedAt : undefined) : undefined;
      const requested = options.undoFrom ?? (armedExternalWrite?.next === project ? armedExternalWrite : undefined);
      // ROADMAP J4: a clean single-revision external write keeps the replaced content as exactly one Undo step.
      // Anything else (dirty, another project, a revision jump) starts a fresh history, as before.
      const undoFrom = requested && !options.dirty && isSingleRevisionExternalWrite(requested.previous, project) ? requested : undefined;
      cleanProject = options.dirty ? undefined : project;
      publish({
        sessionId: snapshot.sessionId + 1, history: undoFrom ? { ...createHistory(project), past: [undoFrom.previous] } : createHistory(project), projectPath: path,
        cleanUpdatedAt: options.cleanUpdatedAt ?? project.updatedAt,
        dirty: project !== cleanProject, diskRevision: diskFileIdentity?.revision ?? project.revision,
        diskFileIdentity,
        savePending: Boolean(pending), recoveryOwner: {}, contentOwner: {},
        ...(undoFrom ? { externalWrite: { label: undoFrom.label, revisionBefore: undoFrom.previous.revision, revisionAfter: project.revision, writtenUpdatedAt: project.updatedAt } } : {}),
      });
    },
    /** Runs the host's load callback with this one opened project armed for adoption as a single Undo step. */
    adoptExternalWrite: (undo: ExternalWriteUndo & { next: EditProject }, load: () => void) => {
      armedExternalWrite = undo;
      try { load(); } finally { armedExternalWrite = undefined; }
    },
    beginSave: (saveAs = false): SaveRequest | undefined => {
      if (pending) return undefined;
      const submittedProject = snapshot.history.present;
      const project = structuredClone(submittedProject);
      // Undo/Redo and a just-completed save must use the acknowledged disk version.
      project.revision = snapshot.diskRevision;
      const request = Object.freeze({ sessionId: snapshot.sessionId, project, submittedProject, projectPath: snapshot.projectPath, saveAs,
        expectedFileIdentity: !saveAs && snapshot.diskFileIdentity ? Object.freeze({ ...snapshot.diskFileIdentity }) : undefined });
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
      const diskFileIdentity = acceptedDiskIdentity(saved.project, saved.fileIdentity);
      pending.completed = true;
      cleanProject = saved.project;
      const current = snapshot.history;
      const present = current.present === request.submittedProject
        ? saved.project
        : { ...current.present, revision: saved.project.revision };
      publish({
        ...snapshot, history: { ...current, present }, projectPath: saved.path,
        cleanUpdatedAt: saved.project.updatedAt, diskRevision: saved.project.revision,
        diskFileIdentity,
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
