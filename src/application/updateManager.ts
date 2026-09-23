import { randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { get as httpsGet } from "node:https";
import { dirname } from "node:path";
import { compareUpdateVersions, parseUpdateVersion } from "../shared/updateVersion.mjs";
import { stageVerifiedUpdateCache } from "./updateCache";

export interface UpdateArtifact {
  url: string;
  sha256: string;
  size: number;
  signatureSubject?: string;
  signatureSha256?: string;
}

export interface UpdateManifest {
  schemaVersion: 1;
  version: string;
  publishedAt: string;
  minimumProjectSchema: number;
  windowsX64: UpdateArtifact;
}

export interface StagedUpdate {
  version: string;
  artifactPath: string;
  sha256: string;
  size: number;
  cacheHit: boolean;
  signatureSubject?: string;
  signatureSha256?: string;
}

export interface UpdateTransaction {
  schemaVersion: 1;
  status: "staged" | "applying" | "healthy" | "rollback_required";
  fromVersion: string;
  toVersion: string;
  stagedArtifact: string;
  previousInstaller?: string;
  createdAt: string;
  launchAttempts: number;
}

type Fetcher = (input: string) => Promise<Response>;

interface StageUpdateOptions {
  currentVersion: string;
  currentProjectSchema: number;
  cacheRoot: string;
  fetcher?: Fetcher;
  httpsCa?: string | Buffer;
}

export function compareVersions(left: string, right: string): number {
  return compareUpdateVersions(left, right);
}

function secureHttpsUrl(input: string, label: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error(`${label} URL 不合法`); }
  if (url.protocol !== "https:") throw new Error(`${label}只允許 HTTPS`);
  if (url.username || url.password) throw new Error(`${label} URL 不可包含帳號密碼`);
  if (url.hash) throw new Error(`${label} URL 不可包含 fragment`);
  return url.href;
}

export function assertUpdateManifestUrl(input: string): string {
  return secureHttpsUrl(input, "更新 manifest ");
}

export function signerIdentityMatches(
  actual: { subject: string; certificateSha256: string },
  expected: { subject: string; certificateSha256: string },
): boolean {
  return actual.subject.trim().toLocaleLowerCase() === expected.subject.trim().toLocaleLowerCase()
    && actual.certificateSha256.length === 64 && expected.certificateSha256.length === 64
    && /^[a-f0-9]{64}$/i.test(actual.certificateSha256)
    && actual.certificateSha256.toLowerCase() === expected.certificateSha256.toLowerCase();
}

export function parseUpdateManifest(input: unknown): UpdateManifest {
  if (!input || typeof input !== "object") throw new Error("更新 manifest 不是物件");
  const value = input as Record<string, unknown>;
  const artifact = value.windowsX64 as Record<string, unknown> | undefined;
  if (value.schemaVersion !== 1 || typeof value.version !== "string" || typeof value.publishedAt !== "string"
    || !Number.isInteger(value.minimumProjectSchema) || Number(value.minimumProjectSchema) < 1
    || !artifact || typeof artifact.url !== "string"
    || typeof artifact.sha256 !== "string" || artifact.sha256.length !== 64 || !/^[a-f0-9]{64}$/i.test(artifact.sha256)
    || !Number.isSafeInteger(artifact.size) || Number(artifact.size) <= 0
    || (artifact.signatureSubject !== undefined && (typeof artifact.signatureSubject !== "string" || !artifact.signatureSubject.trim()))
    || (artifact.signatureSha256 !== undefined && (typeof artifact.signatureSha256 !== "string" || artifact.signatureSha256.length !== 64 || !/^[a-f0-9]{64}$/i.test(artifact.signatureSha256)))
    || (artifact.signatureSubject === undefined) !== (artifact.signatureSha256 === undefined)) {
    throw new Error("更新 manifest 欄位不合法");
  }
  if (!Number.isFinite(Date.parse(value.publishedAt))) throw new Error("更新 manifest publishedAt 不合法");
  const url = secureHttpsUrl(artifact.url, "更新檔");
  parseUpdateVersion(value.version);
  return {
    schemaVersion: 1,
    version: value.version,
    publishedAt: value.publishedAt,
    minimumProjectSchema: Number(value.minimumProjectSchema),
    windowsX64: {
      url,
      sha256: artifact.sha256.toLowerCase(),
      size: Number(artifact.size),
      ...(typeof artifact.signatureSubject === "string" ? { signatureSubject: artifact.signatureSubject.trim() } : {}),
      ...(typeof artifact.signatureSha256 === "string" ? { signatureSha256: artifact.signatureSha256.toLowerCase() } : {}),
    },
  };
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function writeBoundedByteStream(stream: AsyncIterable<Uint8Array>, handle: FileHandle, maximumBytes: number): Promise<number> {
  let received = 0;
  for await (const value of stream) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    received += bytes.byteLength;
    if (received > maximumBytes) throw new Error(`更新檔超過 manifest 宣告大小：${received} / ${maximumBytes}`);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, null);
      if (bytesWritten <= 0) throw new Error("更新檔寫入未前進");
      offset += bytesWritten;
    }
  }
  return received;
}

