import { createHash, createPublicKey, verify } from "node:crypto";
import { compareUpdateVersions, parseUpdateVersion } from "../shared/updateVersion.mjs";

const HEX_256 = /^[a-f0-9]{64}$/u;
const KEY_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/u;

export interface UpdateTrustPolicy {
  schema: "editkin.update-trust-policy/v1";
  policyVersion: number;
  repository: string;
  channel: string;
  platform: string;
  arch: string;
  abi: string;
  manifestUrl: string;
  artifactBaseUrl: string;
  publisherKeyId: string;
  publisherPublicKeyPem: string;
  authenticodeSubject: string;
  authenticodeCertificateSha256: string;
  maxManifestBytes: number;
  maxArtifactBytes: number;
  checkIntervalMs: number;
}

export interface SignedUpdateMetadata {
  schema: "editkin.update-metadata/v1";
  policyVersion: number;
  sequence: number;
  repository: string;
  channel: string;
  platform: string;
  arch: string;
  abi: string;
  version: string;
  publishedAt: string;
  expiresAt: string;
  minimumProjectSchema: number;
  minimumOsVersion: string;
  artifact: {
    url: string;
    sha256: string;
    size: number;
    authenticodeSubject: string;
    certificateSha256: string;
  };
}

export interface SignedUpdateEnvelope {
  schema: "editkin.signed-update-metadata/v1";
  keyId: string;
  signed: SignedUpdateMetadata;
  signature: string;
}

export interface HighestTrustedUpdateState {
  schema: "editkin.highest-trusted-update/v1";
  policyVersion: number;
  highestSequence: number;
  version: string;
  artifactSha256: string;
  metadataSha256: string;
  acceptedAt: string;
}

export interface TrustedUpdateDecision {
  status: "current" | "available" | "incompatible";
  reason?: "project_schema" | "operating_system";
  metadata: SignedUpdateMetadata;
  nextState: HighestTrustedUpdateState;
}

type PlainObject = Record<string, unknown>;

function object(input: unknown, label: string): PlainObject {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype) throw new Error(`${label} 必須是普通物件`);
  return input as PlainObject;
}

function exactKeys(value: PlainObject, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} 欄位不是封閉集合`);
  }
}

function requiredText(value: unknown, label: string, maximum = 2048): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${label} 不合法`);
  return value;
}

function positiveInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) throw new Error(`${label} 不合法`);
  return Number(value);
}

