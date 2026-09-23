import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type { EditProject } from "../domain/types";
import { validatePublicAssetRights, validatePublicGrant } from "../shared/visualAssetRights.mjs";
import { creativeAssetIdFromUri } from "../shared/creativeAssetUri";
export { creativeAssetIdFromUri, creativeAssetUri } from "../shared/creativeAssetUri";

const PROCEDURAL_BACKGROUND_IDS = new Set([
  "broll:0d152ac1677e", "broll:0e20a6a51040", "broll:20b4715a9638", "broll:217399fe9b38",
  "broll:2f3e5e265fda", "broll:724f1b44869d", "broll:95edd98fb3a4", "broll:faa0906d5230",
]);

export interface CreativeLibraryAsset {
  id: string;
  name: string;
  category: string;
  role: string;
  domains: string[];
  mediaKind: "video" | "audio" | "image";
  bytes: number;
  license: string;
  provenance: string;
  duration?: number;
  bpm?: number;
  energyDb?: number;
  suggestedUse?: string;
  redistributable?: boolean;
  rightsBasis?: string;
  distributionScope?: "private-owner-only" | "bundled-redistributable";
  sourceFilename?: string;
  width?: number;
  height?: number;
  colorMetadata?: { primaries: string | null; transfer: string | null; matrix: string | null; range: string | null };
  preview?: { poster: boolean; motion: boolean; revision: string };
}

interface CreativePackAsset extends CreativeLibraryAsset {
  path: string;
  sha256: string;
  renderer: string;
  derivatives?: { sourceSha256: string; revision: string; poster?: VisualFile; media?: VisualFile };
}

interface CreativePackManifest {
  ownerVisualGrant?: NonNullable<ReturnType<typeof validatePublicGrant>>["grant"];
  schemaVersion: number;
  id: string;
  name: string;
  version: string;
  attribution: string;
  source: { privateImagesEmbedded: boolean };
  assets: CreativePackAsset[];
  assetCount: number;
  assetBytes: number;
  portability: {
    relativePathsOnly: boolean;
    privateWorkspaceEmbedded: boolean;
    originalPrivateReferencesEmbedded: boolean;
  };
}

const validatedAliases = new WeakMap<CreativePackManifest, NonNullable<ReturnType<typeof validatePublicGrant>>["legacyAliases"]>();
function canonicalAssetId(manifest: CreativePackManifest, id: string): string {
  return validatedAliases.get(manifest)?.find(alias => alias.legacyId === id)?.assetId ?? id;
}

export interface CreativeLibrarySummary {
  id: string;
  name: string;
  version: string;
  attribution: string;
  assetCount: number;
  assetBytes: number;
  assets: CreativeLibraryAsset[];
  musicAssetCount: number;
  sfxAssetCount: number;
  restrictedAssetCount: number;
}

