import type { EditProject } from "../domain/types";
import type { ProjectSession, ProjectTask } from "./projectSession";
import { dispatchPreparedEditGraphDownload, prepareEditGraphDownload, PROJECT_DOWNLOAD_URL_LIFETIME_MS, type ProjectDownloadRequest } from "./exportGraph";

export interface ProjectDownloadLease extends Readonly<ProjectDownloadRequest> {
  readonly requestId: string;
  readonly url: string;
  readonly expiresAt: number;
  readonly projectId: string;
  readonly revision: number;
  /** Content changes label an older snapshot; they do not replace its bytes. */
  readonly isCurrent: () => boolean;
  /** Guards a briefly retained DOM link after cancellation/replacement/expiry. */
  readonly isAvailable: () => boolean;
}

interface OwnedDownload {
  view: ProjectDownloadLease;
  task: ProjectTask;
  dispose: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** Factory has no mount side effects, so discarded React renders cannot leak listeners. */
export function createProjectDownloadOwner(input: {
  session: ProjectSession;
  onChange: (lease: ProjectDownloadLease | undefined) => void;
}) {
  let current: OwnedDownload | undefined;
  let mounted = false;
  let attachment = 0;
  let sequence = 0;
  const release = (owned = current) => {
    if (!owned || current !== owned) return;
    current = undefined;
    if (owned.timer !== undefined) clearTimeout(owned.timer);
    owned.dispose();
    input.onChange(undefined);
  };
  return {
    attach: (): (() => void) => {
      if (mounted) throw new Error("專案下載 owner 已連接，不能重複連接。");
      mounted = true;
      const generation = ++attachment;
      const onPageHide = () => release();
      const unsubscribe = input.session.subscribe(() => {
        if (current && !current.task.isSessionCurrent()) release();
      });
      window.addEventListener("pagehide", onPageHide);
      return () => {
        if (!mounted || attachment !== generation) return;
        mounted = false;
        unsubscribe();
        window.removeEventListener("pagehide", onPageHide);
        release();
      };
    },
    request: (project = input.session.getSnapshot().history.present): ProjectDownloadRequest => {
      const task = input.session.beginTask(project);
      if (!mounted || !task.isCurrent()) throw new Error("下載請求所屬專案已失效，請從目前工作區重新下載。");
      release();
      if (!Number.isSafeInteger(sequence + 1)) throw new Error("下載請求數超過上限，請重新開啟工作區。");
      const artifact = prepareEditGraphDownload(project);
      const expiresAt = Date.now() + PROJECT_DOWNLOAD_URL_LIFETIME_MS;
      const requestId = `project-download-${input.session.getSnapshot().sessionId}-${++sequence}`;
      let owned!: OwnedDownload;
      const view: ProjectDownloadLease = Object.freeze({ status: artifact.status, filename: artifact.filename, bytes: artifact.bytes,
        url: artifact.url, requestId, expiresAt, projectId: project.id, revision: project.revision,
        isCurrent: () => task.isCurrent() && input.session.getSnapshot().history.present === project,
        isAvailable: () => mounted && current === owned && task.isSessionCurrent() && Date.now() < expiresAt });
      owned = { view, task, dispose: artifact.dispose };
      current = owned;
      try {
        owned.timer = setTimeout(() => release(owned), PROJECT_DOWNLOAD_URL_LIFETIME_MS);
        input.onChange(view);
        dispatchPreparedEditGraphDownload(view);
      } catch (error) { release(owned); throw error; }
      return { status: view.status, filename: view.filename, bytes: view.bytes };
    },
    cancel: (requestId?: string): void => { if (!requestId || current?.view.requestId === requestId) release(); },
    getCurrent: (): ProjectDownloadLease | undefined => current?.view,
  };
}