function secureUrl(value: unknown, label: string): URL {
  const text = requiredText(value, label);
  let url: URL;
  try { url = new URL(text); } catch { throw new Error(`${label} 不合法`); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error(`${label} 必須是無憑證、無 fragment 的 HTTPS URL`);
  return url;
}

function canonicalJson(input: unknown): string {
  if (input === null || typeof input === "boolean" || typeof input === "string") return JSON.stringify(input);
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new Error("簽章內容包含非有限數字");
    return JSON.stringify(input);
  }
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(",")}]`;
  const value = object(input, "簽章內容");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function numericVersion(input: unknown, label: string): number[] {
  const value = requiredText(input, label, 64);
  if (!/^(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){1,3}$/u.test(value)) throw new Error(`${label} 不合法`);
  return value.split(".").map(Number);
}

function compareNumericVersion(left: string, right: string): number {
  const a = numericVersion(left, "minimumOsVersion");
  const b = numericVersion(right, "currentOsVersion");
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}

function artifactUrlWithinBase(artifact: URL, base: URL): boolean {
  if (artifact.origin !== base.origin) return false;
  const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  return artifact.pathname.startsWith(basePath) && artifact.pathname.length > basePath.length;
}

export function parseUpdateTrustPolicy(input: unknown): UpdateTrustPolicy {
  const value = object(input, "更新信任政策");
  exactKeys(value, ["schema", "policyVersion", "repository", "channel", "platform", "arch", "abi", "manifestUrl",
    "artifactBaseUrl", "publisherKeyId", "publisherPublicKeyPem", "authenticodeSubject",
    "authenticodeCertificateSha256", "maxManifestBytes", "maxArtifactBytes", "checkIntervalMs"], "更新信任政策");
  if (value.schema !== "editkin.update-trust-policy/v1") throw new Error("更新信任政策 schema 不支援");
  const manifestUrl = secureUrl(value.manifestUrl, "manifestUrl");
  const artifactBaseUrl = secureUrl(value.artifactBaseUrl, "artifactBaseUrl");
  if (!artifactBaseUrl.pathname.endsWith("/")) throw new Error("artifactBaseUrl 必須以 / 結尾");
  const publisherKeyId = requiredText(value.publisherKeyId, "publisherKeyId", 64);
  if (!KEY_ID.test(publisherKeyId)) throw new Error("publisherKeyId 不合法");
  if (typeof value.publisherPublicKeyPem !== "string" || value.publisherPublicKeyPem.length < 1
    || value.publisherPublicKeyPem.length > 8192 || /[\u0000\u007f]/u.test(value.publisherPublicKeyPem)) {
    throw new Error("publisherPublicKeyPem 不合法");
  }
  const publisherPublicKeyPem = `${value.publisherPublicKeyPem.trim()}\n`;
  let key;
  try { key = createPublicKey(publisherPublicKeyPem); } catch { throw new Error("publisherPublicKeyPem 不是有效公開金鑰"); }
  if (key.asymmetricKeyType !== "ed25519") throw new Error("更新 metadata 僅接受 Ed25519 發布金鑰");
  const certificate = requiredText(value.authenticodeCertificateSha256, "authenticodeCertificateSha256", 64).toLowerCase();
  if (!HEX_256.test(certificate)) throw new Error("authenticodeCertificateSha256 不合法");
  return {
    schema: "editkin.update-trust-policy/v1",
    policyVersion: positiveInteger(value.policyVersion, "policyVersion", 1_000_000),
    repository: requiredText(value.repository, "repository", 512),
    channel: requiredText(value.channel, "channel", 32),
    platform: requiredText(value.platform, "platform", 32),
    arch: requiredText(value.arch, "arch", 32),
    abi: requiredText(value.abi, "abi", 32),
    manifestUrl: manifestUrl.href,
    artifactBaseUrl: artifactBaseUrl.href,
    publisherKeyId,
    publisherPublicKeyPem,
    authenticodeSubject: requiredText(value.authenticodeSubject, "authenticodeSubject", 1024),
    authenticodeCertificateSha256: certificate,
    maxManifestBytes: positiveInteger(value.maxManifestBytes, "maxManifestBytes", 4 * 1024 * 1024),
    maxArtifactBytes: positiveInteger(value.maxArtifactBytes, "maxArtifactBytes", 16 * 1024 * 1024 * 1024),
    checkIntervalMs: positiveInteger(value.checkIntervalMs, "checkIntervalMs", 7 * 24 * 60 * 60 * 1000),
  };
}

function parseMetadata(input: unknown): SignedUpdateMetadata {
  const value = object(input, "更新 metadata");
  exactKeys(value, ["schema", "policyVersion", "sequence", "repository", "channel", "platform", "arch", "abi", "version",
    "publishedAt", "expiresAt", "minimumProjectSchema", "minimumOsVersion", "artifact"], "更新 metadata");
  if (value.schema !== "editkin.update-metadata/v1") throw new Error("更新 metadata schema 不支援");
  const artifact = object(value.artifact, "更新 artifact");
  exactKeys(artifact, ["url", "sha256", "size", "authenticodeSubject", "certificateSha256"], "更新 artifact");
  const version = requiredText(value.version, "version", 256);
  parseUpdateVersion(version);
  const publishedAt = requiredText(value.publishedAt, "publishedAt", 64);
  const expiresAt = requiredText(value.expiresAt, "expiresAt", 64);
  if (!Number.isFinite(Date.parse(publishedAt)) || !Number.isFinite(Date.parse(expiresAt))) throw new Error("更新 metadata 時間不合法");
  const sha256 = requiredText(artifact.sha256, "artifact.sha256", 64).toLowerCase();
  const certificateSha256 = requiredText(artifact.certificateSha256, "artifact.certificateSha256", 64).toLowerCase();
  if (!HEX_256.test(sha256) || !HEX_256.test(certificateSha256)) throw new Error("更新 artifact digest 不合法");
  return {
    schema: "editkin.update-metadata/v1",
    policyVersion: positiveInteger(value.policyVersion, "policyVersion", 1_000_000),
    sequence: positiveInteger(value.sequence, "sequence"),
    repository: requiredText(value.repository, "repository", 512),
    channel: requiredText(value.channel, "channel", 32),
    platform: requiredText(value.platform, "platform", 32),
    arch: requiredText(value.arch, "arch", 32),
    abi: requiredText(value.abi, "abi", 32),
    version,
    publishedAt,
    expiresAt,
    minimumProjectSchema: positiveInteger(value.minimumProjectSchema, "minimumProjectSchema", 1_000_000),
    minimumOsVersion: requiredText(value.minimumOsVersion, "minimumOsVersion", 64),
    artifact: {
      url: secureUrl(artifact.url, "artifact.url").href,
      sha256,
      size: positiveInteger(artifact.size, "artifact.size", 16 * 1024 * 1024 * 1024),
      authenticodeSubject: requiredText(artifact.authenticodeSubject, "artifact.authenticodeSubject", 1024),
      certificateSha256,
    },
  };
}

export function parseHighestTrustedUpdateState(input: unknown): HighestTrustedUpdateState {
  const value = object(input, "highest-trusted state");
  exactKeys(value, ["schema", "policyVersion", "highestSequence", "version", "artifactSha256", "metadataSha256", "acceptedAt"], "highest-trusted state");
  if (value.schema !== "editkin.highest-trusted-update/v1") throw new Error("highest-trusted state schema 不支援");
  const version = requiredText(value.version, "state.version", 256);
  parseUpdateVersion(version);
  const artifactSha256 = requiredText(value.artifactSha256, "state.artifactSha256", 64).toLowerCase();
  const metadataSha256 = requiredText(value.metadataSha256, "state.metadataSha256", 64).toLowerCase();
  const acceptedAt = requiredText(value.acceptedAt, "state.acceptedAt", 64);
  if (!HEX_256.test(artifactSha256) || !HEX_256.test(metadataSha256) || !Number.isFinite(Date.parse(acceptedAt))) {
    throw new Error("highest-trusted state 欄位不合法");
  }
  return {
    schema: "editkin.highest-trusted-update/v1",
    policyVersion: positiveInteger(value.policyVersion, "state.policyVersion", 1_000_000),
    highestSequence: positiveInteger(value.highestSequence, "state.highestSequence"),
    version,
    artifactSha256,
    metadataSha256,
    acceptedAt,
  };
}

export function verifyTrustedUpdateEnvelope(input: unknown, policyInput: unknown, options: {
  now?: Date;
  currentVersion: string;
  currentProjectSchema: number;
  currentOsVersion: string;
  currentArtifactSha256?: string;
  highestTrustedState?: unknown;
}): TrustedUpdateDecision {
  const policy = parseUpdateTrustPolicy(policyInput);
  const envelope = object(input, "更新 envelope");
  exactKeys(envelope, ["schema", "keyId", "signed", "signature"], "更新 envelope");
  if (envelope.schema !== "editkin.signed-update-metadata/v1") throw new Error("更新 envelope schema 不支援");
  const keyId = requiredText(envelope.keyId, "keyId", 64);
  if (keyId !== policy.publisherKeyId) throw new Error("更新 metadata keyId 不符合內建信任政策");
  const metadata = parseMetadata(envelope.signed);
  const signatureText = requiredText(envelope.signature, "signature", 256);
  if (!/^[A-Za-z0-9_-]{86}$/u.test(signatureText)) throw new Error("更新 metadata signature 編碼不合法");
  const signature = Buffer.from(signatureText, "base64url");
  if (signature.byteLength !== 64 || !verify(null, Buffer.from(canonicalJson(metadata)), policy.publisherPublicKeyPem, signature)) {
    throw new Error("更新 metadata Ed25519 簽章驗證失敗");
  }
  if (metadata.policyVersion !== policy.policyVersion || metadata.repository !== policy.repository
    || metadata.channel !== policy.channel || metadata.platform !== policy.platform || metadata.arch !== policy.arch
    || metadata.abi !== policy.abi) throw new Error("更新 metadata 與內建 repo／channel／platform 信任政策不一致");
  if (metadata.artifact.authenticodeSubject !== policy.authenticodeSubject
    || metadata.artifact.certificateSha256 !== policy.authenticodeCertificateSha256) {
    throw new Error("更新 artifact 發布者與內建 Authenticode 身分不一致");
  }
  const artifactUrl = new URL(metadata.artifact.url);
  if (!artifactUrlWithinBase(artifactUrl, new URL(policy.artifactBaseUrl))) throw new Error("更新 artifact URL 超出內建發行路徑");
  if (metadata.artifact.size > policy.maxArtifactBytes) throw new Error("更新 artifact 超過內建大小上限");
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("更新檢查時間不合法");
  const published = Date.parse(metadata.publishedAt);
  const expires = Date.parse(metadata.expiresAt);
  if (published > now.getTime() + 5 * 60 * 1000) throw new Error("更新 metadata publishedAt 位於未來");
  if (expires <= now.getTime() || expires <= published) throw new Error("更新 metadata 已過期或 expiry 順序不合法");
  parseUpdateVersion(options.currentVersion, "currentVersion");
  const currentArtifact = options.currentArtifactSha256?.toLowerCase();
  if (currentArtifact !== undefined && !HEX_256.test(currentArtifact)) throw new Error("currentArtifactSha256 不合法");
  const metadataSha256 = createHash("sha256").update(canonicalJson(metadata)).digest("hex");
  const previous = options.highestTrustedState === undefined ? undefined : parseHighestTrustedUpdateState(options.highestTrustedState);
  if (previous) {
    if (previous.policyVersion > policy.policyVersion) throw new Error("內建 trust policy 版本低於已信任狀態");
    if (metadata.sequence < previous.highestSequence) throw new Error("拒絕 update metadata rollback／freeze");
    if (metadata.sequence === previous.highestSequence && (metadataSha256 !== previous.metadataSha256
      || metadata.version !== previous.version || metadata.artifact.sha256 !== previous.artifactSha256)) {
      throw new Error("相同 update sequence 出現不同內容，拒絕 mix-and-match");
    }
  }
  const versionOrder = compareUpdateVersions(metadata.version, options.currentVersion);
  if (versionOrder < 0) throw new Error("拒絕版本降級");
  if (versionOrder === 0 && currentArtifact && metadata.artifact.sha256 !== currentArtifact) {
    throw new Error("相同版本出現不同 artifact bytes");
  }
  const nextState: HighestTrustedUpdateState = {
    schema: "editkin.highest-trusted-update/v1",
    policyVersion: policy.policyVersion,
    highestSequence: metadata.sequence,
    version: metadata.version,
    artifactSha256: metadata.artifact.sha256,
    metadataSha256,
    acceptedAt: now.toISOString(),
  };
  if (metadata.minimumProjectSchema > options.currentProjectSchema) {
    return { status: "incompatible", reason: "project_schema", metadata, nextState };
  }
  if (compareNumericVersion(metadata.minimumOsVersion, options.currentOsVersion) > 0) {
    return { status: "incompatible", reason: "operating_system", metadata, nextState };
  }
  return { status: versionOrder === 0 ? "current" : "available", metadata, nextState };
}

export const canonicalizeUpdateMetadataForSigning = canonicalJson;
