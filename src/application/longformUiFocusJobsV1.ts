import { randomBytes } from "node:crypto";
import { longformUiFocusFileRequestV1Schema, type LongformUiFocusFileRequestV1, type LongformUiFocusJobResultV1 } from "../domain/longformUiFocusFileV1";

export interface LongformUiFocusJobV1 {
  jobId: string; state: "RUNNING" | "CANCELLING" | "CANCELLED" | "FAILED" | "COMPLETED";
  startedAt: string; finishedAt?: string; progress: { completedFrames: number; totalFrames: number };
  result?: LongformUiFocusJobResultV1; error?: string;
}
export interface LongformUiFocusJobDepsV1 {
  prepare: (request: LongformUiFocusFileRequestV1, signal: AbortSignal,
    progress: (value: LongformUiFocusJobV1["progress"]) => void) => Promise<LongformUiFocusJobResultV1>;
}
interface Owned { value: LongformUiFocusJobV1; controller: AbortController; done: Promise<void> }
const active = (value: LongformUiFocusJobV1) => value.state === "RUNNING" || value.state === "CANCELLING";

/** Only IDs actually produced by this owner may enter public confirmation.
 * Self-sealed external artifacts are not an alternative detector ingress. */
export class LongformUiFocusJobsV1 {
  private readonly jobs = new Map<string, Owned>();
  private readonly artifacts = new Set<string>();
  private readonly framesReturned = new Map<string, Set<string>>();
  private closed = false;
  constructor(private readonly deps: LongformUiFocusJobDepsV1) {}
  start(raw: unknown) {
    if (this.closed) throw Error("UI_FOCUS_JOBS_CLOSED");
    const request = longformUiFocusFileRequestV1Schema.parse(raw);
    if ([...this.jobs.values()].some(row => active(row.value))) throw Error("UI_FOCUS_JOB_ALREADY_RUNNING");
    while (this.jobs.size >= 32) {
      const oldest = [...this.jobs.entries()].find(([, row]) => !active(row.value));
      if (!oldest) throw Error("UI_FOCUS_JOB_HISTORY_FULL");
      this.jobs.delete(oldest[0]);
      if (oldest[1].value.result && ![...this.jobs.values()].some(row => row.value.result?.artifactId === oldest[1].value.result!.artifactId))
        { this.artifacts.delete(oldest[1].value.result.artifactId); this.framesReturned.delete(oldest[1].value.result.artifactId); }
    }
    const jobId = "uf-" + randomBytes(12).toString("hex"), controller = new AbortController();
    const value: LongformUiFocusJobV1 = { jobId, state: "RUNNING", startedAt: new Date().toISOString(),
      progress: { completedFrames: 0, totalFrames: request.frameTimes.length } };
    const owned: Owned = { value, controller, done: Promise.resolve() }; this.jobs.set(jobId, owned);
    owned.done = Promise.resolve().then(async () => {
      try {
        controller.signal.throwIfAborted();
        const result = await this.deps.prepare(request, controller.signal, progress => {
          if (progress.totalFrames !== request.frameTimes.length || !Number.isInteger(progress.completedFrames)
            || progress.completedFrames < value.progress.completedFrames || progress.completedFrames > progress.totalFrames)
            throw Error("UI_FOCUS_JOB_PROGRESS");
          value.progress = { ...progress };
        });
        controller.signal.throwIfAborted();
        if (!/^[a-f0-9]{64}$/.test(result.artifactId) || !/^[a-f0-9]{64}$/.test(result.draftId)
          || result.projectModified !== false || result.focusHintsReady !== false || result.state !== "REVIEW_REQUIRED"
          || !Number.isInteger(result.frameCount) || result.frameCount < 1 || !Number.isInteger(result.omittedFrameCount)
          || result.omittedFrameCount < 0 || result.frameCount + result.omittedFrameCount !== request.frameTimes.length
          || !Number.isSafeInteger(result.candidateCount) || result.candidateCount < 0
          || result.projectRevision !== request.expectedRevision)
          throw Error("UI_FOCUS_JOB_RESULT");
        value.result = structuredClone(result); this.artifacts.add(result.artifactId); value.state = "COMPLETED";
      } catch (error) {
        value.state = controller.signal.aborted ? "CANCELLED" : "FAILED";
        value.error = controller.signal.aborted ? "OCR cancelled after owned process settlement" :
          (error instanceof Error ? error.message : String(error)).replace(/[A-Za-z]:[\\/][^\r\n]+/g, "[local-path]").slice(0, 1000);
        delete value.result;
      } finally { value.finishedAt = new Date().toISOString(); }
    });
    return structuredClone(value);
  }
  get(id: string) { const row = this.jobs.get(id); if (!row) throw Error("UI_FOCUS_JOB_NOT_FOUND"); return structuredClone(row.value); }
  cancel(id: string) {
    const row = this.jobs.get(id); if (!row) throw Error("UI_FOCUS_JOB_NOT_FOUND");
    if (active(row.value)) { row.value.state = "CANCELLING"; row.controller.abort(); }
    return structuredClone(row.value);
  }
  assertArtifactOwned(id: string) {
    if (this.closed || !this.artifacts.has(id)) throw Error("UI_FOCUS_ARTIFACT_NOT_PRODUCED_BY_THIS_OWNER");
  }
  markFramesReturned(id: string, frameIds: string[]) {
    this.assertArtifactOwned(id);
    const frames = this.framesReturned.get(id) ?? new Set<string>();
    for (const frame of frameIds) frames.add(frame); this.framesReturned.set(id, frames);
  }
  assertFramesReturned(id: string, frameIds: string[]) {
    this.assertArtifactOwned(id);
    if (frameIds.some(frame => !this.framesReturned.get(id)?.has(frame))) throw Error("UI_FOCUS_VIEW_SOURCE_FRAMES_FIRST");
  }
  async close() {
    this.closed = true;
    for (const [id, row] of this.jobs) if (active(row.value)) this.cancel(id);
    await Promise.all([...this.jobs.values()].map(row => row.done)); this.artifacts.clear(); this.framesReturned.clear();
  }
}
const owners = new Set<LongformUiFocusJobsV1>();
export function ownLongformUiFocusJobsV1(deps: LongformUiFocusJobDepsV1) { const owner = new LongformUiFocusJobsV1(deps); owners.add(owner); return owner; }
export async function closeLongformUiFocusJobsV1() { await Promise.all([...owners].map(owner => owner.close())); owners.clear(); }
