import { canonicalJson } from "../shared/canonicalJson";
import { refuseShotMatchPanelV1, ShotMatchPanelRefusalV1, shotMatchHostStampV1, shotMatchPanelRequestV1,
  shotMatchReferenceStripV1, targetShotMatchClipV1, validateShotMatchFramesV1,
  type ShotMatchDraftV1, type ShotMatchFramesV1, type ShotMatchHoldV1, type ShotMatchHostV1,
  type ShotMatchModeV1, type ShotMatchReviewV1, type ShotMatchRuntimeV1 } from "./shotMatchPanelModelV1";

export interface ShotMatchPanelStateV1 {
  status: "idle" | "loading" | "analysing" | "ready" | "applying" | "applied" | "unchanged" | "not_applicable" | "held" | "cancelled" | "uncertain";
  draft: ShotMatchDraftV1; target?: ShotMatchFramesV1; reference?: ShotMatchFramesV1; review?: ShotMatchReviewV1;
  comparison?: { before: ShotMatchFramesV1; after: ShotMatchFramesV1 }; code?: ShotMatchHoldV1;
}
interface Snapshot { host: ShotMatchHostV1; stamp: string; }
function same(a?: Snapshot, b?: Snapshot) {
  return a?.stamp === b?.stamp && a?.host.projectOwner === b?.host.projectOwner && a?.host.contentOwner === b?.host.contentOwner
    && a?.host.sessionId === b?.host.sessionId && a?.host.readFrames === b?.host.readFrames && a?.host.prepare === b?.host.prepare;
}
function checkedReview(review: ShotMatchReviewV1, request: ReturnType<typeof shotMatchPanelRequestV1>, snapshot: Snapshot, target: ShotMatchFramesV1, reference?: ShotMatchFramesV1) {
  const p = review?.proposal;
  if (!p || typeof review.apply !== "function" || typeof review.discard !== "function" || p.projectId !== snapshot.host.project.id
    || p.expectedRevision !== request.expectedRevision || p.clipId !== request.target.clipId || p.mode !== request.mode
    || p.referenceClipId !== (request.mode === "shot_match" ? request.reference.clipId : null)
    || !["ready", "unchanged", "not_applicable"].includes(p.state) || !Array.isArray(p.sourceBindings)
    || p.sourceBindings.length !== (request.mode === "shot_match" ? 2 : 1)) refuseShotMatchPanelV1("stale");
  for (const source of [target, ...(request.mode === "shot_match" && reference ? [reference] : [])]) {
    if (!p.sourceBindings.some(b => b.clipId === source.clipId && b.assetId === source.assetId && b.sourceSha256 === source.sourceSha256)) refuseShotMatchPanelV1("stale");
  }
  for (const frames of [review.before, review.after]) {
    validateShotMatchFramesV1(frames, snapshot.host.project, target.clipId);
    if (frames.sourceSha256 !== target.sourceSha256 || canonicalJson(frames.frames.map(f => [f.sampleId, f.timeSeconds, f.width, f.height]))
      !== canonicalJson(target.frames.map(f => [f.sampleId, f.timeSeconds, f.width, f.height]))) refuseShotMatchPanelV1("frames");
  }
  return { proposal: structuredClone(p), before: validateShotMatchFramesV1(review.before, snapshot.host.project, target.clipId),
    after: validateShotMatchFramesV1(review.after, snapshot.host.project, target.clipId),
    apply: (runtime: ShotMatchRuntimeV1) => review.apply(runtime), discard: () => review.discard() };
}
const discard = (review?: ShotMatchReviewV1) => { try { review?.discard(); } catch { /* The aborted backend runtime still forbids a later apply. */ } };

