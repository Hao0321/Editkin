import type { ReferenceMotionTemplatesUpdate } from "./referenceMotionTemplateInstances";

/**
 * 「把標題更新到新版」 in one window: one runner (registered by the editor's notice host), so the notice and the template
 * editor's button run the very same update; whether it is running now; and the latest result, so the notice can list
 * the titles that were not updated and why. Only committed results (or ones that changed nothing) are published; a
 * cancelled or stale update publishes nothing.
 */
export interface TemplatesUpdateReport {
  episode: number;
  projectId: string;
  updated: ReferenceMotionTemplatesUpdate["updated"];
  notUpdated: ReferenceMotionTemplatesUpdate["notUpdated"];
  message: string;
}

let latest: TemplatesUpdateReport | undefined;
let episode = 0;
let runner: (() => Promise<unknown>) | undefined;
let running = false;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of [...listeners]) listener(); };

export function publishTemplatesUpdateReport(projectId: string, update: Pick<ReferenceMotionTemplatesUpdate, "updated" | "notUpdated" | "message">): void {
  latest = Object.freeze({ episode: ++episode, projectId, updated: [...update.updated], notUpdated: [...update.notUpdated], message: update.message });
  notify();
}
export function latestTemplatesUpdateReport(): TemplatesUpdateReport | undefined {
  return latest;
}
/** Reports and running changes. */
export function subscribeTemplatesUpdates(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The host that runs the update for this window; returns the function that takes it back. */
export function registerTemplatesUpdateRunner(run: () => Promise<unknown>): () => void {
  runner = run;
  notify();
  return () => { if (runner === run) { runner = undefined; notify(); } };
}
export function canRunTemplatesUpdate(): boolean {
  return runner !== undefined;
}
export function templatesUpdateRunning(): boolean {
  return running;
}
/** Runs the update once (a second request while it runs is ignored). */
export async function requestTemplatesUpdate(): Promise<void> {
  const run = runner;
  if (!run || running) return;
  running = true; notify();
  try { await run(); }
  finally { running = false; notify(); }
}
