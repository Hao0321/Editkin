import type { EditProject } from "../domain/types";
import type { ProjectSession, ProjectTask } from "./projectSession";
import { canonicalJson } from "../shared/canonicalJson";
import { admitAutoReframePlanV1, autoReframeJobRequestV1, beginAutoReframeEditV1, takeAutoReframeApplicationV1, settleAutoReframeApplicationV1,
  type AutoReframeApplicationV1, type AutoReframeJobV1, type AutoReframeModeV1, type AutoReframePlanV1, type AutoReframeProgressV1,
  type AutoReframeReplyV1, type AutoReframeRequestV1, type AutoReframeSubjectV1 } from "./autoReframeEditV1";
import { assertAutoReframeVideoV1, type ReframeNewProjectIdentityV1 } from "./autoReframePortraitProjectV1";

export interface AutoReframeContextV1 {
  project: EditProject; projectSession: ProjectSession; clipId: string; subject: AutoReframeSubjectV1;
  outputWidth: number; outputHeight: number; hostReady: boolean; currentProjectHostReady: boolean; newProjectHostReady: boolean; disabled?: boolean;
}
export type AutoReframeInteractionStateV1 = { status: "idle" | "preparing" | "analyzing" | "ready" | "applying" | "done" | "failed";
  mode?: AutoReframeModeV1; progress?: AutoReframeProgressV1; plan?: AutoReframePlanV1; error?: unknown; };
export interface AutoReframeInteractionOptionsV1 {
  read(): AutoReframeContextV1;
  analyze(project: EditProject, request: AutoReframeRequestV1, runtime: { signal: AbortSignal; onProgress(progress: AutoReframeProgressV1): void }): Promise<AutoReframeReplyV1>;
  /** The existing host owns its atomic expected-revision check and history dispatch. A
   * cancelled acknowledgement guarantees that nothing was committed. Never retry an uncertain write. */
  apply(application: AutoReframeApplicationV1): Promise<{ status: "applied" | "created" | "cancelled" }> | { status: "applied" | "created" | "cancelled" };
  makeIdentity(project: EditProject): ReframeNewProjectIdentityV1;
  onState?(state: AutoReframeInteractionStateV1): void; onError?(error: unknown): void; onPause?(): void;
}
export function autoReframeInteractionErrorKindV1(error: unknown): "locked" | "camera" | "dependency" | "source" | "stale" | "subjectChanged" | "unavailable" | "failed" {
  const s = String(error);
  if (/LOCKED/.test(s)) return "locked";
  if (/CAMERA_REQUIRES_MERGE/.test(s)) return "camera";
  if (/RECOMPOSITION|RECOMPILE|DEPENDENCY|LINKED_|PORTRAIT_REQUIRED/.test(s)) return "dependency";
  if (/INSPECTION_REQUIRED|ORIGINAL_SOURCE_REQUIRED|SOURCE_CLOCK|VIDEO_REQUIRED|MATTE_STALE/.test(s)) return "source";
  if (/STALE|BINDING_CHANGED|GRAPH_CHANGED/.test(s)) return "stale";
  if (/SUBJECT_|MATTE_CHANGED|TRUST/.test(s)) return "subjectChanged";
  if (/UNAVAILABLE/.test(s)) return "unavailable";
  return "failed";
}
const stages = ["verify", "matte", "source", "finalize"] as const;
const signature = (c: AutoReframeContextV1) => canonicalJson({ clipId: c.clipId, subject: c.subject, width: c.outputWidth, height: c.outputHeight,
  hostReady: c.hostReady, currentProjectHostReady: c.currentProjectHostReady, newProjectHostReady: c.newProjectHostReady, disabled: !!c.disabled });
/** Browser-safe operation owner. Analysis/preview never edits; only explicit apply reaches
 * the existing command/file owner. A stale selection/session cannot accept a late reply. */
