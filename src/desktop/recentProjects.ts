/** Recently opened or saved project files, newest first, kept in this window's browser storage (per computer). */
export interface RecentProject {
  path: string;
  name: string;
  openedAt: number;
}

export const RECENT_PROJECTS_KEY = "editkin.recent-projects.v1";
export const MAX_RECENT_PROJECTS = 8;

const listeners = new Set<() => void>();
let cache: readonly RecentProject[] | undefined;

function storage(): Storage | undefined {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
}

const samePath = (left: string, right: string) => left.replace(/\//g, "\\").toLowerCase() === right.replace(/\//g, "\\").toLowerCase();

function read(): readonly RecentProject[] {
  if (cache) return cache;
  let parsed: unknown;
  try { parsed = JSON.parse(storage()?.getItem(RECENT_PROJECTS_KEY) ?? "[]"); } catch { parsed = []; }
  cache = (Array.isArray(parsed) ? parsed : [])
    .filter((item): item is RecentProject => Boolean(item) && typeof item.path === "string" && item.path.length > 0 && item.path.length < 4096
      && typeof item.name === "string" && Number.isFinite(item.openedAt))
    .slice(0, MAX_RECENT_PROJECTS);
  return cache;
}

function write(next: readonly RecentProject[]): void {
  cache = next;
  try { storage()?.setItem(RECENT_PROJECTS_KEY, JSON.stringify(next)); } catch { /* The list still works for this session. */ }
  for (const listener of listeners) listener();
}

export function listRecentProjects(): readonly RecentProject[] {
  return read();
}

export function subscribeRecentProjects(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function rememberRecentProject(path: string, name: string, now = Date.now()): void {
  const current = read();
  const first = current[0];
  const label = name.trim() || path.split(/[\\/]/).pop() || path;
  if (first && samePath(first.path, path) && first.name === label) return;
  write([{ path, name: label, openedAt: now }, ...current.filter(item => !samePath(item.path, path))].slice(0, MAX_RECENT_PROJECTS));
}

export function forgetRecentProject(path: string): void {
  const current = read();
  if (!current.some(item => samePath(item.path, path))) return;
  write(current.filter(item => !samePath(item.path, path)));
}

/** The folder part of a path, for the small line under each name. */
export function recentProjectFolder(path: string): string {
  const parts = path.split(/[\\/]/);
  parts.pop();
  return parts.slice(-2).join("\\") || path;
}

/** Tests only. */
export function resetRecentProjectsForTest(): void {
  cache = undefined;
  for (const listener of listeners) listener();
}
