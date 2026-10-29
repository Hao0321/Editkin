import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { MEDIA_EXTENSIONS_BY_KIND } from "../application/mediaDiscovery";
import { readBoundedFile } from "../shared/boundedFile";
import { isWindowsNetworkPath } from "../shared/localMediaPath";
import { editkinAppDataRoot } from "./guiSessionState";

/**
 * Outside-workspace media reads for MCP (security finding 2026-10-23, follow-up to the W2-2 B4 rule).
 *
 * A saved project file is not an authority: anyone can hand the user a crafted `.editkin.json` whose assets point at
 * a file inside the user profile (`…\secret.mov`) or at `\\attacker\share\x.mov`. The MCP server therefore reads media outside
 * EDITKIN_WORKSPACE only when every one of these holds:
 *
 * 1. the reference is a plain local absolute path, decided from its text alone, before any filesystem call:
 *    never UNC (`\\host\share`), `\\?\…`, `\\.\…`, `\??\…`, `//…`, a DOS device name, an NTFS stream, a
 *    drive- or root-relative path or a relative path (no SMB connection, so no NTLM credential leak);
 * 2. it has a video/audio/image extension (the media discovery table), before and after canonicalisation;
 * 3. it canonicalises with realpath to a local regular file;
 * 4. and either the canonical file lies under a canonical EDITKIN_EXTRA_MEDIA_ROOTS root (a symlink/junction
 *    inside a root that resolves outside every root is refused), or the Editkin desktop app granted exactly that
 *    canonical path and the file still has the granted size, modification time and first-64-KiB SHA-256.
 *
 * Grants live in `<app data>/media-access/outside-media-grants.json` (schema editkin.outside-media-grants/v1). Only
 * the desktop host writes them (src-tauri/src/outside_media_grants.rs): the media chooser, drag-and-drop, relink,
 * and the creator's 允許 when the desktop app asks about an opened project's media outside its folder. Opening a
 * project grants nothing (a crafted or shared project must not hand an agent the files it points at); projects saved
 * before grants existed are asked about once when opened. Grants an earlier build recorded automatically on project
 * open (`source: "project_open"`) are not honoured. This module only reads the store; nothing on the MCP side ever
 * creates or extends a grant.
 */

export const OUTSIDE_MEDIA_GRANTS_SCHEMA = "editkin.outside-media-grants/v1";
export const OUTSIDE_MEDIA_GRANTS_SCHEMA_VERSION = 1;
export const OUTSIDE_MEDIA_GRANT_HEAD_BYTES = 64 * 1024;
export const OUTSIDE_MEDIA_GRANTS_MAX = 20_000;
export const EXTRA_MEDIA_ROOTS_ENV = "EDITKIN_EXTRA_MEDIA_ROOTS";
const MAX_STORE_BYTES = 16 * 1024 * 1024;
const MAX_EXTRA_ROOTS = 32;
const MAX_PATH_CHARS = 4096;
const SHA256 = /^[a-f0-9]{64}$/;

export type OutsideMediaRefusal =
  | "not_local" | "not_media" | "missing" | "unreadable" | "link_escape" | "changed_since_import" | "not_granted";

export type OutsideMediaDecision =
  | { allowed: true; path: string; via: "extra_root" | "grant" }
  | { allowed: false; reason: OutsideMediaRefusal };

export interface OutsideMediaGrant {
  path: string;
  size: number;
  mtimeMs: number;
  headSha256: string;
  headBytes: number;
  grantedAtMs: number;
  source: OutsideMediaGrantSource;
}

/** Explicit acts of the creator in the desktop app. `project_open` (automatic, before the consent fix) is not one. */
export const OUTSIDE_MEDIA_GRANT_SOURCES = ["import", "relink", "project_consent"] as const;
export type OutsideMediaGrantSource = typeof OUTSIDE_MEDIA_GRANT_SOURCES[number];

/**
 * How a media reference may be resolved, from its text alone (never touches the filesystem).
 * "not_local": UNC, `\\?\`, `\\.\`, `\??\`, `//`, DOS device names, `:` streams, drive- or root-relative forms.
 */
