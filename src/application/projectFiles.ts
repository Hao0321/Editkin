import { assertProjectRetentionBudgetV1 } from "./projectRetentionBudgetV1";
import type { RetainedProjectV1 } from "../domain/projectSaveRetentionV1";
import { createHash, randomUUID } from "node:crypto";
import { isProjectFileIdentityV1, sameProjectFileIdentityV1, type ProjectFileIdentityV1 } from "../domain/projectFileIdentityV1";
import { access, link, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join, toNamespacedPath } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EditProject } from "../domain/types";
import { readBoundedFile } from "../shared/boundedFile";
import { parseProject, PROJECT_MAX_BYTES } from "./projectCodec";
export { parseProject, PROJECT_MAX_BYTES } from "./projectCodec";

const ownedRetainedProjectErrors = new WeakMap<object, Readonly<RetainedProjectV1>>();
/** Only errors registered after this writer fsyncs its own retained buffer qualify. */
export function retainedProjectForSaveErrorV1(error: unknown): Readonly<RetainedProjectV1> | undefined {
  return error !== null && (typeof error === "object" || typeof error === "function") ? ownedRetainedProjectErrors.get(error as object) : undefined;
}

export class ProjectRevisionConflictError extends Error {
  constructor(expected: number, actual: number) {
    super(`專案已被其他視窗或 Agent 更新（目前 revision ${actual}，你的版本 ${expected}）；請重新開啟後再套用修改。`);
    this.name = "ProjectRevisionConflictError";
  }
}

export class ProjectIdentityConflictError extends Error {
  constructor() {
    super("專案已被其他視窗或 Agent 更新成另一個專案；拒絕覆寫，請重新開啟或另存新檔。");
    this.name = "ProjectIdentityConflictError";
  }
}

function previousPath(path: string): string { return `${path}.previous`; }
function lockPath(path: string): string { return `${path}.lock`; }

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

/** Reads a user-selected project file, refusing one larger than `maxBytes` before it is buffered. */
export async function readProjectText(path: string, maxBytes = PROJECT_MAX_BYTES): Promise<string> {
  return (await readBoundedFile(path, maxBytes, {
    // Preserve the existing user-selected project symlink behavior.
    followSymlinks: true,
    messages: {
      notRegular: `專案路徑不是一般檔案：${path}`,
      tooLarge: `專案檔超過 ${Math.floor(maxBytes / 1024 / 1024)} MiB 上限，拒絕讀取`,
      changed: "專案檔在讀取時變動，拒絕讀取",
    },
  })).toString("utf8");
}

async function readCandidate(path: string): Promise<EditProject | undefined> {
  if (!await exists(path)) return undefined;
  return parseProject(JSON.parse(await readProjectText(path)));
}

export async function readProjectFile(path: string): Promise<EditProject> {
  try {
    const primary = await readCandidate(path);
    if (primary) return primary;
    const previous = await readCandidate(previousPath(path));
    if (previous) return previous;
    throw Object.assign(new Error(`找不到專案：${path}`), { code: "ENOENT" });
  } catch (primaryError) {
    try {
      const recovered = await readCandidate(previousPath(path));
      if (recovered) return recovered;
    } catch { /* report the primary corruption below */ }
    throw primaryError;
  }
}

export class ProjectLockBusyError extends Error {
  constructor(message: string) { super(message); this.name = "ProjectLockBusyError"; }
}

