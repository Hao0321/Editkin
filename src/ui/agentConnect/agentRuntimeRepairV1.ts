import { useEffect, useSyncExternalStore } from "react";
import type { AgentConnectionsResult } from "../../application/remoteOnboarding";
import type { HaoDesktopApi } from "../../desktop/types";

/**
 * Whether Editkin's start-up refresh of the AI connection failed after an update (2026-10-29). The entry points and the
 * dialog read one shared state: `failed` shows 「Editkin 更新後要重新連一次 AI」 with 「重新連一次」. One normal connect
 * re-activates it (the agent's own settings were not touched), so a successful connect clears it.
 */
export type AgentRuntimeRepairStateV1 = NonNullable<AgentConnectionsResult["agentRuntimeRepair"]>["state"] | "unknown";

export interface AgentRuntimeRepairViewV1 {
  state: AgentRuntimeRepairStateV1;
  message?: string;
}

const POLL_MS = 4_000;
const POLL_LIMIT = 15;

export function createAgentRuntimeRepairStoreV1(options: { schedule?: (run: () => void, ms: number) => void } = {}) {
  let current: AgentRuntimeRepairViewV1 = { state: "unknown" };
  let started = false, polls = 0;
  const listeners = new Set<() => void>();
  const schedule = options.schedule ?? ((run: () => void, ms: number) => { if (typeof window !== "undefined") window.setTimeout(run, ms); });
  const set = (next: AgentRuntimeRepairViewV1) => {
    if (next.state === current.state && next.message === current.message) return;
    current = next;
    for (const listener of listeners) listener();
  };
  const publish = (repair: AgentConnectionsResult["agentRuntimeRepair"]) => {
    if (repair) set({ state: repair.state, message: repair.message });
  };
  const check = async (api: Pick<HaoDesktopApi, "inspectAgentConnections"> | undefined) => {
    const inspect = api?.inspectAgentConnections;
    if (!inspect) return;
    try {
      const repair = (await inspect()).agentRuntimeRepair;
      publish(repair);
      // The refresh runs in the background at start-up: look again while it is still working.
      if (repair?.state === "pending" && ++polls < POLL_LIMIT) schedule(() => void check(api), POLL_MS);
    } catch { /* Detection failing is not a repair failure; the dialog reports its own problems. */ }
  };
  return {
    get: () => current,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    publish,
    /** A connect succeeded: the runtime is current again. */
    markConnected: () => { if (current.state === "failed" || current.state === "pending") set({ state: "ok" }); },
    /** Asks once per app session (the dialog's own detection publishes fresher answers). */
    ensure: (api: Pick<HaoDesktopApi, "inspectAgentConnections"> | undefined = typeof window === "undefined" ? undefined : window.haoDesktop) => {
      if (started) return;
      started = true;
      void check(api);
    },
  };
}

export const agentRuntimeRepairV1 = createAgentRuntimeRepairStoreV1();

/** The shared state for an entry point; `enabled` (the desktop) starts the one check. */
export function useAgentRuntimeRepairV1(enabled = true): AgentRuntimeRepairViewV1 {
  const view = useSyncExternalStore(agentRuntimeRepairV1.subscribe, agentRuntimeRepairV1.get, agentRuntimeRepairV1.get);
  useEffect(() => { if (enabled) agentRuntimeRepairV1.ensure(); }, [enabled]);
  return view;
}
