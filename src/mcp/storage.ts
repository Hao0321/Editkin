import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireProjectLock, ProjectLockBusyError, ProjectRevisionConflictError, readPrimaryProjectFileWithIdentityV1, readProjectFile, writeProjectFileAtomicWithIdentityV1 } from "../application/projectFiles";
import { applyCommand, type EditorCommand } from "../domain/commands";
import { createEmptyProject, summarizeProject } from "../domain/editGraph";
import type { ProjectFileIdentityV1 } from "../domain/projectFileIdentityV1";
import type { EditProject } from "../domain/types";
import { assertNoDirtyGuiSession } from "./guiSessionState";
import { decideOutsideMediaRead, mediaPathSyntax, outsideMediaRefusalMessage, type OutsideMediaRefusal } from "./outsideMediaGrants";
import { readBoundedFile } from "../shared/boundedFile";
import { sha256Canonical, type AutopilotProjectAuditIdentity } from "../application/autopilotInvocationIdentity";
import { sealPersistentOriginalMotionCommit, verifyOriginalMotionCommitAuthority, type OriginalMotionCommitAuthorityKey } from "../application/originalMotionCommitAuthority";

export class WorkspaceBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceBoundaryError";
  }
}

/** Media outside EDITKIN_WORKSPACE that the MCP server may not read (see outsideMediaGrants.ts). The message never carries a path. */
export class OutsideMediaNotGrantedError extends WorkspaceBoundaryError {
  readonly code = "OUTSIDE_MEDIA_NOT_GRANTED";
  constructor(readonly assetId: string, readonly reason: OutsideMediaRefusal) {
    super(outsideMediaRefusalMessage(assetId, reason));
    this.name = "OutsideMediaNotGrantedError";
  }
}

export function workspaceRoot(): string {
  return resolve(process.env.EDITKIN_WORKSPACE ?? process.env.HAO_EDITOR_WORKSPACE ?? process.cwd());
}

function lexicalWorkspacePath(input: string, field: string): string {
  if (!input.trim()) throw new WorkspaceBoundaryError(`${field} 不可空白`);
  const root = workspaceRoot();
  const target = resolve(root, input);
  const relation = relative(root, target);
  if (relation.startsWith("..") || isAbsolute(relation)) throw new WorkspaceBoundaryError(`${field} 超出 EDITKIN_WORKSPACE`);
  return target;
}

