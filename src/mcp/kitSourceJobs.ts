/** Process-owned, recoverable preparation of large external Kit sources. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { KitSourceOptions, KitSourceProgress } from "./kitSourceStaging";

type JobStatus = "PREPARING" | "CREATING" | "COMPLETED" | "CANCELLING" | "CANCELLED" | "FAILED" | "INTERRUPTED" | "UNCERTAIN";
type SourceFact = { path: string; bytes: number; mtimeMs: number };
type Job = { schema: "editkin.kit-source-job/v1"; id: string; project: string; projectSha256: string;
  ownerPid: number; requestKey: string; sources: SourceFact[]; input: Record<string, unknown>; status: JobStatus; progress?: KitSourceProgress;
  result?: unknown; error?: string; updatedAt: string };
const idPattern = /^[a-f0-9-]{36}$/i;
const activeStatuses = new Set<JobStatus>(["PREPARING", "CREATING", "CANCELLING"]);
export type KitSourcePreparationView = { status: JobStatus; preparationId?: string; runId?: string;
  progress?: KitSourceProgress; updatedAt?: string; error?: string };

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function projectHash(path: string): string {
  if (statSync(path).size > 64 * 1024 * 1024) throw Error("Editkin project exceeds the Agent binding limit");
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function publicStatus(job: Job) {
  const { input: _input, project: _project, projectSha256: _hash, sources: _sources, schema: _schema, ownerPid: _ownerPid, requestKey: _requestKey, ...safe } = job;
  return { ...safe, preparationId: job.id, runId: job.input.runId, nextAction: job.status === "COMPLETED" ? "Use result.run_dir with run_kit_workflow(next)"
    : job.status === "INTERRUPTED" ? "Use run_kit_workflow(source-resume) with preparationId"
    : job.status === "UNCERTAIN" ? "Inspect the saved runId with run_kit_workflow(status) before any retry"
    : job.status === "PREPARING" || job.status === "CREATING" ? "Use run_kit_workflow(source-status) with preparationId" : undefined };
}

/** The desktop reads only the current project's bounded job summary; no original source path leaves the service. */
export function readCurrentKitSourcePreparation(workspace?: string, project?: string): KitSourcePreparationView | undefined {
  if (!workspace || !project) return undefined;
  let directory: string;
  try {
    const root = realpathSync(workspace), file = realpathSync(project);
    if (!within(root, file)) return undefined;
    directory = join(root, ".editkin-kit-sources", "jobs");
    if (!existsSync(directory)) return undefined;
    if (!within(root, realpathSync(directory))) throw Error("job directory leaves workspace");
    const pointerPath = join(directory, "current.json");
    if (!existsSync(pointerPath)) return undefined;
    if (statSync(pointerPath).size > 1024 || !within(directory, realpathSync(pointerPath))) throw Error("invalid job pointer");
    const pointer = JSON.parse(readFileSync(pointerPath, "utf8")) as { id?: unknown };
    if (typeof pointer.id !== "string" || !idPattern.test(pointer.id)) throw Error("invalid job ID");
    const jobPath = join(directory, `${pointer.id}.json`);
    if (statSync(jobPath).size > 1024 * 1024 || !within(directory, realpathSync(jobPath))) throw Error("invalid job record");
    const job = JSON.parse(readFileSync(jobPath, "utf8")) as Job;
    if (job.schema !== "editkin.kit-source-job/v1" || job.id !== pointer.id || job.project !== file
      || !Number.isSafeInteger(job.ownerPid) || job.ownerPid < 1 || !activeStatuses.has(job.status)
      && !["COMPLETED", "CANCELLED", "FAILED", "INTERRUPTED", "UNCERTAIN"].includes(job.status)) throw Error("invalid job state");
    let status = job.status;
    if (activeStatuses.has(status)) {
      try { process.kill(job.ownerPid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") status = status === "CREATING" ? "UNCERTAIN" : "INTERRUPTED"; else throw error; }
    }
    if (status === "PREPARING" && existsSync(join(directory, `${job.id}.cancel`))) status = "CANCELLING";
    const progress = job.progress;
    return { status, preparationId: job.id,
      runId: typeof job.input?.runId === "string" && job.input.runId.length <= 1024 ? job.input.runId : undefined,
      progress: progress && ["hashing", "checking", "copying", "verifying", "ready"].includes(progress.phase)
        && Number.isSafeInteger(progress.bytesDone) && Number.isSafeInteger(progress.bytesTotal) && progress.bytesDone >= 0 && progress.bytesTotal >= 0
        ? progress : undefined,
      updatedAt: typeof job.updatedAt === "string" ? job.updatedAt : undefined,
      error: typeof job.error === "string" ? job.error.slice(0, 500) : undefined };
  } catch { return { status: "FAILED", error: "素材準備紀錄無法讀取" }; }
}

export function requestCurrentKitSourceCancellation(workspace?: string, project?: string): boolean {
  const current = readCurrentKitSourcePreparation(workspace, project);
  if (!current || current.status !== "PREPARING" || !current.preparationId || !workspace) return false;
  const root = realpathSync(workspace), directory = join(root, ".editkin-kit-sources", "jobs");
  if (!within(root, realpathSync(directory))) throw Error("Kit source job directory leaves the workspace");
  const marker = join(directory, `${current.preparationId}.cancel`);
  let created = false;
  try { writeFileSync(marker, `${new Date().toISOString()}\n`, { flag: "wx" }); created = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const after = readCurrentKitSourcePreparation(workspace, project);
  if (after && ["CREATING", "COMPLETED", "UNCERTAIN"].includes(after.status)) {
    if (created) rmSync(marker, { force: true });
    return false;
  }
  return true;
}

export class KitSourceJobs {
  private readonly root: string;
  private readonly project: string;
  private readonly directory: string;
  private jobs = new Map<string, Job>();
  private controllers = new Map<string, AbortController>();
  private lastWrite = new Map<string, number>();

  constructor(workspace: string, project: string,
    private readonly execute: (input: Record<string, unknown>, options: KitSourceOptions & { onControllerStart: () => void }) => Promise<unknown>) {
    this.root = realpathSync(workspace);
    this.project = realpathSync(project);
    if (!within(this.root, this.project)) throw Error("Kit source job project leaves the workspace");
    this.directory = join(this.root, ".editkin-kit-sources", "jobs");
    mkdirSync(this.directory, { recursive: true });
    if (!within(this.root, realpathSync(this.directory))) throw Error("Kit source job directory leaves the workspace");
  }

  private path(id: string) {
    if (!idPattern.test(id)) throw Error("Invalid Kit source preparation ID");
    return join(this.directory, `${id}.json`);
  }
  private cancelPath(id: string) { return join(this.directory, `${id}.cancel`); }
  private currentPath() { return join(this.directory, "current.json"); }
  private saveCurrent(id: string) {
    const path = this.currentPath(), temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ id })}\n`, { flag: "wx" });
    try { renameSync(temporary, path); } finally { rmSync(temporary, { force: true }); }
  }
  private save(job: Job) {
    job.updatedAt = new Date().toISOString();
    const path = this.path(job.id), temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(job)}\n`, { flag: "wx" });
    try { renameSync(temporary, path); } finally { rmSync(temporary, { force: true }); }
    this.lastWrite.set(job.id, Date.now());
  }
  private get(id: string): Job {
    const current = this.jobs.get(id);
    if (current && current.ownerPid === process.pid) return current;
    const path = this.path(id);
    if (!existsSync(path) || statSync(path).size > 1024 * 1024) throw Error("Kit source preparation was not found");
    if (!within(this.directory, realpathSync(path))) throw Error("Kit source preparation leaves the workspace");
    const job = JSON.parse(readFileSync(path, "utf8")) as Job;
    if (job.schema !== "editkin.kit-source-job/v1" || job.id !== id || job.project !== this.project
      || !Number.isSafeInteger(job.ownerPid) || job.ownerPid < 1 || !/^[a-f0-9]{64}$/.test(job.requestKey)
      || !Array.isArray(job.sources) || !job.input || typeof job.input !== "object") throw Error("Kit source preparation record is invalid");
    if (activeStatuses.has(job.status) && job.ownerPid !== process.pid) {
      try { process.kill(job.ownerPid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") job.status = job.status === "CREATING" ? "UNCERTAIN" : "INTERRUPTED"; else throw error; }
    }
    this.jobs.set(id, job);
    return job;
  }
  status(id: string) { return publicStatus(this.get(id)); }

  start(input: Record<string, unknown>, sources: SourceFact[]) {
    const serialized = JSON.stringify(input);
    if (Buffer.byteLength(serialized) > 64 * 1024 || sources.length < 1 || sources.length > 32) throw Error("Kit source preparation input is invalid");
    const requestKey = createHash("sha256").update(serialized).digest("hex");
    const currentProjectSha = projectHash(this.project);
    if (existsSync(this.currentPath())) {
      if (!within(this.directory, realpathSync(this.currentPath())) || statSync(this.currentPath()).size > 1024) throw Error("Kit source job pointer is invalid");
      const pointer = JSON.parse(readFileSync(this.currentPath(), "utf8")) as { id?: string };
      const job = this.get(String(pointer.id || ""));
      const sameSources = JSON.stringify(job.sources) === JSON.stringify(sources);
      const sameProject = job.projectSha256 === currentProjectSha;
      if (activeStatuses.has(job.status) || job.status === "INTERRUPTED" || job.status === "UNCERTAIN" || job.status === "COMPLETED") {
        if (job.requestKey === requestKey && sameSources && sameProject) return publicStatus(job);
        if (job.status !== "COMPLETED")
          throw Error("A Kit source preparation needs inspection or completion before creating another run");
        if (input.runId && input.runId === job.input.runId) throw Error("This Kit runId already belongs to a completed preparation");
      }
    }
    const id = randomUUID();
    const job: Job = { schema: "editkin.kit-source-job/v1", id, project: this.project, projectSha256: currentProjectSha, ownerPid: process.pid, requestKey,
      sources, input: { ...input, runId: input.runId || `kit-source-${id}` }, status: "PREPARING", updatedAt: "" };
    this.jobs.set(id, job);
    this.save(job);
    this.saveCurrent(id);
    this.run(job);
    return publicStatus(job);
  }
  private run(job: Job) {
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    const checkCancel = () => { if (existsSync(this.cancelPath(job.id))) controller.abort(); controller.signal.throwIfAborted(); };
    void (async () => {
      try {
        checkCancel();
        if (projectHash(this.project) !== job.projectSha256) throw Error("Project changed since source preparation started");
        for (const source of job.sources) {
          const path = realpathSync(source.path), facts = statSync(path);
          if (path !== source.path || facts.size !== source.bytes || facts.mtimeMs !== source.mtimeMs)
            throw Error("External source changed since preparation started");
        }
        const result = await this.execute(job.input, { signal: controller.signal,
          onProgress: progress => {
            job.progress = progress;
            if (Date.now() - (this.lastWrite.get(job.id) || 0) >= 500) this.save(job);
            checkCancel();
          },
          onControllerStart: () => { checkCancel(); job.status = "CREATING"; this.save(job); checkCancel(); } });
        job.result = result;
        job.status = "COMPLETED";
      } catch (error) {
        job.status = controller.signal.aborted ? "CANCELLED" : job.status === "CREATING" ? "UNCERTAIN" : "FAILED";
        job.error = error instanceof Error ? error.message.slice(0, 1200) : String(error).slice(0, 1200);
      } finally { this.controllers.delete(job.id); rmSync(this.cancelPath(job.id), { force: true }); this.save(job); }
    })();
  }
  cancel(id: string) {
    const job = this.get(id);
    if (job.status === "CREATING" || job.status === "UNCERTAIN") throw Error("Kit controller may already have created a run; inspect its runId before retrying");
    if (job.status === "PREPARING") {
      if (job.ownerPid !== process.pid) throw Error("Source preparation is active in another Agent session");
      job.status = "CANCELLING";
      this.save(job);
      this.controllers.get(id)?.abort();
    }
    return publicStatus(job);
  }
  resume(id: string) {
    const job = this.get(id);
    if (existsSync(this.currentPath()) && JSON.parse(readFileSync(this.currentPath(), "utf8")).id !== id)
      throw Error("A newer Kit source preparation exists for this project");
    if (job.status !== "INTERRUPTED" && job.status !== "FAILED" && job.status !== "CANCELLED")
      throw Error("Only interrupted, failed or cancelled source preparation can resume");
    if (projectHash(this.project) !== job.projectSha256) throw Error("Project changed; create a new source preparation");
    for (const source of job.sources) {
      const path = realpathSync(source.path), facts = statSync(path);
      if (path !== source.path || facts.size !== source.bytes || facts.mtimeMs !== source.mtimeMs)
        throw Error("External source changed; create a new source preparation");
    }
    job.ownerPid = process.pid;
    job.status = "PREPARING";
    job.error = undefined;
    rmSync(this.cancelPath(job.id), { force: true });
    this.save(job);
    this.run(job);
    return publicStatus(job);
  }
  interrupt() {
    for (const controller of this.controllers.values()) controller.abort();
  }
}
