import { getCurrentWindow } from "@tauri-apps/api/window";

export type DesktopDragEvent = { type: string; paths?: string[] };

const listeners = new Set<(event: DesktopDragEvent) => void>();
const pendingDrops: DesktopDragEvent[] = [];
let startup: Promise<void> | undefined;
let startupError: string | undefined;

/** Register before App mounts. Drops during code loading are delivered once the
 * editor subscribes, instead of disappearing between the first paint and effect. */
export function startDesktopDropBroker(): Promise<void> {
  if (typeof window === "undefined" || !window.__TAURI_INTERNALS__) return Promise.resolve();
  startup ??= getCurrentWindow().onDragDropEvent(({ payload }) => {
    const event: DesktopDragEvent = payload.type === "drop"
      ? { type: "drop", paths: payload.paths } : { type: payload.type };
    if (event.type === "drop" && listeners.size === 0) pendingDrops.push(event);
    else for (const listener of listeners) listener(event);
  }).then(() => undefined).catch((error) => {
    startupError = `拖放匯入初始化失敗：${error instanceof Error ? error.message : String(error)}`;
  });
  return startup;
}

export function subscribeDesktopDragEvents(listener: (event: DesktopDragEvent) => void): () => void {
  listeners.add(listener);
  for (const event of pendingDrops.splice(0)) listener(event);
  return () => { listeners.delete(listener); };
}

export function desktopDropStartupError(): string | undefined { return startupError; }
