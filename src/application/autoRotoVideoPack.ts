import { createHash, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { compareUtf8Bytes } from "../shared/utf8ByteOrder";

export const AUTO_ROTO_PUBLISHER_KEY_ID = "editkin-auto-roto-production-2026";
export const AUTO_ROTO_PUBLISHER_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAz4LwpOp7SCCfMdx+jHKYbY0WyAiRfNQ7ZSYAJ3O0LfE=
-----END PUBLIC KEY-----
`;

export interface AutoRotoPackFileReceipt {
  path: string;
  bytes: number;
  sha256: string;
}

export interface VerifiedAutoRotoPackReceipt {
  schema: "editkin.auto-roto-pack-receipt/v1";
  packId: string;
  packVersion: string;
  qualityTier: "production";
  publisherKeyId: typeof AUTO_ROTO_PUBLISHER_KEY_ID;
  sourceCommit: string;
  precision: "float16";
  requiredDevice: "cuda";
  manifestIdentitySha256: string;
  inventorySha256: string;
  files: AutoRotoPackFileReceipt[];
}

type Manifest = Record<string, unknown>;
const CONTROL_FILES = new Set(["manifest.json", "pack-receipt.json", "pack-receipt.sig"]);
const verifiedPayloadCache = new Map<string, { statSeal: string; observed: AutoRotoPackFileReceipt[] }>();

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalRelativePath(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.includes("\\") || value.startsWith("/") || isAbsolute(value)
    || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Auto Roto production pack ${field} 必須是正規相對路徑`);
  }
  return value;
}

function canonicalHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`Auto Roto production pack ${field} 不合法`);
  return value;
}

function isInside(root: string, target: string): boolean {
  const value = relative(root, target);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

interface CollectedPayloadFile { path: string; bytes: number; absolute: string; modifiedNs: string; changedNs: string }
interface PayloadPath { path: string; absolute: string }

async function collectPayloadPaths(root: string, directory = root): Promise<PayloadPath[]> {
  const output: PayloadPath[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => compareUtf8Bytes(left.name, right.name))) {
    const target = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Auto Roto production pack 不接受 symbolic link／junction payload");
    if (entry.isDirectory()) output.push(...await collectPayloadPaths(root, target));
    else if (entry.isFile()) {
      const path = relative(root, target).replaceAll("\\", "/");
      if (!CONTROL_FILES.has(path)) output.push({ path, absolute: target });
    } else throw new Error(`Auto Roto production pack 含不支援的檔案類型：${entry.name}`);
  }
  return output.sort((left, right) => compareUtf8Bytes(left.path, right.path));
}

async function collectPayload(root: string): Promise<CollectedPayloadFile[]> {
  const paths = await collectPayloadPaths(root);
  const output = new Array<CollectedPayloadFile>(paths.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(32, paths.length) }, async () => {
    while (true) {
      const index = next; next += 1;
      if (index >= paths.length) return;
      const file = paths[index];
      const metadata = await lstat(file.absolute, { bigint: true });
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Auto Roto production pack payload 檔案型態已漂移");
      const bytes = Number(metadata.size);
      if (!Number.isSafeInteger(bytes)) throw new Error("Auto Roto production pack 檔案尺寸超出安全整數");
      output[index] = { ...file, bytes, modifiedNs: metadata.mtimeNs.toString(), changedNs: metadata.ctimeNs.toString() };
    }
  }));
  return output;
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 4 * 1024 * 1024 })) digest.update(chunk);
  return digest.digest("hex");
}

async function walkPayload(files: CollectedPayloadFile[]): Promise<AutoRotoPackFileReceipt[]> {
  const output = new Array<AutoRotoPackFileReceipt>(files.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
    while (true) {
      const index = next; next += 1;
      if (index >= files.length) return;
      const file = files[index];
      output[index] = { path: file.path, bytes: file.bytes, sha256: await sha256File(file.absolute) };
    }
  }));
  return output.sort((left, right) => compareUtf8Bytes(left.path, right.path));
}

function payloadStatSeal(files: CollectedPayloadFile[]): string {
  return sha256(Buffer.from(JSON.stringify(files.map(({ path, bytes, modifiedNs, changedNs }) => ({ path, bytes, modifiedNs, changedNs })))));
}

function parseReceipt(value: unknown): VerifiedAutoRotoPackReceipt {
  if (!value || typeof value !== "object") throw new Error("Auto Roto production pack receipt 不是物件");
  const receipt = value as Partial<VerifiedAutoRotoPackReceipt>;
  if (receipt.schema !== "editkin.auto-roto-pack-receipt/v1" || receipt.qualityTier !== "production"
    || receipt.publisherKeyId !== AUTO_ROTO_PUBLISHER_KEY_ID || receipt.precision !== "float16" || receipt.requiredDevice !== "cuda"
    || typeof receipt.packId !== "string" || !/^[a-z0-9][a-z0-9._-]{2,80}$/.test(receipt.packId)
    || typeof receipt.packVersion !== "string" || !/^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i.test(receipt.packVersion)
    || typeof receipt.sourceCommit !== "string" || !/^[a-f0-9]{40}$/.test(receipt.sourceCommit)
    || !Array.isArray(receipt.files) || receipt.files.length < 10) throw new Error("Auto Roto production pack receipt 合約不合法");
  const seen = new Set<string>();
  let previous = "";
  for (const file of receipt.files) {
    const path = canonicalRelativePath(file?.path, "receipt.files.path");
    if (CONTROL_FILES.has(path) || seen.has(path) || (previous && compareUtf8Bytes(previous, path) >= 0)
      || !Number.isSafeInteger(file?.bytes) || file.bytes < 0) throw new Error("Auto Roto production pack receipt inventory 不合法");
    canonicalHash(file.sha256, "receipt.files.sha256");
    seen.add(path); previous = path;
  }
  canonicalHash(receipt.manifestIdentitySha256, "manifestIdentitySha256");
  const inventorySha256 = canonicalHash(receipt.inventorySha256, "inventorySha256");
  if (sha256(Buffer.from(JSON.stringify(receipt.files))) !== inventorySha256) throw new Error("Auto Roto production pack inventory SHA-256 驗證失敗");
  return receipt as VerifiedAutoRotoPackReceipt;
}

