import { access, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";
import type { RenderProgressSnapshot } from "../render/renderProgress";

/** Files of one desktop export job; the Tauri host creates their folder (src-tauri/src/render_jobs.rs). */
export const RENDER_PROGRESS_FILE = "progress.json";
export const RENDER_CANCEL_FILE = "cancel.request";
export const RENDER_CANCELED_MESSAGE = "影片輸出已取消";

export interface FileJobControlV1<T> {
  /** Aborts the render when the host writes the cancel request. */
  signal?: AbortSignal;
  /** Writes progress snapshots for the host to read (throttled; the latest always lands). */
  sink?: (snapshot: T) => void;
  /** Stops watching and writes the last snapshot. Never deletes the job files: the host owns them. */
  dispose(): Promise<void>;
}
export type RenderJobControl = FileJobControlV1<RenderProgressSnapshot>;

function jobFile(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !isAbsolute(value) || basename(value) !== name || value.includes("\0")) {
    throw new Error(`render job ${name} path is invalid`);
  }
  return value;
}

/**
 * Progress out and cancel in for one export, through files in the job folder the desktop host created. Without
 * those paths (MCP, CLI, tests) it does nothing, so every other caller renders exactly as before.
 */
export function openFileJobControlV1<T>(payload: Record<string, unknown>, options: { pollMs?: number; minWriteIntervalMs?: number; cancelMessage?: string } = {}): FileJobControlV1<T> {
  const progressPath = jobFile(payload.progressPath, RENDER_PROGRESS_FILE);
  const cancelPath = jobFile(payload.cancelPath, RENDER_CANCEL_FILE);
  if (progressPath && cancelPath && dirname(progressPath) !== dirname(cancelPath)) throw new Error("render job files must share one folder");
  const pollMs = options.pollMs ?? 250;
  const minWriteIntervalMs = options.minWriteIntervalMs ?? 250;

  let latest: T | undefined;
  let written: T | undefined;
  let lastWriteAt = 0;
  let writeTimer: ReturnType<typeof setTimeout> | undefined;
  let writing: Promise<void> = Promise.resolve();
  const write = () => {
    writeTimer = undefined;
    const snapshot = latest;
    if (!progressPath || !snapshot || snapshot === written) return writing;
    lastWriteAt = Date.now();
    written = snapshot;
    const temporary = `${progressPath}.${process.pid}.tmp`;
    // Progress is best effort: a reader holding the file or a full disk never changes the render's outcome.
    writing = writing.then(() => writeFile(temporary, JSON.stringify(snapshot), "utf8")).then(() => rename(temporary, progressPath)).catch(() => undefined);
    return writing;
  };
  const sink: ((snapshot: T) => void) | undefined = progressPath ? snapshot => {
    latest = snapshot;
    if (writeTimer) return;
    const wait = minWriteIntervalMs - (Date.now() - lastWriteAt);
    if (wait <= 0) void write();
    else writeTimer = setTimeout(() => void write(), wait);
  } : undefined;

  const controller = cancelPath ? new AbortController() : undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  if (cancelPath && controller) {
    poll = setInterval(() => {
      void access(cancelPath).then(() => {
        if (controller.signal.aborted) return;
        clearInterval(poll);
        controller.abort(new Error(options.cancelMessage ?? RENDER_CANCELED_MESSAGE));
      }, () => undefined);
    }, pollMs);
    poll.unref?.();
  }

  return {
    signal: controller?.signal,
    sink,
    async dispose() {
      if (poll) clearInterval(poll);
      if (writeTimer) { clearTimeout(writeTimer); writeTimer = undefined; }
      await write();
    },
  };
}

/** Existing export API and progress bytes stay unchanged; engine tasks share its file lifetime. */
export function openRenderJobControl(payload: Record<string, unknown>, options: { pollMs?: number; minWriteIntervalMs?: number } = {}): RenderJobControl {
  return openFileJobControlV1<RenderProgressSnapshot>(payload, options);
}
