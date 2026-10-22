// Render work directories: where an export keeps its temporary files, and the only stale cleanup it may perform.
import { AsyncLocalStorage } from "node:async_hooks";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { hostname as osHostname, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve, toNamespacedPath } from "node:path";
import { LongRenderRefusalV1 } from "./longRenderContractsV1";
import { PendingNativeCloseError } from "../shared/pendingNativeClose";

/** Hidden folder created next to the requested output, so heavy temporary files stay on the output's drive. */
export const RENDER_WORK_ROOT_NAME = ".editkin-render-work";
/** Every work-directory prefix the render pipeline creates (each followed by mkdtemp's six random characters). */
export const RENDER_WORK_DIRECTORY_PREFIXES = [
  "editkin-render-",
  "editkin-aces2-sdr-",
  "editkin-resident-aces2-video-",
  "editkin-precomp-",
  "editkin-mesh3d-",
  "editkin-filtergraph-",
] as const;
export type RenderWorkDirectoryPrefix = typeof RENDER_WORK_DIRECTORY_PREFIXES[number];
/** Optional fixed location for render work directories (desktop service / MCP environment). */
export const RENDER_WORK_ROOT_ENV = "EDITKIN_RENDER_WORK_ROOT";

const OWNER_FILE = ".editkin-render-work-owner.json";
const OWNER_SCHEMA = "editkin.render-work-owner/v1";
/** A directory without an owner record was made by an older build, whose exports were capped at well under an hour. */
export const LEGACY_WORK_DIRECTORY_MIN_AGE_MS = 24 * 60 * 60_000;
/** Grace period before a directory whose recorded owner process has exited may be removed. */
export const ORPHANED_WORK_DIRECTORY_MIN_AGE_MS = 10 * 60_000;
/** Directories owned by another computer (shared drive) are only removed when untouched for a week. */
export const FOREIGN_WORK_DIRECTORY_MIN_AGE_MS = 7 * 24 * 60 * 60_000;

// Prefixes are plain [a-z0-9-] literals; the suffix is exactly mkdtemp's six [A-Za-z0-9] characters.
const WORK_DIRECTORY_PATTERN = new RegExp(`^(?:${RENDER_WORK_DIRECTORY_PREFIXES.join("|")})[A-Za-z0-9]{6}$`);
const workRootStorage = new AsyncLocalStorage<string>();
interface RenderWorkOwnerV1 { common: boolean; waitingForClose: boolean; cleanupFailure?: string; retirement?: Promise<void> }
const activeDirectories = new Map<string, RenderWorkOwnerV1>();
const COMMON_RENDER_WORK_LIMIT_V1 = 4;
let commonRenderReservationsV1 = 0;
const key = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);

/** Counts include admission before allocation and retained failed cleanup; no paths or growing history. */
export function renderWorkOwnershipSnapshotV1() {
  const common = [...activeDirectories.values()].filter(owner => owner.common);
  return { limit: COMMON_RENDER_WORK_LIMIT_V1, active: commonRenderReservationsV1,
    pendingClose: common.filter(owner => owner.waitingForClose).length,
    cleanupFailed: common.filter(owner => owner.cleanupFailure !== undefined).length,
    observations: common.flatMap(owner => owner.cleanupFailure === undefined ? [] : [owner.cleanupFailure]) };
}

export function assertRenderWorkDirectoryOwnedV1(directory: string): void {
  if (!activeDirectories.has(key(directory))) throw Error("RENDER_WORK_DIRECTORY_NOT_OWNED");
}

function observeWorkCleanupV1(owner: RenderWorkOwnerV1, error: unknown): void {
  let text: string;
  try { text = String(error); } catch { text = "Unprintable render cleanup error"; }
  owner.cleanupFailure = text.slice(0, 512);
}

