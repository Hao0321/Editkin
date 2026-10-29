import type { EditProject } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import type { ProjectSession } from "./projectSession";
import { admitSubjectOverlaySourceV1 } from "./subjectOverlayProjectV1";
import type { SubjectOverlayBakeRequestV1 } from "./subjectStickerBakeV1";
export type SubjectOverlayKindV1 = SubjectOverlayBakeRequestV1["effect"]["kind"];
export interface SubjectOverlayProgressV1 { stage: "verify" | "render" | "inspect" | "ready"; frames: number; total: number; }
export interface SubjectOverlayUiStateV1 { status: "idle" | "applying" | "done" | "clean_hold" | "cancelled" | "failed" | "uncertain"; kind?: SubjectOverlayKindV1; progress?: SubjectOverlayProgressV1; }
export interface SubjectOverlayUiContextV1 { project: EditProject; projectSession: ProjectSession; request: SubjectOverlayBakeRequestV1; selectionRange: { startFrame: number; endFrame: number }; hostOwner: unknown; disabled?: boolean; }
export interface SubjectOverlayUiApplicationV1 {
  project: EditProject; request: SubjectOverlayBakeRequestV1;
  guard: { signal: AbortSignal; isCurrent(): boolean }; onProgress(progress: SubjectOverlayProgressV1): void;
}
export interface SubjectOverlayUiAckV1 { status: "applied" | "cancelled" | "clean_hold"; }
const identity = (c: SubjectOverlayUiContextV1) => canonicalJson([c.request.ids.assetId, c.request.ids.clipId, c.request.ids.trackId, c.request.ids.linkGroupId]);
/** Browser-safe request lifecycle. The existing Node owner must forward both
 * guards through preparation and apply; public JSON is never an apply capability. */
export function createSubjectOverlayInteractionV1(options: {
  read(kind: SubjectOverlayKindV1): SubjectOverlayUiContextV1;
  apply(application: SubjectOverlayUiApplicationV1): Promise<SubjectOverlayUiAckV1>;
  onState?(state: SubjectOverlayUiStateV1): void; onPause?(): void; timeoutMs?: number;
}) {
  interface Operation { kind: SubjectOverlayKindV1; key: string; controller: AbortController; matches(): boolean; }
  let alive = true, pending: Operation | undefined, terminal: { kind: SubjectOverlayKindV1; key: string } | undefined, state: SubjectOverlayUiStateV1 = { status: "idle" };
  const timeout = options.timeoutMs ?? 30000;
  if (!Number.isFinite(timeout) || timeout < 100 || timeout > 60000) throw Error("SUBJECT_OVERLAY_UI_TIMEOUT_BUDGET");
  const copy = () => ({ ...state, ...(state.progress ? { progress: { ...state.progress } } : {}) });
  const publish = (next: SubjectOverlayUiStateV1) => { state = next; if (alive) { try { options.onState?.(copy()); } catch { /* Observer only. */ } } };
  const refresh = () => {
    if (!pending && terminal) { try { if (identity(options.read(terminal.kind)) !== terminal.key) { terminal = undefined; publish({ status: "idle" }); } } catch { /* A changed context is not authoring permission. */ } }
  };
  return {
    getState: copy,
    async apply(kind: SubjectOverlayKindV1) {
      refresh(); if (!alive || pending || terminal) return false;
      let issued = false, op: Operation | undefined;
      try {
        const c = options.read(kind), project = c.project, projectSession = c.projectSession, hostOwner = c.hostOwner, snapshot = projectSession.getSnapshot(), path = snapshot.projectPath;
        if (!hostOwner || c.disabled || snapshot.history.present !== project || c.request.expectedRevision !== project.revision || c.request.effect.kind !== kind) throw Error("SUBJECT_OVERLAY_UI_UNAVAILABLE_OR_CHANGED");
        admitSubjectOverlaySourceV1(project, c.request.clipId, kind);
        const request = structuredClone(c.request), requestFingerprint = canonicalJson(request), fingerprint = canonicalJson([request, c.selectionRange]), before = canonicalJson(project), task = projectSession.beginTask(project), controller = new AbortController();
        op = { kind, key: identity(c), controller, matches() {
          const now = options.read(kind), current = now.projectSession.getSnapshot();
          return alive && !controller.signal.aborted && !now.disabled && now.hostOwner === hostOwner && now.projectSession === projectSession
            && now.project === project && current.history.present === project && current.projectPath === path && task.isCurrent()
            && canonicalJson(request) === requestFingerprint && canonicalJson([now.request, now.selectionRange]) === fingerprint && canonicalJson(now.project) === before;
        } };
        pending = op; options.onPause?.(); if (!op.matches()) throw Error("SUBJECT_OVERLAY_UI_CHANGED"); publish({ status: "applying", kind });
        const progress = (p: SubjectOverlayProgressV1) => {
          if (pending !== op || !op!.matches()) return;
          if (!["verify", "render", "inspect", "ready"].includes(p.stage) || !Number.isSafeInteger(p.frames) || !Number.isSafeInteger(p.total) || p.frames < 0 || p.frames > p.total || p.total < 1 || p.total > 28800) return;
          publish({ status: "applying", kind, progress: { stage: p.stage, frames: p.frames, total: p.total } });
        };
        const ack = await new Promise<SubjectOverlayUiAckV1>((resolve, reject) => {
          const timer = setTimeout(() => { controller.abort(Error("SUBJECT_OVERLAY_UI_TIMEOUT")); reject(Error("SUBJECT_OVERLAY_UI_OUTCOME_UNKNOWN")); }, timeout);
          Promise.resolve().then(() => { if (!op!.matches()) return { status: "cancelled" as const }; issued = true;
            return options.apply({ project, request, guard: { signal: controller.signal, isCurrent: op!.matches }, onProgress: progress }); })
            .then(reply => { clearTimeout(timer); resolve(reply); }, error => { clearTimeout(timer); reject(error); });
        });
        if (!["applied", "cancelled", "clean_hold"].includes(ack?.status)) throw Error("SUBJECT_OVERLAY_UI_OUTCOME_UNKNOWN");
        // A successful host commit changes contentOwner; accept its explicit ack.
        if (ack.status === "applied") terminal = { kind, key: op.key };
        publish({ status: ack.status === "applied" ? task.isSessionCurrent() ? "done" : "cancelled" : ack.status, kind });
        return ack.status === "applied";
      } catch { op?.controller.abort(Error("SUBJECT_OVERLAY_UI_STOPPED")); if (issued && op) terminal = { kind, key: op.key }; publish({ status: issued ? "uncertain" : "failed", kind }); return false; }
      finally { if (pending === op) pending = undefined; }
    },
    synchronize() { if (pending) { try { if (!pending.matches()) pending.controller.abort(Error("SUBJECT_OVERLAY_UI_CHANGED")); } catch { pending.controller.abort(Error("SUBJECT_OVERLAY_UI_CHANGED")); } } else refresh(); },
    cancel() { pending?.controller.abort(Error("SUBJECT_OVERLAY_UI_CANCELLED")); },
    resume() { alive = true; },
    dispose() { alive = false; pending?.controller.abort(Error("SUBJECT_OVERLAY_UI_UNMOUNTED")); },
  };
}