export function mediaPathSyntax(path: string, platform: NodeJS.Platform = process.platform): "not_local" | "relative" | "local_absolute" {
  if (!path || path.length > MAX_PATH_CHARS || path.includes("\0")) return "not_local";
  if (platform === "win32") {
    const normalized = path.replaceAll("/", "\\");
    if (normalized.startsWith("\\\\") || normalized.startsWith("\\??\\") || isWindowsNetworkPath(normalized)) return "not_local";
    if (/^[A-Za-z]:\\/.test(normalized)) return normalized.includes(":", 2) ? "not_local" : "local_absolute";
    if (normalized.includes(":") || normalized.startsWith("\\")) return "not_local";
    return "relative";
  }
  if (path.startsWith("//")) return "not_local";
  return path.startsWith("/") ? "local_absolute" : "relative";
}

const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set(Object.values(MEDIA_EXTENSIONS_BY_KIND).flat());

export function hasMediaExtension(path: string): boolean {
  return MEDIA_EXTENSIONS.has(extname(path).toLowerCase());
}

function comparablePath(path: string): string {
  return process.platform === "win32" ? path.replaceAll("/", "\\").toLowerCase() : path;
}

function isInside(root: string, path: string): boolean {
  const relation = relative(root, path);
  return relation !== "" && relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
}

/** EDITKIN_EXTRA_MEDIA_ROOTS: path-delimiter separated absolute local folders the user allows; other entries are ignored. */
export function extraMediaRoots(environment: NodeJS.ProcessEnv = process.env): string[] {
  const raw = environment[EXTRA_MEDIA_ROOTS_ENV];
  if (!raw) return [];
  return raw.split(delimiter).map(entry => entry.trim()).filter(entry => mediaPathSyntax(entry) === "local_absolute")
    .slice(0, MAX_EXTRA_ROOTS).map(entry => resolve(entry));
}

export function outsideMediaGrantStorePath(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const root = editkinAppDataRoot(environment);
  return root ? join(root, "media-access", "outside-media-grants.json") : undefined;
}

const nonNegativeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Valid grants of a store document, keyed by comparable canonical path. Anything malformed grants nothing. */
export function parseOutsideMediaGrantStore(value: unknown): Map<string, OutsideMediaGrant> {
  const grants = new Map<string, OutsideMediaGrant>();
  if (!value || typeof value !== "object" || Array.isArray(value)) return grants;
  const store = value as Record<string, unknown>;
  if (store.schema !== OUTSIDE_MEDIA_GRANTS_SCHEMA || store.schemaVersion !== OUTSIDE_MEDIA_GRANTS_SCHEMA_VERSION || !Array.isArray(store.grants)) return grants;
  for (const item of store.grants.slice(0, OUTSIDE_MEDIA_GRANTS_MAX)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const grant = item as Record<string, unknown>;
    if (typeof grant.path !== "string" || mediaPathSyntax(grant.path) !== "local_absolute" || !hasMediaExtension(grant.path)
      || !nonNegativeInteger(grant.size) || !nonNegativeInteger(grant.mtimeMs) || !nonNegativeInteger(grant.grantedAtMs)
      || typeof grant.headSha256 !== "string" || !SHA256.test(grant.headSha256)
      || grant.headBytes !== Math.min(grant.size, OUTSIDE_MEDIA_GRANT_HEAD_BYTES)
      || !(OUTSIDE_MEDIA_GRANT_SOURCES as readonly unknown[]).includes(grant.source)) continue;
    grants.set(comparablePath(grant.path), {
      path: grant.path, size: grant.size, mtimeMs: grant.mtimeMs, headSha256: grant.headSha256, headBytes: grant.headBytes,
      grantedAtMs: grant.grantedAtMs, source: grant.source as OutsideMediaGrant["source"],
    });
  }
  return grants;
}

let storeCache: { path: string; fingerprint: string; grants: ReadonlyMap<string, OutsideMediaGrant> } | undefined;

/** The desktop app's grants (read only). A missing, unreadable, oversized or malformed store grants nothing. */
export async function readOutsideMediaGrants(environment: NodeJS.ProcessEnv = process.env): Promise<ReadonlyMap<string, OutsideMediaGrant>> {
  const path = outsideMediaGrantStorePath(environment);
  if (!path) return new Map();
  let fingerprint: string;
  try {
    const info = await stat(path, { bigint: true });
    fingerprint = `${info.ino}:${info.size}:${info.mtimeNs}`;
  } catch { return new Map(); }
  if (storeCache?.path === path && storeCache.fingerprint === fingerprint) return storeCache.grants;
  let grants: ReadonlyMap<string, OutsideMediaGrant>;
  try { grants = parseOutsideMediaGrantStore(JSON.parse((await readBoundedFile(path, MAX_STORE_BYTES)).toString("utf8"))); }
  catch { grants = new Map(); }
  storeCache = { path, fingerprint, grants };
  return grants;
}