export interface ResolvedCreativeAsset {
  asset: CreativeLibraryAsset;
  absolutePath: string;
  sha256: string;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function manifestPath(packRoot: string): string {
  return resolve(packRoot, "editkin-pack.json");
}

async function readManifest(packRoot: string): Promise<CreativePackManifest> {
  const manifest = JSON.parse(await readFile(manifestPath(packRoot), "utf8")) as CreativePackManifest;
  if (manifest.schemaVersion !== 1 || !manifest.id?.trim() || !Array.isArray(manifest.assets)) throw new Error("Creative Pack manifest 格式不合法");
  if (manifest.source.privateImagesEmbedded || manifest.portability.privateWorkspaceEmbedded
    || manifest.portability.originalPrivateReferencesEmbedded || !manifest.portability.relativePathsOnly) {
    throw new Error("Creative Pack 含私人來源或不可攜路徑，已拒絕載入");
  }
  if (manifest.assets.length !== manifest.assetCount) throw new Error("Creative Pack assetCount 不一致");
  let documentSha256: string | undefined;
  if (manifest.ownerVisualGrant) {
    const documentPath = manifest.ownerVisualGrant.document.path;
    if (typeof documentPath !== "string" || isAbsolute(documentPath) || documentPath.split(/[\\/]+/).some(part => !part || part === "." || part === "..")) throw new Error("Creative Pack grant document path 不安全");
    const base = await realpath(packRoot), document = await realpath(resolve(base, documentPath));
    if (!document.startsWith(`${base}${sep}`) || !(await stat(document)).isFile()) throw new Error("Creative Pack grant document 離開 root");
    documentSha256 = await sha256(document);
  }
  const grant = validatePublicGrant(manifest, { documentSha256 });
  validatedAliases.set(manifest, grant?.legacyAliases ?? []);
  const ids = new Set<string>();
  for (const asset of manifest.assets) {
    if (!asset.id?.trim() || ids.has(asset.id)) throw new Error(`Creative Pack 素材 metadata 不合法：${asset.id}`);
    validatePublicAssetRights(asset, grant?.grant);
    if (!asset.path?.trim() || isAbsolute(asset.path) || asset.path.split(/[\\/]+/).includes("..")) throw new Error(`Creative Pack 素材路徑不安全：${asset.id}`);
    if (!/^[a-f0-9]{64}$/i.test(asset.sha256) || asset.bytes <= 0 || !["video", "audio", "image"].includes(asset.mediaKind)) {
      throw new Error(`Creative Pack 素材完整性資料不合法：${asset.id}`);
    }
    ids.add(asset.id);
    if (asset.derivatives && (asset.derivatives.sourceSha256 !== asset.sha256
      || !/^[a-f0-9]{64}$/.test(asset.derivatives.revision)
      || [asset.derivatives.poster, asset.derivatives.media].some(file => file !== undefined && !safeVisualFile(file)))) throw new Error("Creative Pack preview binding 不合法");
  }
  return manifest;
}

function publicAsset(asset: CreativePackAsset): CreativeLibraryAsset {
  const { id, name, category, role, domains, mediaKind, bytes, license, provenance } = asset;
  const proceduralBackground = category === "broll" && PROCEDURAL_BACKGROUND_IDS.has(id)
    && provenance === "domain_broll_pack.py procedural original";
  return { id, name, category: proceduralBackground ? "motion" : category,
    role: proceduralBackground ? "motion-background" : role, domains: [...domains], mediaKind, bytes, license, provenance,
    ...(asset.duration !== undefined ? {duration: asset.duration} : {}),
    ...(asset.width !== undefined ? {width: asset.width} : {}),
    ...(asset.height !== undefined ? {height: asset.height} : {}),
    ...(asset.colorMetadata ? {colorMetadata: {...asset.colorMetadata}} : {}),
    ...(asset.sourceFilename ? {sourceFilename: asset.sourceFilename} : {}),
    ...(asset.rightsBasis !== undefined ? {rightsBasis: asset.rightsBasis} : {}),
    ...(asset.distributionScope !== undefined ? {distributionScope: asset.distributionScope} : {}),
    ...(asset.redistributable !== undefined ? {redistributable: asset.redistributable} : {}),
    ...(asset.derivatives ? { preview: {poster:!!asset.derivatives.poster,motion:!!asset.derivatives.media,revision:asset.derivatives.revision} } : {}) };
}

interface PersonalMusicAsset extends CreativePackAsset {
  duration: number;
  bpm: number;
  energyDb: number;
  suggestedUse: string;
  rightsBasis: "owner-attestation-2026-08-22";
  redistributable: true;
}

interface PersonalMusicManifest {
  schemaVersion: 2;
  id: "studio.hao.personal-music-library";
  name: string;
  version: string;
  attribution: string;
  distributionScope: "community-redistributable";
  redistributable: true;
  provenanceAudit: {
    status: "owner_attested_ai_generated";
    publicExportAllowed: true;
    attestationId: "owner-attestation-2026-08-22";
    independentPlatformTermsVerified: false;
  };
  assets: PersonalMusicAsset[];
  assetCount: number;
  assetBytes: number;
}

async function pathExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function readPersonalMusicManifest(root: string): Promise<PersonalMusicManifest> {
  const manifest = JSON.parse(await readFile(resolve(root, "editkin-personal-music.json"), "utf8")) as PersonalMusicManifest;
  if (manifest.schemaVersion !== 2 || manifest.id !== "studio.hao.personal-music-library" || manifest.distributionScope !== "community-redistributable"
    || manifest.redistributable !== true || manifest.provenanceAudit?.status !== "owner_attested_ai_generated"
    || manifest.provenanceAudit?.publicExportAllowed !== true || manifest.provenanceAudit?.attestationId !== "owner-attestation-2026-08-22"
    || manifest.provenanceAudit?.independentPlatformTermsVerified !== false || !Array.isArray(manifest.assets)
    || manifest.assetCount !== manifest.assets.length) throw new Error("Community Music Pack manifest 格式或散布聲明不合法");
  const ids = new Set<string>();
  for (const asset of manifest.assets) {
    if (!asset.id.startsWith("music:") || ids.has(asset.id) || asset.license !== "HAO-COMMUNITY-ASSET-GRANT-1.0"
      || asset.rightsBasis !== "owner-attestation-2026-08-22" || asset.redistributable !== true
      || asset.mediaKind !== "audio" || !Number.isFinite(asset.duration) || asset.duration <= 0 || !Number.isFinite(asset.bpm) || asset.bpm <= 0
      || !asset.path?.trim() || isAbsolute(asset.path) || asset.path.split(/[\\/]+/).includes("..") || !/^[a-f0-9]{64}$/i.test(asset.sha256) || asset.bytes <= 0) {
      throw new Error(`Community Music Pack 素材 metadata 不合法：${asset.id}`);
    }
    ids.add(asset.id);
  }
  return manifest;
}

function publicPersonalMusicAsset(asset: PersonalMusicAsset): CreativeLibraryAsset {
  const base = publicAsset(asset);
  return { ...base, duration: asset.duration, bpm: asset.bpm, energyDb: asset.energyDb, suggestedUse: asset.suggestedUse, redistributable: true };
}

interface VisualFile { path: string; bytes: number; sha256: string }
interface PrivateVisualAsset extends CreativePackAsset {
  width: number; height: number; duration: number; rightsBasis: "private-owner-only";
  derivatives: { sourceSha256: string; revision: string; poster?: VisualFile; media?: VisualFile };
}
interface PrivateVisualManifest {
  schemaVersion: 1; id: "studio.hao.personal-visual-library";
  distributionScope: "private-owner-only"; redistributable: false;
  assets: PrivateVisualAsset[]; assetCount: number; assetBytes: number;
}
function safeVisualFile(file: VisualFile): boolean {
  return !!file && typeof file.path === "string" && /^[a-zA-Z0-9_.\-/]+$/.test(file.path)
    && !isAbsolute(file.path) && !file.path.split("/").some(part => !part || part === "." || part === "..")
    && Number.isSafeInteger(file.bytes) && file.bytes > 0 && /^[a-f0-9]{64}$/.test(file.sha256);
}
async function readPrivateVisualManifest(root: string): Promise<PrivateVisualManifest> {
  const manifest = JSON.parse(await readFile(resolve(root, "editkin-personal-visual.json"), "utf8")) as PrivateVisualManifest;
  if (manifest.schemaVersion !== 1 || manifest.id !== "studio.hao.personal-visual-library"
    || manifest.distributionScope !== "private-owner-only" || manifest.redistributable !== false
    || !Array.isArray(manifest.assets) || manifest.assetCount !== manifest.assets.length) throw new Error("Private Visual Pack manifest 不合法");
  const ids = new Set<string>();
  let bytes = 0;
  for (const asset of manifest.assets) {
    if (!/^private-visual:[a-f0-9]{20}$/.test(asset.id) || ids.has(asset.id) || !safeVisualFile(asset)
      || asset.redistributable !== false || asset.rightsBasis !== "private-owner-only" || asset.license !== "PRIVATE-OWNER-ONLY"
      || asset.mediaKind !== "video" || !["broll", "motion", "transition", "private_animation"].includes(asset.category)
      || typeof asset.name !== "string" || !asset.name.trim() || !Array.isArray(asset.domains)
      || !asset.domains.every(domain => typeof domain === "string") || typeof asset.provenance !== "string"
      || !Number.isInteger(asset.width) || asset.width <= 0 || !Number.isInteger(asset.height) || asset.height <= 0
      || !Number.isFinite(asset.duration) || asset.duration <= 0
      || asset.derivatives?.sourceSha256 !== asset.sha256 || !/^[a-f0-9]{64}$/.test(asset.derivatives?.revision ?? "")
      || [asset.derivatives.poster, asset.derivatives.media].some(file => file !== undefined && !safeVisualFile(file))) throw new Error(`Private Visual Pack 素材不合法：${asset.id}`);
    ids.add(asset.id); bytes += asset.bytes;
  }
  if (manifest.assetBytes !== bytes) throw new Error("Private Visual Pack assetBytes 不一致");
  return manifest;
}
function publicPrivateVisualAsset(asset: PrivateVisualAsset): CreativeLibraryAsset {
  return { ...publicAsset(asset), duration: asset.duration, width: asset.width, height: asset.height,
    ...(asset.sourceFilename ? {sourceFilename:asset.sourceFilename} : {}),
    ...(asset.colorMetadata ? {colorMetadata:asset.colorMetadata} : {}),
    rightsBasis: asset.rightsBasis, distributionScope: "private-owner-only", redistributable: false,
    preview: { poster: !!asset.derivatives.poster, motion: !!asset.derivatives.media, revision: asset.derivatives.revision } };
}
async function verifiedVisualPath(root: string, file: VisualFile): Promise<string> {
  const base = await realpath(root), path = await realpath(resolve(base, file.path));
  if (!path.startsWith(`${base}${sep}`)) throw new Error("Creative Pack 路徑離開 root");
  const info = await stat(path);
  if (!info.isFile() || info.size !== file.bytes || await sha256(path) !== file.sha256) throw new Error("Creative Pack 素材完整性驗證失敗");
  return path;
}

export async function listCreativeLibrary(packRoot: string, personalMusicRoot?: string, personalVisualRoot?: string): Promise<CreativeLibrarySummary> {
  const manifest = await readManifest(packRoot);
  const music = personalMusicRoot && await pathExists(resolve(personalMusicRoot, "editkin-personal-music.json"))
    ? await readPersonalMusicManifest(personalMusicRoot) : undefined;
  const musicAssets = music?.assets.map(publicPersonalMusicAsset) ?? [];
  const visual = personalVisualRoot && await pathExists(resolve(personalVisualRoot, "editkin-personal-visual.json"))
    ? await readPrivateVisualManifest(personalVisualRoot) : undefined;
  const uniqueVisual = (visual?.assets ?? []).filter(asset => {
    const alias = validatedAliases.get(manifest)?.find(item => item.legacyId === asset.id);
    if (!alias) return true;
    if (asset.sha256 !== alias.sha256 || asset.bytes !== alias.bytes) throw new Error("Creative Pack legacy alias 與私人來源 hash/bytes 衝突");
    return false;
  });
  const visualAssets = uniqueVisual.map(publicPrivateVisualAsset);
  const grantedIds = new Set(validatedAliases.get(manifest)?.map(alias => alias.assetId));
  const publicAssets = [...manifest.assets.filter(asset => grantedIds.has(asset.id)), ...manifest.assets.filter(asset => !grantedIds.has(asset.id))].map(publicAsset);
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    attribution: manifest.attribution,
    assetCount: manifest.assetCount + musicAssets.length + visualAssets.length,
    assetBytes: manifest.assetBytes + (music?.assetBytes ?? 0) + uniqueVisual.reduce((sum, asset) => sum + asset.bytes, 0),
    assets: [...visualAssets, ...publicAssets, ...musicAssets],
    musicAssetCount: musicAssets.length,
    sfxAssetCount: manifest.assets.filter((asset) => asset.category === "sfx").length,
    restrictedAssetCount: visualAssets.length + musicAssets.filter((asset) => asset.redistributable === false).length,
  };
}

