import { describe, expect, it } from "vitest";
import { editkinWorkflowProfileSchema } from "./skillPack";
import {
  createDefaultWorkflowProfile,
  loadWorkflowProfile,
  moveWorkflowSkillPriority,
  pluginAutomationAuthorizationStatus,
  pluginAutomationCapabilityIdentities,
  saveWorkflowProfile,
  setPluginAutomationEnabled,
  setWorkflowSkillEnabled,
  workflowSkillAuthorizationStatus,
  workflowSkillIdentities,
  type WorkflowProfileStorage,
  type WorkflowSkillIdentity,
} from "./workflowProfileStore";

function skill(id: string, manifest = "a", pack = "b"): WorkflowSkillIdentity {
  const [pluginId, capabilityId] = id.split("/");
  return {
    skillId: id,
    pluginId,
    capabilityId,
    title: capabilityId,
    manifestSha256: manifest.repeat(64),
    packSha256: pack.repeat(64),
    planningReady: true,
  };
}

function memoryStorage(initial: string | null = null): WorkflowProfileStorage & { value: string | null } {
  return {
    value: initial,
    read() { return this.value; },
    write(value) { this.value = value; },
  };
}

describe("workflowProfileStore", () => {
  it("creates, persists and reloads exact workflow.read grants bound to both hashes", () => {
    const first = skill("studio.first/workflow");
    const second = skill("studio.second/workflow", "c", "d");
    let profile = setWorkflowSkillEnabled(createDefaultWorkflowProfile(), first, true);
    profile = setWorkflowSkillEnabled(profile, second, true);
    profile = moveWorkflowSkillPriority(profile, second.skillId, -1);
    expect(profile.priority).toEqual([second.skillId, first.skillId]);
    expect(profile.grants).toEqual([
      { skillId: first.skillId, manifestSha256: first.manifestSha256, packSha256: first.packSha256, permissions: ["workflow.read"] },
      { skillId: second.skillId, manifestSha256: second.manifestSha256, packSha256: second.packSha256, permissions: ["workflow.read"] },
    ]);
    expect(profile.conflictPolicy).toBe("profile_priority");
    expect(() => editkinWorkflowProfileSchema.parse(profile)).not.toThrow();

    const storage = memoryStorage();
    saveWorkflowProfile(storage, profile);
    const loaded = loadWorkflowProfile(storage);
    expect(loaded).toEqual({ profile, recoveredFromInvalidState: false });
    expect(storage.value).not.toContain("description");
  });

  it("fails closed on hash drift until a human reauthorizes the current identity", () => {
    const original = skill("studio.first/workflow");
    const updated = skill(original.skillId, "e", "f");
    const other = skill("studio.other/workflow", "c", "d");
    let granted = setWorkflowSkillEnabled(createDefaultWorkflowProfile(), original, true);
    granted = setWorkflowSkillEnabled(granted, other, true);
    expect(workflowSkillAuthorizationStatus(granted, updated)).toBe("needs_reauthorization");
    const reauthorized = setWorkflowSkillEnabled(granted, updated, true);
    expect(reauthorized.revision).toBe(granted.revision + 1);
    expect(workflowSkillAuthorizationStatus(reauthorized, updated)).toBe("enabled");
    expect(reauthorized.priority).toEqual([original.skillId, other.skillId]);
    expect(reauthorized.grants.find((grant) => grant.skillId === original.skillId)).toMatchObject({ manifestSha256: updated.manifestSha256, packSha256: updated.packSha256 });
  });

  it("removes the grant and priority entry when automatic editing is disabled", () => {
    const candidate = skill("studio.first/workflow");
    const enabled = setWorkflowSkillEnabled(createDefaultWorkflowProfile(), candidate, true);
    const disabled = setWorkflowSkillEnabled(enabled, candidate, false);
    expect(disabled.enabledSkills).toEqual([]);
    expect(disabled.priority).toEqual([]);
    expect(disabled.grants).toEqual([]);
    expect(workflowSkillAuthorizationStatus(disabled, candidate)).toBe("disabled");
  });

  it("recovers to a disabled profile instead of preserving executable or broadened permission data", () => {
    const unsafe = JSON.stringify({
      ...createDefaultWorkflowProfile(),
      enabledSkills: ["studio.first/workflow"],
      priority: ["studio.first/workflow"],
      grants: [{
        skillId: "studio.first/workflow",
        manifestSha256: "a".repeat(64),
        packSha256: "b".repeat(64),
        permissions: ["workflow.read", "project.write"],
        command: "run arbitrary code",
      }],
    });
    const loaded = loadWorkflowProfile(memoryStorage(unsafe));
    expect(loaded.recoveredFromInvalidState).toBe(true);
    expect(loaded.profile.enabledSkills).toEqual([]);
    expect(loaded.profile.grants).toEqual([]);
  });

  it("only exposes planning packs that carry a verified pack hash", () => {
    const identities = workflowSkillIdentities({
      schema: "editkin.plugin-registry/v1",
      plugins: [{
        id: "studio.first", name: "First", version: "1.0.0", publisher: "Studio", manifestSha256: "a".repeat(64),
        permissions: ["workflow.read"],
        capabilities: [{
          id: "workflow", name: "Workflow", description: "data only", kind: "workflow_skill", automation: "assisted",
          automationReady: false, planningReady: true, readiness: "RUNTIME_READY", readinessDetail: "ready", semanticRoles: [], formats: ["any"],
          requires: [], avoidWhen: [], runtimeType: "skill_pack", packSha256: "b".repeat(64), commandScopes: [], parameters: [],
        }, {
          id: "missing-hash", name: "Missing", description: "blocked", kind: "workflow_skill", automation: "assisted",
          automationReady: false, planningReady: true, readiness: "RUNTIME_READY", readinessDetail: "bad", semanticRoles: [], formats: ["any"],
          requires: [], avoidWhen: [], runtimeType: "skill_pack", commandScopes: [], parameters: [],
        }],
      }],
      diagnostics: [],
    });
    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({ skillId: "studio.first/workflow", packSha256: "b".repeat(64) });
  });

  it("adds and removes an exact manifest-bound plugin automation grant", () => {
    const registry = {
      schema: "editkin.plugin-registry/v1" as const,
      plugins: [{
        id: "studio.automation", name: "Automation", version: "1.0.0", publisher: "Studio",
        manifestSha256: "c".repeat(64), permissions: ["project.write" as const],
        capabilities: [{
          id: "emphasis", name: "Emphasis", description: "structured commands", kind: "workflow_tool", automation: "full" as const,
          automationReady: true, planningReady: false, readiness: "AUTOMATION_READY", readinessDetail: "ready", semanticRoles: ["emphasis"], formats: ["shorts"],
          requires: [], avoidWhen: [], runtimeType: "editgraph_commands" as const, commandScopes: ["clip" as const], parameters: [],
        }],
      }],
      diagnostics: [],
    };
    const identities = pluginAutomationCapabilityIdentities(registry);
    expect(identities).toHaveLength(1);
    const enabled = setPluginAutomationEnabled(createDefaultWorkflowProfile(), identities[0], identities, true);
    expect(enabled.pluginGrants).toEqual([{
      pluginId: "studio.automation",
      manifestSha256: "c".repeat(64),
      capabilityIds: ["emphasis"],
      permissions: ["project.write"],
    }]);
    expect(pluginAutomationAuthorizationStatus(enabled, identities[0])).toBe("enabled");
    expect(() => editkinWorkflowProfileSchema.parse(enabled)).not.toThrow();
    const disabled = setPluginAutomationEnabled(enabled, identities[0], identities, false);
    expect(disabled.pluginGrants).toEqual([]);
    expect(pluginAutomationAuthorizationStatus(disabled, identities[0])).toBe("disabled");
  });

  it("rejects forged permissions and unknown capability expansion", () => {
    const valid = {
      pluginId: "studio.automation",
      capabilityId: "emphasis",
      manifestSha256: "c".repeat(64),
      runtimeType: "editgraph_commands" as const,
      automationReady: true,
      manifestPermissions: ["project.write" as const],
    };
    const forged = { ...valid, manifestPermissions: ["project.read" as const] };
    expect(() => setPluginAutomationEnabled(createDefaultWorkflowProfile(), forged, [forged], true)).toThrow(/permission/);

    const profile = {
      ...createDefaultWorkflowProfile(),
      pluginGrants: [{
        pluginId: valid.pluginId,
        manifestSha256: valid.manifestSha256,
        capabilityIds: ["unknown-capability"],
        permissions: ["project.write" as const],
      }],
    };
    expect(() => setPluginAutomationEnabled(profile, valid, [valid], true)).toThrow(/未知|漂移/);
  });
});
