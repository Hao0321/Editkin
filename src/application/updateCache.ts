import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";

const samePath = (a: string, b: string): boolean => process.platform === "win32"
  ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";
type FileIdentity = { dev: number; ino: number };

function validateAbsolutePath(input: string): string {
  if (typeof input !== "string" || !isAbsolute(input)) throw new Error("更新快取需要絕對路徑");
  const volume = parse(input).root;
  const parts = input.slice(volume.length).split(/[\\/]+/u).filter(Boolean);
  if (parts.some((part) => part === "." || part === ".." || /[. ]$/u.test(part)
    || /[<>:"|?*\u0000-\u001f]/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) {
    throw new Error("更新快取路徑包含不安全的別名或字元");
  }
  const absolute = resolve(input);
  if (samePath(absolute, volume)) throw new Error("更新快取不可使用磁碟根目錄");
  return absolute;
}

async function canonicalDirectory(path: string): Promise<void> {
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink() || !samePath(await realpath(path), path)) {
    throw new Error("更新快取拒絕 symlink／junction 或非正規目錄");
  }
}

// Never recursively mkdir before validating existing ancestors: that would
// create directories through a junction before discovering the escape.
async function directoryChain(path: string, create = false): Promise<void> {
  let cursor = parse(path).root;
  await canonicalDirectory(cursor);
  for (const part of relative(cursor, path).split(sep).filter(Boolean)) {
    const parent = cursor;
    cursor = resolve(cursor, part);
    await canonicalDirectory(parent);
    try { await canonicalDirectory(cursor); }
    catch (error) {
      if (!create || !missing(error)) throw error;
      try { await mkdir(cursor, { recursive: false, mode: 0o700 }); }
      catch (creationError) { if ((creationError as NodeJS.ErrnoException).code !== "EEXIST") throw creationError; }
      await canonicalDirectory(cursor);
    }
  }
}

async function regularFile(path: string, allowMissing = false, allowOwnedLinks = false) {
  await directoryChain(dirname(path));
  let details;
  try { details = await lstat(path); }
  catch (error) { if (allowMissing && missing(error)) return undefined; throw error; }
  if (!details.isFile() || details.isSymbolicLink() || (!allowOwnedLinks && details.nlink !== 1)
    || !samePath(await realpath(path), path)) throw new Error("更新快取拒絕連結、hardlink 或非正規檔案");
  return details;
}

function assertIdentity(actual: FileIdentity, expected: FileIdentity): void {
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error("更新快取檔案身分已改變");
}

async function verifyArtifact(path: string, expected: { size: number; sha256: string }): Promise<boolean> {
  const before = await regularFile(path, true);
  if (!before) return false;
  if (before.size !== expected.size) throw new Error("更新快取大小不符；保留原檔，不覆寫未知內容");
  const handle = await open(path, "r");
  const hash = createHash("sha256");
  try {
    assertIdentity(await handle.stat(), before);
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, expected.size));
    let position = 0;
    while (position < expected.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, expected.size - position), position);
      if (!bytesRead) throw new Error("更新快取讀取提前結束");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await regularFile(path);
    assertIdentity(after!, before);
    if (after!.size !== expected.size || hash.digest("hex") !== expected.sha256) {
      throw new Error("更新檔 SHA-256 驗證失敗；保留原檔");
    }
  } finally { await handle.close(); }
  return true;
}

async function unlinkOwned(path: string, identity: FileIdentity): Promise<void> {
  const actual = await regularFile(path, true, true);
  if (!actual) return;
  assertIdentity(actual, identity);
  await unlink(path);
}

function attachCleanupFailure(primary: unknown, cleanup: unknown): never {
  if (primary instanceof Error) {
    Object.defineProperty(primary, "cleanupFailure", { value: cleanup, configurable: true });
    throw primary;
  }
  throw new AggregateError([primary, cleanup], "更新失敗，且安全清理未完成");
}

