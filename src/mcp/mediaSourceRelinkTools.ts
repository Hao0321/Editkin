import type { McpServer } from "@modelcontextprotocol/server";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { applyCommand } from "../domain/commands";
import type { EditProject, MediaAsset } from "../domain/types";
import { prepareReferenceMotionMediaRelink } from "../application/referenceMotionMediaRelink";
import { writeProjectFileAtomic } from "../application/projectFiles";
import { sha256Canonical } from "../application/autopilotInvocationIdentity";
import { inspectMedia } from "../application/inspectMedia";
import type { MediaProbe } from "../render/ffmpegContracts";
import { assertLocalMediaPath } from "../shared/localMediaPath";
import { readProject, resolveProjectPath, resolveWorkspaceMediaPath, workspaceRoot } from "./storage";
import { errorResult, textResult } from "./toolRuntime";

export const MEDIA_SOURCE_RELINK_TIMEOUT_MS = 60_000;
export const prepareMediaSourceRelinkInputSchema = z.strictObject({
  projectPath: z.string().min(1).max(1024), assetId: z.string().min(1).max(160),
  sourcePath: z.string().min(1).max(1024), expectedProjectRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  expectedSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const applyMediaSourceRelinkInputSchema = prepareMediaSourceRelinkInputSchema.extend({
  expectedPreparationSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type PrepareMediaSourceRelinkInput = z.input<typeof prepareMediaSourceRelinkInputSchema>;
export type ApplyMediaSourceRelinkInput = z.input<typeof applyMediaSourceRelinkInputSchema>;

export interface MediaSourceRelinkDependencies {
  readProject: typeof readProject;
  resolveProjectPath: typeof resolveProjectPath;
  resolveWorkspaceMediaPath: typeof resolveWorkspaceMediaPath;
  workspaceRoot: typeof workspaceRoot;
  inspect: (path: string, ffprobePath?: string) => Promise<MediaProbe>;
  writeProjectAtomic: typeof writeProjectFileAtomic;
  ffprobePath?: string;
}
const productionDependencies = (): MediaSourceRelinkDependencies => ({ readProject, resolveProjectPath,
  resolveWorkspaceMediaPath, workspaceRoot, inspect: inspectMedia, writeProjectAtomic: writeProjectFileAtomic,
  ffprobePath: process.env.HAO_FFPROBE_PATH });

function lifetime(signal?: AbortSignal) {
  const deadline = performance.now() + MEDIA_SOURCE_RELINK_TIMEOUT_MS;
  return () => {
    signal?.throwIfAborted();
    if (performance.now() >= deadline) throw new Error("Media relink exceeded its 60-second preparation/commit budget");
  };
}
function within(root: string, path: string) {
  const relation = relative(root, path);
  if (!relation || relation === ".." || relation.startsWith("../") || relation.startsWith("..\\") || isAbsolute(relation)) {
    throw new Error("Relink media must be a regular file inside the current workspace");
  }
}
function fileIdentity(value: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }) {
  return { dev: value.dev, ino: value.ino, bytes: value.size, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs };
}
async function observeSource(pathInput: string, rootInput: string, check: () => void) {
  check(); assertLocalMediaPath(pathInput);
  const lexical = resolve(pathInput), lexicalRoot = resolve(rootInput);
  within(lexicalRoot, lexical);
  const entry = await lstat(lexical); check();
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size <= 0 || !Number.isSafeInteger(entry.size)) throw new Error("Relink media must be a nonempty regular file, never a link or sequence");
  const [root, path] = await Promise.all([realpath(lexicalRoot), realpath(lexical)]); check();
  assertLocalMediaPath(path); within(root, path);
  const handle = await open(path, "r");
  try {
    const before = await handle.stat(); check();
    if (!before.isFile() || sha256Canonical(fileIdentity(entry)) !== sha256Canonical(fileIdentity(before))) throw new Error("Relink media changed before opening");
    const digest = createHash("sha256"), buffer = Buffer.allocUnsafe(512 * 1024);
    let bytes = 0;
    while (true) {
      check(); const block = await handle.read(buffer, 0, buffer.length, null); check();
      if (!block.bytesRead) break;
      bytes += block.bytesRead; digest.update(buffer.subarray(0, block.bytesRead));
    }
    const after = await handle.stat(), leafAfter = await lstat(lexical); check();
    if (bytes !== before.size || leafAfter.isSymbolicLink()
      || sha256Canonical(fileIdentity(before)) !== sha256Canonical(fileIdentity(after))
      || sha256Canonical(fileIdentity(before)) !== sha256Canonical(fileIdentity(leafAfter))
      || await realpath(lexical) !== path || await realpath(lexicalRoot) !== root) throw new Error("Relink media path or bytes changed while reading SHA-256");
    check(); return { path, bytes, sha256: digest.digest("hex"), identity: fileIdentity(after), workspace: root };
  } finally { await handle.close(); }
}
function assertSourceProbe(asset: MediaAsset, probe: MediaProbe, project: EditProject) {
  if (probe.imageSequence || !Number.isFinite(probe.duration) || Math.abs(probe.duration - asset.duration) > 1e-6) throw new Error("Relink duration differs from the saved source; use a new source-replacement workflow");
  if (asset.kind === "video") {
    if (!probe.hasVideo || probe.width !== asset.width || probe.height !== asset.height) throw new Error("Relink video display dimensions differ from the saved source");
    if (asset.displayAspectRatio !== undefined && (probe.displayAspectRatio === undefined
      || Math.abs(probe.displayAspectRatio - asset.displayAspectRatio) > 1e-6)) throw new Error("Relink upright display aspect ratio differs from the saved source");
  } else if (!probe.hasAudio || probe.hasVideo) throw new Error("Relink source is not the saved audio media kind");
  for (const track of project.tracks) for (const clip of track.clips) if (clip.assetId === asset.id
    && clip.sourceStart + clip.duration > probe.duration + 1e-6) throw new Error("Relink would lose an existing source window");
}

async function prepareInternal(input: PrepareMediaSourceRelinkInput, dependencies: MediaSourceRelinkDependencies, check: () => void) {
  const request = prepareMediaSourceRelinkInputSchema.parse(input); check();
  const rootInput = dependencies.workspaceRoot();
  // Resolve only the new contained location. The stored missing/outside URI is
  // graph data and never read or used to expand a filesystem grant.
  const sourcePath = await dependencies.resolveWorkspaceMediaPath(request.sourcePath); check();
  if (extname(sourcePath).toLowerCase() === ".json") throw new Error("Relink only supports single-file video/audio, never sequence manifests");
  const projectPath = await dependencies.resolveProjectPath(request.projectPath); check();
  const project = await dependencies.readProject(request.projectPath); check();
  if (project.revision !== request.expectedProjectRevision) throw new Error("Media relink project revision is stale");
  const projectSha256 = sha256Canonical(project);
  const asset = project.assets.find(row => row.id === request.assetId);
  if (!asset || asset.compositionId || asset.imageSequence || (asset.kind !== "video" && asset.kind !== "audio")
    || /^(?:creative|editkin-composition|blob|data|https?):/i.test(asset.uri)) throw new Error("Relink supports only an existing single-file local video/audio asset");
  if (asset.derivatives?.sourceSha256 !== request.expectedSourceSha256) throw new Error("Relink requires the original saved source SHA-256; unpinned or different media is not accepted");
  const source = await observeSource(sourcePath, rootInput, check);
  if (source.sha256 !== request.expectedSourceSha256) throw new Error("Relink file SHA-256 differs from the original saved media");
  const probe = await dependencies.inspect(source.path, dependencies.ffprobePath); check();
  assertSourceProbe(asset, probe, project);
  const prepared = await prepareReferenceMotionMediaRelink(project, asset.id, source.path, source.sha256); check();
  if (dependencies.workspaceRoot() !== rootInput || sha256Canonical(await dependencies.readProject(request.projectPath)) !== projectSha256) throw new Error("Relink project/workspace changed during preparation");
  const after = await observeSource(sourcePath, rootInput, check);
  if (sha256Canonical(source) !== sha256Canonical(after)) throw new Error("Relink source changed during probe or scope preparation");
  if (dependencies.workspaceRoot() !== rootInput) throw new Error("Relink workspace changed during source observation");
  check();
  const binding = { schema: "editkin.media-source-relink-binding/v1" as const,
    project: { id: project.id, revision: project.revision, sha256: projectSha256, path: projectPath },
    assetId: asset.id, previousUri: asset.uri, source, probeSha256: sha256Canonical(probe),
    managedCommandSha256: sha256Canonical(prepared.commands), affectedInstances: prepared.affectedInstances.map(row => row.instanceId) };
  return { status: prepared.status, readOnly: true as const, mutationPerformed: false as const,
    neutralSameSourceRelocationOnly: true as const, differentMediaReplacement: false as const,
    request, binding, preparationSha256: sha256Canonical(binding), probe, prepared, project, workspaceInput: rootInput,
    capabilityBoundary: "Verified same bytes and preparation freshness; no media lock, legal rights, new Motion artwork, render or installed capability is certified" };
}
export async function prepareMediaSourceRelinkReadOnly(input: PrepareMediaSourceRelinkInput,
  dependencies: MediaSourceRelinkDependencies = productionDependencies(), signal?: AbortSignal) {
  const { project: _project, ...result } = await prepareInternal(input, dependencies, lifetime(signal));
  return result;
}
export async function applyMediaSourceRelink(input: ApplyMediaSourceRelinkInput,
  dependencies: MediaSourceRelinkDependencies = productionDependencies(), signal?: AbortSignal) {
  const { expectedPreparationSha256, ...request } = applyMediaSourceRelinkInputSchema.parse(input);
  const check = lifetime(signal), result = await prepareInternal(request, dependencies, check);
  if (result.preparationSha256 !== expectedPreparationSha256) throw new Error("Media relink preparation/source/project is stale; prepare again");
  if (!result.prepared.commands.length) return { status: "UNCHANGED" as const, mutationPerformed: false,
    projectRevision: result.project.revision, assetId: result.binding.assetId, sourceSha256: result.binding.source.sha256 };
  const next = applyCommand(result.project, { type: "batch", commands: result.prepared.commands }); check();
  // Preserve all other stored URIs. The generic MCP writer normalizes every URI;
  // this exact neutral operation must not rehash or silently alter unrelated scopes.
  const saved = await dependencies.writeProjectAtomic(result.binding.project.path, next, result.project.revision, {
    beforeCommit: async () => {
      check();
      if (dependencies.workspaceRoot() !== result.workspaceInput) throw new Error("Relink workspace changed before commit");
      if (sha256Canonical(await dependencies.readProject(request.projectPath)) !== result.binding.project.sha256) throw new Error("Relink project content changed before commit");
      const source = await observeSource(result.binding.source.path, dependencies.workspaceRoot(), check);
      if (sha256Canonical(source) !== sha256Canonical(result.binding.source)) throw new Error("Relink media changed before commit");
      if (dependencies.workspaceRoot() !== result.workspaceInput) throw new Error("Relink workspace changed during commit observation");
      check();
    },
  });
  return { status: "COMMITTED" as const, mutationPerformed: true, neutralSameSourceRelocationOnly: true,
    differentMediaReplacement: false, projectRevisionBefore: result.project.revision, projectRevisionAfter: saved.revision,
    projectSha256: sha256Canonical(saved), assetId: result.binding.assetId, source: result.binding.source,
    affectedInstances: result.prepared.affectedInstances.map(row => ({ instanceId: row.instanceId,
      instanceRevisionBefore: row.expectedInstanceRevision, instanceRevisionAfter: row.after.instanceRevision })),
    v4MotionRequired: true, previousQaOrArtworkApprovalReusable: false,
    capabilityBoundary: "Source freshness rechecked immediately before atomic project rename, without an OS media lock; no output, rights, artwork or performance approval" };
}
export function registerMediaSourceRelinkTools(server: McpServer, dependencies: MediaSourceRelinkDependencies = productionDependencies()) {
  server.registerTool("prepare_media_source_relink", {
    description: "唯讀準備：已保存原素材SHA一致的新工作區本機單檔，驗真bytes/probe與所有受影響模板CURRENT。只重連同一素材，保持IDs／畫面／時鐘／音訊；不讀舊越界路徑、不替換不同影片、不複製素材、不授權Motion成片。回傳preparationSha供正式原子套用，後續Motion仍唯一revision6/v4。",
    inputSchema: prepareMediaSourceRelinkInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input, context) => { try { return textResult(await prepareMediaSourceRelinkReadOnly(input, dependencies, context.mcpReq.signal)); } catch (error) { return errorResult(error); } });
  server.registerTool("apply_media_source_relink", {
    description: "正式中性同素材重連：重新核對prepared SHA、真素材與project revision/full SHA，在專案lease內再次核對後一次atomic保存URI及受影響模板metadata。原視覺／IDs／媒體時鐘保持，不自動產Motion、不沿用舊QA/art；原始媒體唯讀。不同影片替換不支援。",
    inputSchema: applyMediaSourceRelinkInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input, context) => { try { return textResult(await applyMediaSourceRelink(input, dependencies, context.mcpReq.signal)); } catch (error) { return errorResult(error); } });
}
