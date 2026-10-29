import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EditProject, MediaAsset, RotoMatteSequence } from "../domain/types";
import { resolveProjectAssetReadPath, resolveWorkspaceMediaPath, workspaceRoot, WorkspaceBoundaryError } from "./storage";

/** creative://, editkin-composition:// and other multi-letter schemes are not files (the same rule as storage.ts). */
const VIRTUAL_URI = /^[a-z][a-z0-9+.-]+:\/\//i;
const isVirtualAssetUri = (uri: string) => VIRTUAL_URI.test(uri) && !/^file:/i.test(uri);

/** The preview derivatives a saved asset may name (see MediaDerivatives). */
export const RENDER_DERIVATIVE_URI_KEYS = ["proxyUri", "overlayProxyUri", "thumbnailUri", "waveformUri"] as const;
type DerivativeKey = typeof RENDER_DERIVATIVE_URI_KEYS[number];

function localPathOf(uri: string): string | undefined {
  if (!/^file:/i.test(uri)) return uri;
  try { return fileURLToPath(uri); } catch { return undefined; }
}
const isInside = (root: string, path: string) => {
  const relation = relative(root, path);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
};
const comparable = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;

async function canonicalOrMissing(path: string): Promise<string | undefined> {
  try { return await realpath(path); }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw error;
  }
}

/**
 * The media cache an MCP render trusts for derivatives and Auto Roto mattes: the same root renderTools passes to the
 * renderer as autoRotoCacheRoot (the desktop app's media-cache when Agent Connect launched this server).
 */
export function mcpMediaCacheRoot(environment: NodeJS.ProcessEnv = process.env): string {
  return resolve(environment.EDITKIN_CACHE_ROOT ?? resolve(environment.EDITKIN_MODEL_ROOT ?? resolve(workspaceRoot(), ".editkin-models"), "../media-cache"));
}

export type RenderMediaRefusal = "not_local" | "outside_cache" | "link_escape" | "not_canonical";
const REFUSAL_HINTS: Record<RenderMediaRefusal, string> = {
  not_local: "只接受本機磁碟上的檔案路徑。",
  outside_cache: "它不在 Editkin 媒體快取裡，也不在工作區內。",
  link_escape: "路徑經 symlink／junction 指到 Editkin 媒體快取之外。",
  not_canonical: "路徑中含 symlink／junction；Auto Roto 檔案必須以實際路徑記錄。",
};

/** A derivative or matte the render will not read. The message never carries a path (like OUTSIDE_MEDIA_NOT_GRANTED). */
export class RenderMediaRefusedError extends WorkspaceBoundaryError {
  readonly code = "RENDER_MEDIA_REFUSED";
  constructor(readonly owner: string, readonly field: string, readonly reason: RenderMediaRefusal) {
    super(`RENDER_MEDIA_REFUSED (${reason}): ${JSON.stringify(owner.slice(0, 96))} 的 ${field} 不會被讀取。${REFUSAL_HINTS[reason]}`
      + "請在 Editkin 桌面版重新產生或重新匯入，或用與桌面版相同的 EDITKIN_CACHE_ROOT 啟動 MCP。");
    this.name = "RenderMediaRefusedError";
  }
}

interface BindingContext {
  project: EditProject;
  workspace: string;
  cacheLexical: string;
  cacheCanonical?: string;
}

/** Workspace files keep their URI (the renderer resolves them against the workspace exactly as before). */
async function workspaceFile(context: BindingContext, local: string): Promise<boolean> {
  if (!isInside(context.workspace, resolve(context.workspace, local))) return false;
  try { await resolveWorkspaceMediaPath(local); return true; }
  catch (error) { if (error instanceof WorkspaceBoundaryError) return false; throw error; }
}

/** A cache file: its canonical path if it exists and stays inside the canonical cache root; undefined when missing. */
async function cacheFile(context: BindingContext, absolute: string, owner: string, field: string): Promise<string | undefined> {
  const canonical = await canonicalOrMissing(absolute);
  if (canonical === undefined) return undefined;
  if (!context.cacheCanonical || !isInside(context.cacheCanonical, canonical)) throw new RenderMediaRefusedError(owner, field, "link_escape");
  return canonical;
}

/**
 * A preview derivative: kept when it is a workspace file; the canonical cache path when it is in the media cache (dropped
 * from the render copy when the cache no longer has it, so nothing unchecked can be read); otherwise it must be granted
 * outside media like any asset (resolveProjectAssetReadPath), or the render fails.
 */
async function bindDerivative(context: BindingContext, asset: MediaAsset, key: DerivativeKey, uri: string): Promise<{ uri: string } | "keep" | "drop"> {
  if (isVirtualAssetUri(uri)) return "keep";
  const local = localPathOf(uri);
  if (local === undefined) throw new RenderMediaRefusedError(asset.id, `derivatives.${key}`, "not_local");
  if (await workspaceFile(context, local)) return "keep";
  if (isAbsolute(local) && isInside(context.cacheLexical, resolve(local))) {
    const canonical = await cacheFile(context, resolve(local), asset.id, `derivatives.${key}`);
    return canonical === undefined ? "drop" : canonical === uri ? "keep" : { uri: canonical };
  }
  const granted = await resolveProjectAssetReadPath(context.project, { id: `${asset.id}#derivatives.${key}`, uri });
  return granted === uri ? "keep" : { uri: granted };
}