function cacheArtifactPaths(cacheRoot: string, expected: { size: number; sha256: string }) {
  if (typeof expected.sha256 !== "string" || expected.sha256.length !== 64 || !/^[a-f0-9]{64}$/u.test(expected.sha256)
    || !Number.isSafeInteger(expected.size) || expected.size <= 0) {
    throw new Error("更新快取身分不合法");
  }
  const root = validateAbsolutePath(cacheRoot);
  const directory = resolve(root, `sha256-${expected.sha256}`);
  return { directory, artifactPath: resolve(directory, "installer.exe") };
}

/** Read-only launch preflight; does not replace publisher trust or an OS-level execute-by-handle guarantee. */
export async function verifyStagedUpdateCache(
  cacheRoot: string,
  staged: { artifactPath: string; size: number; sha256: string },
): Promise<void> {
  const { artifactPath } = cacheArtifactPaths(cacheRoot, staged);
  if (!samePath(validateAbsolutePath(staged.artifactPath), artifactPath)) {
    throw new Error("更新檔路徑不符合已驗證的快取身分");
  }
  if (!await verifyArtifact(artifactPath, staged)) throw new Error("已暫存的更新檔遺失，拒絕啟動");
}

/** Only stages bytes; publisher trust, health and executable launch are separate. */
export async function stageVerifiedUpdateCache(
  cacheRoot: string,
  expected: { size: number; sha256: string },
  download: (handle: FileHandle, assertSafePath: () => Promise<void>) => Promise<void>,
): Promise<{ artifactPath: string; cacheHit: boolean }> {
  const { directory, artifactPath } = cacheArtifactPaths(cacheRoot, expected);
  await directoryChain(directory, true);
  const lockPath = resolve(directory, ".stage.lock");
  const token = `${process.pid}:${randomUUID()}\n`;
  let lock: FileHandle;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("更新快取正在使用中；不接管既有 lock");
    throw error;
  }
  let lockIdentity: FileIdentity | undefined;
  let primary: unknown;
  try {
    lockIdentity = await lock.stat();
    await lock.writeFile(token);
    await lock.sync();
    if (await verifyArtifact(artifactPath, expected)) return { artifactPath, cacheHit: true };
    const temporaryPath = resolve(directory, `.download-${process.pid}-${randomUUID()}.tmp`);
    await directoryChain(directory);
    const handle = await open(temporaryPath, "wx", 0o600);
    let identity: FileIdentity | undefined;
    let downloadFailure: unknown;
    try {
      identity = await handle.stat();
      await download(handle, () => directoryChain(directory));
      await handle.sync();
      await handle.close();
      if (!await verifyArtifact(temporaryPath, expected)) throw new Error("更新暫存檔遺失");
      // link is an atomic no-clobber publication. Never rm/replace an existing
      // installer; concurrent different digests have different immutable paths.
      await link(temporaryPath, artifactPath);
      await unlinkOwned(temporaryPath, identity);
      if (!await verifyArtifact(artifactPath, expected)) throw new Error("已發布的更新檔遺失，拒絕回報 ready");
      return { artifactPath, cacheHit: false };
    } catch (error) { downloadFailure = error; throw error; }
    finally {
      try {
        await handle.close();
        if (!identity) throw new Error("暫存檔身分未能確認；已關閉 handle，保留檔案供檢查");
        await unlinkOwned(temporaryPath, identity);
      }
      catch (cleanup) { if (downloadFailure) attachCleanupFailure(downloadFailure, cleanup); throw cleanup; }
    }
  } catch (error) { primary = error; throw error; }
  finally {
    try {
      await lock.close();
      if (!lockIdentity) throw new Error("更新 lock 身分未能確認；已關閉 handle，保留檔案供檢查");
      const current = await regularFile(lockPath);
      assertIdentity(current!, lockIdentity);
      if (current!.size !== Buffer.byteLength(token) || await readFile(lockPath, "utf8") !== token) {
        throw new Error("更新 lock 身分已變動，保留供檢查");
      }
      await unlinkOwned(lockPath, lockIdentity);
    } catch (cleanup) { if (primary) attachCleanupFailure(primary, cleanup); throw cleanup; }
  }
}
