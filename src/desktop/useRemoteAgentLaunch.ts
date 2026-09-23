import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { HaoDesktopApi } from "./types";
import { remoteAgentLaunchStore } from "./remoteAgentLaunchStore";

export function useRemoteAgentLaunch(api: HaoDesktopApi | undefined) {
  const state = useSyncExternalStore(
    remoteAgentLaunchStore.subscribe,
    remoteAgentLaunchStore.getSnapshot,
    remoteAgentLaunchStore.getSnapshot,
  );
  useEffect(() => {
    void remoteAgentLaunchStore.hydrate(api);
  }, [api]);
  const start = useCallback(
    (target: "codex" | "claude") => remoteAgentLaunchStore.start(api, target),
    [api],
  );
  const cancel = useCallback(() => remoteAgentLaunchStore.cancel(api), [api]);
  return { state, start, cancel, clearTerminal: remoteAgentLaunchStore.clearTerminal };
}
