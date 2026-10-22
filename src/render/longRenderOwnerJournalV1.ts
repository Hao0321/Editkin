// Exact-path owner journal for LONG renders (design C2; LV-05). Append-only JSONL in the LONG work root.
// Cleanup deletes only journaled paths: absolute, no link/junction in the ancestry, same dev/ino as recorded,
// owned directories carry this run's owner record and are removed bottom-up without following any link.
// Deletion retries until policy.releaseMs; whatever is left stays journaled with a reason. At service start,
// journals whose owner process is dead are replayed through the same checks (never a pattern sweep).
import { appendFile, lstat, mkdir, readdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { hostname as osHostname, tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import type { LongJournalCleanupReceiptV1, LongRenderJournalRecordV1, LongRenderOwnerJournalHandleV1 } from "./longRenderContractsV1";

export const LONG_RENDER_JOURNAL_ROOT_ENV = "EDITKIN_LONG_RENDER_JOURNAL_ROOT";
export const LONG_RENDER_OWNER_FILE = ".editkin-long-owner.json";
const OWNER_SCHEMA = "editkin.long-render-owner/v1";
const POINTER_SCHEMA = "editkin.long-render-journal-pointer/v1";
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const MAX_TREE_ENTRIES = 200_000;
const DIRECTORY_KINDS = new Set<LongRenderJournalRecordV1["kind"]>(["run-work-dir", "output-staging-dir", "dir"]);
const OWNED_DIRECTORY_KINDS = new Set<LongRenderJournalRecordV1["kind"]>(["run-work-dir", "output-staging-dir"]);

export function longRenderJournalRegistryRootV1(configured?: string): string {
  const value = configured?.trim() || process.env[LONG_RENDER_JOURNAL_ROOT_ENV]?.trim();
  return value && isAbsolute(value) ? resolve(value) : join(tmpdir(), "editkin-long-render-journals");
}

function defaultProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

const sameText = (left: string, right: string) => process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;

/** Absolute, normalized, and every existing ancestor a real directory (no link or junction). */
async function ancestryProblem(path: string): Promise<string | undefined> {
  if (!isAbsolute(path) || resolve(path) !== path) return "path is not absolute and normalized";
  const root = parse(path).root;
  const parts: string[] = [];
  for (let current = dirname(path); ; current = dirname(current)) {
    parts.unshift(current);
    if (current === root || dirname(current) === current) break;
  }
  for (const ancestor of parts) {
    let info;
    try { info = await lstat(ancestor); } catch (error) { return `ancestor ${ancestor} unreadable: ${(error as NodeJS.ErrnoException).code ?? String(error)}`; }
    if (info.isSymbolicLink()) return `ancestor ${ancestor} is a link or junction`;
    if (!info.isDirectory()) return `ancestor ${ancestor} is not a directory`;
  }
  return undefined;
}

async function identity(path: string): Promise<{ dev: string; ino: string } | undefined> {
  try { const info = await lstat(path, { bigint: true }); return { dev: info.dev.toString(), ino: info.ino.toString() }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** Creates an owned directory with this run's owner record (fails if it exists). */
export async function createOwnedDirectoryV1(path: string, runId: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await mkdir(path);
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`owned directory ${path} is not a real directory`);
  await writeFile(join(path, LONG_RENDER_OWNER_FILE), `${JSON.stringify({ schema: OWNER_SCHEMA, runId, pid: process.pid, host: osHostname(), createdAt: new Date().toISOString() })}\n`, { flag: "wx" });
}

async function ownerState(directory: string, runId: string): Promise<"match" | "missing" | "foreign"> {
  const path = join(directory, LONG_RENDER_OWNER_FILE);
  let info;
  try { info = await lstat(path); } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "foreign"; }
  try {
    if (!info.isFile() || info.size > 4096) return "foreign";
    const value = JSON.parse(await readFile(path, "utf8")) as { schema?: unknown; runId?: unknown };
    return value.schema === OWNER_SCHEMA && value.runId === runId ? "match" : "foreign";
  } catch { return "foreign"; }
}

/**
 * Removes a directory tree bottom-up; refuses (and leaves untouched) any link, junction or special file inside.
 * The root's owner record goes last, so a removal interrupted by a busy file keeps the proof of ownership.
 */
async function removeTreeNoFollow(root: string): Promise<void> {
  const files: string[] = [], directories: string[] = [];
  const pending = [root];
  while (pending.length) {
    const path = pending.pop()!, info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`link or junction inside owned directory: ${path}`);
    if (directories.length + files.length > MAX_TREE_ENTRIES) throw new Error(`owned directory holds more than ${MAX_TREE_ENTRIES} entries`);
    if (info.isDirectory()) { directories.push(path); for (const name of await readdir(path)) pending.push(join(path, name)); }
    else if (info.isFile()) files.push(path);
    else throw new Error(`special file inside owned directory: ${path}`);
  }
  const ownerFile = join(root, LONG_RENDER_OWNER_FILE);
  const removeFile = async (file: string) => { const info = await lstat(file); if (!info.isFile()) throw new Error(`entry changed during removal: ${file}`); await unlink(file); };
  const removeDirectory = async (directory: string) => { const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`entry changed during removal: ${directory}`); await rmdir(directory); };
  for (const file of files) if (file !== ownerFile) await removeFile(file);
  const nested = directories.slice(1).reverse();
  for (const directory of nested) await removeDirectory(directory);
  if (files.includes(ownerFile)) await removeFile(ownerFile);
  await removeDirectory(root);
}

