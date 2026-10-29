import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { readBoundedFile } from "../shared/boundedFile";
import { join, resolve } from "node:path";
import * as z from "zod/v4";
import { canonicalJson } from "../shared/canonicalJson";
import { configuredWhisperCliPath } from "./automaticCaptions";
import { prepareMaterialIntelligence, type MaterialPreparationProgress, type MaterialRuntime, type PrepareMaterialRequest } from "./materialIntelligence";
import type { AttachedJob, AttachedJobOutcome, JobProgress, JobTracker } from "./jobRegistry";

const idSchema = z.string().uuid();
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const stateSchema = z.object({
  schema: z.literal("editkin.material-preparation-job/v1"), jobId: idSchema,
  requestHash: z.string().regex(/^[a-f0-9]{64}$/), ownerPid: z.number().int().positive(), ownerInstance: idSchema,
  state: z.enum(["RUNNING", "CANCELLING", "CANCELLED", "FAILED", "COMPLETED", "INTERRUPTED"]),
  startedAt: z.string(), updatedAt: z.string(), resumedFrom: idSchema.optional(),
  progress: z.union([
    z.object({ phase: z.enum(["identity", "scene", "keyframes", "color", "finalizing"]) }),
    z.object({ phase: z.literal("transcript"), completedSegments: z.number().int().nonnegative(), totalSegments: z.number().int().positive(), analyzedSeconds: z.number().nonnegative(), totalSeconds: z.number().positive(), cachedSegments: z.number().int().nonnegative() }),
  ]),
  result: z.object({ materialId: z.string().regex(/^[a-f0-9]{64}$/), packetSha256: z.string().regex(/^[a-f0-9]{64}$/), cacheHit: z.boolean() }).optional(),
  error: z.string().max(500).optional(),
});
export type MaterialPreparationJob = z.infer<typeof stateSchema>;
type Preparation = typeof prepareMaterialIntelligence;
type LocalJob = { state: MaterialPreparationJob; published: MaterialPreparationJob; abort: AbortController; done: Promise<void>;
  /** The same job in the shared job registry (`job` tool), when the MCP process attached one; never required. */
  tracked?: Promise<AttachedJob | undefined> };
const active = (state: MaterialPreparationJob) => state.state === "RUNNING" || state.state === "CANCELLING";
function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Jobs are orchestration state, NOT evidence or permissions. Resume accepts a
 * fresh validated request/runtime; never executes paths read from saved state.
 * Results still belong to sealed material caches and must be read/verified there.
 */