/**
 * An Auto Roto matte file: a workspace file, or a file in the media cache recorded by its real path (the renderer checks
 * the manifest against these exact paths, so they are verified, never rewritten). Anything else fails the render.
 */
async function checkMatteFile(context: BindingContext, owner: string, field: string, uri: string): Promise<void> {
  const local = isVirtualAssetUri(uri) ? undefined : localPathOf(uri);
  if (local === undefined) throw new RenderMediaRefusedError(owner, field, "not_local");
  if (await workspaceFile(context, local)) return;
  const absolute = resolve(context.workspace, local);
  if (!isAbsolute(local) || !isInside(context.cacheLexical, absolute)) throw new RenderMediaRefusedError(owner, field, "outside_cache");
  const canonical = await cacheFile(context, absolute, owner, field);
  // Missing: nothing to read; the renderer's product-cache verification refuses a missing matte the export uses.
  if (canonical !== undefined && comparable(canonical) !== comparable(absolute)) throw new RenderMediaRefusedError(owner, field, "not_canonical");
}

function matteSequences(project: EditProject): Array<{ owner: string; sequence: RotoMatteSequence }> {
  const found: Array<{ owner: string; sequence: RotoMatteSequence }> = [];
  for (const track of [...project.tracks, ...(project.compositions ?? []).flatMap(composition => composition.tracks)]) {
    for (const clip of track.clips) for (const mask of clip.masks ?? []) if (mask.matteSequence) found.push({ owner: `${clip.id}/${mask.id}`, sequence: mask.matteSequence });
  }
  return found;
}

/**
 * The project an MCP render reads (security follow-up to 16b3a10: the check and the read must name the same file).
 *
 * - Workspace files keep their URI, so a workspace-only project renders exactly as before (the same project object).
 * - An asset outside EDITKIN_WORKSPACE gets the canonical path resolveProjectAssetReadPath checked (a desktop grant or
 *   an EDITKIN_EXTRA_MEDIA_ROOTS file): the renderer then opens that resolved file, not the project's own path, through
 *   which a junction or symlink could be swapped in between the check and the read.
 * - An outside asset that is missing, ungranted, changed or not local fails the render here; nothing is skipped.
 * - Preview derivatives and Auto Roto mattes follow the same rule with the media cache as a second trusted root (see
 *   bindDerivative and checkMatteFile).
 *
 * Every MCP render entry must render the returned project: renderAutopilotProject (sync, async job, original motion,
 * autopilot batch), the exact-copy, source-preserving and source-clock tools, and the multi-source Short.
 */
export async function bindProjectMediaForRender(project: EditProject, options: { cacheRoot?: string } = {}): Promise<EditProject> {
  const cacheLexical = options.cacheRoot ? resolve(options.cacheRoot) : mcpMediaCacheRoot();
  const context: BindingContext = { project, workspace: resolve(workspaceRoot()), cacheLexical, cacheCanonical: await canonicalOrMissing(cacheLexical) };
  let assets: EditProject["assets"] | undefined;
  for (const [index, asset] of project.assets.entries()) {
    let bound = asset;
    if (!isVirtualAssetUri(asset.uri)) {
      const local = localPathOf(asset.uri);
      let inside = false;
      if (local !== undefined) {
        try { await resolveWorkspaceMediaPath(local); inside = true; }
        catch (error) { if (!(error instanceof WorkspaceBoundaryError)) throw error; }
      }
      // Outside the workspace (or not a local path at all): grant or refuse, and read only what was granted.
      if (!inside) bound = { ...bound, uri: await resolveProjectAssetReadPath(project, asset) };
    }
    if (asset.derivatives) {
      let derivatives: MediaAsset["derivatives"] | undefined;
      for (const key of RENDER_DERIVATIVE_URI_KEYS) {
        const uri = asset.derivatives[key];
        if (typeof uri !== "string") continue;
        const decision = await bindDerivative(context, asset, key, uri);
        if (decision === "keep") continue;
        derivatives ??= { ...asset.derivatives };
        if (decision === "drop") delete derivatives[key]; else derivatives[key] = decision.uri;
      }
      if (derivatives) bound = { ...bound, derivatives };
    }
    if (bound !== asset) { assets ??= [...project.assets]; assets[index] = bound; }
  }
  for (const { owner, sequence } of matteSequences(project)) {
    await checkMatteFile(context, owner, "matteSequence.sequenceUri", sequence.sequenceUri);
    await checkMatteFile(context, owner, "matteSequence.manifestUri", sequence.manifestUri);
    for (const [frame, uri] of (sequence.frameArtifactUris ?? []).entries()) await checkMatteFile(context, owner, `matteSequence.frameArtifactUris[${frame}]`, uri);
  }
  return assets ? { ...project, assets } : project;
}