function signedManifestIdentity(manifest: Manifest): Manifest {
  return {
    schema: manifest.schema, id: manifest.id, version: manifest.version, qualityTier: manifest.qualityTier,
    publisherKeyId: manifest.publisherKeyId, signatureAlgorithm: manifest.signatureAlgorithm,
    hostPath: manifest.hostPath, hostSha256: manifest.hostSha256,
    pythonPath: manifest.pythonPath, pythonSha256: manifest.pythonSha256,
    sourceRoot: manifest.sourceRoot, sourceMarkerPath: manifest.sourceMarkerPath, sourceMarkerSha256: manifest.sourceMarkerSha256,
    configPath: manifest.configPath, configSha256: manifest.configSha256, configName: manifest.configName,
    checkpointPath: manifest.checkpointPath, checkpointSha256: manifest.checkpointSha256,
    licensePath: manifest.licensePath, licenseSha256: manifest.licenseSha256,
    runtimeReceiptPath: manifest.runtimeReceiptPath, runtimeReceiptSha256: manifest.runtimeReceiptSha256,
    sourceCommit: manifest.sourceCommit, precision: manifest.precision, requiredDevice: manifest.requiredDevice,
  };
}

export async function verifyProductionAutoRotoPack(trustedRootInput: string, manifestPathInput: string): Promise<{
  root: string;
  manifestPath: string;
  manifestBytes: Buffer;
  manifest: Manifest;
  receipt: VerifiedAutoRotoPackReceipt;
  receiptSha256: string;
  signatureSha256: string;
}> {
  const root = await realpath(trustedRootInput);
  if (!(await stat(root)).isDirectory()) throw new Error("Auto Roto production pack root 不是資料夾");
  const manifestPath = await realpath(manifestPathInput);
  if (!isInside(root, manifestPath) || relative(root, manifestPath).replaceAll("\\", "/") !== "manifest.json") {
    throw new Error("Auto Roto production manifest 必須是 pack root 的 manifest.json");
  }
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as Manifest;
  if (manifest.schema !== "editkin.auto-roto-video-pack/v2" || manifest.qualityTier !== "production"
    || manifest.signatureAlgorithm !== "ed25519" || manifest.publisherKeyId !== AUTO_ROTO_PUBLISHER_KEY_ID) {
    throw new Error("Auto Roto production manifest schema／publisher 不支援");
  }
  const receiptPath = canonicalRelativePath(manifest.receiptPath, "receiptPath");
  const signaturePath = canonicalRelativePath(manifest.signaturePath, "signaturePath");
  if (receiptPath !== "pack-receipt.json" || signaturePath !== "pack-receipt.sig") throw new Error("Auto Roto production pack control path 不合法");
  const [receiptBytes, signatureBytes] = await Promise.all([readFile(resolve(root, receiptPath)), readFile(resolve(root, signaturePath))]);
  const receiptSha256 = sha256(receiptBytes);
  const signatureSha256 = sha256(signatureBytes);
  if (receiptSha256 !== canonicalHash(manifest.receiptSha256, "receiptSha256")
    || signatureSha256 !== canonicalHash(manifest.signatureSha256, "signatureSha256")) throw new Error("Auto Roto production pack control SHA-256 驗證失敗");
  const signatureText = signatureBytes.toString("utf8").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signatureText)
    || !verify(null, receiptBytes, AUTO_ROTO_PUBLISHER_PUBLIC_KEY, Buffer.from(signatureText, "base64"))) {
    throw new Error("Auto Roto production pack Ed25519 簽章驗證失敗");
  }
  const receipt = parseReceipt(JSON.parse(receiptBytes.toString("utf8")));
  if (sha256(Buffer.from(JSON.stringify(signedManifestIdentity(manifest)))) !== receipt.manifestIdentitySha256) {
    throw new Error("Auto Roto production manifest 語意身分未受 publisher 簽章保護");
  }
  if (receipt.packId !== manifest.id || receipt.packVersion !== manifest.version || receipt.sourceCommit !== manifest.sourceCommit
    || receipt.precision !== manifest.precision || receipt.requiredDevice !== manifest.requiredDevice) {
    throw new Error("Auto Roto production manifest 與簽章 receipt 身分不一致");
  }
  const collected = (await collectPayload(root)).sort((left, right) => compareUtf8Bytes(left.path, right.path));
  const statSeal = payloadStatSeal(collected);
  const cacheKey = `${root}\n${sha256(manifestBytes)}\n${receiptSha256}\n${signatureSha256}`;
  let observed = verifiedPayloadCache.get(cacheKey)?.statSeal === statSeal ? verifiedPayloadCache.get(cacheKey)!.observed : undefined;
  if (!observed) {
    observed = await walkPayload(collected);
    verifiedPayloadCache.set(cacheKey, { statSeal, observed });
  }
  if (JSON.stringify(observed) !== JSON.stringify(receipt.files)) throw new Error("Auto Roto production pack closed-world inventory 驗證失敗");
  return { root, manifestPath, manifestBytes, manifest, receipt, receiptSha256, signatureSha256 };
}