export async function acquireProjectLock(path: string, options: { maximumAttempts?: number } = {}): Promise<() => Promise<void>> {
  const maximumAttempts = options.maximumAttempts ?? 50;
  if (!Number.isInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 50) throw new RangeError("Project lock attempts must be 1–50");
  await mkdir(dirname(path), { recursive: true });
  const target = lockPath(path);
  const retry = () => new Promise<void>(resolvePromise => setTimeout(resolvePromise, 20));
  // A permanent directory prevents old file-lock writers from acquiring this
  // path or removing it with their nonrecursive unlink. Never expire/delete it:
  // the actual ownership below is an OS lock, not the directory's existence.
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    try {
      await mkdir(target);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let entry;
      try { entry = await lstat(target); }
      catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException).code === "ENOENT") { await retry(); continue; }
        throw inspectionError;
      }
      if (entry.isSymbolicLink()) throw new Error("專案儲存鎖不可使用連結路徑，請另存新檔。");
      if (entry.isDirectory()) break;
      // Unknown/live legacy locks are never stolen. New-protocol crashes leave
      // a reusable directory, not a PID marker that requires this migration.
      if (attempt === maximumAttempts - 1) throw new ProjectLockBusyError("專案留有舊版儲存鎖，暫不覆寫。請等其他視窗或 Agent 完成；若先前程式已異常關閉，請用「另存新檔」保留修改。");
      await retry();
    }
  }
  const databasePath = join(target, "lease.sqlite");
  try {
    const entry = await lstat(databasePath);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("專案儲存鎖檔案無效，請另存新檔。");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // node:sqlite is already in the bundled Node runtime. No helper process owns
  // the lease on our behalf: the process doing the writes owns the OS handle.
  // No project data or user SQL is stored here; extensions remain disabled.
  // Preserve the same lease inode/OS lock; only Windows filename spelling changes.
  const sqlitePath = process.platform === "win32" ? toNamespacedPath(databasePath) : databasePath;
  const database = new DatabaseSync(sqlitePath, { allowExtension: false });
  try {
    database.exec("PRAGMA busy_timeout = 0");
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      try {
        database.exec("BEGIN IMMEDIATE");
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          try { database.exec("ROLLBACK"); }
          finally { database.close(); }
        };
      } catch (error) {
        const sqliteCode = Number((error as { errcode?: number }).errcode) & 0xff;
        if (sqliteCode !== 5 && sqliteCode !== 6) throw error; // SQLITE_BUSY / SQLITE_LOCKED only.
        if (attempt === maximumAttempts - 1) throw new ProjectLockBusyError("專案正在由另一個 Editkin 視窗或 Agent 儲存，請稍後再試。");
        // SQLite's blocking busy timeout would stall the service event loop.
        await retry();
      }
    }
    throw new Error("無法取得專案儲存鎖");
  } catch (error) {
    database.close();
    throw error;
  }
}

async function writeSynced(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, "wx");
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}

