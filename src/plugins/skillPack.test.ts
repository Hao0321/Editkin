import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EditorCommand } from "../domain/commands";
import {
  discoverInstalledPlugins,
  findInstalledCapability,
  installedSkillPackCandidates,
  pluginAutomationApplicationBase,
  pluginRegistryIdentity,
  resolveSkillCapabilityQueries,
  verifyPluginAutomationApplications,
} from "./registry";
import {
  EDITKIN_WORKFLOW_PROFILE_SCHEMA,
  resolveEditkinSkillWorkflow,
  verifyEditkinSkillSelectionReceipt,
  type EditkinWorkflowProfile,
} from "./skillPack";

function workflowProfile(candidate: ReturnType<typeof installedSkillPackCandidates>[number]): EditkinWorkflowProfile {
  return {
    schema: EDITKIN_WORKFLOW_PROFILE_SCHEMA,
    id: "creator-default",
    revision: 1,
    enabledSkills: [candidate.skillId],
    priority: [candidate.skillId],
    grants: [{ skillId: candidate.skillId, manifestSha256: candidate.manifestSha256, packSha256: candidate.packSha256, permissions: ["workflow.read"] }],
    pluginGrants: [],
    conflictPolicy: "fail_closed",
  };
}

describe("Editkin declarative Skill Packs", () => {
  it("discovers a data-only pack and resolves a bounded, grant-bound workflow receipt", async () => {
    const registry = await discoverInstalledPlugins([join(process.cwd(), "plugins")]);
    const candidates = installedSkillPackCandidates(registry);
    const candidate = candidates.find((item) => item.skillId === "studio.hao.creator-workflow/balanced-creator-workflow");
    expect(candidate).toMatchObject({ planningReady: true, pluginVersion: "1.0.0" });
    if (!candidate) throw new Error("bundled Skill Pack missing");
    const context = { format: "longform" as const, domain: "technology", semanticRoles: ["technology", "tutorial"] };
    const profile = workflowProfile(candidate);
    const receipt = resolveEditkinSkillWorkflow(candidates, profile, context, pluginRegistryIdentity(registry).sha256);
    expect(receipt.selected).toHaveLength(1);
    expect(receipt.compiled.preferences).toMatchObject({ captionColorPolicy: "single_primary_text_color", colorPolicy: "single_primary_look" });
    expect(receipt.compiled.capabilityQueries).toHaveLength(4);
    expect(receipt.estimatedContextTokens).toBeLessThanOrEqual(600);
    expect(() => verifyEditkinSkillSelectionReceipt(receipt, candidates, context, pluginRegistryIdentity(registry).sha256, profile)).not.toThrow();
    const capabilityResolution = resolveSkillCapabilityQueries(registry, receipt);
    expect(capabilityResolution.resolutions).toHaveLength(receipt.compiled.capabilityQueries.length);
    expect(capabilityResolution.resolutions.every((resolution) => resolution.candidates.length <= resolution.maxCandidates)).toBe(true);

    const tampered = structuredClone(receipt);
    tampered.compiled.preferences.pacing = "dense";
    expect(() => verifyEditkinSkillSelectionReceipt(tampered, candidates, context, pluginRegistryIdentity(registry).sha256, profile)).toThrow(/竄改/);
    const staleGrant = workflowProfile(candidate);
    staleGrant.grants[0].packSha256 = "0".repeat(64);
    expect(() => resolveEditkinSkillWorkflow(candidates, staleGrant, context, pluginRegistryIdentity(registry).sha256)).toThrow(/grant/);

    const requiredMissingCandidate = structuredClone(candidate);
    requiredMissingCandidate.pack.capabilityQueries = [{
      id: "required-impossible",
      kind: "effect",
      semanticRoles: ["definitely-not-installed"],
      formats: ["longform"],
      maxCandidates: 1,
      required: true,
    }];
    requiredMissingCandidate.packSha256 = "9".repeat(64);
    const requiredProfile = workflowProfile(requiredMissingCandidate);
    const requiredReceipt = resolveEditkinSkillWorkflow([requiredMissingCandidate], requiredProfile, context, pluginRegistryIdentity(registry).sha256);
    expect(() => resolveSkillCapabilityQueries(registry, requiredReceipt)).toThrow(/required capability query/);
  });

  it("fails closed on an unresolved exclusive workflow conflict and obeys explicit profile priority", async () => {
    const registry = await discoverInstalledPlugins([join(process.cwd(), "plugins")]);
    const first = installedSkillPackCandidates(registry)[0];
    if (!first) throw new Error("bundled Skill Pack missing");
    const second = structuredClone(first);
    second.pluginId = "studio.fixture.second";
    second.capabilityId = "second-workflow";
    second.skillId = `${second.pluginId}/${second.capabilityId}`;
    second.manifestSha256 = "1".repeat(64);
    second.packSha256 = "2".repeat(64);
    second.pack.identity = { pluginId: second.pluginId, capabilityId: second.capabilityId, version: second.pluginVersion };
    const profile: EditkinWorkflowProfile = {
      schema: EDITKIN_WORKFLOW_PROFILE_SCHEMA,
      id: "conflict-profile",
      revision: 1,
      enabledSkills: [first.skillId, second.skillId],
      priority: [second.skillId, first.skillId],
      grants: [first, second].map((candidate) => ({ skillId: candidate.skillId, manifestSha256: candidate.manifestSha256, packSha256: candidate.packSha256, permissions: ["workflow.read"] })),
      pluginGrants: [],
      conflictPolicy: "fail_closed",
    };
    const context = { format: "longform" as const, domain: "technology", semanticRoles: [] };
    expect(() => resolveEditkinSkillWorkflow([first, second], profile, context, "a".repeat(64))).toThrow(/衝突/);
    const resolved = resolveEditkinSkillWorkflow([first, second], { ...profile, conflictPolicy: "profile_priority" }, context, "a".repeat(64));
    expect(resolved.selected.map((item) => item.skillId)).toEqual([second.skillId]);
    expect(resolved.rejected).toEqual([{ skillId: first.skillId, reason: "conflict_lower_priority" }]);

    const undeclaredFirst = structuredClone(first);
    const undeclaredSecond = structuredClone(second);
    delete undeclaredFirst.pack.conflictGroup;
    delete undeclaredSecond.pack.conflictGroup;
    undeclaredFirst.pack.preferences.pacing = "calm";
    undeclaredSecond.pack.preferences.pacing = "dense";
    expect(() => resolveEditkinSkillWorkflow([undeclaredFirst, undeclaredSecond], profile, context, "a".repeat(64))).toThrow(/衝突/);
    expect(resolveEditkinSkillWorkflow([undeclaredFirst, undeclaredSecond], { ...profile, conflictPolicy: "profile_priority" }, context, "a".repeat(64)).selected.map((item) => item.skillId)).toEqual([second.skillId]);
  });

  it("recompiles plugin applications and verifies exact command indexes plus explicit plugin grants", async () => {
    const registry = await discoverInstalledPlugins([join(process.cwd(), "plugins")]);
    const { plugin, capability } = findInstalledCapability(registry, "studio.hao.creator-accelerators", "attention-punch");
    const compiled = pluginAutomationApplicationBase(plugin, capability, "clip-demo", { contrast: 1.1, saturation: 1.03, scale: 1.04 });
    const prefix: EditorCommand[] = [{ type: "rename_project", name: "Before plugin" }];
    const commands = [...prefix, ...compiled.commands];
    const application = { ...compiled.binding, commandIndexes: compiled.commands.map((_, index) => index + prefix.length) };
    const profile: EditkinWorkflowProfile = {
      schema: EDITKIN_WORKFLOW_PROFILE_SCHEMA,
      id: "plugin-grant-profile",
      revision: 1,
      enabledSkills: [],
      priority: [],
      grants: [],
      pluginGrants: [{ pluginId: plugin.manifest.id, manifestSha256: plugin.manifestSha256, capabilityIds: [capability.id], permissions: ["project.write"] }],
      conflictPolicy: "fail_closed",
    };
    expect(verifyPluginAutomationApplications([application], registry, commands, profile)).toMatchObject({ applicationCount: 1, commandCount: 2 });
    const altered = structuredClone(commands);
    if (altered[1].type === "set_clip_color") altered[1].patch.contrast = 1.2;
    expect(() => verifyPluginAutomationApplications([application], registry, altered, profile)).toThrow(/重新編譯/);
    expect(() => verifyPluginAutomationApplications([application], registry, commands, { ...profile, pluginGrants: [] })).toThrow(/grant/);
    expect(() => verifyPluginAutomationApplications([application], registry, commands, profile, { maxCapabilityDeepReads: 1, maxAutomaticActions: 1 })).toThrow(/guardrail/);
  });

  it("recompiles GPU plugin applications deterministically through the v4 provenance verifier", async () => {
    const registry = await discoverInstalledPlugins([join(process.cwd(), "plugins")]);
    const { plugin, capability } = findInstalledCapability(registry, "studio.hao.creator-accelerators", "warm-cinematic-gpu");
    const first = pluginAutomationApplicationBase(plugin, capability, "clip-demo", {});
    const second = pluginAutomationApplicationBase(plugin, capability, "clip-demo", {});
    expect(second.binding.applicationId).not.toBe(first.binding.applicationId);
    expect(second.commands).not.toEqual(first.commands);
    const application = { ...first.binding, commandIndexes: [0] };
    const profile: EditkinWorkflowProfile = {
      schema: EDITKIN_WORKFLOW_PROFILE_SCHEMA,
      id: "gpu-plugin-grant-profile",
      revision: 1,
      enabledSkills: [],
      priority: [],
      grants: [],
      pluginGrants: [{ pluginId: plugin.manifest.id, manifestSha256: plugin.manifestSha256, capabilityIds: [capability.id], permissions: ["render.effect"] }],
      conflictPolicy: "fail_closed",
    };
    expect(verifyPluginAutomationApplications([application], registry, first.commands, profile)).toMatchObject({ applicationCount: 1, commandCount: 1 });
    expect(() => verifyPluginAutomationApplications([application, { ...application, commandIndexes: [1] }], registry, [...first.commands, ...first.commands], profile)).toThrow(/applicationId/);
  });
});
