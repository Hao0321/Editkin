import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectSession } from "../application/projectSession";
import type { HaoDesktopApi } from "./apiTypes";
import { createProjectFileWatchControllerV1, type ProjectFileChange } from "./projectFileWatchControllerV1";
export { PROJECT_FILE_WATCH_MS, type ProjectFileChange } from "./projectFileWatchControllerV1";

/** React is a view of the single controller; it does not keep another baseline/dismissal store. */
export function useProjectFileWatch(api: Pick<HaoDesktopApi, "inspectProjectFile"> | undefined, session: ProjectSession, enabled: boolean) {
  const [change, setChange] = useState<ProjectFileChange>();
  const owner = useRef<ReturnType<typeof createProjectFileWatchControllerV1> | undefined>(undefined);
  useEffect(() => {
    setChange(undefined);
    if (!enabled || !api?.inspectProjectFile) return;
    const current = createProjectFileWatchControllerV1(api, session, {
      onChange: setChange,
      isVisible: () => document.visibilityState !== "hidden",
      listenFocus: callback => { window.addEventListener("focus", callback); return () => window.removeEventListener("focus", callback); },
      every: (milliseconds, callback) => { const timer = window.setInterval(callback, milliseconds); return () => window.clearInterval(timer); },
    });
    owner.current = current;
    return () => { if (owner.current === current) owner.current = undefined; current.dispose(); };
  }, [api, session, enabled]);
  const check = useCallback(() => owner.current?.check() ?? Promise.resolve(), []);
  const dismiss = useCallback(() => owner.current?.dismiss(change), [change]);
  return { change, check, dismiss };
}