export async function resolveCreativeLibraryAsset(packRoot: string, assetId: string, personalMusicRoot?: string, personalVisualRoot?: string): Promise<ResolvedCreativeAsset> {
  const publicManifest = assetId.startsWith("music:") ? undefined : await readManifest(packRoot);
  if (publicManifest) assetId = canonicalAssetId(publicManifest, assetId);
  if (assetId.startsWith("private-visual:")) {
    if (!personalVisualRoot) throw new Error("Private Visual Pack runtime 未安裝");
    const source = (await readPrivateVisualManifest(personalVisualRoot)).assets.find(asset => asset.id === assetId);
    if (!source) throw new Error(`Private Visual Pack 找不到素材：${assetId}`);
    return { asset: publicPrivateVisualAsset(source), absolutePath: await verifiedVisualPath(personalVisualRoot, source), sha256: source.sha256 };
  }
  const personal = assetId.startsWith("music:");
  if (personal && !personalMusicRoot) throw new Error("Community Music Pack runtime 未安裝");
  const manifest = personal ? await readPersonalMusicManifest(personalMusicRoot!) : publicManifest!;
  const source = manifest.assets.find((asset) => asset.id === assetId);
  if (!source) throw new Error(`Creative Pack 找不到素材：${assetId}`);
  const absolutePath = await verifiedVisualPath(personal ? personalMusicRoot! : packRoot, source);
  return { asset: personal ? publicPersonalMusicAsset(source as PersonalMusicAsset) : publicAsset(source), absolutePath, sha256: source.sha256 };
}

