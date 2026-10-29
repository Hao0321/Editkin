import type { EditorCommand } from "../domain/commandTypes";
import type { EditProject } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import type { ProjectSession, ProjectTask } from "./projectSession";
import { admitAnnotationTargetV1, annotationCanvasPointV1, buildAnnotationDraftV1, prepareAnnotationCommandV1,
  type AnnotationDraftV1, type AnnotationKindV1, type AnnotationPointV1, type AnnotationTargetV1 } from "./annotationDraftV1";

export interface AnnotationContextV1 {
  project: EditProject; projectSession: ProjectSession; target: AnnotationTargetV1;
  hostReady: boolean; commandOwner: unknown; disabled?: boolean;
}
export interface AnnotationStateV1 {
  status: "idle" | "armed" | "drawing" | "ready" | "applying" | "done" | "failed";
  kind?: AnnotationKindV1; draft?: AnnotationDraftV1; error?: unknown;
}
export interface AnnotationApplicationV1 {
  command: EditorCommand; expectedRevision: number; projectId: string;
  /** Host MUST check immediately before its existing synchronous dispatch, after any await. */
  guard: { signal: AbortSignal; isCurrent(): boolean };
}
export interface AnnotationInteractionOptionsV1 {
  read(): AnnotationContextV1;
  apply(application: AnnotationApplicationV1): { status: "applied" | "cancelled" } | Promise<{ status: "applied" | "cancelled" }>;
  makeId(): string; name(kind: AnnotationKindV1): string; onPause(): void;
  onState?(state: AnnotationStateV1): void; onError?(error: unknown): void;
  writeTimeoutMs?: number;
}
export function annotationInteractionErrorKindV1(error: unknown): "locked" | "source" | "tracking" | "stale" | "invalid" | "unavailable" | "uncertain" {
  const s = String(error);
  if (s.includes("先解鎖") || /LOCKED/u.test(s)) return "locked";
  if (/OUTCOME_UNKNOWN/u.test(s)) return "uncertain";
  if (/CHANGED|STALE/u.test(s)) return "stale";
  if (/HOST_UNAVAILABLE/u.test(s)) return "unavailable";
  if (/TRACK|QUAD|REFERENCE_LOST|GEOMETRY_UNSUPPORTED/u.test(s)) return "tracking";
  if (/SOURCE|CLIP_MISSING/u.test(s)) return "source";
  return "invalid";
}
/** Pointer motion touches a tiny private guide only. The original whole-project compiler
 * runs once at explicit commit; all live state still belongs to the existing host. */