function openHttpsResponse(input: string, ca?: string | Buffer, redirects = 0): Promise<IncomingMessage> {
  return new Promise((resolveResponse, reject) => {
    const request = httpsGet(input, { ca }, (response) => {
      const location = response.headers.location;
      if (location && [301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
        response.resume();
        if (redirects >= 3) return reject(new Error("更新下載重新導向過多"));
        let next: string;
        try { next = secureHttpsUrl(new URL(location, input).href, "更新重新導向 "); }
        catch (error) { return reject(error); }
        resolveResponse(openHttpsResponse(next, ca, redirects + 1));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`更新下載失敗：HTTP ${response.statusCode ?? 0}`));
        return;
      }
      resolveResponse(response);
    });
    request.setTimeout(30_000, () => request.destroy(new Error("更新下載逾時")));
    request.once("error", reject);
  });
}

function validateTransaction(input: unknown): UpdateTransaction {
  if (!input || typeof input !== "object") throw new Error("更新 transaction 不是物件");
  const state = input as Record<string, unknown>;
  if (state.schemaVersion !== 1 || !["staged", "applying", "healthy", "rollback_required"].includes(String(state.status))
    || typeof state.fromVersion !== "string" || typeof state.toVersion !== "string" || typeof state.stagedArtifact !== "string"
    || typeof state.createdAt !== "string" || !Number.isInteger(state.launchAttempts) || Number(state.launchAttempts) < 0
    || (state.previousInstaller !== undefined && typeof state.previousInstaller !== "string")) {
    throw new Error("更新 transaction 格式不合法");
  }
  parseUpdateVersion(state.fromVersion);
  parseUpdateVersion(state.toVersion);
  return input as UpdateTransaction;
}

async function readTransactionCandidate(path: string): Promise<UpdateTransaction | undefined> {
  if (!await exists(path)) return undefined;
  return validateTransaction(JSON.parse(await readFile(path, "utf8")));
}

