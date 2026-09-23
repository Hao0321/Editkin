import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectRevisionConflictError, readProjectFile, writeProjectFileAtomic } from "../application/projectFiles";
import { applyCommand, type EditorCommand } from "../domain/commands";
import { createEmptyProject, summarizeProject } from "../domain/editGraph";
import type { EditProject } from "../domain/types";

export class WorkspaceBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceBoundaryError";
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

export async function resolveWorkspaceMediaPath(input: string): Promise<string> {
  return assertCanonicalWorkspaceBoundary(lexicalWorkspacePath(input, "素材路徑"));
}

export async function readProject(projectPath: string): Promise<EditProject> {
  return readProjectFile(await resolveProjectPath(projectPath));
}

export async function writeProject(projectPath: string, project: EditProject, expectedRevision: number | null = project.revision): Promise<EditProject> {
  const path = await resolveProjectPath(projectPath);
  // A desktop process has a different working directory and no MCP workspace.
  // Bind local files while this process still knows their workspace; retain
  // virtual composition/creative URIs and leave the caller's audited plan intact.
  const persisted = structuredClone(project);
  for (const asset of persisted.assets) {
    if (!asset.uri.startsWith("creative://") && !asset.uri.startsWith("editkin-composition://")) {
      asset.uri = await resolveWorkspaceMediaPath(asset.uri.startsWith("file:") ? fileURLToPath(asset.uri) : asset.uri);
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
  return writeProjectFileAtomic(path, persisted, expectedRevision);
}

export async function createProjectFile(
  projectPath: string,
  name: string,
  width: number,
  height: number,
  fps: number,
): Promise<EditProject> {
  const project = createEmptyProject(name, {
    id: `project-${Date.now()}`,
    width,
    height,
    fps,
  });
  return writeProject(projectPath, project, null);
}

export async function applyProjectCommands(
  projectPath: string,
  commands: EditorCommand[],
  expectedRevision?: number,
): Promise<EditProject> {
  let project = await readProject(projectPath);
  if (expectedRevision !== undefined && project.revision !== expectedRevision) {
    throw new ProjectRevisionConflictError(expectedRevision, project.revision);
  }
  for (const command of commands) project = applyCommand(project, command);
  return writeProject(projectPath, project, expectedRevision ?? project.revision);
}

export async function inspectProject(projectPath: string) {
  const project = await readProject(projectPath);
  return { status: "GREEN" as const, summary: summarizeProject(project) };
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

export async function commitAutopilotReceipt(pendingPath: string, receipt: Record<string, unknown>): Promise<string> {
  await assertCanonicalWorkspaceBoundary(pendingPath);
  if (!pendingPath.endsWith(".pending.json")) throw new WorkspaceBoundaryError("receipt 必須是 pending 狀態");
  const committedPath = pendingPath.replace(/\.pending\.json$/, ".committed.json");
  const preparedPath = pendingPath.replace(/\.pending\.json$/, ".prepared.json");
  await rename(pendingPath, preparedPath);
  await writeJsonAtomic(committedPath, { ...receipt, state: "committed" });
  return basename(committedPath);
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