export async function resolveCreativeLibraryPreviewAsset(packRoot: string, assetId: string, mode: "poster" | "media", personalMusicRoot?: string, personalVisualRoot?: string): Promise<ResolvedCreativeAsset> {
  if (mode !== "poster" && mode !== "media") throw new Error("Creative preview mode 不合法");
  const publicManifest = assetId.startsWith("music:") ? undefined : await readManifest(packRoot);
  if (publicManifest) assetId = canonicalAssetId(publicManifest, assetId);
  if (!assetId.startsWith("private-visual:")) {
    if (!assetId.startsWith("music:")) {
      const source = publicManifest!.assets.find(asset => asset.id === assetId);
      const file = source?.derivatives?.[mode];
      if (source && file) return {asset:publicAsset(source),absolutePath:await verifiedVisualPath(packRoot,file),sha256:file.sha256};
    }
    if (mode === "poster") throw new Error("Creative Pack 沒有已驗證的 poster");
    return resolveCreativeLibraryAsset(packRoot, assetId, personalMusicRoot, personalVisualRoot);
  }
  if (!personalVisualRoot) throw new Error("Private Visual Pack runtime 未安裝");
  const source = (await readPrivateVisualManifest(personalVisualRoot)).assets.find(asset => asset.id === assetId);
  if (!source) throw new Error("Private Visual Pack 找不到素材");
  const file = source.derivatives[mode] ?? (mode === "media" ? source : undefined);
  if (!file) throw new Error("Private Visual Pack 沒有已驗證的 poster");
  return { asset: publicPrivateVisualAsset(source), absolutePath: await verifiedVisualPath(personalVisualRoot, file), sha256: file.sha256 };
}

export async function materializeCreativeAssets(project: EditProject, packRoot: string, personalMusicRoot?: string, personalVisualRoot?: string): Promise<EditProject> {
  const copy = structuredClone(project);
  for (const asset of copy.assets) {
    const creativeId = creativeAssetIdFromUri(asset.uri);
    if (creativeId) asset.uri = (await resolveCreativeLibraryAsset(packRoot, creativeId, personalMusicRoot, personalVisualRoot)).absolutePath;
  }
  return copy;
}