export function createAnnotationInteractionV1(options: AnnotationInteractionOptionsV1) {
  let state: AnnotationStateV1 = { status: "idle" }, alive = true;
  interface Operation { context: AnnotationContextV1; target: AnnotationTargetV1; task: ProjectTask; key: string; before: string; kind: AnnotationKindV1;
    id: string; name: string; controller: AbortController; pointer?: number; start?: AnnotationPointV1; end?: AnnotationPointV1; draft?: AnnotationDraftV1 }
  let active: Operation | undefined, pending: Operation | undefined;
  const timeout = options.writeTimeoutMs ?? 10000;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 60000) throw Error("ANNOTATION_WRITE_BUDGET");
  const key = (c: AnnotationContextV1) => canonicalJson({ projectId: c.project.id, width: c.project.width, height: c.project.height, fps: c.project.fps,
    target: c.target, ready: c.hostReady, disabled: c.disabled });
  const publish = (value: AnnotationStateV1) => { state = value; if (alive) { try { options.onState?.(structuredClone(value)); } catch { /* Observation cannot alter a command. */ } } };
  const report = (error: unknown) => { if (alive) { try { options.onError?.(error); } catch { /* Observational only. */ } } };
  const matches = (op: Operation, deep = false) => {
    if (!alive || op.controller.signal.aborted) return false;
    const c = options.read();
    return !!c.hostReady && !c.disabled && c.commandOwner === op.context.commandOwner && c.projectSession === op.context.projectSession && c.project === op.context.project
      && c.projectSession.getSnapshot().history.present === c.project && op.task.isCurrent() && key(c) === op.key && (!deep || canonicalJson(c.project) === op.before);
  };
  const clear = () => { active?.controller.abort(Error("ANNOTATION_CANCELLED")); active = undefined; publish({ status: "idle" }); };
  const stale = () => { active?.controller.abort(Error("ANNOTATION_PROJECT_CHANGED")); active = undefined; publish({ status: "failed", error: Error("ANNOTATION_PROJECT_CHANGED") }); };
  const current = (deep = false) => { const op = active; if (!op) return undefined; if (!matches(op, deep)) { stale(); return undefined; } return op; };
  const redraw = (op: Operation, end: AnnotationPointV1, status: "drawing" | "ready") => {
    op.end = end;
    try { op.draft = buildAnnotationDraftV1(op.context.project, op.target, op.kind, op.start!, end, op.id, op.name); publish({ status, kind: op.kind, draft: op.draft }); return true; }
    catch (error) { op.draft = undefined; publish({ status: status === "ready" ? "armed" : status, kind: op.kind, error }); return false; }
  };
  const driver = {
    getState: () => structuredClone(state),
    arm(kind: AnnotationKindV1) {
      if (pending || !alive) return false;
      clear();
      try {
        options.onPause(); const c = options.read();
        if (!c.hostReady || !c.commandOwner || c.disabled) throw Error("ANNOTATION_HOST_UNAVAILABLE");
        if (c.projectSession.getSnapshot().history.present !== c.project) throw Error("ANNOTATION_PROJECT_CHANGED");
        const { target } = admitAnnotationTargetV1(c.project, c.target), task = c.projectSession.beginTask(c.project);
        active = { context: { ...c }, target, task, key: key(c), before: canonicalJson(c.project), kind, id: options.makeId(), name: options.name(kind), controller: new AbortController() };
        publish({ status: "armed", kind }); return true;
      } catch (error) { publish({ status: "failed", error }); report(error); return false; }
    },
    begin(point: AnnotationPointV1, pointer: number) {
      const op = current(); if (!op || op.pointer !== undefined || !Number.isSafeInteger(pointer) || pointer < 0) return false;
      try { op.start = annotationCanvasPointV1(point, op.context.project.width, op.context.project.height); }
      catch { return false; }
      op.pointer = pointer; op.end = undefined; op.draft = undefined; publish({ status: "drawing", kind: op.kind }); return true;
    },
    move(point: AnnotationPointV1, pointer: number) {
      const op = current(); if (!op || op.pointer !== pointer) return false;
      try { return redraw(op, annotationCanvasPointV1(point, op.context.project.width, op.context.project.height, true), "drawing"); } catch { return false; }
    },
    finish(point: AnnotationPointV1, pointer: number) {
      const op = current(true); if (!op || op.pointer !== pointer) return false;
      op.pointer = undefined; try { return redraw(op, annotationCanvasPointV1(point, op.context.project.width, op.context.project.height, true), "ready"); } catch { publish({ status: "armed", kind: op.kind }); return false; }
    },
    cancelPointer(pointer: number) {
      const op = active; if (!op || op.pointer !== pointer) return;
      op.pointer = undefined; op.start = op.end = undefined; op.draft = undefined; publish({ status: "armed", kind: op.kind });
    },
    nudge(dx: number, dy: number) {
      const op = current(true); if (!op?.start || !op.end || op.pointer !== undefined || ![dx, dy].every(n => Number.isSafeInteger(n) && Math.abs(n) <= 10)) return false;
      const start = { x: op.start.x + dx, y: op.start.y + dy }, end = { x: op.end.x + dx, y: op.end.y + dy };
      try { const draft = buildAnnotationDraftV1(op.context.project, op.target, op.kind, start, end, op.id, op.name);
        op.start = start; op.end = end; op.draft = draft; publish({ status: "ready", kind: op.kind, draft }); return true;
      } catch (error) { report(error); return false; }
    },
    async commit() {
      if (pending) return false;
      const op = current(true); if (!op?.draft || op.pointer !== undefined || state.status !== "ready") return false;
      let issued = false;
      try {
        const plan = prepareAnnotationCommandV1(op.context.project, op.target, op.draft);
        if (!matches(op, true)) throw Error("ANNOTATION_PROJECT_CHANGED");
        active = undefined; pending = op; publish({ status: "applying", kind: op.kind }); issued = true;
        const application: AnnotationApplicationV1 = { command: structuredClone(plan.command), expectedRevision: op.context.project.revision, projectId: op.context.project.id,
          guard: { signal: op.controller.signal, isCurrent: () => matches(op, true) } };
        const acknowledgement = await new Promise<{ status: "applied" | "cancelled" }>((resolve, reject) => {
          const timer = setTimeout(() => { op.controller.abort(Error("ANNOTATION_APPLY_TIMEOUT")); reject(Error("ANNOTATION_APPLY_OUTCOME_UNKNOWN")); }, timeout);
          Promise.resolve().then(() => options.apply(application)).then(reply => { clearTimeout(timer); resolve(reply); }, error => { clearTimeout(timer); reject(error); });
        });
        if (acknowledgement.status !== "applied" && acknowledgement.status !== "cancelled") throw Error("ANNOTATION_APPLY_OUTCOME_UNKNOWN");
        if (pending === op) { pending = undefined; publish({ status: acknowledgement.status === "applied" && op.task.isSessionCurrent() ? "done" : "idle" }); }
        return acknowledgement.status === "applied";
      } catch (error) {
        if (active === op) active = undefined; if (pending === op) pending = undefined;
        op.controller.abort(error); const failure = issued ? Error("ANNOTATION_APPLY_OUTCOME_UNKNOWN", { cause: error }) : error;
        publish({ status: "failed", error: failure }); report(failure); return false;
      }
    },
    cancel() { if (pending) { pending.controller.abort(Error("ANNOTATION_CANCEL_REQUESTED")); return; } clear(); },
    invalidate() { if (active && !matches(active, true)) stale(); if (pending && !matches(pending, true)) pending.controller.abort(Error("ANNOTATION_PROJECT_CHANGED")); },
    resume() { alive = true; },
    dispose() { alive = false; active?.controller.abort(Error("ANNOTATION_UNMOUNTED")); pending?.controller.abort(Error("ANNOTATION_UNMOUNTED")); active = undefined; },
  }; return driver;
}
