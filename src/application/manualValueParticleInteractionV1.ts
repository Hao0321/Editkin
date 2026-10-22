import type { EditProject } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import type { ProjectSession } from "./projectSession";
import type { ManualValueParticleRequestV1 } from "./manualValueParticlesV1";
export interface ManualValueParticleContextV1 { project: EditProject; projectSession: ProjectSession; request: ManualValueParticleRequestV1; hostOwner: unknown; disabled?: boolean; }
export interface ManualValueParticleStateV1 { status: "idle" | "applying" | "done" | "cancelled" | "failed"; error?: unknown; }
export interface ManualValueParticleApplicationV1 { project: EditProject; request: ManualValueParticleRequestV1; guard: { signal: AbortSignal; isCurrent(): boolean }; }
/** Host owns canonical Node preparation/revalidation and its existing synchronous commit.
 * An uncertain request is never automatically replayed. */
export function createManualValueParticleInteractionV1(options: {
  read(): ManualValueParticleContextV1; apply(application: ManualValueParticleApplicationV1): Promise<{ status: "applied" | "cancelled" }>;
  onState?(state: ManualValueParticleStateV1): void; onPause?(): void; timeoutMs?: number;
}) {
  interface Operation { controller: AbortController; matches(): boolean; }
  let state: ManualValueParticleStateV1 = { status: "idle" }, alive = true, pending: Operation | undefined;
  const timeout = options.timeoutMs ?? 15000;
  if (!Number.isFinite(timeout) || timeout < 100 || timeout > 60000) throw Error("MANUAL_VALUE_UI_TIMEOUT_BUDGET");
  const publish = (next: ManualValueParticleStateV1) => { state = next; if (alive) { try { options.onState?.(structuredClone(next)); } catch { /* Observer only. */ } } };
  return {
    getState: () => structuredClone(state),
    async apply() {
      if (!alive || pending) return false;
      let issued = false, op: Operation | undefined;
      try {
        options.onPause?.(); const c = options.read();
        if (!c.hostOwner || c.disabled) throw Error("MANUAL_VALUE_UI_UNAVAILABLE");
        if (c.projectSession.getSnapshot().history.present !== c.project) throw Error("MANUAL_VALUE_UI_PROJECT_CHANGED");
        const request = structuredClone(c.request), fingerprint = canonicalJson(request), before = canonicalJson(c.project), task = c.projectSession.beginTask(c.project), controller = new AbortController();
        op = { controller, matches() { const now = options.read(); return alive && !controller.signal.aborted && now.hostOwner === c.hostOwner && !now.disabled
          && now.projectSession === c.projectSession && now.project === c.project && task.isCurrent() && now.projectSession.getSnapshot().history.present === c.project
          && canonicalJson(now.request) === fingerprint && canonicalJson(now.project) === before; } };
        pending = op; if (!op.matches()) throw Error("MANUAL_VALUE_UI_PROJECT_CHANGED"); publish({ status: "applying" }); issued = true;
        const ack = await new Promise<{ status: "applied" | "cancelled" }>((resolve, reject) => {
          const timer = setTimeout(() => { controller.abort(Error("MANUAL_VALUE_UI_TIMEOUT")); reject(Error("MANUAL_VALUE_UI_OUTCOME_UNKNOWN")); }, timeout);
          Promise.resolve().then(() => { if (!op!.matches()) return { status: "cancelled" as const }; return options.apply({ project: c.project, request, guard: { signal: controller.signal, isCurrent: op!.matches } }); })
            .then(reply => { clearTimeout(timer); resolve(reply); }, error => { clearTimeout(timer); reject(error); });
        });
        if (ack?.status !== "applied" && ack?.status !== "cancelled") throw Error("MANUAL_VALUE_UI_OUTCOME_UNKNOWN");
        // Our own successful dispatch changes contentOwner. Its explicit ack remains authoritative.
        publish({ status: ack.status === "applied" && task.isSessionCurrent() ? "done" : "cancelled" }); return ack.status === "applied";
      } catch (error) { op?.controller.abort(error); publish({ status: "failed", error: issued ? Error("MANUAL_VALUE_UI_OUTCOME_UNKNOWN", { cause: error }) : error }); return false; }
      finally { if (pending === op) pending = undefined; }
    },
    invalidate() { if (pending && !pending.matches()) pending.controller.abort(Error("MANUAL_VALUE_UI_PROJECT_CHANGED")); },
    cancel() { if (pending) pending.controller.abort(Error("MANUAL_VALUE_UI_CANCELLED")); else publish({ status: "idle" }); },
    resume() { alive = true; },
    dispose() { alive = false; pending?.controller.abort(Error("MANUAL_VALUE_UI_UNMOUNTED")); },
  };
}
