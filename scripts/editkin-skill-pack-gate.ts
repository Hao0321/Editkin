import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import type { EditorCommand } from "../src/domain/commands";
import {
  compactPluginAutomationDiscovery,
  discoverInstalledPlugins,
  findInstalledCapability,
  installedSkillPackCandidates,
  pluginAutomationApplicationBase,
  pluginRegistryIdentity,
  resolveSkillCapabilityQueries,
  verifyPluginAutomationApplications,
} from "../src/plugins/registry";
import {
  EDITKIN_WORKFLOW_PROFILE_SCHEMA,
  resolveEditkinSkillWorkflow,
  verifyEditkinSkillSelectionReceipt,
  type EditkinWorkflowProfile,
} from "../src/plugins/skillPack";

const root = resolve(import.meta.dirname, "..");
const registry = await discoverInstalledPlugins([resolve(root, "plugins")]);
assert.equal(registry.diagnostics.length, 0, JSON.stringify(registry.diagnostics));
const registryIdentity = pluginRegistryIdentity(registry);
const discovery = compactPluginAutomationDiscovery(registry, { format: "longform", semanticRoles: ["technology", "tutorial"], limit: 8 });
const discoveryTokens = Math.ceil(Buffer.byteLength(JSON.stringify(discovery), "utf8") / 4);
assert.ok(discoveryTokens <= 200, `automation discovery 超過 200 estimated tokens：${discoveryTokens}`);

const skillCandidates = installedSkillPackCandidates(registry);
const skill = skillCandidates.find((candidate) => candidate.skillId === "studio.hao.creator-workflow/balanced-creator-workflow");
assert.ok(skill?.planningReady, "bundled creator workflow Skill Pack 未達 planning-ready");
const profile: EditkinWorkflowProfile = {
  schema: EDITKIN_WORKFLOW_PROFILE_SCHEMA,
  id: "formal-gate-profile",
  revision: 1,
  enabledSkills: [skill.skillId],
  priority: [skill.skillId],
  grants: [{ skillId: skill.skillId, manifestSha256: skill.manifestSha256, packSha256: skill.packSha256, permissions: ["workflow.read"] }],
  pluginGrants: [],
  conflictPolicy: "fail_closed",
};
const context = { format: "longform" as const, domain: "technology", semanticRoles: ["technology", "tutorial"] };
const selection = resolveEditkinSkillWorkflow(skillCandidates, profile, context, registryIdentity.sha256);
assert.ok(selection.estimatedContextTokens <= 600, "Skill selection 超過 600 estimated tokens");
assert.equal(JSON.stringify(selection).includes(skill.pack.description), false, "作者自由文字進入 automation selection receipt");
verifyEditkinSkillSelectionReceipt(selection, skillCandidates, context, registryIdentity.sha256, profile);
const capabilityResolution = resolveSkillCapabilityQueries(registry, selection);
assert.equal(capabilityResolution.resolutions.length, selection.compiled.capabilityQueries.length);
assert.ok(capabilityResolution.resolutions.every((resolution) => resolution.candidates.length <= resolution.maxCandidates));

const { plugin, capability } = findInstalledCapability(registry, "studio.hao.creator-accelerators", "attention-punch");
const compiled = pluginAutomationApplicationBase(plugin, capability, "clip-gate", { contrast: 1.1, saturation: 1.02, scale: 1.04 });
const commands: EditorCommand[] = [{ type: "rename_project", name: "Skill gate" }, ...compiled.commands];
const application = { ...compiled.binding, commandIndexes: compiled.commands.map((_, index) => index + 1) };
const pluginProfile: EditkinWorkflowProfile = {
  schema: EDITKIN_WORKFLOW_PROFILE_SCHEMA,
  id: "formal-plugin-profile",
  revision: 1,
  enabledSkills: [],
  priority: [],
  grants: [],
  pluginGrants: [{
    pluginId: plugin.manifest.id,
    manifestSha256: plugin.manifestSha256,
    capabilityIds: [capability.id],
    permissions: ["project.write"],
  }],
  conflictPolicy: "fail_closed",
};
verifyPluginAutomationApplications([application], registry, commands, pluginProfile);

const negativeControls: Array<{ id: string; rejected: boolean }> = [];
async function rejected(id: string, operation: () => unknown | Promise<unknown>) {
  let blocked = false;
  try { await operation(); } catch { blocked = true; }
  assert.equal(blocked, true, `Skill Pack negative control escaped: ${id}`);
  negativeControls.push({ id, rejected: blocked });
}

await rejected("missing-skill-grant", () => resolveEditkinSkillWorkflow(skillCandidates, { ...profile, grants: [] }, context, registryIdentity.sha256));
await rejected("stale-skill-hash", () => resolveEditkinSkillWorkflow(skillCandidates, {
  ...profile,
  grants: [{ ...profile.grants[0], packSha256: "0".repeat(64) }],
}, context, registryIdentity.sha256));
await rejected("selection-tamper", () => {
  const tampered = structuredClone(selection);
  tampered.compiled.preferences.pacing = "dense";
  return verifyEditkinSkillSelectionReceipt(tampered, skillCandidates, context, registryIdentity.sha256, profile);
});
await rejected("registry-drift", () => verifyEditkinSkillSelectionReceipt(selection, skillCandidates, context, "0".repeat(64), profile));
await rejected("capability-resolution-selection-tamper", () => resolveSkillCapabilityQueries(registry, { ...selection, receiptSha256: "0".repeat(64) }));
await rejected("missing-plugin-grant", () => verifyPluginAutomationApplications([application], registry, commands, { ...pluginProfile, pluginGrants: [] }));
await rejected("command-tamper", () => {
  const altered = structuredClone(commands);
  if (altered[1].type === "set_clip_color") altered[1].patch.contrast = 1.2;
  return verifyPluginAutomationApplications([application], registry, altered, pluginProfile);
});
await rejected("command-index-overlap", () => verifyPluginAutomationApplications([application, application], registry, commands, pluginProfile));

process.stdout.write(`${JSON.stringify({
  schema: "editkin.skill-pack-gate/v1",
  status: "GREEN",
  registry: registryIdentity,
  planningReadySkills: skillCandidates.filter((candidate) => candidate.planningReady).length,
  discoveryEstimatedTokens: discoveryTokens,
  selectionEstimatedTokens: selection.estimatedContextTokens,
  selectedSkillCount: selection.selected.length,
  compiledQueryCount: selection.compiled.capabilityQueries.length,
  resolvedCapabilityCandidateCount: capabilityResolution.resolutions.reduce((total, resolution) => total + resolution.candidates.length, 0),
  pluginApplicationCommandCount: compiled.commands.length,
  negativeControls,
  boundary: "Declarative planning only; exact grants and hashes; read-only plugin compilation; v4 audit/apply remains the sole automatic mutation boundary.",
})}\n`);