export async function writeProjectFileAtomicWithIdentityV1(
  path: string,
  project: EditProject,
  expectedRevision: number | null = project.revision,
  options: { createOnly?: boolean; beforeCommit?: () => Promise<void>; expectedFileIdentity?: ProjectFileIdentityV1 } = {},
): Promise<{ project: EditProject; fileIdentity: ProjectFileIdentityV1 }> {
  const valid = parseProject(project);
  const expectedFileIdentity = options.expectedFileIdentity === undefined ? undefined : requireProjectFileIdentityV1(options.expectedFileIdentity);
  const release = await acquireProjectLock(path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const backup = previousPath(path);
  const heldCurrent = `${path}.retained-current-${randomUUID()}.json`;
  const heldBackup = `${path}.retained-previous-${randomUUID()}.json`;
  const rollbackBackup = `${path}.retained-rollback-${randomUUID()}.json`;
  const unsaved = `${path}.retained-unsaved-${randomUUID()}.json`;
  let currentHeld = false, backupHeld = false, installedBackup = false, committed = false;
  let restoredCurrent = false, restoredBackup = false, retainTemporary = false, race = false;
  let stagedBytes: Uint8Array | undefined;
  let stagedIdentity: ProjectFileIdentityV1 | undefined, retainedReady = false;
  let primaryProof: ProjectFileIdentityV1 | undefined, backupProof: ProjectFileIdentityV1 | undefined;
  const probe = async (target: string) => {
    try { return (await readPrimaryProjectFileWithIdentityV1(target)).fileIdentity; }
    catch { return undefined; } // unknown/corrupt bytes are retained, never declared disposable.
  };
  const noReplace = async (from: string, to: string): Promise<boolean> => {
    try { await link(from, to); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
  };
  const conflict = () => { race = true; return new ProjectFileContentConflictError(); };
  try {
    if (options.createOnly && (await exists(path) || await exists(backup))) throw new Error("專案已存在；拒絕覆蓋既有或可復原的剪輯");
    let current: EditProject | undefined;
    try { current = await readProjectFile(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") current = undefined; else if (!await exists(backup)) throw error; }
    if (current && expectedRevision !== null && current.id !== valid.id) throw new ProjectIdentityConflictError();
    const actualRevision = current?.revision ?? 0;
    if (expectedRevision !== null && actualRevision !== expectedRevision) throw new ProjectRevisionConflictError(expectedRevision, actualRevision);
    if (expectedFileIdentity) await assertProjectFileIdentityV1(path, expectedFileIdentity);
    const saved: EditProject = { ...valid, revision: expectedRevision === null ? Math.max(actualRevision, valid.revision) + 1 : actualRevision + 1,
      updatedAt: new Date().toISOString() };
    const savedJson = `${JSON.stringify(saved, null, 2)}\n`;
    await assertProjectRetentionBudgetV1(path, Buffer.byteLength(savedJson, "utf8"));
    const savedBytes = Buffer.from(savedJson, "utf8");
    stagedBytes = savedBytes;
    const fileIdentity = identityForProjectBytesV1(savedBytes, saved);
    stagedIdentity = fileIdentity;
    await writeSynced(temporary, savedBytes);
    const primaryExisted = await exists(path), backupExisted = await exists(backup);
    backupProof = backupExisted ? await probe(backup) : undefined;
    await options.beforeCommit?.();
    primaryProof = expectedFileIdentity ? (await assertProjectFileIdentityV1(path, expectedFileIdentity)).fileIdentity : await probe(path);
    if (backupProof && !sameProjectFileIdentityV1(await probe(backup), backupProof)) throw conflict();
    if (!backupExisted && await exists(backup)) throw conflict();
    // Capture actual source bytes into a unique owned name before touching any
    // destination. An external replacement is captured, checked and retained.
    if (primaryExisted) {
      await rename(path, heldCurrent); currentHeld = true;
      const captured = await probe(heldCurrent);
      if (primaryProof ? !sameProjectFileIdentityV1(captured, primaryProof) : Boolean(captured)) throw conflict();
      if (primaryProof) {
        if (backupExisted) {
          await rename(backup, heldBackup); backupHeld = true;
          if (backupProof && !sameProjectFileIdentityV1(await probe(heldBackup), backupProof)) throw conflict();
        }
        if (!await noReplace(heldCurrent, backup)) throw conflict();
        installedBackup = true;
      }
    }
    // Unlike rename(), hard-link publication cannot replace a concurrently
    // installed primary. Never fall back to a replacing rename on any volume.
    if (!await noReplace(temporary, path)) throw conflict();
    committed = true;
    if (currentHeld && primaryProof) { try { await rm(heldCurrent, { force: true }); } catch { /* keep readable generation */ } }
    if (backupHeld && backupProof) { try { await rm(heldBackup, { force: true }); } catch { /* keep readable generation */ } }
    return { project: saved, fileIdentity };
  } catch (error) {
    race ||= error instanceof ProjectFileContentConflictError;
    const rollbackErrors: unknown[] = [];
    if (!committed) {
      if (currentHeld) {
        try { restoredCurrent = await noReplace(heldCurrent, path); if (!restoredCurrent) race = true; }
        catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (installedBackup) {
        try {
          // Capture first; never unlink/rename-over a public name after a check.
          // A newer external previous is retained rather than mistaken for ours.
          await rename(backup, rollbackBackup);
          const captured = await probe(rollbackBackup);
          if (!primaryProof || !sameProjectFileIdentityV1(captured, primaryProof)) race = true;
          if (!race && primaryProof) { try { await rm(rollbackBackup, { force: true }); } catch { /* keep copy */ } }
        } catch (rollbackError) { if ((rollbackError as NodeJS.ErrnoException).code === "ENOENT") race = true; else rollbackErrors.push(rollbackError); }
      }
      if (backupHeld) {
        try { restoredBackup = await noReplace(heldBackup, backup); if (!restoredBackup) race = true; }
        catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (!race) {
        if (restoredCurrent) { try { await rm(heldCurrent, { force: true }); } catch { /* keep copy */ } }
        if (restoredBackup) { try { await rm(heldBackup, { force: true }); } catch { /* keep copy */ } }
      }
    }
    // A retained unsaved project is written from the same staged buffer, never
    // reconstructed from a later pathname read or an older recovery cache.
    if (stagedBytes) {
      retainTemporary = true;
      try { await writeSynced(unsaved, stagedBytes); retainTemporary = false; retainedReady = true; }
      catch (retentionError) { rollbackErrors.push(retentionError); }
    }
    const preservedProjectPaths: string[] = [];
    for (const file of [path, backup, heldCurrent, heldBackup, rollbackBackup, unsaved, ...(retainTemporary ? [temporary] : [])]) {
      if (await exists(file)) preservedProjectPaths.push(file);
    }
    const remember = <T extends Error>(failure: T): T => {
      if (retainedReady && stagedIdentity) ownedRetainedProjectErrors.set(failure, Object.freeze({
        schema: "editkin.retained-project/v1", path: unsaved, fileIdentity: Object.freeze({ ...stagedIdentity }),
      }));
      return failure;
    };
    if (rollbackErrors.length) throw remember(Object.assign(new AggregateError([error, ...rollbackErrors], `專案儲存／回復未完成；保留的實際檔案：${preservedProjectPaths.join("、")}`), { preservedProjectPaths }));
    if (race) throw remember(new ProjectFileRaceConflictError(preservedProjectPaths, error));
    throw remember(Object.assign(error instanceof Error ? error : new Error(String(error)), { preservedProjectPaths }));
  } finally {
    try {
      if (!retainTemporary) {
        try { await rm(temporary, { force: true }); }
        catch (cleanupError) {
          // Preserve a pending save failure and its retained receipt. After a
          // successful publication, keep the existing cleanup-error contract.
          if (committed) throw cleanupError;
        }
      }
    } finally { await release(); }
  }
}

/** The existing API keeps its exact return shape; new bridges may opt into the receipt API. */
export async function writeProjectFileAtomic(
  path: string,
  project: EditProject,
  expectedRevision: number | null = project.revision,
  options: { createOnly?: boolean; beforeCommit?: () => Promise<void>; expectedFileIdentity?: ProjectFileIdentityV1 } = {},
): Promise<EditProject> {
  return (await writeProjectFileAtomicWithIdentityV1(path, project, expectedRevision, options)).project;
}

/** Sole bytes-to-identity builder. Never serialize an editor graph to infer file identity. */
function identityForProjectBytesV1(bytes: Uint8Array, project: EditProject): ProjectFileIdentityV1 {
  return { schema: "editkin.project-file-identity/v1", projectId: project.id,
    revision: project.revision, updatedAt: project.updatedAt,
    projectSha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
}

/** Exact current primary only: never silently identify a fallback .previous as the watched file. */
export async function readPrimaryProjectFileWithIdentityV1(path: string): Promise<{ project: EditProject; fileIdentity: ProjectFileIdentityV1 }> {
  const bytes = await readBoundedFile(path, PROJECT_MAX_BYTES, { followSymlinks: true });
  const project = parseProject(JSON.parse(bytes.toString("utf8")));
  return { project, fileIdentity: identityForProjectBytesV1(bytes, project) };
}

export class ProjectFileContentConflictError extends Error {
  constructor() { super("專案檔案內容已被其他視窗或 Agent 修改；拒絕覆寫，請重新開啟或另存新檔。"); this.name = "ProjectFileContentConflictError"; }
}
export function requireProjectFileIdentityV1(value: unknown): Readonly<ProjectFileIdentityV1> {
  if (!isProjectFileIdentityV1(value)) throw new Error("PROJECT_FILE_IDENTITY_REQUIRED_USE_SAVE_AS");
  return Object.freeze({ ...value });
}
/** The canonical primary reader and the same receipt rules serve save/verify/recovery. */
export async function assertProjectFileIdentityV1(path: string, expected: ProjectFileIdentityV1) {
  const required = requireProjectFileIdentityV1(expected);
  let observed;
  try { observed = await readPrimaryProjectFileWithIdentityV1(path); }
  catch { throw new ProjectFileContentConflictError(); }
  if (!sameProjectFileIdentityV1(observed.fileIdentity, required)) throw new ProjectFileContentConflictError();
  return observed;
}

export class ProjectFileRaceConflictError extends ProjectFileContentConflictError {
  readonly preservedProjectPaths: readonly string[];
  constructor(paths: string[], cause: unknown) {
    super(); this.name = "ProjectFileRaceConflictError";
    this.preservedProjectPaths = Object.freeze([...paths]);
    this.message += ` 已保留可讀回的實際版本：${paths.join("、")}`;
    Object.assign(this, { cause });
  }
}