/** Only an acknowledged close permits retirement. Earlier business errors keep their original identity. */
export async function finishRenderWorkDirectoryV1(directory: string, cleanup: () => Promise<void>, failed: boolean, primary?: unknown): Promise<void> {
  assertRenderWorkDirectoryOwnedV1(directory);
  const owner = activeDirectories.get(key(directory))!;
  const trackedCleanup = async () => {
    try { await cleanup(); }
    catch (error) { observeWorkCleanupV1(owner, error); throw error; }
  };
  if (failed && primary instanceof PendingNativeCloseError) {
    if (!owner.retirement) {
      owner.waitingForClose = true;
      owner.retirement = primary.closed.then(async () => {
        owner.waitingForClose = false;
        await trackedCleanup();
      }).catch(error => primary.observeFailure(error));
    }
    return;
  }
  try { await trackedCleanup(); }
  catch (error) { if (!failed) throw error; }
}

export function isRenderWorkDirectoryName(name: string): boolean {
  return WORK_DIRECTORY_PATTERN.test(name);
}

/** The work root selected for the current export, or undefined outside one (callers then use the OS temp directory). */
export function currentRenderWorkRoot(): string | undefined {
  return workRootStorage.getStore();
}

async function realDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function usableRoot(path: string): Promise<boolean> {
  try { await mkdir(path, { recursive: true }); } catch { return false; }
  // Never place work inside a junction/symlink that could point at another drive or folder.
  return realDirectory(path);
}

/**
 * Runs an export with its work directories on the output's drive: the configured root (option or
 * EDITKIN_RENDER_WORK_ROOT), else a hidden folder next to the output, else the OS temp directory. Stale directories
 * that this code itself created are cleaned from the selected dedicated root first; the OS temp directory is never
 * swept here (see sweepStaleRenderWorkDirectories at service startup).
 */
export async function withRenderWorkRoot<T>(outputPath: string, configuredRoot: string | undefined, operation: () => Promise<T>): Promise<T> {
  const configured = configuredRoot?.trim() || process.env[RENDER_WORK_ROOT_ENV]?.trim() || undefined;
  const besideOutput = join(dirname(resolve(outputPath)), RENDER_WORK_ROOT_NAME);
  const candidates = [
    ...(configured && isAbsolute(configured) ? [{ path: resolve(configured), dedicated: true, besideOutput: false }] : []),
    { path: besideOutput, dedicated: true, besideOutput: true },
  ];
  let selected: { path: string; dedicated: boolean; besideOutput: boolean } = { path: tmpdir(), dedicated: false, besideOutput: false };
  for (const candidate of candidates) {
    if (await usableRoot(candidate.path)) { selected = candidate; break; }
  }
  if (selected.dedicated) await sweepStaleRenderWorkDirectories([selected.path]).catch(() => undefined);
  try {
    return await workRootStorage.run(selected.path, operation);
  } finally {
    // Remove the hidden folder beside the output when nothing else is using it (rmdir refuses non-empty folders).
    if (selected.besideOutput) await rmdir(selected.path).catch(() => undefined);
  }
}

/**
 * Creates `<work root>/<prefix>XXXXXX` with an owner record (process id and computer name), so a later sweep can tell
 * a live export's directory from an orphaned one. Remove it with removeRenderWorkDirectory.
 */