export class MaterialPreparationJobs {
  private readonly directory: string;
  private readonly instance = randomUUID();
  private readonly jobs = new Map<string, LocalJob>();
  private closed = false;
  constructor(cacheRoot: string, private readonly prepare: Preparation = prepareMaterialIntelligence, private tracker?: JobTracker) {
    this.directory = join(resolve(cacheRoot), "material-preparation-jobs");
  }
  /** W2-5: mirror every job this manager starts into the shared registry as kind `material_prep`. */
  useTracker(tracker: JobTracker) { this.tracker ??= tracker; }
  /** Best effort: a registry that cannot record the job never changes preparation, its ids or its tools. */
  private track(state: MaterialPreparationJob, request: PrepareMaterialRequest): Promise<AttachedJob | undefined> {
    const tracker = this.tracker;
    if (!tracker) return Promise.resolve(undefined);
    return tracker.attach({ kind: "material_prep", ownerJobId: state.jobId, cancel: () => this.cancel(state.jobId),
      label: { clipId: request.clipId.slice(0, 128), assetId: request.assetId.slice(0, 128), ...(state.resumedFrom ? { resumedFrom: state.resumedFrom } : {}) } })
      .catch(() => undefined);
  }
  private path(id: string) { return join(this.directory, `${idSchema.parse(id)}.json`); }
  private async save(state: MaterialPreparationJob) {
    state.updatedAt = new Date().toISOString();
    const path = this.path(state.jobId), temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(stateSchema.parse(state)) + "\n", { flag: "wx" });
    try {
      for (let attempt = 0; ; attempt++) {
        try { await rename(temp, path); break; }
        catch (error) {
          if (attempt >= 5 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          await new Promise(done => setTimeout(done, 20));
        }
      }
    } finally { await rm(temp, { force: true }); }
  }
  private async read(id: string) {
    const bytes = await readBoundedFile(this.path(id), 32768, { messages: { notRegular: "素材工作狀態檔不合法", tooLarge: "素材工作狀態檔不合法" } });
    const state = stateSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (state.jobId !== id) throw Error("素材工作識別不一致");
    return state;
  }
  /** Short cross-process critical section. Never evicted by age: only a lock whose recorded owner process is
   * provably gone (a crash inside the section) is recovered, so a live owner is never stolen from. */
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true });
    if ((await lstat(this.directory)).isSymbolicLink()) throw Error("素材工作目錄不可為連結");
    const path = join(this.directory, "coordination.lock");
    let handle;
    const deadline = Date.now() + 2000;
    while (!handle) {
      try { handle = await open(path, "wx"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await this.recoverDeadCoordinationLock(path)) continue;
        if (Date.now() >= deadline) throw Error("素材工作鎖忙碌或中斷，未啟動重複分析");
        await new Promise(done => setTimeout(done, 20));
      }
    }
    try { await handle.writeFile(`${process.pid}:${this.instance}`); return await work(); }
    finally { await handle.close(); await rm(path); }
  }
  /** The lock names `<pid>:<instance>`. Empty or unreadable content (being written) or a live pid is never removed. */
  private async recoverDeadCoordinationLock(path: string): Promise<boolean> {
    let owner: string;
    try { owner = (await readFile(path, "utf8")).trim(); }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
    const match = /^(\d+):/.exec(owner), pid = match ? Number(match[1]) : 0;
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || alive(pid)) return false;
    await rm(path, { force: true });
    return true;
  }
  async status(jobId: string): Promise<MaterialPreparationJob> {
    const state = this.jobs.get(jobId)?.published ?? await this.read(jobId);
    if (active(state) && !alive(state.ownerPid)) return { ...state, state: "INTERRUPTED", error: "分析程序已停止；以相同 prepare 要求和 resumeJobId 明確續跑，已完成字幕分段可重用" };
    return structuredClone(state);
  }
  async start(request: PrepareMaterialRequest, runtime: MaterialRuntime, resumeJobId?: string) {
    if (this.closed) throw Error("素材工作服務正在停止");
    const requestHash = digest({ request, runtime: { ffmpegPath: resolve(runtime.ffmpegPath), ffprobePath: runtime.ffprobePath,
      modelRoot: resolve(runtime.modelRoot), modelPath: runtime.modelPath, whisperCliPath: configuredWhisperCliPath(runtime), cacheRoot: resolve(runtime.cacheRoot) } });
    return this.exclusive(async () => {
      // One active slot per prepare request (B3b): different clips/requests prepare in parallel, matching the v4
      // contract's material-prepare fan-out, and an interrupted job only blocks its own request until it is resumed.
      const activePath = join(this.directory, `active-${requestHash}.json`);
      const readOwner = async (path: string) => {
        try { return await this.read(idSchema.parse(JSON.parse(await readFile(path, "utf8")).jobId)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return undefined; }
      };
      let owner = await readOwner(activePath);
      // A slot written by the previous single-slot layout still owns its own request.
      if (!owner) { const legacy = await readOwner(join(this.directory, "active.json")); if (legacy?.requestHash === requestHash) owner = legacy; }
      if (owner && active(owner) && alive(owner.ownerPid)) {
        if (owner.requestHash !== requestHash) throw Error("已有素材分析進行中，請先等待或取消該工作");
        return { job: await this.status(owner.jobId), coalesced: true };
      }
      if (owner && active(owner) && resumeJobId !== owner.jobId) {
        // B3: name the job, so the caller can resume it without guessing.
        const progress = owner.progress.phase === "transcript" ? `，字幕分段 ${owner.progress.completedSegments}/${owner.progress.totalSegments} 已完成` : "";
        throw Error(`前次素材工作中斷，請指定 resumeJobId（MATERIAL_JOB_INTERRUPTED resumeJobId=${owner.jobId}，${owner.updatedAt} 中斷${progress}）；以相同 prepare 要求續跑，未自動重跑`);
      }
      if (resumeJobId) {
        const previous = await this.status(resumeJobId);
        if (previous.requestHash !== requestHash || active(previous)) throw Error("續跑要求不一致或工作仍在執行");
      }
      const now = new Date().toISOString();
      const state: MaterialPreparationJob = { schema: "editkin.material-preparation-job/v1", jobId: randomUUID(), requestHash,
        ownerPid: process.pid, ownerInstance: this.instance, state: "RUNNING", startedAt: now, updatedAt: now,
        progress: { phase: "identity" }, ...(resumeJobId ? { resumedFrom: resumeJobId } : {}) };
      await this.save(state);
      await writeFile(activePath, JSON.stringify({ jobId: state.jobId }));
      const local: LocalJob = { state, published: structuredClone(state), abort: new AbortController(), done: Promise.resolve() };
      this.jobs.set(state.jobId, local);
      local.tracked = this.track(state, request);
      // Do not await the analysis in the MCP request handler.
      local.done = this.execute(local, structuredClone(request), runtime);
      return { job: structuredClone(state), coalesced: false };
    });
  }
  private async execute(local: LocalJob, request: PrepareMaterialRequest, runtime: MaterialRuntime) {
    const { state, abort } = local;
    try {
      const result = await this.prepare(request, { ...runtime, requireTranscriptCompletion: true, signal: abort.signal,
        onProgress: async (progress: MaterialPreparationProgress) => { abort.signal.throwIfAborted(); state.progress = progress; await this.save(state); local.published = structuredClone(state);
          void local.tracked?.then(tracked => tracked?.progress(materialJobProgress(progress))); } });
      abort.signal.throwIfAborted();
      if (!result.packet.cache) throw Error("素材完成結果缺少完整性封存");
      state.result = { materialId: result.packet.materialId, packetSha256: result.packet.cache.packetSha256, cacheHit: result.cacheHit };
      state.state = "COMPLETED";
    } catch (error) {
      state.state = abort.signal.aborted ? "CANCELLED" : "FAILED";
      state.error = (abort.signal.aborted ? "分析已取消；已完成分段已保留" : error instanceof Error ? error.message : String(error))
        .replace(/[A-Za-z]:[\\/][^\n\r]+|\/(?:[^\s/]+\/)+[^\s]+/g, "[local-path]").slice(0, 500);
      delete state.result;
    }
    // A failed persistence write remains an observable failed job, not an
    // unhandled rejection or successful result returned from memory.
    try { await this.save(state); }
    catch (error) { state.state = "FAILED"; state.error = `素材工作狀態無法保存 (${(error as NodeJS.ErrnoException).code ?? "I/O"})`; delete state.result; }
    local.published = structuredClone(state);
    try { await (await local.tracked)?.finish(materialJobOutcome(state)); } catch { /* The registry mirror never changes the job. */ }
  }
  async cancel(jobId: string) {
    const local = this.jobs.get(jobId);
    if (!local) { const state = await this.status(jobId); if (!active(state)) return state; throw Error("工作由其他仍在執行的程序持有，請在原連線取消"); }
    if (active(local.state)) {
      // Owner remains CANCELLING until prepare has closed its actual children.
      local.state.state = "CANCELLING"; local.abort.abort();
      local.published = { ...local.published, state: "CANCELLING" };
      void local.tracked?.then(tracked => tracked?.cancelRequested());
    }
    return this.status(jobId);
  }
  async close() {
    this.closed = true;
    for (const local of this.jobs.values()) if (active(local.state)) { local.state.state = "CANCELLING"; local.published = { ...local.published, state: "CANCELLING" }; local.abort.abort(); }
    await Promise.all([...this.jobs.values()].map(local => local.done));
  }
}

