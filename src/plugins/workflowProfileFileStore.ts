import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { PluginRegistry } from "./registry";
import { findInstalledCapability, installedSkillPackCandidates } from "./registry";
import {
  editkinWorkflowProfileSchema,
  skillPackSha256,
  type EditkinWorkflowProfile,
} from "./skillPack";

const MAX_PROFILE_BYTES = 128 * 1024;

export interface HostWorkflowProfile {
  configured: boolean;
  path?: string;
  profile: EditkinWorkflowProfile;
}

export function safeEmptyWorkflowProfile(): EditkinWorkflowProfile {
  return {
    schema: "hao.editkin.workflow-profile/v1",
    id: "default-safe",
    revision: 1,
    enabledSkills: [],
    priority: [],
    grants: [],
    pluginGrants: [],
    conflictPolicy: "fail_closed",
  };
}

function configuredProfilePath(pathInput = process.env.EDITKIN_WORKFLOW_PROFILE_PATH): string | undefined {
  const value = pathInput?.trim();
  if (!value) return undefined;
  if (!isAbsolute(value)) throw new Error("EDITKIN_WORKFLOW_PROFILE_PATH 必須是絕對路徑");
  return resolve(value);
}

async function assertRegularProfileFile(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("Workflow Profile 必須是一般檔案，不能是 symlink 或資料夾");
    if (metadata.size > MAX_PROFILE_BYTES) throw new Error(`Workflow Profile 超過 ${MAX_PROFILE_BYTES} bytes`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function recoverInterruptedProfileWrite(path: string): Promise<void> {
  const previous = `${path}.previous`;
  try {
    const current = await lstat(path);
    if (current.isSymbolicLink() || !current.isFile()) throw new Error("Workflow Profile 必須是一般檔案，不能是 symlink 或資料夾");
    try {
      const stale = await lstat(previous);
      if (stale.isSymbolicLink() || !stale.isFile()) throw new Error("Workflow Profile previous recovery 檔案不合法");
      await rm(previous);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    const previousMetadata = await lstat(previous);
    if (previousMetadata.isSymbolicLink() || !previousMetadata.isFile()) throw new Error("Workflow Profile previous recovery 檔案不合法");
    if (previousMetadata.size > MAX_PROFILE_BYTES) throw new Error(`Workflow Profile 超過 ${MAX_PROFILE_BYTES} bytes`);
    // A hard link fails if another writer restored the current file first, so a
    // recovery can never overwrite a newer Profile.
    await link(previous, path);
    await rm(previous);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      const current = await lstat(path);
      if (current.isSymbolicLink() || !current.isFile()) throw new Error("Workflow Profile recovery 遇到不合法的新檔案");
      await rm(previous);
      return;
    }
    if (code !== "ENOENT") throw error;
  }
}

async function readRegularProfileSource(path: string): Promise<string> {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error("Workflow Profile 必須是一般檔案，不能是 symlink 或資料夾");
  if (before.size > MAX_PROFILE_BYTES) throw new Error(`Workflow Profile 超過 ${MAX_PROFILE_BYTES} bytes`);
  const handle = await open(path, "r");
  try {
    const opened = await handle.stat();
    const after = await lstat(path);
    if (after.isSymbolicLink() || !after.isFile() || !opened.isFile()) throw new Error("Workflow Profile 在讀取期間被替換");
    if (before.dev !== opened.dev || before.ino !== opened.ino || after.dev !== opened.dev || after.ino !== opened.ino) {
      throw new Error("Workflow Profile 在讀取期間被替換");
    }
    if (opened.size > MAX_PROFILE_BYTES) throw new Error(`Workflow Profile 超過 ${MAX_PROFILE_BYTES} bytes`);
    return handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

export async function readHostWorkflowProfile(pathInput = process.env.EDITKIN_WORKFLOW_PROFILE_PATH): Promise<HostWorkflowProfile> {
  const path = configuredProfilePath(pathInput);
  if (!path) return { configured: false, profile: safeEmptyWorkflowProfile() };
  await recoverInterruptedProfileWrite(path);
  await assertRegularProfileFile(path);
  try {
    const source = await readRegularProfileSource(path);
    if (Buffer.byteLength(source, "utf8") > MAX_PROFILE_BYTES) throw new Error(`Workflow Profile 超過 ${MAX_PROFILE_BYTES} bytes`);
    return { configured: true, path, profile: editkinWorkflowProfileSchema.parse(JSON.parse(source)) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { configured: true, path, profile: safeEmptyWorkflowProfile() };
    throw error;
  }
}

function requiredPermissionForRuntime(runtimeType: string): "project.write" | "render.effect" {
  if (runtimeType === "editgraph_commands") return "project.write";
  if (runtimeType === "native_effect" || runtimeType === "gpu_effect_graph" || runtimeType === "gpu_effect_module") return "render.effect";
  throw new Error(`能力不是可授權的自動化 runtime：${runtimeType}`);
}

export function assertWorkflowProfileMatchesRegistry(profileInput: unknown, registry: PluginRegistry): EditkinWorkflowProfile {
  const profile = editkinWorkflowProfileSchema.parse(profileInput);
  const skills = new Map(installedSkillPackCandidates(registry).map((candidate) => [candidate.skillId, candidate]));
  const grants = new Map(profile.grants.map((grant) => [grant.skillId, grant]));
  for (const skillId of profile.enabledSkills) {
    const skill = skills.get(skillId);
    const grant = grants.get(skillId);
    if (!skill?.planningReady || !grant || grant.manifestSha256 !== skill.manifestSha256 || grant.packSha256 !== skill.packSha256) {
      throw new Error(`Workflow Skill 不存在、尚未 planning-ready，或授權 hash 已漂移：${skillId}`);
    }
  }
  for (const grant of profile.grants) {
    if (!profile.enabledSkills.includes(grant.skillId)) throw new Error(`Workflow Skill grant 未對應已啟用 Skill：${grant.skillId}`);
  }
  for (const grant of profile.pluginGrants) {
    const plugin = registry.plugins.find((candidate) => candidate.manifest.id === grant.pluginId);
    if (!plugin || plugin.manifestSha256 !== grant.manifestSha256) throw new Error(`Plugin automation grant identity 已漂移：${grant.pluginId}`);
    const required = new Set<"project.write" | "render.effect">();
    for (const capabilityId of grant.capabilityIds) {
      const { capability } = findInstalledCapability(registry, grant.pluginId, capabilityId);
      if (!capability.automationReady || capability.readiness !== "AUTOMATION_READY") {
        throw new Error(`Plugin capability 尚未 automation-ready：${grant.pluginId}/${capabilityId}`);
      }
      required.add(requiredPermissionForRuntime(capability.runtime.type));
    }
    const granted = new Set(grant.permissions);
    if ([...required].some((permission) => !granted.has(permission))) throw new Error(`Plugin automation grant 缺少必要權限：${grant.pluginId}`);
    if (grant.permissions.some((permission) => !plugin.manifest.permissions.includes(permission))) {
      throw new Error(`Plugin automation grant 超出 manifest 宣告權限：${grant.pluginId}`);
    }
  }
  return profile;
}

export function assertSelectionUsesHostWorkflowProfile(
  host: HostWorkflowProfile,
  selectionProfileSha256: string,
  registry: PluginRegistry,
): EditkinWorkflowProfile {
  const profile = assertWorkflowProfileMatchesRegistry(host.profile, registry);
  if (skillPackSha256(profile) !== selectionProfileSha256) {
    throw new Error("Skill selection receipt 不是由目前 Editkin Workflow Profile 簽發，或 Profile 已變更");
  }
  return profile;
}

async function writeSynced(path: string, source: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(source, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeHostWorkflowProfileAtomic(
  profileInput: unknown,
  registry: PluginRegistry,
  pathInput = process.env.EDITKIN_WORKFLOW_PROFILE_PATH,
): Promise<HostWorkflowProfile> {
  const path = configuredProfilePath(pathInput);
  if (!path) throw new Error("Editkin 原生主程式尚未設定 Workflow Profile 路徑");
  const profile = assertWorkflowProfileMatchesRegistry(profileInput, registry);
  const source = `${JSON.stringify(profile, null, 2)}\n`;
  if (Buffer.byteLength(source, "utf8") > MAX_PROFILE_BYTES) throw new Error(`Workflow Profile 超過 ${MAX_PROFILE_BYTES} bytes`);
  await mkdir(dirname(path), { recursive: true });
  await recoverInterruptedProfileWrite(path);
  await assertRegularProfileFile(path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const previous = `${path}.previous`;
  let movedCurrent = false;
  try {
    await writeSynced(temporary, source);
    try {
      await rename(path, previous);
      movedCurrent = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(temporary, path);
    await rm(previous, { force: true });
    return { configured: true, path, profile };
  } catch (error) {
    if (movedCurrent) {
      try {
        await lstat(path);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") await rename(previous, path);
      }
    }
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}