async function writeTransactionAtomic(statePath: string, state: UpdateTransaction): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  const backup = `${statePath}.previous`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(validateTransaction(state), null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  let movedCurrent = false;
  try {
    if (await exists(statePath)) {
      let currentValid = false;
      try { currentValid = Boolean(await readTransactionCandidate(statePath)); } catch { /* keep the last valid backup */ }
      if (currentValid) {
        await rm(backup, { force: true });
        await rename(statePath, backup);
        movedCurrent = true;
      } else {
        await rm(statePath, { force: true });
      }
    }
    await rename(temporary, statePath);
  } catch (error) {
    if (movedCurrent && !await exists(statePath) && await exists(backup)) await rename(backup, statePath);
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function stageUpdate(
  manifestInput: unknown,
  options: StageUpdateOptions,
): Promise<StagedUpdate | undefined> {
  const manifest = parseUpdateManifest(manifestInput);
  if (compareVersions(manifest.version, options.currentVersion) <= 0) return undefined;
  if (manifest.minimumProjectSchema > options.currentProjectSchema) throw new Error("這個更新需要尚未支援的專案 schema");
  const staged = await stageVerifiedUpdateCache(options.cacheRoot, manifest.windowsX64, async (handle, assertSafePath) => {
    let declaredSize = Number.NaN;
    if (options.fetcher) {
      const response = await options.fetcher(manifest.windowsX64.url);
      if (!response.ok || !response.body) throw new Error(`更新下載失敗：HTTP ${response.status}`);
      declaredSize = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredSize) && declaredSize > manifest.windowsX64.size) {
        throw new Error(`更新檔 Content-Length 超過 manifest：${declaredSize} / ${manifest.windowsX64.size}`);
      }
      await assertSafePath();
      await writeBoundedByteStream(response.body as unknown as AsyncIterable<Uint8Array>, handle, manifest.windowsX64.size);
    } else {
      const response = await openHttpsResponse(manifest.windowsX64.url, options.httpsCa);
      declaredSize = Number(response.headers["content-length"]);
      if (Number.isFinite(declaredSize) && declaredSize > manifest.windowsX64.size) {
        response.destroy();
        throw new Error(`更新檔 Content-Length 超過 manifest：${declaredSize} / ${manifest.windowsX64.size}`);
      }
      try {
        await assertSafePath();
        await writeBoundedByteStream(response, handle, manifest.windowsX64.size);
      } finally {
        response.destroy();
      }
    }
    if (Number.isFinite(declaredSize) && declaredSize > manifest.windowsX64.size) {
      throw new Error(`更新檔 Content-Length 超過 manifest：${declaredSize} / ${manifest.windowsX64.size}`);
    }
  });
  return { version: manifest.version, ...staged, sha256: manifest.windowsX64.sha256, size: manifest.windowsX64.size,
    signatureSubject: manifest.windowsX64.signatureSubject, signatureSha256: manifest.windowsX64.signatureSha256 };
}

export async function createUpdateTransaction(
  statePath: string,
  input: Omit<UpdateTransaction, "schemaVersion" | "status" | "createdAt" | "launchAttempts">,
): Promise<UpdateTransaction> {
  const state: UpdateTransaction = { schemaVersion: 1, status: "staged", createdAt: new Date().toISOString(), launchAttempts: 0, ...input };
  await writeTransactionAtomic(statePath, state);
  return state;
}

export async function readUpdateTransaction(statePath: string): Promise<UpdateTransaction | undefined> {
  try { return await readTransactionCandidate(statePath); }
  catch (primaryError) {
    try {
      const recovered = await readTransactionCandidate(`${statePath}.previous`);
      if (recovered) return recovered;
    } catch { /* report the primary corruption below */ }
    throw primaryError;
  }
}

export async function recordUpdateLaunch(statePath: string): Promise<UpdateTransaction> {
  const state = await readUpdateTransaction(statePath);
  if (!state) throw new Error("找不到更新 transaction");
  state.launchAttempts += 1;
  state.status = state.launchAttempts >= 2 ? "rollback_required" : "applying";
  await writeTransactionAtomic(statePath, state);
  return state;
}

export async function markUpdateHealthy(statePath: string, runningVersion: string): Promise<UpdateTransaction> {
  const state = await readUpdateTransaction(statePath);
  if (!state) throw new Error("找不到更新 transaction");
  if (state.toVersion !== runningVersion) throw new Error(`健康版本與 transaction 不一致：${runningVersion} / ${state.toVersion}`);
  state.status = "healthy";
  await writeTransactionAtomic(statePath, state);
  return state;
}

export async function rollbackInstaller(statePath: string): Promise<string | undefined> {
  const state = await readUpdateTransaction(statePath);
  if (!state) return undefined;
  if (state.status !== "rollback_required" || !state.previousInstaller || !await exists(state.previousInstaller)) return undefined;
  return state.previousInstaller;
}
