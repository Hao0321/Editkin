import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as z from "zod/v4";
import { canonicalJson } from "../shared/canonicalJson";
import { configuredWhisperCliPath } from "./automaticCaptions";
import { prepareMaterialIntelligence, type MaterialPreparationProgress, type MaterialRuntime, type PrepareMaterialRequest } from "./materialIntelligence";

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
type LocalJob = { state: MaterialPreparationJob; published: MaterialPreparationJob; abort: AbortController; done: Promise<void> };
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
  constructor(cacheRoot: string, private readonly prepare: Preparation = prepareMaterialIntelligence) {
    this.directory = join(resolve(cacheRoot), "material-preparation-jobs");
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
    const path = this.path(id), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 32768) throw Error("素材工作狀態檔不合法");
    const state = stateSchema.parse(JSON.parse(await readFile(path, "utf8")));
    if (state.jobId !== id) throw Error("素材工作識別不一致");
    return state;
  }
  /** Short cross-process critical section. Never evict by age. A crashed
   * arbitration lock fails visibly; it cannot license stealing a live job. */
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
        if (Date.now() >= deadline) throw Error("素材工作鎖忙碌或中斷，未啟動重複分析");
        await new Promise(done => setTimeout(done, 20));
      }
    }
    try { await handle.writeFile(this.instance); return await work(); }
    finally { await handle.close(); await rm(path); }
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
      const activePath = join(this.directory, "active.json");
      let owner: MaterialPreparationJob | undefined;
      try { const id = idSchema.parse(JSON.parse(await readFile(activePath, "utf8")).jobId); owner = await this.read(id); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (owner && active(owner) && alive(owner.ownerPid)) {
        if (owner.requestHash !== requestHash) throw Error("已有素材分析進行中，請先等待或取消該工作");
        return { job: await this.status(owner.jobId), coalesced: true };
      }
      if (owner && active(owner) && resumeJobId !== owner.jobId) throw Error("前次素材工作中斷，請指定 resumeJobId；未自動重跑");
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
      // Do not await the analysis in the MCP request handler.
      local.done = this.execute(local, structuredClone(request), runtime);
      return { job: structuredClone(state), coalesced: false };
    });
  }
  private async execute(local: LocalJob, request: PrepareMaterialRequest, runtime: MaterialRuntime) {
    const { state, abort } = local;
    try {
      const result = await this.prepare(request, { ...runtime, requireTranscriptCompletion: true, signal: abort.signal,
        onProgress: async (progress: MaterialPreparationProgress) => { abort.signal.throwIfAborted(); state.progress = progress; await this.save(state); local.published = structuredClone(state); } });
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
  }
  async cancel(jobId: string) {
    const local = this.jobs.get(jobId);
    if (!local) { const state = await this.status(jobId); if (!active(state)) return state; throw Error("工作由其他仍在執行的程序持有，請在原連線取消"); }
    if (active(local.state)) {
      // Owner remains CANCELLING until prepare has closed its actual children.
      local.state.state = "CANCELLING"; local.abort.abort();
      local.published = { ...local.published, state: "CANCELLING" };
    }
    return this.status(jobId);
  }
  async close() {
    this.closed = true;
    for (const local of this.jobs.values()) if (active(local.state)) { local.state.state = "CANCELLING"; local.published = { ...local.published, state: "CANCELLING" }; local.abort.abort(); }
    await Promise.all([...this.jobs.values()].map(local => local.done));
  }
}

const managers = new Map<string, MaterialPreparationJobs>();
export function materialPreparationJobs(cacheRoot: string) {
  const key = resolve(cacheRoot); let manager = managers.get(key);
  if (!manager) { manager = new MaterialPreparationJobs(key); managers.set(key, manager); }
  return manager;
}
export async function closeMaterialPreparationJobs() { await Promise.all([...managers.values()].map(manager => manager.close())); }
