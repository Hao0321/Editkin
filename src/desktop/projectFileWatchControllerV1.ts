import type { ProjectSession } from "../application/projectSession";
import { isProjectFileIdentityV1, projectFileWatchDecisionV1, sameProjectFileIdentityV1, type ProjectFileIdentityV1 } from "../domain/projectFileIdentityV1";
import type { HaoDesktopApi } from "./apiTypes";
import { createProjectMetadataCheck } from "./projectMetadataCheck";

export const PROJECT_FILE_WATCH_MS = 3_000;

export interface ProjectFileChange {
  kind: "changed" | "missing";
  path: string;
  revision?: number;
  fileIdentity?: Readonly<ProjectFileIdentityV1>;
}

export interface ProjectFileWatchPortsV1 {
  listenFocus: (callback: () => void) => () => void;
  every: (milliseconds: number, callback: () => void) => () => void;
  isVisible: () => boolean;
  onChange: (change: ProjectFileChange | undefined) => void;
}

/** One observer/dismissal owner. The session, not this observer, owns acknowledged disk bytes. */
export function createProjectFileWatchControllerV1(
  api: Pick<HaoDesktopApi, "inspectProjectFile">,
  session: ProjectSession,
  ports: ProjectFileWatchPortsV1,
) {
  const checks = createProjectMetadataCheck();
  let disposed = false;
  let previous = session.getSnapshot();
  let binding: { sessionId: number; path?: string; dismissed?: Readonly<ProjectFileIdentityV1>; missingDismissed?: boolean }
    = { sessionId: previous.sessionId, path: previous.projectPath };
  let change: ProjectFileChange | undefined;
  let stopSession = () => {};
  let stopFocus = () => {};
  let stopTimer = () => {};

  const publish = (next: ProjectFileChange | undefined) => {
    if (disposed || next === change) return;
    change = next;
    ports.onChange(next);
  };
  const refreshBinding = () => {
    const next = session.getSnapshot();
    const changed = next.sessionId !== binding.sessionId || next.projectPath !== binding.path;
    const shouldCheck = changed || next.diskRevision !== previous.diskRevision || previous.savePending && !next.savePending;
    previous = next;
    if (changed) {
      checks.invalidate();
      binding = { sessionId: next.sessionId, path: next.projectPath };
      publish(undefined);
    }
    return shouldCheck;
  };

  const check = (): Promise<void> => {
    if (disposed || !api.inspectProjectFile) return Promise.resolve();
    refreshBinding();
    // A newer focus/notify/reconnect hint supersedes publication of an older
    // in-flight observation, without starting a second parallel file read.
    checks.invalidate();
    return checks.request(async isCurrent => {
      if (disposed || !isCurrent()) return;
      const snapshot = session.getSnapshot();
      const captured = binding;
      const path = snapshot.projectPath;
      if (!path || snapshot.savePending) return;
      // Never provide mtime as an unchanged shortcut. The host uses the same
      // bounded primary-byte producer as canonical open/save receipts.
      const file = await api.inspectProjectFile!(path);
      const now = session.getSnapshot();
      if (disposed || !isCurrent() || captured !== binding || now.sessionId !== snapshot.sessionId
        || now.projectPath !== path || now.diskRevision !== snapshot.diskRevision || now.savePending) return;
      if (!file.exists) {
        if (!captured.missingDismissed && change?.kind !== "missing") publish({ kind: "missing", path });
        return;
      }
      captured.missingDismissed = false;
      if (file.readable === false || typeof file.revision !== "number") return;
      const observed = isProjectFileIdentityV1(file.fileIdentity) ? Object.freeze({ ...file.fileIdentity }) : undefined;
      const decision = projectFileWatchDecisionV1(observed, now.diskFileIdentity, captured.dismissed);
      if (decision === "self") { publish(undefined); return; }
      if (decision === "dismissed") return;
      // Missing/invalid receipt is unknown, never self-owned or permanently dismissed.
      if (change?.kind === "changed" && change.path === path && sameProjectFileIdentityV1(change.fileIdentity, observed)) return;
      publish({ kind: "changed", path, revision: file.revision, fileIdentity: observed });
    });
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    checks.invalidate();
    // Release each registered owner even if another host cleanup throws.
    try { stopTimer(); } finally { try { stopFocus(); } finally { stopSession(); } }
  };
  try {
    stopSession = session.subscribe(() => { if (!disposed && refreshBinding()) void check(); });
    stopFocus = ports.listenFocus(() => { void check(); });
    stopTimer = ports.every(PROJECT_FILE_WATCH_MS, () => { if (ports.isVisible()) void check(); });
  } catch (error) { dispose(); throw error; }
  void check();
  return {
    check,
    getChange: () => change,
    /** Capture the actual displayed object: an old callback cannot dismiss a newer byte version. */
    dismiss: (displayed: ProjectFileChange | undefined) => {
      if (disposed || !displayed || displayed !== change) return;
      if (displayed.kind === "missing") binding.missingDismissed = true;
      else if (isProjectFileIdentityV1(displayed.fileIdentity)) binding.dismissed = Object.freeze({ ...displayed.fileIdentity });
      publish(undefined);
    },
    dispose,
  };
}