export async function createRenderWorkDirectory(prefix: RenderWorkDirectoryPrefix): Promise<string> {
  if (!RENDER_WORK_DIRECTORY_PREFIXES.includes(prefix)) throw new Error(`Unknown render work directory prefix: ${prefix}`);
  const common = prefix === "editkin-render-";
  if (common && commonRenderReservationsV1 >= COMMON_RENDER_WORK_LIMIT_V1) {
    const failed = [...activeDirectories.values()].some(owner => owner.common && owner.cleanupFailure !== undefined);
    throw Error(failed ? "RENDER_WORK_CLEANUP_FAILED" : "RENDER_WORK_CLEANUP_BUSY");
  }
  if (common) commonRenderReservationsV1++;
  const root = currentRenderWorkRoot() ?? tmpdir();
  let directory: string;
  try {
    directory = await allocateRenderWorkDirectoryV1(root, prefix);
  } catch (error) {
    if (common) commonRenderReservationsV1--;
    throw error;
  }
  activeDirectories.set(key(directory), { common, waitingForClose: false });
  try {
    await writeFile(join(directory, OWNER_FILE), `${JSON.stringify({ schema: OWNER_SCHEMA, pid: process.pid, host: osHostname(), createdAt: new Date().toISOString() })}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    try { await removeRenderWorkDirectory(directory); } catch { /* failed cleanup keeps its reservation */ }
    throw error;
  }
  return directory;
}

async function allocateRenderWorkDirectoryV1(root: string, prefix: RenderWorkDirectoryPrefix): Promise<string> {
  const literalPrefix = join(root, prefix);
  const filesystemPrefix = process.platform === "win32" ? toNamespacedPath(literalPrefix) : literalPrefix;
  // Node's Windows mkdtemp needs the extended form for deep paths. Keep that API detail out of media paths.
  const allocate = async () => {
    const created = await mkdtemp(filesystemPrefix);
    return process.platform === "win32" ? join(root, basename(created)) : created;
  };
  try { return await allocate(); }
  catch (error) {
    // A finishing export may have just removed an empty hidden root; recreate it once.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(root, { recursive: true });
    return allocate();
  }
}

export async function removeRenderWorkDirectory(directory: string): Promise<void> {
  const owner = activeDirectories.get(key(directory));
  if (owner?.waitingForClose) throw Error("RENDER_WORK_CLOSE_PENDING");
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 2 });
  } catch (error) {
    if (owner) observeWorkCleanupV1(owner, error);
    throw error;
  }
  if (activeDirectories.delete(key(directory)) && owner?.common) commonRenderReservationsV1--;
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface OwnerRecord { pid: number; host: string }
async function readOwner(directory: string): Promise<OwnerRecord | undefined> {
  const path = join(directory, OWNER_FILE);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 4_096) return undefined;
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<OwnerRecord> & { schema?: unknown };
    if (value.schema !== OWNER_SCHEMA || !Number.isSafeInteger(value.pid) || (value.pid ?? 0) <= 0 || typeof value.host !== "string") return undefined;
    return { pid: value.pid!, host: value.host };
  } catch {
    return undefined;
  }
}

/** Newest modification time of the directory and its direct entries (a live export keeps touching them). */
async function newestActivityMs(directory: string): Promise<number> {
  let newest = (await lstat(directory)).mtimeMs;
  for (const name of await readdir(directory)) {
    try { newest = Math.max(newest, (await lstat(join(directory, name))).mtimeMs); } catch { /* removed meanwhile */ }
  }
  return newest;
}

export interface RenderWorkSweepOptions {
  now?: number;
  hostname?: string;
  isProcessAlive?: (pid: number) => boolean;
}
export interface RenderWorkSweepResult {
  removed: string[];
  kept: string[];
  failures: Array<{ path: string; error: string }>;
}

/**
 * Removes only stale render work directories this code created: a real directory (not a link or junction) directly
 * under one of `roots`, named exactly `<known prefix><six random characters>`, that is not in use. In use means:
 * created by this process and not yet removed, owned by a live process on this computer, or (for older builds without
 * an owner record, other computers, or an unreadable record) touched more recently than a conservative age. Nothing
 * else in the roots is ever opened for deletion.
 */
export async function sweepStaleRenderWorkDirectories(roots: readonly string[], options: RenderWorkSweepOptions = {}): Promise<RenderWorkSweepResult> {
  const now = options.now ?? Date.now();
  const host = options.hostname ?? osHostname();
  const alive = options.isProcessAlive ?? defaultProcessAlive;
  const result: RenderWorkSweepResult = { removed: [], kept: [], failures: [] };
  for (const root of [...new Set(roots.filter(root => isAbsolute(root)).map(root => resolve(root)))]) {
    if (!await realDirectory(root)) continue;
    let names: string[];
    try { names = await readdir(root); } catch { continue; }
    for (const name of names) {
      if (!isRenderWorkDirectoryName(name)) continue;
      const directory = join(root, name);
      try {
        if (activeDirectories.has(key(directory)) || !await realDirectory(directory)) { result.kept.push(directory); continue; }
        const owner = await readOwner(directory);
        const age = now - await newestActivityMs(directory);
        const stale = owner === undefined
          ? age >= LEGACY_WORK_DIRECTORY_MIN_AGE_MS
          : owner.host.toLowerCase() === host.toLowerCase()
            ? owner.pid !== process.pid && !alive(owner.pid) && age >= ORPHANED_WORK_DIRECTORY_MIN_AGE_MS
            : age >= FOREIGN_WORK_DIRECTORY_MIN_AGE_MS;
        // Re-check right before removal: never follow a directory that was swapped for a link meanwhile.
        if (!stale || activeDirectories.has(key(directory)) || !await realDirectory(directory)) { result.kept.push(directory); continue; }
        await rm(directory, { recursive: true, force: true, maxRetries: 2 });
        result.removed.push(directory);
      } catch (error) {
        result.failures.push({ path: directory, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return result;
}

/** Roots swept when the desktop service starts: the OS temp directory (where older builds rendered) and the configured root. */
export function startupRenderWorkSweepRoots(): string[] {
  const configured = process.env[RENDER_WORK_ROOT_ENV]?.trim();
  return [tmpdir(), ...(configured && isAbsolute(configured) ? [resolve(configured)] : [])];
}

/** Where a LONG render works (decision Q-L8): the configured root, else the hidden folder beside the output. */
export interface LongRenderWorkRootSelectionV1 { root: string; source: "configured" | "beside-output"; volumeRoot: string; availableBytes: number }

/** First existing path component (the path itself or an ancestor) that is a link or junction. */
async function linkedAncestorV1(path: string): Promise<string | undefined> {
  const root = parse(path).root;
  for (let current = path; ; current = dirname(current)) {
    try { if ((await lstat(current)).isSymbolicLink()) return current; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (current === root || dirname(current) === current) return undefined;
  }
}

/**
 * LONG work-root policy: the configured root (option or EDITKIN_RENDER_WORK_ROOT), else `<output dir>/.editkin-render-work`.
 * It must be measurable, must not be the OS temp folder and must not pass through a link or junction. Anything else is
 * refused with a stable code; unlike withRenderWorkRoot there is no fallback (never silently to the system Temp).
 */
export async function selectLongRenderWorkRootV1(input: { outputPath: string; configuredRoot?: string;
  probe: (path: string) => Promise<{ root: string; availableBytes: number } | undefined> }): Promise<LongRenderWorkRootSelectionV1> {
  const configured = input.configuredRoot?.trim() || process.env[RENDER_WORK_ROOT_ENV]?.trim() || undefined;
  if (configured && !isAbsolute(configured)) throw new LongRenderRefusalV1("LONG_RENDER_WORK_ROOT_UNAVAILABLE", "the configured render work root must be an absolute path", { configured });
  const source = configured ? "configured" as const : "beside-output" as const;
  const root = configured ? resolve(configured) : join(dirname(resolve(input.outputPath)), RENDER_WORK_ROOT_NAME);
  if (key(root) === key(tmpdir())) throw new LongRenderRefusalV1("LONG_RENDER_WORK_ROOT_SYSTEM_TEMP", "a LONG render never works in the OS temp folder", { root });
  const linkedBefore = await linkedAncestorV1(root);
  if (linkedBefore) throw new LongRenderRefusalV1("LONG_RENDER_WORK_ROOT_REPARSE", `the work root path passes through a link or junction (${linkedBefore})`, { root, linked: linkedBefore });
  if (!await usableRoot(root)) throw new LongRenderRefusalV1("LONG_RENDER_WORK_ROOT_UNAVAILABLE", `the ${source} work root cannot be used as a real directory`, { root, source });
  const linkedAfter = await linkedAncestorV1(root);
  if (linkedAfter) throw new LongRenderRefusalV1("LONG_RENDER_WORK_ROOT_REPARSE", `the work root path passes through a link or junction (${linkedAfter})`, { root, linked: linkedAfter });
  const space = await input.probe(root);
  if (!space || !Number.isFinite(space.availableBytes) || space.availableBytes < 0) throw new LongRenderRefusalV1("LONG_RENDER_VOLUME_UNKNOWN", "the free space of the LONG work root cannot be measured", { root });
  return { root, source, volumeRoot: space.root, availableBytes: space.availableBytes };
}

/** Runs `operation` with `root` as the current render work root (LONG renders nest their owned run directory here). */
export function runWithRenderWorkRootV1<T>(root: string, operation: () => Promise<T>): Promise<T> {
  return workRootStorage.run(root, operation);
}
