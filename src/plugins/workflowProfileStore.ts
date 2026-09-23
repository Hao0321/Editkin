import type { PluginRegistrySummary } from "../desktop/pluginTypes";
import type { EditkinWorkflowProfile } from "./skillPack";

export const EDITKIN_WORKFLOW_PROFILE_STORAGE_KEY = "editkin.workflow-profile/v1";

const SKILL_REFERENCE = /^[a-z][a-z0-9.-]{2,127}\/[a-z][a-z0-9_.-]{0,95}$/;
const PLUGIN_ID = /^[a-z][a-z0-9.-]{2,127}$/;
const CAPABILITY_ID = /^[a-z][a-z0-9_.-]{0,95}$/;
const PROFILE_ID = /^[a-z][a-z0-9_.-]{0,95}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ALLOWED_PLUGIN_PERMISSIONS = new Set([
  "project.read",
  "project.write",
  "media.read",
  "render.effect",
  "assets.read",
  "knowledge.read",
  "workflow.read",
]);

export interface WorkflowSkillIdentity {
  skillId: string;
  pluginId: string;
  capabilityId: string;
  title: string;
  manifestSha256: string;
  packSha256: string;
  planningReady: boolean;
}

export interface PluginAutomationCapabilityIdentity {
  pluginId: string;
  capabilityId: string;
  manifestSha256: string;
  runtimeType: string;
  automationReady: boolean;
  manifestPermissions: EditkinWorkflowProfile["pluginGrants"][number]["permissions"];
}

/**
 * Intentionally tiny and synchronous so the product UI can use localStorage
 * today, while the native host can inject an atomic file-backed adapter later.
 * The profile remains ordinary serializable JSON; no executable callback or
 * third-party prompt crosses this boundary.
 */
export interface WorkflowProfileStorage {
  read(): string | null;
  write(serializedProfile: string): void;
}

export type WorkflowSkillAuthorizationStatus = "disabled" | "enabled" | "needs_reauthorization" | "unavailable";

export interface WorkflowProfileLoadResult {
  profile: EditkinWorkflowProfile;
  recoveredFromInvalidState: boolean;
}

function uniqueStrings(value: unknown, pattern: RegExp, maximum: number): string[] | undefined {
  if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== "string" || !pattern.test(item))) return undefined;
  const result = value as string[];
  return new Set(result).size === result.length ? [...result] : undefined;
}

function validGrant(value: unknown): EditkinWorkflowProfile["grants"][number] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (!SKILL_REFERENCE.test(String(candidate.skillId)) || !SHA256.test(String(candidate.manifestSha256)) || !SHA256.test(String(candidate.packSha256))) return undefined;
  if (!Array.isArray(candidate.permissions) || candidate.permissions.length !== 1 || candidate.permissions[0] !== "workflow.read") return undefined;
  return {
    skillId: String(candidate.skillId),
    manifestSha256: String(candidate.manifestSha256),
    packSha256: String(candidate.packSha256),
    permissions: ["workflow.read"],
  };
}

function validPluginGrant(value: unknown): EditkinWorkflowProfile["pluginGrants"][number] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const capabilityIds = uniqueStrings(candidate.capabilityIds, CAPABILITY_ID, 32);
  const permissions = uniqueStrings(candidate.permissions, /^[a-z]+\.[a-z]+$/, 7);
  if (!PLUGIN_ID.test(String(candidate.pluginId)) || !SHA256.test(String(candidate.manifestSha256)) || !capabilityIds?.length || !permissions?.length) return undefined;
  if (permissions.some((permission) => !ALLOWED_PLUGIN_PERMISSIONS.has(permission))) return undefined;
  return {
    pluginId: String(candidate.pluginId),
    manifestSha256: String(candidate.manifestSha256),
    capabilityIds,
    permissions: permissions as EditkinWorkflowProfile["pluginGrants"][number]["permissions"],
  };
}

export function createDefaultWorkflowProfile(): EditkinWorkflowProfile {
  return {
    schema: "hao.editkin.workflow-profile/v1",
    id: "creator-workflow",
    revision: 1,
    enabledSkills: [],
    priority: [],
    grants: [],
    pluginGrants: [],
    conflictPolicy: "profile_priority",
  };
}