/** View-local state only. All I/O waits for the preceding cancelled operation to close. */
export function createShotMatchPanelInteractionV1(read: () => ShotMatchHostV1 | undefined, label: string, emit: (state: ShotMatchPanelStateV1) => void) {
  let state: ShotMatchPanelStateV1 = { status: "idle", draft: { targetRegions: [], referenceRegions: [], destination: { kind: "append", label } } };
  let snapshot: Snapshot | undefined, initialized = false, disposed = false, sequence = 0, abort: AbortController | undefined, work: Promise<void> | undefined;
  const now = (): Snapshot | undefined => { try { const host = read(); return host ? { host, stamp: shotMatchHostStampV1(host) } : undefined; } catch { return undefined; } };
  const publish = (patch: Partial<ShotMatchPanelStateV1>) => { state = { ...state, ...patch }; if (!disposed) emit(state); };
  const invalidate = () => { sequence++; abort?.abort(); abort = undefined; discard(state.review); state = { ...state, review: undefined, comparison: undefined }; };
  const current = (id: number, captured: Snapshot, draftKey: string) => !disposed && id === sequence && same(captured, now()) && canonicalJson(state.draft) === draftKey;
  const schedule = (status: "loading" | "analysing" | "applying", operation: (s: Snapshot, runtime: ShotMatchRuntimeV1) => Promise<void>) => {
    const captured = snapshot; if (!captured || disposed) return Promise.resolve();
    const previous = work, id = sequence, draftKey = canonicalJson(state.draft), control = new AbortController(); abort = control;
    const runtime = { signal: control.signal, isCurrent: () => current(id, captured, draftKey) && !control.signal.aborted };
    publish({ status, code: undefined });
    const pending = (async () => {
      await previous?.catch(() => undefined); if (!runtime.isCurrent()) return;
      const timer = setTimeout(() => {
        control.abort(); if (!disposed && id === sequence) publish({ status: status === "applying" ? "uncertain" : "held", code: "timeout", review: undefined });
      }, 20000);
      try { await operation(captured, runtime); }
      catch (error) {
        if (disposed || id !== sequence) return;
        if (status !== "applying" && !same(captured, now())) { refresh(); return; }
        publish({ status: status === "applying" ? "uncertain" : "held",
          code: control.signal.aborted ? "timeout" : error instanceof ShotMatchPanelRefusalV1 ? error.code : "unavailable", review: undefined });
      } finally { clearTimeout(timer); }
    })(); work = pending; return pending;
  };
  const reload = () => {
    if (disposed || state.status === "applying" || state.status === "uncertain") return Promise.resolve();
    invalidate(); publish({ target: undefined, reference: undefined });
    return schedule("loading", async (s, runtime) => {
      targetShotMatchClipV1(s.host);
      const target = validateShotMatchFramesV1(await s.host.readFrames(s.host.targetClipId, runtime), s.host.project, s.host.targetClipId);
      if (!runtime.isCurrent()) return;
      const id = state.draft.referenceClipId, reference = id ? validateShotMatchFramesV1(await s.host.readFrames(id, runtime), s.host.project, id) : undefined;
      if (runtime.isCurrent()) publish({ status: "idle", target, reference });
    });
  };
  const refresh = () => {
    if (disposed) return Promise.resolve(); let next: Snapshot | undefined;
    try { next = now(); } catch { next = undefined; }
    if (initialized && same(snapshot, next)) return Promise.resolve();
    initialized = true; invalidate(); snapshot = next;
    state = { status: "idle", draft: { targetRegions: [], referenceRegions: [], destination: { kind: "append", label } } };
    try {
      if (!next) refuseShotMatchPanelV1("unavailable");
      state.draft.referenceClipId = shotMatchReferenceStripV1(next.host).previousClipId; return reload();
    } catch (error) { publish({ status: "held", code: error instanceof ShotMatchPanelRefusalV1 ? error.code : "unavailable" }); return Promise.resolve(); }
  };
  const changeDraft = (draft: ShotMatchDraftV1) => {
    if (disposed || state.status === "applying" || state.status === "uncertain") return false;
    const changedReference = draft.referenceClipId !== state.draft.referenceClipId, needsFrames = !state.target;
    invalidate(); publish({ status: "idle", code: undefined, draft: structuredClone({ ...draft, referenceRegions: changedReference ? [] : draft.referenceRegions }) });
    if (changedReference || needsFrames) void reload(); return true;
  };
  const run = (mode: ShotMatchModeV1) => {
    if (disposed || ["loading", "analysing", "applying", "uncertain"].includes(state.status)) return Promise.resolve();
    if (!state.target || !snapshot || !same(snapshot, now())) return refresh();
    let request: ReturnType<typeof shotMatchPanelRequestV1>;
    try { request = shotMatchPanelRequestV1(snapshot.host, state.draft, state.target, state.reference, mode); }
    catch (error) { publish({ status: "held", code: error instanceof ShotMatchPanelRefusalV1 ? error.code : "unavailable" }); return Promise.resolve(); }
    invalidate(); const target = state.target, reference = state.reference;
    return schedule("analysing", async (s, runtime) => {
      const review = await s.host.prepare(request, runtime);
      if (!runtime.isCurrent()) { discard(review); return; }
      let owned: ShotMatchReviewV1;
      try { owned = checkedReview(review, request, s, target, reference); }
      catch (error) { discard(review); throw error; }
      publish({ status: owned.proposal.state === "ready" ? "ready" : owned.proposal.state, review: owned, comparison: { before: owned.before, after: owned.after } });
    });
  };
  const apply = () => {
    if (disposed || state.status !== "ready" || !state.review || !snapshot || !same(snapshot, now())) return refresh();
    const review = state.review; state = { ...state, review: undefined }; // Consume the view attempt before the first await.
    return schedule("applying", async (_s, runtime) => {
      try {
        const result = await review.apply(runtime);
        if (result.status !== "applied" || result.undoSteps !== 1 || result.clipId !== review.proposal.clipId) throw Error("SHOT_MATCH_APPLY_ACK_UNCERTAIN");
        if (!disposed && runtime.signal.aborted === false) publish({ status: "applied" });
      } finally { discard(review); }
    });
  };
  const cancel = () => { if (disposed) return; const status = state.status === "applying" ? "uncertain" : "cancelled"; invalidate(); publish({ status }); };
  return { state: () => state, refresh, reload, changeDraft, run, apply, cancel,
    dispose() { if (!disposed) { invalidate(); disposed = true; } }, settled: () => work ?? Promise.resolve() };
}