async function nearestExistingRealPath(path: string): Promise<string> {
  let candidate = path;
  while (true) {
    try { return await realpath(candidate); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

async function assertCanonicalWorkspaceBoundary(target: string): Promise<string> {
  const [canonicalRoot, canonicalTargetOrAncestor] = await Promise.all([
    realpath(workspaceRoot()),
    nearestExistingRealPath(target),
  ]);
  const relation = relative(canonicalRoot, canonicalTargetOrAncestor);
  if (relation.startsWith("..") || isAbsolute(relation)) {
    throw new WorkspaceBoundaryError("路徑透過 symlink／junction 超出 EDITKIN_WORKSPACE");
  }
  return target;
}

export async function resolveProjectPath(input: string): Promise<string> {
  const target = lexicalWorkspacePath(input, "projectPath");
  if (extname(target).toLowerCase() !== ".json" || !/\.(?:editkin|haoedit)\.json$/i.test(target)) {
    throw new WorkspaceBoundaryError("專案檔必須使用 .editkin.json 副檔名（舊 .haoedit.json 仍可讀）");
  }
  return assertCanonicalWorkspaceBoundary(target);
}

export async function resolveRenderPath(input: string): Promise<string> {
  const target = lexicalWorkspacePath(input, "outputPath");
  if (extname(target).toLowerCase() !== ".mp4") throw new WorkspaceBoundaryError("輸出檔必須使用 .mp4 副檔名");
  return assertCanonicalWorkspaceBoundary(target);
}

export async function resolveLutExportPath(input: string): Promise<string> {
  const target = lexicalWorkspacePath(input, "outputPath");
  if (extname(target).toLowerCase() !== ".cube") throw new WorkspaceBoundaryError("LUT 匯出檔必須使用 .cube 副檔名");
  return assertCanonicalWorkspaceBoundary(target);
}

export async function resolveWorkspaceMediaPath(input: string): Promise<string> {
  return assertCanonicalWorkspaceBoundary(lexicalWorkspacePath(input, "素材路徑"));
}

/** The file identity of the bytes this process just wrote for a returned project object. */
const savedFileIdentities = new WeakMap<EditProject, ProjectFileIdentityV1>();

export async function readProject(projectPath: string): Promise<EditProject> {
  return readProjectFile(await resolveProjectPath(projectPath));
}

/** creative://, editkin-composition:// and other multi-letter schemes are not filesystem paths (a drive letter is one letter). */
const VIRTUAL_URI = /^[a-z][a-z0-9+.-]+:\/\//i;
const isVirtualAssetUri = (uri: string) => VIRTUAL_URI.test(uri) && !/^file:/i.test(uri);

/** The local path of a file reference (plain path or file: URL); undefined when a file: URL cannot be a local path. */
function assetLocalPath(uri: string): string | undefined {
  if (!/^file:/i.test(uri)) return uri;
  try { return fileURLToPath(uri); } catch { return undefined; }
}

/**
 * Where to read a project asset's media. Inside the workspace this is exactly resolveWorkspaceMediaPath. Outside it, the
 * saved project is not an authority (a crafted or shared project can name any file): see outsideMediaGrants.ts. UNC,
 * `\\?\`, `\\.\`, `//` and device references are refused before any filesystem call; a local outside file must be media,
 * canonicalise without escaping, and be granted by the desktop app (unchanged since) or lie under EDITKIN_EXTRA_MEDIA_ROOTS.
 * Returns the canonical path for an allowed outside file.
 */
export async function resolveProjectAssetReadPath(_project: EditProject, asset: { id: string; uri: string }): Promise<string> {
  if (isVirtualAssetUri(asset.uri)) return resolveWorkspaceMediaPath(asset.uri);
  const local = assetLocalPath(asset.uri);
  const syntax = local === undefined ? "not_local" : mediaPathSyntax(local);
  if (local === undefined || syntax === "not_local") throw new OutsideMediaNotGrantedError(asset.id, "not_local");
  try { return await resolveWorkspaceMediaPath(local); }
  catch (error) {
    if (!(error instanceof WorkspaceBoundaryError) || syntax !== "local_absolute") throw error;
    const decision = await decideOutsideMediaRead(local);
    if (!decision.allowed) throw new OutsideMediaNotGrantedError(asset.id, decision.reason);
    return decision.path;
  }
}

/**
 * Before an MCP renderer reads a whole project: every local asset source must be readable by resolveProjectAssetReadPath.
 * An outside file that does not exist is left to the renderer (there is nothing to read); every other refusal stands.
 */
export async function assertProjectMediaReadable(project: EditProject): Promise<void> {
  for (const asset of project.assets) {
    if (isVirtualAssetUri(asset.uri)) continue;
    try { await resolveProjectAssetReadPath(project, asset); }
    catch (error) { if (!(error instanceof OutsideMediaNotGrantedError && error.reason === "missing")) throw error; }
  }
}

async function onDiskAssetUris(path: string): Promise<ReadonlyMap<string, string>> {
  try { return new Map((await readProjectFile(path)).assets.map((asset) => [asset.id, asset.uri])); }
  catch { return new Map(); }
}

export async function writeProject(projectPath: string, project: EditProject, expectedRevision: number | null = project.revision,
  options: { beforeCommit?: () => Promise<void>; createOnly?: boolean } = {}): Promise<EditProject> {
  const path = await resolveProjectPath(projectPath);
  // Never write underneath a desktop editor session with unsaved changes, unless the call explicitly allowed it.
  await assertNoDirtyGuiSession(path);
  // A desktop process has a different working directory and no MCP workspace.
  // Bind local files while this process still knows their workspace; retain
  // virtual composition/creative URIs and leave the caller's audited plan intact.
  const persisted = structuredClone(project);
  let onDisk: ReadonlyMap<string, string> | undefined;
  for (const asset of persisted.assets) {
    if (!asset.uri.startsWith("creative://") && !asset.uri.startsWith("editkin-composition://")) {
      const local = asset.uri.startsWith("file:") ? fileURLToPath(asset.uri) : asset.uri;
      try { asset.uri = await resolveWorkspaceMediaPath(local); }
      catch (error) {
        // B4: media the saved project already references outside the workspace (imported in the desktop editor) stays
        // an unchanged, read-only reference. Only a new or changed reference must lie inside EDITKIN_WORKSPACE.
        if (!(error instanceof WorkspaceBoundaryError) || !isAbsolute(local)) throw error;
        onDisk ??= await onDiskAssetUris(path);
        if (onDisk.get(asset.id) !== asset.uri) throw error;
      }
    }
    if (asset.derivatives) {
      for (const key of ["proxyUri", "overlayProxyUri", "thumbnailUri", "waveformUri"] as const) {
        const uri = asset.derivatives[key];
        // Verified caches may already live outside the media workspace.
        if (uri && !isAbsolute(uri)) asset.derivatives[key] = await resolveWorkspaceMediaPath(uri);
      }
    }
    if (asset.imageSequence?.previewUri && !isAbsolute(asset.imageSequence.previewUri)) {
      asset.imageSequence.previewUri = await resolveWorkspaceMediaPath(asset.imageSequence.previewUri);
    }
  }
  const { project: saved, fileIdentity } = await writeProjectFileAtomicWithIdentityV1(path, persisted, expectedRevision, options);
  savedFileIdentities.set(saved, fileIdentity);
  return saved;
}

export async function createProjectFile(
  projectPath: string,
  name: string,
  width: number,
  height: number,
  fps: number,
  initialCommands: EditorCommand[] = [],
  beforeCommit?: () => Promise<void>,
  options: { createOnly?: boolean } = {},
): Promise<EditProject> {
  const project = createEmptyProject(name, {
    id: `project-${Date.now()}`,
    width,
    height,
    fps,
  });
  return writeProject(projectPath, initialCommands.length ? applyCommand(project, { type: "batch", commands: initialCommands }) : project, null,
    { beforeCommit, ...(options.createOnly ? { createOnly: true } : {}) });
}

export async function applyProjectCommands(
  projectPath: string,
  commands: EditorCommand[],
  expectedRevision?: number,
): Promise<EditProject> {
  const rejectUnverifiedRelink = (command: EditorCommand): void => {
    if (command.type === "rebind_reference_motion_clip_source") throw new WorkspaceBoundaryError("Use prepare_reference_motion_template_source_replacement and independently audited canonical v4; raw commands cannot authorize a template source replacement");
    if (command.type === "revise_motion_scene_graphics") throw new WorkspaceBoundaryError("ORIGINAL_SCENE_MANUAL_PREPARATION_REQUIRED: manual scene content editing cannot be submitted through raw automation; use actual versioned source-bound canonical v4 for automatic owner changes");
    if (command.type === "revise_original_motion_scene_graphic") throw new WorkspaceBoundaryError("ORIGINAL_SOURCE_OWNER_AUTHORITY_REQUIRED: canonical source owner revisions require independent audited source compilation");
    if (command.type === "relink_asset_source") throw new WorkspaceBoundaryError("Use prepare_media_source_relink/apply_media_source_relink; raw commands cannot verify relocated media bytes");
    if (command.type === "batch") command.commands.forEach(rejectUnverifiedRelink);
  };
  commands.forEach(rejectUnverifiedRelink);
  let project = await readProject(projectPath);
  if (expectedRevision !== undefined && project.revision !== expectedRevision) {
    throw new ProjectRevisionConflictError(expectedRevision, project.revision);
  }
  for (const command of commands) project = applyCommand(project, command);
  return writeProject(projectPath, project, expectedRevision ?? project.revision);
}

export interface StoredProject {
  project: EditProject;
  /** SHA-256 of the exact file bytes read (or just written), as in editkin.project-file-identity/v1; VA's sha256_file. */
  projectSha256: string | null;
  /** "previous" when the primary file was missing or unreadable and the last good generation was read instead. */
  readFrom: "primary" | "previous";
}

/** readProject plus the identity of the bytes it read. Errors are exactly readProject's. */
export async function readStoredProject(projectPath: string): Promise<StoredProject> {
  const path = await resolveProjectPath(projectPath);
  for (const [readFrom, candidate] of [["primary", path], ["previous", `${path}.previous`]] as const) {
    try {
      const { project, fileIdentity } = await readPrimaryProjectFileWithIdentityV1(candidate);
      return { project, projectSha256: fileIdentity.projectSha256, readFrom };
    } catch { /* fall through to the next generation, then to readProject's own error */ }
  }
  // Same message and code as every other reader; a file that appeared meanwhile is still returned honestly.
  return { project: await readProject(projectPath), projectSha256: null, readFrom: "primary" };
}

/** Keeps a summary response under 2 KB even with long CJK asset names. */
export const MISSING_MEDIA_LIST_LIMIT = 6;
const MISSING_MEDIA_NAME_CHARS = 32;

export interface ProjectMediaState {
  /** Assets whose local file is absent. Never carries a path; at most MISSING_MEDIA_LIST_LIMIT items. */
  missingMedia: { count: number; items: Array<{ assetId: string; name: string; kind: string; reason: "missing" | "unreadable"; inWorkspace: boolean }>; hasMore: boolean };
  /** Media referenced outside EDITKIN_WORKSPACE: never written; read only when granted by the desktop app or under EDITKIN_EXTRA_MEDIA_ROOTS. */
  outsideWorkspaceMedia: number;
}

/** Existence check of every local asset file (creative:// and composition URIs are virtual and not checked). */
export async function projectMediaState(project: EditProject, listLimit = MISSING_MEDIA_LIST_LIMIT): Promise<ProjectMediaState> {
  const root = workspaceRoot();
  const items: ProjectMediaState["missingMedia"]["items"] = [];
  let count = 0, outside = 0;
  for (const asset of project.assets) {
    if (asset.uri.startsWith("creative://") || asset.uri.startsWith("editkin-composition://")) continue;
    const local = assetLocalPath(asset.uri) ?? asset.uri;
    // UNC, \\?\, \\.\, // and device references are never stat'ed (no SMB connection): reported unreadable.
    const notLocal = !isVirtualAssetUri(asset.uri) && (assetLocalPath(asset.uri) === undefined || mediaPathSyntax(local) === "not_local");
    const absolute = isAbsolute(local) ? local : resolve(root, local);
    const relation = relative(root, absolute);
    const inWorkspace = !notLocal && !relation.startsWith("..") && !isAbsolute(relation);
    if (!inWorkspace) outside += 1;
    let reason: "missing" | "unreadable" | undefined = notLocal ? "unreadable" : undefined;
    if (!notLocal) {
      try { await stat(absolute); }
      catch (error) { reason = ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "") ? "missing" : "unreadable"; }
    }
    if (!reason) continue;
    count += 1;
    if (items.length < listLimit) {
      const name = asset.name.length > MISSING_MEDIA_NAME_CHARS ? `${asset.name.slice(0, MISSING_MEDIA_NAME_CHARS - 1)}…` : asset.name;
      items.push({ assetId: asset.id.slice(0, 96), name, kind: asset.kind, reason, inWorkspace });
    }
  }
  return { missingMedia: { count, items, hasMore: count > items.length }, outsideWorkspaceMedia: outside };
}

/**
 * SHA-256 of the saved bytes of exactly this project object: the identity this process recorded when it wrote it, or,
 * for a project read earlier in the call, the file on disk if it still holds the same id/revision/updatedAt (else null).
 */
export async function projectFileSha256(projectPath: string, project: EditProject): Promise<string | null> {
  const saved = savedFileIdentities.get(project);
  if (saved) return saved.projectSha256;
  const path = await resolveProjectPath(projectPath);
  for (const candidate of [path, `${path}.previous`]) {
    try {
      const { fileIdentity } = await readPrimaryProjectFileWithIdentityV1(candidate);
      if (fileIdentity.projectId === project.id && fileIdentity.revision === project.revision && fileIdentity.updatedAt === project.updatedAt) return fileIdentity.projectSha256;
    } catch { /* next generation */ }
  }
  return null;
}

/** The B3 project state every agent-facing summary carries: revision (in the summary), file SHA and media state. */
export async function projectSummaryState(projectPath: string, project: EditProject, known: { projectSha256?: string | null; readFrom?: "primary" | "previous" } = {}) {
  return {
    summary: summarizeProject(project),
    projectSha256: known.projectSha256 !== undefined ? known.projectSha256 : await projectFileSha256(projectPath, project),
    ...(known.readFrom === "previous" ? { readFrom: "previous" as const } : {}),
    ...await projectMediaState(project),
  };
}

export async function inspectProject(projectPath: string) {
  const stored = await readStoredProject(projectPath);
  return { status: "GREEN" as const, ...await projectSummaryState(projectPath, stored.project, stored) };
}

/** A project file or its recoverable previous generation exists. */
export async function projectFileExists(absoluteProjectPath: string): Promise<boolean> {
  for (const candidate of [absoluteProjectPath, `${absoluteProjectPath}.previous`]) {
    try { await access(candidate); return true; } catch { /* next */ }
  }
  return false;
}

/**
 * Whether another Editkin window or agent holds the project's save lock or its v4 autopilot execution lock right now.
 * Probes only locks whose directory already exists, so it never creates lock directories beside a project.
 */
export async function projectLockState(absoluteProjectPath: string): Promise<{ saveLocked: boolean; autopilotLocked: boolean }> {
  const held = async (base: string): Promise<boolean> => {
    try { await access(`${base}.lock`); } catch { return false; }
    try { await (await acquireProjectLock(base, { maximumAttempts: 1 }))(); return false; }
    catch (error) { return error instanceof ProjectLockBusyError || (error as NodeJS.ErrnoException).code !== "ENOENT"; }
  };
  const [saveLocked, autopilotLocked] = await Promise.all([held(absoluteProjectPath), held(`${absoluteProjectPath}.autopilot-execution`)]);
  return { saveLocked, autopilotLocked };
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, path);
}

async function evidenceDirectory(projectPath: string, folder: string): Promise<{ directory: string; projectBase: string }> {
  const absoluteProject = await resolveProjectPath(projectPath);
  const directory = resolve(dirname(absoluteProject), folder);
  await assertCanonicalWorkspaceBoundary(directory);
  await mkdir(directory, { recursive: true });
  await assertCanonicalWorkspaceBoundary(directory);
  return { directory, projectBase: basename(absoluteProject).replace(/\.(?:editkin|haoedit)\.json$/i, "") };
}

export async function writePendingAutopilotReceipt(projectPath: string, receipt: Record<string, unknown>): Promise<{ receiptId: string; pendingPath: string }> {
  const { directory, projectBase } = await evidenceDirectory(projectPath, ".editkin-receipts");
  const receiptId = `${Date.now()}-${randomUUID()}`;
  const pendingPath = resolve(directory, `${projectBase}.${receiptId}.pending.json`);
  await writeJsonAtomic(pendingPath, { ...receipt, receiptId, state: "pending" });
  return { receiptId, pendingPath };
}

export async function commitAutopilotReceipt(pendingPath: string, receipt: Record<string, unknown>, originalCommitKey?: OriginalMotionCommitAuthorityKey): Promise<string> {
  await assertCanonicalWorkspaceBoundary(pendingPath);
  if (!pendingPath.endsWith(".pending.json")) throw new WorkspaceBoundaryError("receipt 必須是 pending 狀態");
  const committedPath = pendingPath.replace(/\.pending\.json$/, ".committed.json");
  const preparedPath = pendingPath.replace(/\.pending\.json$/, ".prepared.json");
  const committed = { ...receipt, state: "committed" };
  if (receipt.originalMotionBinding && !originalCommitKey) throw new Error("Original Motion commit requires its pre-apply prepared signing authority");
  const authenticated = receipt.originalMotionBinding ? await sealPersistentOriginalMotionCommit(committed, originalCommitKey!) : committed;
  await rename(pendingPath, preparedPath);
  await writeJsonAtomic(committedPath, authenticated);
  return basename(committedPath);
}

/** Only owned committed files may reach the original render verifier. */
export async function readAuthenticatedOriginalMotionReceipt(projectPath: string, identity: AutopilotProjectAuditIdentity, planSha256: string): Promise<Record<string, unknown>> {
  if (!/^[a-f0-9]{64}$/.test(planSha256)) throw new Error("Original render plan SHA is invalid");
  const { directory, projectBase } = await evidenceDirectory(projectPath, ".editkin-receipts");
  const canonicalDirectory = await realpath(directory);
  const names = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.startsWith(`${projectBase}.`) && entry.name.endsWith(".committed.json"))
    .map(entry => entry.name).sort().reverse().slice(0, 512);
  for (const name of names) {
    const bytes = await readBoundedFile(resolve(directory, name), 1024 * 1024);
    let receipt: Record<string, unknown>;
    try { receipt = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { continue; }
    if (receipt.planSha256 !== planSha256 || !receipt.originalMotionBinding) continue;
    const authenticated = await verifyOriginalMotionCommitAuthority(receipt);
    if (sha256Canonical(authenticated.projectIdentityAfter) !== sha256Canonical(identity)) throw new Error("Original render committed project is stale");
    if (await realpath(directory) !== canonicalDirectory) throw new Error("Original receipt directory changed during read");
    return authenticated;
  }
  throw new Error("No authenticated original committed receipt for the saved project");
}

export interface AutopilotExecutionAttribution {
  executionReceiptId: string;
  executionReceiptFile: string;
  skillSelectionReceiptSha256: string;
  profileSha256: string;
  selectedSkills: Array<{ skillId: string; manifestSha256: string; packSha256: string }>;
}

export async function readAutopilotExecutionAttribution(projectPath: string, planSha256: string): Promise<AutopilotExecutionAttribution> {
  if (!/^[a-f0-9]{64}$/.test(planSha256)) throw new Error("Outcome planSha256 不合法");
  const { directory, projectBase } = await evidenceDirectory(projectPath, ".editkin-receipts");
  const candidates = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.startsWith(`${projectBase}.`) && entry.name.endsWith(".committed.json"))
    .map((entry) => entry.name)
    .sort()
    .reverse()
    .slice(0, 512);
  for (const name of candidates) {
    const source = await readFile(resolve(directory, name));
    if (source.byteLength > 1024 * 1024) continue;
    let receipt: Record<string, unknown>;
    try { receipt = JSON.parse(source.toString("utf8")); } catch { continue; }
    if (receipt.schema !== "hao.video-autopilot.execution-receipt/v1" || receipt.state !== "committed" || receipt.planSha256 !== planSha256) continue;
    const skillSelection = receipt.skillSelection;
    if (!skillSelection || typeof skillSelection !== "object" || Array.isArray(skillSelection)) continue;
    const selection = skillSelection as Record<string, unknown>;
    if (typeof receipt.receiptId !== "string"
      || typeof selection.receiptSha256 !== "string" || !/^[a-f0-9]{64}$/.test(selection.receiptSha256)
      || typeof selection.profileSha256 !== "string" || !/^[a-f0-9]{64}$/.test(selection.profileSha256)
      || !Array.isArray(selection.selected)) continue;
    const selectedSkills = selection.selected.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Execution receipt 的 selected Skill attribution 不合法");
      const skill = value as Record<string, unknown>;
      if (typeof skill.skillId !== "string" || !/^[a-z][a-z0-9.-]{2,127}\/[a-z][a-z0-9_.-]{0,95}$/.test(skill.skillId)
        || typeof skill.manifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(skill.manifestSha256)
        || typeof skill.packSha256 !== "string" || !/^[a-f0-9]{64}$/.test(skill.packSha256)) {
        throw new Error("Execution receipt 的 selected Skill attribution 不合法");
      }
      return { skillId: skill.skillId, manifestSha256: skill.manifestSha256, packSha256: skill.packSha256 };
    });
    return {
      executionReceiptId: receipt.receiptId,
      executionReceiptFile: name,
      skillSelectionReceiptSha256: selection.receiptSha256,
      profileSha256: selection.profileSha256,
      selectedSkills,
    };
  }
  throw new Error("找不到與 outcome planSha256 對應的 committed execution receipt");
}

export async function writeAutopilotLearningEvent(projectPath: string, event: Record<string, unknown>): Promise<string> {
  const { directory, projectBase } = await evidenceDirectory(projectPath, ".editkin-learning");
  const eventId = `${Date.now()}-${randomUUID()}`;
  const path = resolve(directory, `${projectBase}.${eventId}.json`);
  await writeJsonAtomic(path, { ...event, eventId, recordedAt: new Date().toISOString() });
  return basename(path);
}