/** Parse and normalize only the declarative profile contract. Unknown data is
 * discarded instead of being echoed back into the automation boundary. */
export function parseWorkflowProfile(value: unknown): EditkinWorkflowProfile | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.schema !== "hao.editkin.workflow-profile/v1" || !PROFILE_ID.test(String(candidate.id))) return undefined;
  if (candidate.conflictPolicy !== "fail_closed" && candidate.conflictPolicy !== "profile_priority") return undefined;
  if (!Number.isInteger(candidate.revision) || Number(candidate.revision) < 1) return undefined;
  const enabledSkills = uniqueStrings(candidate.enabledSkills, SKILL_REFERENCE, 32);
  const rawPriority = uniqueStrings(candidate.priority, SKILL_REFERENCE, 32);
  if (!enabledSkills || !rawPriority) return undefined;
  const enabled = new Set(enabledSkills);
  if (rawPriority.some((skillId) => !enabled.has(skillId))) return undefined;
  const grants = Array.isArray(candidate.grants) ? candidate.grants.map(validGrant) : [];
  const pluginGrants = Array.isArray(candidate.pluginGrants) ? candidate.pluginGrants.map(validPluginGrant) : [];
  if (!Array.isArray(candidate.grants) || candidate.grants.length > 32 || grants.some((grant) => !grant)) return undefined;
  if (!Array.isArray(candidate.pluginGrants) || candidate.pluginGrants.length > 64 || pluginGrants.some((grant) => !grant)) return undefined;
  const typedGrants = grants as EditkinWorkflowProfile["grants"];
  const typedPluginGrants = pluginGrants as EditkinWorkflowProfile["pluginGrants"];
  if (new Set(typedGrants.map((grant) => grant.skillId)).size !== typedGrants.length) return undefined;
  if (new Set(typedPluginGrants.map((grant) => grant.pluginId)).size !== typedPluginGrants.length) return undefined;
  const priority = [...rawPriority, ...enabledSkills.filter((skillId) => !rawPriority.includes(skillId))];
  return {
    schema: "hao.editkin.workflow-profile/v1",
    id: String(candidate.id),
    revision: Number(candidate.revision),
    enabledSkills,
    priority,
    grants: typedGrants.filter((grant) => enabled.has(grant.skillId)),
    pluginGrants: typedPluginGrants,
    conflictPolicy: candidate.conflictPolicy,
  };
}

export function loadWorkflowProfile(storage?: WorkflowProfileStorage): WorkflowProfileLoadResult {
  if (!storage) return { profile: createDefaultWorkflowProfile(), recoveredFromInvalidState: false };
  try {
    const serialized = storage.read();
    if (serialized === null) return { profile: createDefaultWorkflowProfile(), recoveredFromInvalidState: false };
    const profile = parseWorkflowProfile(JSON.parse(serialized));
    return profile
      ? { profile, recoveredFromInvalidState: false }
      : { profile: createDefaultWorkflowProfile(), recoveredFromInvalidState: true };
  } catch {
    return { profile: createDefaultWorkflowProfile(), recoveredFromInvalidState: true };
  }
}

export function saveWorkflowProfile(storage: WorkflowProfileStorage, profile: EditkinWorkflowProfile): void {
  const normalized = parseWorkflowProfile(profile);
  if (!normalized) throw new Error("Workflow Profile 不符合資料型安全契約");
  storage.write(`${JSON.stringify(normalized, null, 2)}\n`);
}

export function createLocalWorkflowProfileStorage(storage: Pick<Storage, "getItem" | "setItem">, key = EDITKIN_WORKFLOW_PROFILE_STORAGE_KEY): WorkflowProfileStorage {
  return {
    read: () => storage.getItem(key),
    write: (serializedProfile) => storage.setItem(key, serializedProfile),
  };
}

export function browserWorkflowProfileStorage(): WorkflowProfileStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage ? createLocalWorkflowProfileStorage(window.localStorage) : undefined;
  } catch {
    return undefined;
  }
}

