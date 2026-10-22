import { useCallback, useEffect, useRef, useState } from "react";
import type { HaoDesktopApi } from "./apiTypes";
import { cancelRenderJob, waitForRenderJobEnd } from "./renderJobStore";

type CloseGuardApi = Pick<HaoDesktopApi, "setCloseGuard" | "acknowledgeCloseRequest" | "closeWindowConfirmed" | "onCloseRequested" | "cancelRenderJob"
  | "clearRecovery" | "keepRecoveryAside">;

export interface WindowCloseGuardOptions {
  api?: CloseGuardApi;
  /** Unsaved changes. */
  dirty: boolean;
  /** A video export is still running. */
  exporting: boolean;
  /** The normal save (opens Save As for a project that has no file yet). */
  save: () => Promise<void>;
  /** Live dirty state after the save attempt settles. */
  isDirty: () => boolean;
}

export interface WindowCloseGuard {
  asking: boolean;
  busy?: "saving" | "closing";
  dirty: boolean;
  exporting: boolean;
  saveAndClose: () => Promise<void>;
  closeWithoutSaving: () => Promise<void>;
  cancel: () => void;
}

/** How long a closing window waits for a stopped export to clean up before it closes anyway. */
export const CLOSE_EXPORT_STOP_WAIT_MS = 8_000;

/**
 * Asks before the window closes while something would be lost (desktop only). The native host holds the close
 * (src-tauri/src/window_close_guard.rs) and asks this page; the page answers save-and-close, close without saving,
 * or cancel. A save that is canceled or fails keeps the window open.
 */
export function useWindowCloseGuard({ api, dirty, exporting, save, isDirty }: WindowCloseGuardOptions): WindowCloseGuard {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState<"saving" | "closing">();
  const armed = dirty || exporting;
  const armedRef = useRef(armed);
  armedRef.current = armed;
  const exportingRef = useRef(exporting);
  exportingRef.current = exporting;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    if (!api?.setCloseGuard) return;
    void api.setCloseGuard(armed).catch(() => undefined);
  }, [api, armed]);

  useEffect(() => {
    if (!api?.onCloseRequested) return;
    return api.onCloseRequested(() => {
      void api.acknowledgeCloseRequest?.().catch(() => undefined);
      setAsking(true);
    });
  }, [api]);

  const close = useCallback(async (saved = false) => {
    setBusy("closing");
    // The crash-recovery copy must not come back next time as "unsaved work": after a save it is obsolete (the
    // editor clears it after every save anyway); after 「不存檔」 it is kept aside in recovery/kept, never deleted.
    try {
      if (saved) await api?.clearRecovery?.();
      else if (dirtyRef.current) await api?.keepRecoveryAside?.();
    } catch { /* Closing is still the creator's choice. */ }
    if (exportingRef.current) {
      // Stop the export first so the renderer removes its own temporary files, then close.
      await cancelRenderJob(api);
      await waitForRenderJobEnd(CLOSE_EXPORT_STOP_WAIT_MS);
    }
    try { await api?.closeWindowConfirmed?.(); }
    catch { setBusy(undefined); }
  }, [api]);

  const saveAndClose = useCallback(async () => {
    setBusy("saving");
    try { await save(); } catch { /* The save reports its own problem. */ }
    if (isDirty()) {
      // Canceled or failed: keep the window and the work.
      setBusy(undefined);
      setAsking(false);
      void api?.setCloseGuard?.(armedRef.current).catch(() => undefined);
      return;
    }
    await close(true);
  }, [api, close, isDirty, save]);

  const cancel = useCallback(() => {
    setAsking(false);
    setBusy(undefined);
    // Re-arming also ends the host's pending question.
    void api?.setCloseGuard?.(armedRef.current).catch(() => undefined);
  }, [api]);

  const closeWithoutSaving = useCallback(() => close(false), [close]);
  return { asking, busy, dirty, exporting, saveAndClose, closeWithoutSaving, cancel };
}