async function headSha256(path: string, bytes: number): Promise<string | undefined> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    let offset = 0;
    while (offset < bytes) {
      const { bytesRead } = await handle.read(buffer, offset, bytes - offset, offset);
      if (bytesRead === 0) return undefined;
      offset += bytesRead;
    }
    return createHash("sha256").update(buffer).digest("hex");
  } finally { await handle.close(); }
}

const refuse = (reason: OutsideMediaRefusal): OutsideMediaDecision => ({ allowed: false, reason });

/**
 * Whether the MCP server may read `local`, a media reference outside EDITKIN_WORKSPACE, and the canonical path to read.
 * The text checks run first, so UNC and device references are refused without any filesystem call.
 */
export async function decideOutsideMediaRead(local: string, environment: NodeJS.ProcessEnv = process.env): Promise<OutsideMediaDecision> {
  if (mediaPathSyntax(local) !== "local_absolute") return refuse("not_local");
  const lexical = resolve(local);
  if (!hasMediaExtension(lexical)) return refuse("not_media");
  let canonical: string;
  try { canonical = await realpath(lexical); }
  catch (error) { return refuse(["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "") ? "missing" : "unreadable"); }
  // A mapped network drive canonicalises to UNC: still not local media.
  if (mediaPathSyntax(canonical) !== "local_absolute") return refuse("not_local");
  if (!hasMediaExtension(canonical)) return refuse("not_media");
  let info: BigIntStats;
  try { info = await stat(canonical, { bigint: true }); } catch { return refuse("unreadable"); }
  if (!info.isFile()) return refuse("not_media");

  let lexicallyUnderRoot = false;
  for (const root of extraMediaRoots(environment)) {
    if (isInside(root, lexical)) lexicallyUnderRoot = true;
    let canonicalRoot: string;
    try { canonicalRoot = await realpath(root); } catch { continue; }
    if (mediaPathSyntax(canonicalRoot) !== "local_absolute") continue;
    if (isInside(canonicalRoot, canonical)) return { allowed: true, path: canonical, via: "extra_root" };
  }

  const grant = (await readOutsideMediaGrants(environment)).get(comparablePath(canonical));
  if (!grant) return refuse(lexicallyUnderRoot ? "link_escape" : "not_granted");
  if (BigInt(grant.size) !== info.size || BigInt(grant.mtimeMs) !== info.mtimeNs / 1_000_000n) return refuse("changed_since_import");
  try { if (await headSha256(canonical, grant.headBytes) !== grant.headSha256) return refuse("changed_since_import"); }
  catch { return refuse("unreadable"); }
  return { allowed: true, path: canonical, via: "grant" };
}

const REFUSAL_HINTS: Record<OutsideMediaRefusal, string> = {
  not_local: "只接受本機磁碟上的一般檔案路徑；網路共用（UNC）、\\\\?\\、\\\\.\\、// 與裝置路徑一律拒絕，請先把檔案複製到本機磁碟。",
  not_media: "工作區外只允許讀取影片、聲音或圖片檔。",
  missing: "找不到這個檔案。",
  unreadable: "無法讀取這個檔案。",
  link_escape: "路徑經 symlink／junction 指到 EDITKIN_EXTRA_MEDIA_ROOTS 之外。",
  changed_since_import: "檔案在 Editkin 桌面版允許讀取後已變更（大小、修改時間或內容不同），需要再允許一次。",
  not_granted: "創作者還沒有在 Editkin 桌面版允許 AI 助手讀取這個檔案。",
};

/** What the creator can do, in every refusal: only an action on their own computer grants access. */
export const OUTSIDE_MEDIA_GRANT_HINT = "請在 Editkin 桌面版開啟這個專案，並在「要允許 AI 助手讀取它們嗎？」的提示選「允許」；"
  + "或把它所在的資料夾加入 EDITKIN_EXTRA_MEDIA_ROOTS。";

/** A compact (well under 2 KB) refusal that never carries a path. */
export function outsideMediaRefusalMessage(assetId: string, reason: OutsideMediaRefusal): string {
  const id = JSON.stringify(assetId.slice(0, 96));
  return `OUTSIDE_MEDIA_NOT_GRANTED (${reason}): 素材 ${id} 位於 EDITKIN_WORKSPACE 之外，MCP 未獲授權讀取。${REFUSAL_HINTS[reason]}`
    + OUTSIDE_MEDIA_GRANT_HINT;
}