export function workflowSkillIdentities(registry?: PluginRegistrySummary): WorkflowSkillIdentity[] {
  return (registry?.plugins ?? []).flatMap((plugin) => plugin.capabilities.flatMap((capability) => {
    if (capability.runtimeType !== "skill_pack" || !capability.packSha256) return [];
    const skillId = `${plugin.id}/${capability.id}`;
    if (!PLUGIN_ID.test(plugin.id) || !CAPABILITY_ID.test(capability.id) || !SKILL_REFERENCE.test(skillId)
      || !SHA256.test(plugin.manifestSha256) || !SHA256.test(capability.packSha256)) return [];
    return [{
      skillId,
      pluginId: plugin.id,
      capabilityId: capability.id,
      title: capability.name,
      manifestSha256: plugin.manifestSha256,
      packSha256: capability.packSha256,
      planningReady: capability.planningReady,
    }];
  })).sort((left, right) => left.skillId.localeCompare(right.skillId));
}

function automationPermission(runtimeType: string): "project.write" | "render.effect" | undefined {
  if (runtimeType === "editgraph_commands") return "project.write";
  if (runtimeType === "native_effect" || runtimeType === "gpu_effect_graph" || runtimeType === "gpu_effect_module") return "render.effect";
  return undefined;
}

export function pluginAutomationCapabilityIdentities(registry?: PluginRegistrySummary): PluginAutomationCapabilityIdentity[] {
  return (registry?.plugins ?? []).flatMap((plugin) => plugin.capabilities.flatMap((capability) => {
    const permission = automationPermission(capability.runtimeType);
    if (!permission || !capability.automationReady || !plugin.permissions.includes(permission)) return [];
    return [{
      pluginId: plugin.id,
      capabilityId: capability.id,
      manifestSha256: plugin.manifestSha256,
      runtimeType: capability.runtimeType,
      automationReady: capability.automationReady,
      manifestPermissions: plugin.permissions,
    }];
  })).sort((left, right) => `${left.pluginId}/${left.capabilityId}`.localeCompare(`${right.pluginId}/${right.capabilityId}`));
}

export function pluginAutomationAuthorizationStatus(profile: EditkinWorkflowProfile, identity: PluginAutomationCapabilityIdentity): WorkflowSkillAuthorizationStatus {
  if (!identity.automationReady) return "unavailable";
  const permission = automationPermission(identity.runtimeType);
  if (!permission || !identity.manifestPermissions.includes(permission)) return "unavailable";
  const grant = profile.pluginGrants.find((candidate) => candidate.pluginId === identity.pluginId);
  if (!grant || !grant.capabilityIds.includes(identity.capabilityId)) return "disabled";
  return grant.manifestSha256 === identity.manifestSha256 && grant.permissions.includes(permission) ? "enabled" : "needs_reauthorization";
}

export function setPluginAutomationEnabled(
  profileInput: EditkinWorkflowProfile,
  identity: PluginAutomationCapabilityIdentity,
  allIdentities: PluginAutomationCapabilityIdentity[],
  enabled: boolean,
): EditkinWorkflowProfile {
  const profile = parseWorkflowProfile(profileInput);
  if (!profile) throw new Error("Workflow Profile 不合法");
  const permission = automationPermission(identity.runtimeType);
  if (!permission || !identity.automationReady || !identity.manifestPermissions.includes(permission)
    || !PLUGIN_ID.test(identity.pluginId) || !CAPABILITY_ID.test(identity.capabilityId) || !SHA256.test(identity.manifestSha256)) {
    throw new Error("Plugin automation identity／readiness／permission 不合法");
  }
  const currentStatus = pluginAutomationAuthorizationStatus(profile, identity);
  if (enabled && currentStatus === "enabled") return profile;
  if (!enabled && currentStatus === "disabled") return profile;
  const existing = profile.pluginGrants.find((grant) => grant.pluginId === identity.pluginId);
  const capabilityIds = new Set(existing?.manifestSha256 === identity.manifestSha256 ? existing.capabilityIds : []);
  if (enabled) capabilityIds.add(identity.capabilityId);
  else capabilityIds.delete(identity.capabilityId);
  const pluginIdentities = allIdentities.filter((candidate) => candidate.pluginId === identity.pluginId
    && candidate.manifestSha256 === identity.manifestSha256 && capabilityIds.has(candidate.capabilityId));
  if (pluginIdentities.length !== capabilityIds.size) throw new Error("Plugin automation grant 含有未知或已漂移 capability");
  const permissions = [...new Set(pluginIdentities.map((candidate) => automationPermission(candidate.runtimeType)).filter((value): value is "project.write" | "render.effect" => Boolean(value)))];
  const nextGrant = capabilityIds.size ? {
    pluginId: identity.pluginId,
    manifestSha256: identity.manifestSha256,
    capabilityIds: [...capabilityIds].sort(),
    permissions: permissions.sort(),
  } : undefined;
  return {
    ...profile,
    revision: profile.revision + 1,
    pluginGrants: [...profile.pluginGrants.filter((grant) => grant.pluginId !== identity.pluginId), ...(nextGrant ? [nextGrant] : [])],
  };
}

