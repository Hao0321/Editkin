import type { EditProject } from "../domain/types";
import type { ProjectSessionSnapshot } from "./projectSession";
import { referenceMotionTemplatesBehindUpdate } from "./referenceMotionTemplateInstances";
import { latestTemplatesUpdateReport, requestTemplatesUpdate, subscribeTemplatesUpdates, templatesUpdateRunning,
  type TemplatesUpdateReport } from "./templatesUpdateRuns";

/**
 * The calm one-line notice for a project whose titles an Editkin update left behind, checked when the project is opened:
 * 「這個專案有 N 個標題是舊版模板做的…」 with 「把標題更新到新版」 and 「先不要」. Never a dialog.
 *
 * - Dismissing it is remembered for that project at that saved revision, so opening the same file again does not ask
 *   again; within one open project it never comes back once it has gone (dismissed, updated, or nothing left to update).
 * - After an update that left titles behind — run here or from the template editor — it lists them with the reason
 *   until 「知道了」.
 */
export type TemplateUpdateNoticeState =
  | { kind: "hidden" }
  | { kind: "offer"; count: number; running: boolean }
  | { kind: "result"; report: TemplatesUpdateReport };

export interface TemplateUpdateNoticeHost {
  session: { getSnapshot(): Pick<ProjectSessionSnapshot, "sessionId" | "history" | "diskRevision">; subscribe(listener: () => void): () => void };
  storage?: Pick<Storage, "getItem" | "setItem">;
  /** How many old titles can be updated; the real detection unless a test replaces it. */
  countOutdated?(project: EditProject): Promise<number>;
}

export interface TemplateUpdateNotice {
  getSnapshot(): TemplateUpdateNoticeState;
  subscribe(listener: () => void): () => void;
  /** Watches the session (the open project is checked at once); returns the function that stops watching. */
  start(): () => void;
  /** 「把標題更新到新版」: the window's one update runner (templatesUpdateRuns). */
  update(): Promise<void>;
  dismiss(): void;
}

export const TEMPLATE_UPDATE_NOTICE_STORAGE_KEY = "editkin.titleUpdateNotice.dismissed.v1";
const REMEMBERED_PROJECTS = 64;

export function createTemplateUpdateNotice(host: TemplateUpdateNoticeHost): TemplateUpdateNotice {
  let state: TemplateUpdateNoticeState = { kind: "hidden" };
  const listeners = new Set<() => void>();
  let sessionId: number | undefined;
  let opened: { projectId: string; revision: number } | undefined;
  // Dismissed, updated, or nothing left to update: quiet until another project is opened.
  let quiet = false;
  let checking = 0;
  let seenReport = latestTemplatesUpdateReport()?.episode ?? 0;
  let wasRunning = templatesUpdateRunning();
  const publish = (next: TemplateUpdateNoticeState) => {
    state = next;
    for (const listener of [...listeners]) listener();
  };
  const countOutdated = host.countOutdated ?? (async (project: EditProject) =>
    (await referenceMotionTemplatesBehindUpdate(project)).filter(item => !item.editedSince).length);
  const key = () => opened && `${opened.projectId}@${opened.revision}`;
  const remembered = (): string[] => {
    try {
      const value: unknown = JSON.parse(host.storage?.getItem(TEMPLATE_UPDATE_NOTICE_STORAGE_KEY) ?? "[]");
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    } catch { return []; }
  };
  const remember = () => {
    const current = key();
    if (!current) return;
    try {
      host.storage?.setItem(TEMPLATE_UPDATE_NOTICE_STORAGE_KEY,
        JSON.stringify([...remembered().filter(item => item !== current), current].slice(-REMEMBERED_PROJECTS)));
    } catch { /* Storage unavailable: it stays dismissed for this open project. */ }
  };
  const check = async () => {
    const token = ++checking, snapshot = host.session.getSnapshot();
    let count = 0;
    try { count = await countOutdated(snapshot.history.present); } catch { count = 0; }
    if (token !== checking || quiet || state.kind === "result" || host.session.getSnapshot().sessionId !== snapshot.sessionId) return;
    if (count > 0) { publish({ kind: "offer", count, running: templatesUpdateRunning() }); return; }
    if (state.kind === "offer") quiet = true;
    if (state.kind !== "hidden") publish({ kind: "hidden" });
  };
  const opening = () => {
    const snapshot = host.session.getSnapshot();
    sessionId = snapshot.sessionId;
    opened = { projectId: snapshot.history.present.id, revision: snapshot.diskRevision };
    checking++;
    quiet = remembered().includes(key()!);
    if (state.kind !== "hidden") publish({ kind: "hidden" });
    if (!quiet) void check();
  };
  const changed = () => {
    if (host.session.getSnapshot().sessionId !== sessionId) { opening(); return; }
    // While it is offered, a change (an Undo, a title re-applied by hand) may change how many are left.
    if (state.kind === "offer" && !state.running) void check();
  };
  const updates = () => {
    const running = templatesUpdateRunning();
    if (running !== wasRunning) {
      wasRunning = running;
      if (state.kind === "offer") publish({ ...state, running });
    }
    const report = latestTemplatesUpdateReport();
    if (report && report.episode > seenReport) {
      seenReport = report.episode;
      if (report.projectId === opened?.projectId && report.notUpdated.length) { checking++; publish({ kind: "result", report }); return; }
    }
    // An update finished (here or in the template editor): count again; nothing left closes the offer.
    if (!running && state.kind === "offer") void check();
  };
  return {
    getSnapshot: () => state,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start: () => {
      const stopSession = host.session.subscribe(changed), stopUpdates = subscribeTemplatesUpdates(updates);
      opening();
      return () => { stopSession(); stopUpdates(); checking++; };
    },
    update: async () => {
      if (state.kind !== "offer" || state.running) return;
      await requestTemplatesUpdate();
    },
    dismiss: () => {
      if (state.kind === "offer") {
        if (state.running) return;
        remember();
      }
      quiet = true; checking++;
      if (state.kind !== "hidden") publish({ kind: "hidden" });
    },
  };
}
