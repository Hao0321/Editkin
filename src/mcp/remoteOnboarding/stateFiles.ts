import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { MAX_JSON_BYTES } from "./constants";
import { type RemoteJsonReadHooks, type RemoteSetupPaths } from "./types";

export class ProposalAlreadyExistsError extends Error {}

export function remoteSetupPaths(environment: NodeJS.ProcessEnv = process.env): RemoteSetupPaths {
  const rawStateRoot = environment.EDITKIN_AGENT_STATE_ROOT?.trim();
  if (!rawStateRoot || !isAbsolute(rawStateRoot)) throw new Error("Editkin MCP 缺少受信任的 Agent state root");
  const stateRoot = resolve(rawStateRoot);
  if (basename(stateRoot).toLocaleLowerCase() !== "agent-runtime-v3") {
    throw new Error("Editkin MCP Agent state root 不是目前支援的 generation");
  }
  const root = join(dirname(stateRoot), "mobile-remote");
  return {
    root,
    config: join(root, "network-config.json"),
    candidate: join(root, "network-config-candidate.json"),
    pending: join(root, "network-setup-pending.json"),
    pendingRenewing: join(root, "network-setup-pending.json.renewing"),
    verification: join(root, "network-verification.json"),
    runtime: join(root, "network-runtime.json"),
  };
}

async function readBoundedUtf8(handle: Awaited<ReturnType<typeof open>>): Promise<string> {
  const buffer = Buffer.allocUnsafe(MAX_JSON_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > MAX_JSON_BYTES) throw new Error("Remote 設定檔讀取超過大小上限");
  return buffer.subarray(0, offset).toString("utf8");
}

export async function readJson(path: string, hooks: RemoteJsonReadHooks = {}): Promise<unknown | undefined> {
  let metadata;
  try { metadata = await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_JSON_BYTES) {
    throw new Error("Remote 設定檔必須是小型本機一般檔案；symlink/reparse 路徑已拒絕");
  }
  const handle = await open(path, "r");
  try {
    const openedBefore = await handle.stat();
    if (!openedBefore.isFile() || openedBefore.size > MAX_JSON_BYTES
      || openedBefore.dev !== metadata.dev || openedBefore.ino !== metadata.ino
      || openedBefore.size !== metadata.size) {
      throw new Error("Remote 設定檔在讀取時被替換；已 fail closed");
    }
    await hooks.afterHandleOpened?.(path);
    const text = await readBoundedUtf8(handle);
    const openedAfter = await handle.stat();
    // The current path is only an identity witness for the already-open handle.
    // Any lookup failure (including Windows delete-pending EPERM) makes that
    // witness unverifiable, so fail closed through the common integrity check.
    const current = await lstat(path).catch(() => undefined);
    if (!openedAfter.isFile() || openedAfter.size > MAX_JSON_BYTES
      || openedAfter.dev !== openedBefore.dev || openedAfter.ino !== openedBefore.ino
      || openedAfter.size !== openedBefore.size || openedAfter.mtimeMs !== openedBefore.mtimeMs
      || openedAfter.ctimeMs !== openedBefore.ctimeMs || Buffer.byteLength(text, "utf8") !== openedAfter.size
      || !current || current.isSymbolicLink() || !current.isFile()
      || current.dev !== openedAfter.dev || current.ino !== openedAfter.ino || current.size !== openedAfter.size
      || current.mtimeMs !== openedAfter.mtimeMs || current.ctimeMs !== openedAfter.ctimeMs) {
      throw new Error("Remote 設定檔在 bounded read 期間成長、替換或改變；已 fail closed");
    }
    return JSON.parse(text);
  } finally {
    await handle.close();
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentMetadata = await lstat(parent);
  if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
    throw new Error("Remote 設定目錄不可是 symlink/reparse 路徑");
  }
  const previous = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (previous?.isSymbolicLink() || (previous && !previous.isFile())) {
    throw new Error("Remote 設定目的地不可是 symlink/reparse 路徑");
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    const current = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (current?.isSymbolicLink() || (current && !current.isFile())
      || Boolean(previous) !== Boolean(current)
      || (previous && current && (previous.dev !== current.dev || previous.ino !== current.ino))) {
      throw new Error("Remote 設定目的地 revision 在寫入期間改變；已拒絕覆蓋");
    }
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function writeJsonCreateNew(path: string, value: unknown): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentMetadata = await lstat(parent);
  if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
    throw new Error("Remote 設定目錄不可是 symlink/reparse 路徑");
  }
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_JSON_BYTES) {
    throw new Error("Remote provider proposal 超過允許的本機 receipt 大小");
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryIdentity: { dev: number | bigint; ino: number | bigint } | undefined;
  let published = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    const temporaryMetadata = await handle.stat();
    if (!temporaryMetadata.isFile() || temporaryMetadata.size !== Buffer.byteLength(serialized, "utf8")) {
      throw new Error("Remote provider proposal temp receipt 未完整寫入");
    }
    temporaryIdentity = { dev: temporaryMetadata.dev, ino: temporaryMetadata.ino };
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, path);
      published = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ProposalAlreadyExistsError("Remote provider proposal 已存在；atomic no-replace publish 拒絕覆寫");
      }
      throw error;
    }
    const finalMetadata = await lstat(path);
    if (finalMetadata.isSymbolicLink() || !finalMetadata.isFile()
      || finalMetadata.dev !== temporaryMetadata.dev || finalMetadata.ino !== temporaryMetadata.ino
      || finalMetadata.size !== temporaryMetadata.size) {
      throw new Error("Remote provider proposal publish identity 驗證失敗");
    }
    await unlink(temporary);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    if (published && temporaryIdentity) {
      const current = await lstat(path).catch(() => undefined);
      if (current && !current.isSymbolicLink() && current.isFile()
        && current.dev === temporaryIdentity.dev && current.ino === temporaryIdentity.ino) {
        await unlink(path).catch(() => undefined);
      }
    }
    throw error;
  }
}

export async function optionalMetadata(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
}