export function workflowSkillAuthorizationStatus(profile: EditkinWorkflowProfile, skill: WorkflowSkillIdentity): WorkflowSkillAuthorizationStatus {
  if (!skill.planningReady) return "unavailable";
  if (!profile.enabledSkills.includes(skill.skillId)) return "disabled";
  const grant = profile.grants.find((candidate) => candidate.skillId === skill.skillId);
  return grant && grant.manifestSha256 === skill.manifestSha256 && grant.packSha256 === skill.packSha256 && grant.permissions.length === 1 && grant.permissions[0] === "workflow.read"
    ? "enabled"
    : "needs_reauthorization";
}

export function setWorkflowSkillEnabled(profileInput: EditkinWorkflowProfile, skill: WorkflowSkillIdentity, enabled: boolean): EditkinWorkflowProfile {
  const profile = parseWorkflowProfile(profileInput);
  if (!profile) throw new Error("Workflow Profile 不合法");
  if (skill.skillId !== `${skill.pluginId}/${skill.capabilityId}` || !SKILL_REFERENCE.test(skill.skillId) || !PLUGIN_ID.test(skill.pluginId)
    || !CAPABILITY_ID.test(skill.capabilityId) || !SHA256.test(skill.manifestSha256) || !SHA256.test(skill.packSha256)) {
    throw new Error("Workflow Skill identity/hash 不合法");
  }
  if (enabled && !skill.planningReady) throw new Error(`Workflow Skill 尚未通過 planning readiness：${skill.skillId}`);
  const currentlyEnabled = profile.enabledSkills.includes(skill.skillId);
  const currentStatus = workflowSkillAuthorizationStatus(profile, skill);
  if (enabled && currentStatus === "enabled") return profile;
  if (!enabled && !currentlyEnabled) return profile;
  const enabledSkills = enabled
    ? currentlyEnabled ? profile.enabledSkills : [...profile.enabledSkills, skill.skillId]
    : profile.enabledSkills.filter((skillId) => skillId !== skill.skillId);
  const priority = enabled
    ? currentlyEnabled ? profile.priority : [...profile.priority, skill.skillId]
    : profile.priority.filter((skillId) => skillId !== skill.skillId);
  const grants = profile.grants.filter((grant) => grant.skillId !== skill.skillId);
  if (enabled) grants.push({
    skillId: skill.skillId,
    manifestSha256: skill.manifestSha256,
    packSha256: skill.packSha256,
    permissions: ["workflow.read"],
  });
  return {
    ...profile,
    revision: profile.revision + 1,
    enabledSkills,
    priority,
    grants,
    conflictPolicy: "profile_priority",
  };
}

export function moveWorkflowSkillPriority(profileInput: EditkinWorkflowProfile, skillId: string, direction: -1 | 1): EditkinWorkflowProfile {
  const profile = parseWorkflowProfile(profileInput);
  if (!profile) throw new Error("Workflow Profile 不合法");
  const priority = [...profile.priority];
  const index = priority.indexOf(skillId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= priority.length) return profile;
  [priority[index], priority[target]] = [priority[target], priority[index]];
  return { ...profile, revision: profile.revision + 1, priority, conflictPolicy: "profile_priority" };
}
