import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateProject, validateProject } from "../domain/editGraph";
import { projectSchema } from "../domain/schema";
import type { EditProject } from "../domain/types";
import { resolveAestheticSystem } from "./editkinAesthetic";
import { dehydrateAutoRotoFramePreviews } from "../domain/autoRotoPreviewProjection";

export class ProjectRevisionConflictError extends Error {
  constructor(expected: number, actual: number) {
    super(`專案已被其他視窗或 Agent 更新（目前 revision ${actual}，你的版本 ${expected}）；請重新開啟後再套用修改。`);
    this.name = "ProjectRevisionConflictError";
  }
}

export function parseProject(input: unknown): EditProject {
  const project = dehydrateAutoRotoFramePreviews(validateProject(projectSchema.parse(migrateProject(input))));
  project.aestheticSystem ??= resolveAestheticSystem(project.editorialProfile, project.width > project.height ? "longform" : "shorts");
  return validateProject(project);
}

function previousPath(path: string): string { return `${path}.previous`; }
function lockPath(path: string): string { return `${path}.lock`; }

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function readCandidate(path: string): Promise<EditProject | undefined> {
  if (!await exists(path)) return undefined;
  return parseProject(JSON.parse(await readFile(path, "utf8")));
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

export async function acquireProjectLock(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });
  const target = lockPath(path);
  const retry = () => new Promise<void>(resolvePromise => setTimeout(resolvePromise, 20));
  // A permanent directory prevents old file-lock writers from acquiring this
  // path or removing it with their nonrecursive unlink. Never expire/delete it:
  // the actual ownership below is an OS lock, not the directory's existence.
  for (let attempt = 0; attempt < 50; attempt += 1) {
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
      if (attempt === 49) throw new Error("專案留有舊版儲存鎖，暫不覆寫。請等其他視窗或 Agent 完成；若先前程式已異常關閉，請用「另存新檔」保留修改。");
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
  const database = new DatabaseSync(databasePath, { allowExtension: false });
  try {
    database.exec("PRAGMA busy_timeout = 0");
    for (let attempt = 0; attempt < 50; attempt += 1) {
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
        if (attempt === 49) throw new Error("專案正在由另一個 Editkin 視窗或 Agent 儲存，請稍後再試。");
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

async function writeSynced(path: string, text: string): Promise<void> {
  const handle = await open(path, "wx");
  try { await handle.writeFile(text, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
}

export async function writeProjectFileAtomic(
  path: string,
  project: EditProject,
  expectedRevision: number | null = project.revision,
  options: { createOnly?: boolean } = {},
): Promise<EditProject> {
  const valid = parseProject(project);
  const release = await acquireProjectLock(path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const backup = previousPath(path);
  let movedCurrent = false;
  try {
    if (options.createOnly && (await exists(path) || await exists(backup))) throw new Error("專案已存在；拒絕覆蓋既有或可復原的剪輯");
    let current: EditProject | undefined;
    try { current = await readProjectFile(path); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") current = undefined;
      else if (!await exists(backup)) throw error;
    }
    const actualRevision = current?.revision ?? 0;
    if (expectedRevision !== null && actualRevision !== expectedRevision) {
      throw new ProjectRevisionConflictError(expectedRevision, actualRevision);
    }
    const saved: EditProject = {
      ...valid,
      revision: expectedRevision === null ? Math.max(actualRevision, valid.revision) + 1 : actualRevision + 1,
      updatedAt: new Date().toISOString(),
    };
    await writeSynced(temporary, `${JSON.stringify(saved, null, 2)}\n`);
    if (await exists(path)) {
      let primaryValid = false;
      try { primaryValid = Boolean(await readCandidate(path)); } catch { /* preserve corrupt bytes separately */ }
      if (primaryValid) {
        await rm(backup, { force: true });
        await rename(path, backup);
        movedCurrent = true;
      } else {
        await rename(path, `${path}.corrupt-${Date.now()}`);
      }
    }
    await rename(temporary, path);
    return saved;
  } catch (error) {
    if (movedCurrent && !await exists(path) && await exists(backup)) await rename(backup, path);
    throw error;
  } finally {
    try { await rm(temporary, { force: true }); }
    finally { await release(); }
  }
}