export function createAutoReframeInteractionV1(options: AutoReframeInteractionOptionsV1) {
  let state: AutoReframeInteractionStateV1 = { status: "idle" }, alive = true;
  type Operation = { controller: AbortController; session: ProjectSession; task: ProjectTask; signature: string; job?: AutoReframeJobV1; plan?: AutoReframePlanV1 };
  let active: Operation | undefined;
  const present = () => { if (alive) { try { options.onState?.(state); } catch { /* Presentation cannot change an accepted editor commit. */ } } };
  const publish = (s: AutoReframeInteractionStateV1) => { state = s; present(); };
  const report = (error: unknown) => { if (alive) { try { options.onError?.(error); } catch { /* Host diagnostics are observational. */ } } };
  const matches = (op: Operation) => {
    if (!alive || active !== op || op.controller.signal.aborted) return false;
    const c = options.read();
    if (c.projectSession !== op.session || !op.task.isCurrent() || signature(c) !== op.signature) return false;
    if (op.job) { try { autoReframeJobRequestV1(c.project, op.job); } catch { return false; } }
    return true;
  };
  const clear = () => { active?.controller.abort(Error("AUTO_REFRAME_CANCELLED")); active = undefined; publish({ status: "idle" }); };
  const fail = (op: Operation, error: unknown) => {
    if (active !== op || !alive) return;
    if (!matches(op)) { clear(); return; }
    op.controller.abort(error); active = undefined; publish({ status: "failed", mode: state.mode, error }); report(error);
  };
  return {
    getState: () => state,
    resume: () => { alive = true; },
    invalidate: () => { if (active && state.status !== "applying" && !matches(active)) clear(); },
    cancel: () => { if (state.status !== "applying") clear(); },
    dispose: () => { alive = false; if (state.status !== "applying") { active?.controller.abort(Error("AUTO_REFRAME_DISPOSED")); active = undefined; } },
    start: async (mode: AutoReframeModeV1): Promise<boolean> => {
      if (!alive || ["preparing", "analyzing", "applying"].includes(state.status)) return false;
      clear(); const c = options.read(), task = c.projectSession.beginTask(c.project), controller = new AbortController();
      const op: Operation = { controller, task, session: c.projectSession, signature: signature(c) }; active = op;
      try {
        if (!c.hostReady || mode === "current_portrait" && !c.currentProjectHostReady || mode === "new_portrait_project" && !c.newProjectHostReady || c.disabled) throw Error("AUTO_REFRAME_UI_UNAVAILABLE");
        if (!task.isCurrent()) throw Error("AUTO_REFRAME_JOB_STALE");
        assertAutoReframeVideoV1(c.project, c.clipId); options.onPause?.(); publish({ status: "preparing", mode });
        const identity = mode === "new_portrait_project" ? options.makeIdentity(c.project) : undefined;
        op.job = await beginAutoReframeEditV1(c.project, c.clipId, { operationId: crypto.randomUUID(), mode, subject: c.subject,
          outputWidth: c.outputWidth, outputHeight: c.outputHeight, ...(identity ? { newProject: identity } : {}) }, controller.signal);
        if (!matches(op)) { if (active === op) clear(); return false; }
        const request = autoReframeJobRequestV1(options.read().project, op.job);
        publish({ status: "analyzing", mode });
        const reply = await options.analyze(structuredClone(c.project), request, { signal: controller.signal, onProgress: p => {
          if (state.status !== "analyzing") return;
          if (!matches(op)) { if (active === op) clear(); return; }
          if (!stages.includes(p.stage) || !Number.isSafeInteger(p.total) || p.total <= 0 || !Number.isSafeInteger(p.completed) || p.completed < 0 || p.completed > p.total) return;
          const prior = state.progress;
          if (prior && (stages.indexOf(p.stage) < stages.indexOf(prior.stage) || p.stage === prior.stage && (p.total !== prior.total || p.completed < prior.completed))) return;
          publish({ status: "analyzing", mode, progress: { ...p } });
        } });
        if (!matches(op)) { if (active === op) clear(); return false; }
        op.plan = admitAutoReframePlanV1(options.read().project, op.job, reply); publish({ status: "ready", mode, plan: op.plan }); return true;
      } catch (error) { fail(op, error); return false; }
    },
    apply: async (): Promise<boolean> => {
      const op = active;
      if (state.status !== "ready" || !op?.plan || !op.job || !matches(op)) { if (op && state.status !== "applying") clear(); return false; }
      let application: AutoReframeApplicationV1;
      try { application = takeAutoReframeApplicationV1(options.read().project, op.plan); }
      catch (error) { fail(op, error); return false; }
      publish({ status: "applying", mode: state.mode, plan: op.plan });
      try {
        const ack = await options.apply(application);
        if (ack?.status === "cancelled") {
          settleAutoReframeApplicationV1(op.plan, true);
          if (matches(op)) publish({ status: "ready", mode: state.mode, plan: op.plan }); else if (active === op) clear();
          return false;
        }
        settleAutoReframeApplicationV1(op.plan);
        if (ack?.status !== (application.kind === "command" ? "applied" : "created")) throw Error("AUTO_REFRAME_APPLY_ACK_UNCERTAIN");
        // An accepted command changes contentOwner. Do not label our own successful edit stale.
        active = undefined; publish({ status: "done", mode: state.mode }); return true;
      } catch (error) {
        // A host error may follow a partial commit. Close the plan; never replay it automatically.
        try { settleAutoReframeApplicationV1(op.plan); } catch { /* Already closed by acknowledgement validation. */ }
        if (active === op) active = undefined;
        publish({ status: "failed", mode: state.mode, error }); report(error); return false;
      }
    },
  };
}
