import type { ProjectSession } from "../application/projectSession";
import type { HaoDesktopApi, ProjectOutsideMediaInspection } from "./apiTypes";

/**
 * The desktop prompt for an opened project's media that AI agents (MCP) may not read yet (security fix 2026-10-23).
 * Opening a project grants nothing; the host lists the project's ungranted media (re-reading the project file itself)
 * and only 允許, pressed here by the creator, grants them. 「先不要」 is remembered for this run of Editkin only, never
 * on disk. Editing and preview never wait for any of this: the GUI reads media through its own asset scope.
 */
export type ProjectOutsideMediaApi = Required<Pick<HaoDesktopApi, "inspectProjectOutsideMedia" | "grantProjectOutsideMedia">>;

export interface ProjectOutsideMediaFile { path: string; name: string }

export type ProjectOutsideMediaPromptState =
  | { kind: "hidden" }
  | { kind: "asking"; projectPath: string; count: number; files: readonly ProjectOutsideMediaFile[]; busy: boolean; failed: boolean };

const HIDDEN: ProjectOutsideMediaPromptState = Object.freeze({ kind: "hidden" });

/** Project paths answered 「先不要」 in this run of Editkin (module memory: gone when the app closes). */
const declinedThisRun = new Set<string>();

export function usableProjectOutsideMediaApi(api: Partial<HaoDesktopApi> | undefined): ProjectOutsideMediaApi | undefined {
  return api?.inspectProjectOutsideMedia && api.grantProjectOutsideMedia ? api as ProjectOutsideMediaApi : undefined;
}

/** Only well-formed entries; anything else from the bridge is ignored. */
function filesOf(result: ProjectOutsideMediaInspection | undefined): ProjectOutsideMediaFile[] {
  if (!result || !Array.isArray(result.items)) return [];
  const seen = new Set<string>();
  return result.items.filter((item): item is ProjectOutsideMediaFile => Boolean(item) && typeof item.path === "string" && item.path.length > 0
    && typeof item.name === "string" && !seen.has(item.path) && Boolean(seen.add(item.path)))
    .map(item => ({ path: item.path, name: item.name }));
}

/** The folder a file is in, shortened to its last part (`…\Camera Roll`), for the file list. */
export function shortFolder(path: string): string {
  const separator = path.includes("\\") ? "\\" : "/";
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (parts.length < 2) return "";
  // A file at a drive or filesystem root shows that root (C:\, /media/); otherwise only the last folder.
  return parts.length === 2 ? path.slice(0, path.length - parts[1].length) : `…${separator}${parts[parts.length - 2]}`;
}

export interface ProjectOutsideMediaPrompt {
  getSnapshot(): ProjectOutsideMediaPromptState;
  subscribe(listener: () => void): () => void;
  /** Watches the session: each opened (or newly saved-as) project file is checked once. Returns the stop function. */
  start(): () => void;
  /** 允許: the host grants only that project's own references among the listed files. */
  allow(): Promise<void>;
  /** 先不要: hidden, and not asked again for this project until Editkin is closed. */
  decline(): void;
}

export function createProjectOutsideMediaPrompt(host: {
  session: Pick<ProjectSession, "getSnapshot" | "subscribe">;
  api: ProjectOutsideMediaApi;
  /** Defaults to this run's memory; tests pass their own. */
  declined?: Set<string>;
}): ProjectOutsideMediaPrompt {
  const declined = host.declined ?? declinedThisRun;
  const listeners = new Set<() => void>();
  let state: ProjectOutsideMediaPromptState = HIDDEN;
  let watched: string | undefined;
  let request = 0;
  const publish = (next: ProjectOutsideMediaPromptState) => {
    state = next;
    for (const listener of [...listeners]) listener();
  };
  const check = () => {
    const { sessionId, projectPath } = host.session.getSnapshot();
    const key = projectPath ? `${sessionId}\u0000${projectPath}` : undefined;
    if (key === watched) return;
    watched = key;
    const current = ++request;
    if (state.kind !== "hidden") publish(HIDDEN);
    if (!projectPath || declined.has(projectPath)) return;
    void host.api.inspectProjectOutsideMedia(projectPath).then(result => {
      const files = filesOf(result);
      if (current !== request || declined.has(projectPath) || !files.length) return;
      publish({ kind: "asking", projectPath, count: files.length, files, busy: false, failed: false });
    }, () => { /* No answer from the host: nothing is asked and editing goes on. */ });
  };
  return {
    getSnapshot: () => state,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start: () => {
      check();
      const stop = host.session.subscribe(check);
      return () => { stop(); request++; watched = undefined; };
    },
    allow: async () => {
      if (state.kind !== "asking" || state.busy) return;
      const asking = state, current = request;
      publish({ ...asking, busy: true, failed: false });
      try {
        await host.api.grantProjectOutsideMedia(asking.projectPath, asking.files.map(file => file.path));
        if (current === request) publish(HIDDEN);
      } catch {
        if (current === request) publish({ ...asking, busy: false, failed: true });
      }
    },
    decline: () => {
      if (state.kind !== "asking" || state.busy) return;
      declined.add(state.projectPath);
      publish(HIDDEN);
    },
  };
}