/** The shared registry's view of a preparation phase: transcript segments are the only measured fraction. */
export function materialJobProgress(progress: MaterialPreparationProgress): JobProgress {
  return progress.phase === "transcript"
    ? { stage: "transcript", fraction: Math.min(1, progress.completedSegments / progress.totalSegments), part: Math.max(1, progress.completedSegments), parts: progress.totalSegments }
    : { stage: progress.phase };
}
export function materialJobOutcome(state: MaterialPreparationJob): AttachedJobOutcome {
  if (state.state === "COMPLETED" && state.result) return { state: "succeeded", result: { ...state.result, next: "get_material_preparation_job" } };
  if (state.state === "CANCELLED") return { state: "cancelled", ...(state.error ? { error: { code: "CANCELLED", message: state.error } } : {}) };
  return { state: "failed", error: { code: "MATERIAL_PREP_FAILED", message: state.error ?? "素材準備失敗" } };
}

const managers = new Map<string, MaterialPreparationJobs>();
export function materialPreparationJobs(cacheRoot: string, options: { tracker?: JobTracker } = {}) {
  const key = resolve(cacheRoot); let manager = managers.get(key);
  if (!manager) { manager = new MaterialPreparationJobs(key); managers.set(key, manager); }
  if (options.tracker) manager.useTracker(options.tracker);
  return manager;
}
export async function closeMaterialPreparationJobs() { await Promise.all([...managers.values()].map(manager => manager.close())); }