export type RemovalOutcomeV1 = { status: "removed" | "missing" } | { status: "leftover"; reason: string; retryable: boolean };

/** One journaled path through every exact-path check. Never follows a link; never removes a path whose identity changed. */
export async function removeJournaledPathV1(record: Pick<LongRenderJournalRecordV1, "path" | "kind" | "dev" | "ino" | "runId">): Promise<RemovalOutcomeV1> {
  const problem = await ancestryProblem(record.path);
  if (problem) return { status: "leftover", reason: problem, retryable: false };
  let info;
  try { info = await lstat(record.path, { bigint: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return { status: "leftover", reason: `lstat failed: ${(error as NodeJS.ErrnoException).code ?? String(error)}`, retryable: true };
  }
  if (info.isSymbolicLink()) return { status: "leftover", reason: "journaled path is now a link or junction", retryable: false };
  if (record.dev !== undefined && record.ino !== undefined && (info.dev.toString() !== record.dev || info.ino.toString() !== record.ino)) {
    return { status: "leftover", reason: "identity changed since it was journaled (dev/ino)", retryable: false };
  }
  try {
    if (DIRECTORY_KINDS.has(record.kind)) {
      if (!info.isDirectory()) return { status: "leftover", reason: "journaled directory is not a directory", retryable: false };
      if (OWNED_DIRECTORY_KINDS.has(record.kind)) {
        // A missing owner record (e.g. removed by an earlier interrupted pass of an older build) is accepted only when the
        // journaled dev/ino identity matched above; a foreign record or an unidentified directory is never removed.
        const owner = await ownerState(record.path, record.runId);
        if (owner === "foreign" || (owner === "missing" && (record.dev === undefined || record.ino === undefined))) {
          return { status: "leftover", reason: "owner record missing or for another run", retryable: false };
        }
        await removeTreeNoFollow(record.path);
      }
      else await rmdir(record.path);
    } else {
      if (!info.isFile()) return { status: "leftover", reason: "journaled file is not a regular file", retryable: false };
      await unlink(record.path);
    }
    return { status: "removed" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { status: "leftover", reason: `${code ?? "error"}: ${error instanceof Error ? error.message : String(error)}`, retryable: code === "EBUSY" || code === "EPERM" || code === "EACCES" || code === "ENOTEMPTY" };
  }
}

function liveRecords(records: readonly LongRenderJournalRecordV1[]): LongRenderJournalRecordV1[] {
  const live = new Map<string, LongRenderJournalRecordV1>();
  for (const record of records) {
    const key = process.platform === "win32" ? record.path.toLowerCase() : record.path;
    if (record.action === "create") live.set(key, record);
    else if (record.action === "remove") live.delete(key);
  }
  return [...live.values()].reverse();
}

async function readJournal(path: string): Promise<LongRenderJournalRecordV1[]> {
  const info = await lstat(path);
  if (!info.isFile() || info.size > MAX_JOURNAL_BYTES) throw new Error(`journal ${path} is not a bounded regular file`);
  const records: LongRenderJournalRecordV1[] = [];
  for (const line of (await readFile(path, "utf8")).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as LongRenderJournalRecordV1;
      if (value.schema === "editkin.long-render-journal/v1" && typeof value.path === "string" && typeof value.runId === "string") records.push(value);
    } catch { /* a torn final line after a crash is ignored */ }
  }
  return records;
}

export interface LongRenderOwnerJournalV1 extends LongRenderOwnerJournalHandleV1 {
  readonly pointerPath: string;
  /** Deletes every live journaled path (newest first), retrying until `releaseMs`; then removes journal and pointer if nothing is left. */
  cleanup(options: { releaseMs: number; retryDelayMs?: number }): Promise<LongJournalCleanupReceiptV1>;
}

export async function openLongRenderJournalV1(input: { workRoot: string; runId: string; registryRoot?: string }): Promise<LongRenderOwnerJournalV1> {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(input.runId)) throw new Error("invalid long-render run id");
  const host = osHostname();
  const path = join(resolve(input.workRoot), `editkin-long-journal-${input.runId}.jsonl`);
  const registry = longRenderJournalRegistryRootV1(input.registryRoot);
  const pointerPath = join(registry, `${input.runId}.json`);
  const records: LongRenderJournalRecordV1[] = [];
  const line = async (record: Omit<LongRenderJournalRecordV1, "schema" | "runId" | "pid" | "host" | "at">) => {
    const full: LongRenderJournalRecordV1 = { schema: "editkin.long-render-journal/v1", runId: input.runId, pid: process.pid, host, at: new Date().toISOString(), ...record };
    await appendFile(path, `${JSON.stringify(full)}\n`, "utf8");
    records.push(full);
  };
  await writeFile(path, "", { flag: "wx" });
  const journalIdentity = await identity(path);
  await line({ action: "open", path, kind: "journal", ...journalIdentity });
  await mkdir(registry, { recursive: true });
  await writeFile(pointerPath, `${JSON.stringify({ schema: POINTER_SCHEMA, runId: input.runId, journalPath: path, pid: process.pid, host, createdAt: new Date().toISOString() })}\n`, { flag: "wx" });
  return {
    runId: input.runId, path, pointerPath,
    async recordCreated(target: string, kind: LongRenderJournalRecordV1["kind"]) {
      const value = await identity(resolve(target));
      if (!value) throw new Error(`cannot journal a path that does not exist: ${target}`);
      await line({ action: "create", path: resolve(target), kind, ...value });
    },
    async recordRemoved(target: string, reason: string) { await line({ action: "remove", path: resolve(target), kind: "file", reason }); },
    live() { return liveRecords(records); },
    async cleanup(options) {
      const started = performance.now(), removed: string[] = [];
      let attempts = 0, leftovers: Array<{ path: string; reason: string }> = [];
      let remaining = liveRecords(records);
      for (;;) {
        attempts += 1; leftovers = [];
        const retry: LongRenderJournalRecordV1[] = [];
        for (const record of remaining) {
          const outcome = await removeJournaledPathV1(record);
          if (outcome.status === "leftover") { leftovers.push({ path: record.path, reason: outcome.reason }); if (outcome.retryable) retry.push(record); continue; }
          if (outcome.status === "removed") removed.push(record.path);
          await line({ action: "remove", path: record.path, kind: record.kind, reason: outcome.status });
        }
        remaining = retry;
        if (!retry.length || performance.now() - started >= options.releaseMs) break;
        await new Promise(done => setTimeout(done, options.retryDelayMs ?? 250));
      }
      for (const leftover of leftovers) await line({ action: "leftover", path: leftover.path, kind: "file", reason: leftover.reason }).catch(() => undefined);
      if (!leftovers.length) {
        await unlink(path).catch(() => undefined);
        await unlink(pointerPath).catch(() => undefined);
      }
      return { schema: "editkin.long-render-cleanup/v1", removed, leftovers, elapsedMs: Math.round(performance.now() - started), attempts };
    },
  };
}

export interface LongJournalReplayReceiptV1 {
  schema: "editkin.long-render-journal-replay/v1";
  journals: number;
  skippedLive: number;
  skippedForeign: number;
  removed: string[];
  leftovers: Array<{ path: string; reason: string }>;
  failures: Array<{ path: string; error: string }>;
}

/** Service start: replays journals whose owner process on this host is gone; exact journaled paths only. */
export async function replayLongRenderJournalsV1(input: { registryRoot?: string; isProcessAlive?: (pid: number) => boolean; hostname?: string;
  /** A just-terminated owner may still hold handles (or a scanner may hold the new file): retry retryable removals this long. */
  retryMs?: number } = {}): Promise<LongJournalReplayReceiptV1> {
  const registry = longRenderJournalRegistryRootV1(input.registryRoot);
  const alive = input.isProcessAlive ?? defaultProcessAlive, host = input.hostname ?? osHostname();
  const receipt: LongJournalReplayReceiptV1 = { schema: "editkin.long-render-journal-replay/v1", journals: 0, skippedLive: 0, skippedForeign: 0, removed: [], leftovers: [], failures: [] };
  let names: string[];
  try {
    const info = await lstat(registry);
    if (!info.isDirectory() || info.isSymbolicLink()) return receipt;
    names = await readdir(registry);
  } catch { return receipt; }
  for (const name of names.filter(candidate => /^[A-Za-z0-9-]{8,64}\.json$/.test(candidate)).slice(0, 1000)) {
    const pointerPath = join(registry, name);
    try {
      const pointerInfo = await lstat(pointerPath);
      if (!pointerInfo.isFile() || pointerInfo.size > 4096) continue;
      const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as { schema?: unknown; runId?: unknown; journalPath?: unknown; pid?: unknown; host?: unknown };
      if (pointer.schema !== POINTER_SCHEMA || typeof pointer.runId !== "string" || typeof pointer.journalPath !== "string" || !Number.isSafeInteger(pointer.pid) || typeof pointer.host !== "string") continue;
      if (!sameText(pointer.host, host)) { receipt.skippedForeign += 1; continue; }
      if ((pointer.pid as number) === process.pid || alive(pointer.pid as number)) { receipt.skippedLive += 1; continue; }
      receipt.journals += 1;
      let records: LongRenderJournalRecordV1[] = [];
      try { records = (await readJournal(pointer.journalPath)).filter(record => record.runId === pointer.runId); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      let leftover = false;
      let pendingRecords = liveRecords(records);
      const started = performance.now();
      for (;;) {
        const retry: LongRenderJournalRecordV1[] = [];
        const reasons = new Map<string, string>();
        for (const record of pendingRecords) {
          const outcome = await removeJournaledPathV1(record);
          if (outcome.status === "leftover") { reasons.set(record.path, outcome.reason); if (outcome.retryable) retry.push(record); else { leftover = true; receipt.leftovers.push({ path: record.path, reason: outcome.reason }); } continue; }
          if (outcome.status === "removed") receipt.removed.push(record.path);
          await appendFile(pointer.journalPath, `${JSON.stringify({ ...record, action: "remove", at: new Date().toISOString(), pid: process.pid, reason: `replay:${outcome.status}` })}\n`).catch(() => undefined);
        }
        pendingRecords = retry;
        if (!retry.length) break;
        if (performance.now() - started >= (input.retryMs ?? 10_000)) {
          leftover = true;
          for (const record of retry) receipt.leftovers.push({ path: record.path, reason: reasons.get(record.path) ?? "retry window elapsed" });
          break;
        }
        await new Promise(done => setTimeout(done, 250));
      }
      if (!leftover) {
        const journalOutcome = records.length ? await removeJournaledPathV1({ path: pointer.journalPath, kind: "journal", runId: pointer.runId,
          dev: records[0].dev, ino: records[0].ino }) : { status: "missing" as const };
        if (journalOutcome.status !== "leftover") await unlink(pointerPath).catch(() => undefined);
        else receipt.leftovers.push({ path: pointer.journalPath, reason: journalOutcome.reason });
      }
    } catch (error) {
      receipt.failures.push({ path: pointerPath, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return receipt;
}
