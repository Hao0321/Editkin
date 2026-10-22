import { randomBytes } from "node:crypto";
import type { LongformUiFocusArtifactV1 } from "../domain/longformUiFocusFileV1";
import { longformUiFocusHoldFileRequestV1Schema, type LongformUiFocusHoldFileRequestV1 } from "../domain/longformUiFocusHoldFileV1";
import type { prepareLongformUiFocusHoldV1 } from "./longformUiFocusHoldRuntimeV1";
import { longformUiFocusHoldTargetV1 } from "./longformUiFocusHoldV1";
import { colorDigest } from "./materialColorSamplingRuntime";
import { assertLongformUiFocusHoldReadyV1, withLongformUiFocusHoldReadyV1 } from "./longformUiFocusHoldReadyV1";
export type LongformUiFocusHoldResultV1 = Awaited<ReturnType<typeof prepareLongformUiFocusHoldV1>>;

/** Populated only after the source OCR confirmation tool has succeeded. Bounded
 * memory is additional admission; it never replaces producer/view/current guards. */
export class LongformUiFocusConfirmationsV1 {
  private readonly artifacts = new Map<string, Set<string>>();
  rememberVerified(artifactId: string, candidateIds: readonly string[]) {
    const ids = this.artifacts.get(artifactId) ?? new Set<string>();
    for (const id of candidateIds) { ids.delete(id); ids.add(id); }
    while (ids.size > 64) ids.delete(ids.values().next().value!);
    this.artifacts.delete(artifactId); this.artifacts.set(artifactId, ids);
    while (this.artifacts.size > 32) this.artifacts.delete(this.artifacts.keys().next().value!);
  }
  assertConfirmed(artifactId: string, candidateId: string) {
    if (!this.artifacts.get(artifactId)?.has(candidateId)) throw Error("UI_FOCUS_CONFIRM_TARGET_FIRST");
  }
  clear() { this.artifacts.clear(); }
}
export interface LongformUiFocusHoldJobDepsV1 {
  assertOwned: (artifactId: string) => void;
  assertViewed: (artifactId: string, frameIds: string[]) => void;
  confirmations: LongformUiFocusConfirmationsV1;
  read: (artifactId: string, signal?: AbortSignal) => Promise<LongformUiFocusArtifactV1>;
  prepare: (artifact: LongformUiFocusArtifactV1, request: LongformUiFocusHoldFileRequestV1, signal: AbortSignal) => Promise<LongformUiFocusHoldResultV1>;
  validateCurrent: (artifactId: string, result: LongformUiFocusHoldResultV1, signal?: AbortSignal) => Promise<void>;
}
export interface LongformUiFocusHoldJobV1 {
  jobId: string; state: "RUNNING" | "CANCELLING" | "CANCELLED" | "FAILED" | "COMPLETED";
  artifactId: string; candidateId: string; duration: number; startedAt: string; finishedAt?: string;
  result?: { receiptSha256: string; state: LongformUiFocusHoldResultV1["state"]; sourceFrameCount: number; flags: string[];
    sourceStart: number; sourceEnd: number; projectModified: false; focusHintsReady: false; artworkStatus: "ART_PENDING_CLAUDE" };
  error?: string;
}
interface Owned { ticket: LongformUiFocusHoldJobV1; controller: AbortController; done: Promise<void>; result?: LongformUiFocusHoldResultV1 }
const active = (row: Owned) => row.ticket.state === "RUNNING" || row.ticket.state === "CANCELLING";
export class LongformUiFocusHoldJobsV1 {
  private readonly jobs = new Map<string, Owned>();
  private closed = false;
  constructor(private readonly deps: LongformUiFocusHoldJobDepsV1) {}
  private admitted(request: Pick<LongformUiFocusHoldFileRequestV1, "artifactId" | "candidateId">) {
    if (this.closed) throw Error("UI_FOCUS_HOLD_JOBS_CLOSED");
    this.deps.assertOwned(request.artifactId); this.deps.confirmations.assertConfirmed(request.artifactId, request.candidateId);
  }
  start(raw: unknown) {
    const request = longformUiFocusHoldFileRequestV1Schema.parse(raw); this.admitted(request);
    if ([...this.jobs.values()].some(active)) throw Error("UI_FOCUS_HOLD_JOB_ALREADY_RUNNING");
    while (this.jobs.size >= 32) {
      const oldest = [...this.jobs.entries()].find(([, row]) => !active(row));
      if (!oldest) throw Error("UI_FOCUS_HOLD_JOB_HISTORY_FULL"); this.jobs.delete(oldest[0]);
    }
    const ticket: LongformUiFocusHoldJobV1 = { jobId: "uh-" + randomBytes(12).toString("hex"), state: "RUNNING", ...request, startedAt: new Date().toISOString() };
    const row: Owned = { ticket, controller: new AbortController(), done: Promise.resolve() }; this.jobs.set(ticket.jobId, row);
    row.done = Promise.resolve().then(async () => {
      const signal = row.controller.signal;
      try {
        signal.throwIfAborted(); const artifact = await this.deps.read(request.artifactId, signal); this.admitted(request);
        if (artifact.artifactId !== request.artifactId) throw Error("UI_FOCUS_HOLD_ARTIFACT_BINDING");
        const target = longformUiFocusHoldTargetV1(artifact.draft, { draftId: artifact.draft.draftId, candidateId: request.candidateId, duration: request.duration });
        this.deps.assertViewed(request.artifactId, [target.candidate.frameId]); signal.throwIfAborted();
        const result = await this.deps.prepare(artifact, request, signal); signal.throwIfAborted(); this.admitted(request);
        const { receiptSha256, ...body } = result;
        if (receiptSha256 !== colorDigest(body) || result.draftId !== artifact.draft.draftId || result.candidateId !== request.candidateId
          || result.sourceSha256 !== artifact.draft.source.sha256 || result.requestedDuration !== request.duration
          || Math.abs(result.sourceStart - target.start) > 1e-7 || Math.abs(result.sourceEnd - target.end) > 1e-7
          || result.projectModified !== false || result.focusHintsReady !== false || result.artworkStatus !== "ART_PENDING_CLAUDE"
          || result.semanticIdentityAcrossIntervalVerified !== false || result.confidenceCalibrated !== false || result.selectableByDefault !== false
          || !["TRACKING_EVIDENCE_READY", "BLOCKED"].includes(result.state) || !Number.isInteger(result.sourceFrameCount)
          || result.sourceFrameCount < 1 || result.sourceFrameCount > 256 || result.frames.length !== result.sourceFrameCount
          || result.localObservations.length !== result.sourceFrameCount
          || result.pixelTemplateContinuityVerified !== (result.state === "TRACKING_EVIDENCE_READY")
          || (result.state === "TRACKING_EVIDENCE_READY") !== (result.flags.length === 0)) throw Error("UI_FOCUS_HOLD_JOB_RESULT");
        await this.deps.validateCurrent(request.artifactId, result, signal); signal.throwIfAborted(); this.admitted(request);
        this.deps.assertViewed(request.artifactId, [target.candidate.frameId]);
        row.result = structuredClone(result);
        ticket.result = { receiptSha256, state: result.state, sourceFrameCount: result.sourceFrameCount, flags: [...result.flags],
          sourceStart: result.sourceStart, sourceEnd: result.sourceEnd, projectModified: false, focusHintsReady: false, artworkStatus: "ART_PENDING_CLAUDE" };
        ticket.state = "COMPLETED";
      } catch (error) {
        ticket.state = signal.aborted ? "CANCELLED" : "FAILED";
        ticket.error = signal.aborted ? "Hold analysis cancelled after owned process settlement" :
          (error instanceof Error ? error.message : String(error)).replace(/[A-Za-z]:[\\/][^\r\n]+/g, "[local-path]").slice(0, 1000);
        delete row.result; delete ticket.result;
      } finally { ticket.finishedAt = new Date().toISOString(); }
    });
    return structuredClone(ticket);
  }
  private row(id: string) { const row = this.jobs.get(id); if (!row) throw Error("UI_FOCUS_HOLD_JOB_NOT_FOUND"); return row; }
  async get(id: string) {
    const row = this.row(id);
    if (row.result) { this.admitted(row.ticket); await this.deps.validateCurrent(row.ticket.artifactId, row.result); this.admitted(row.ticket); }
    return structuredClone(row.ticket);
  }
  cancel(id: string) { const row = this.row(id); if (active(row)) { row.ticket.state = "CANCELLING"; row.controller.abort(); } return structuredClone(row.ticket); }
  async read(id: string, offset: number, limit: number) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 64) throw Error("UI_FOCUS_HOLD_PAGE_BUDGET");
    const row = this.row(id); this.admitted(row.ticket);
    if (!row.result || row.ticket.state !== "COMPLETED") throw Error("UI_FOCUS_HOLD_NOT_COMPLETED");
    await this.deps.validateCurrent(row.ticket.artifactId, row.result); this.admitted(row.ticket);
    const result = row.result, items = result.frames.slice(offset, offset + limit).map(frame => ({ ...frame, localObservation: result.localObservations[frame.frame] }));
    return structuredClone({ ...row.ticket, provider: result.provider, limitations: result.limitations,
      sourceTimeBase: result.sourceTimeBase, sourceSha256: result.sourceSha256, sequenceSha256: result.sequenceSha256,
      rawSha256: result.rawSha256, nativeResultSha256: result.nativeResultSha256, trackingContext: result.trackingContext, contextAuthority: result.contextAuthority,
      semanticIdentityAcrossIntervalVerified: false, confidenceCalibrated: false, selectableByDefault: false,
      offset, total: result.frames.length, items, nextOffset: offset + items.length < result.frames.length ? offset + items.length : null });
  }
  private readyPort(id: string) {
    const row = this.row(id);
    return { admit: () => this.admitted(row.ticket),
      snapshot: () => this.jobs.get(id) === row && row.ticket.state === "COMPLETED" ? row.result : undefined,
      read: (signal?: AbortSignal) => this.deps.read(row.ticket.artifactId, signal),
      assertViewed: (frameId: string) => this.deps.assertViewed(row.ticket.artifactId, [frameId]),
      validate: (result: LongformUiFocusHoldResultV1, signal?: AbortSignal) => this.deps.validateCurrent(row.ticket.artifactId, result, signal) };
  }
  /** Internal current-bound port; never accepts a caller's hold receipt. */
  assertReadyOwned(id: string) { assertLongformUiFocusHoldReadyV1(this.readyPort(id)); }
  withReadyResult<T>(id: string, operation: (hold: LongformUiFocusHoldResultV1, validateCurrent: () => Promise<void>, artifact: LongformUiFocusArtifactV1) => Promise<T>, signal?: AbortSignal) {
    return withLongformUiFocusHoldReadyV1(this.readyPort(id), operation, signal);
  }
  async close() {
    this.closed = true; for (const [id, row] of this.jobs) if (active(row)) this.cancel(id);
    await Promise.all([...this.jobs.values()].map(row => row.done)); this.jobs.clear(); this.deps.confirmations.clear();
  }
}
const owners = new Set<LongformUiFocusHoldJobsV1>();
export function ownLongformUiFocusHoldJobsV1(deps: LongformUiFocusHoldJobDepsV1) { const owner = new LongformUiFocusHoldJobsV1(deps); owners.add(owner); return owner; }
export async function closeLongformUiFocusHoldJobsV1() { await Promise.all([...owners].map(owner => owner.close())); owners.clear(); }
