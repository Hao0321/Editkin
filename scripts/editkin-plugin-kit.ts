import { resolve, dirname, basename } from "node:path";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { discoverInstalledPlugins, resolveGpuEffectGraphBinding } from "../src/plugins/registry";
import { pluginManifestSchema } from "../src/plugins/manifest";
import { editkinSkillPackSchema, skillPackSha256 } from "../src/plugins/skillPack";

async function validate(manifestPath: string): Promise<void> {
  const path = resolve(manifestPath);
  if (basename(path) !== "editkin-plugin.json") throw new Error("請指定 editkin-plugin.json");
  await access(path);
  const registry = await discoverInstalledPlugins([dirname(path)]);
  if (registry.diagnostics.length || registry.plugins.length !== 1) {
    throw new Error(registry.diagnostics.map((item) => `${item.path}: ${item.error}`).join("\n") || "找不到唯一外掛 manifest");
  }
  const plugin = registry.plugins[0];
  const blockedCapabilities = plugin.capabilities.filter((capability) => capability.readiness === "BLOCKED");
  if (blockedCapabilities.length) {
    throw new Error(blockedCapabilities.map((capability) => `${plugin.manifest.id}/${capability.id}: ${capability.readinessDetail}`).join("\n"));
  }
  const workflowSkills = plugin.capabilities
    .filter((capability) => capability.runtime.type === "skill_pack")
    .map((capability) => ({
      capabilityId: capability.id,
      planningReady: capability.planningReady,
      readiness: capability.readiness,
      packSha256: capability.skillPackSha256,
      planSchema: capability.skillPack?.planSchema,
      preferenceKeys: Object.keys(capability.skillPack?.preferences ?? {}),
      capabilityQueryCount: capability.skillPack?.capabilityQueries.length ?? 0,
      guardrails: capability.skillPack?.guardrails,
      arbitraryCodeAllowed: false,
    }));
  const gpuPrograms = plugin.capabilities
    .filter((capability) => capability.runtime.type === "gpu_effect_graph" || capability.runtime.type === "gpu_effect_module")
    .map((capability, index) => {
      const identity = `${plugin.manifest.id}/${capability.id}@${plugin.manifest.version}#${plugin.manifestSha256}`;
      const program = resolveGpuEffectGraphBinding(plugin, capability, `sdk-validation-${index}`, identity, {});
      return {
        capabilityId: capability.id,
        pluginIdentity: identity,
        authoringRuntime: capability.runtime.type,
        readiness: capability.readiness,
        automationReady: capability.automationReady,
        shaderOpCount: program.operations.length,
        opcodes: program.operations.map((operation) => operation.opcode),
        parameters: program.parameters,
        operations: program.operations,
        programSha256: program.programSha256,
      };
    });
  process.stdout.write(`${JSON.stringify({
    schema: "editkin.plugin-kit-validation/v1",
    status: "GREEN",
    manifestPath: path,
    pluginId: plugin.manifest.id,
    version: plugin.manifest.version,
    manifestSha256: plugin.manifestSha256,
    capabilities: plugin.capabilities.length,
    workflowSkills,
    gpuPrograms,
  }, null, 2)}\n`);
}

async function initSkill(directory: string, pluginId: string, capabilityId: string): Promise<void> {
  const target = resolve(directory);
  try {
    await access(target);
    throw new Error(`目標已存在，為避免覆寫已停止：${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const pack = editkinSkillPackSchema.parse({
    schema: "hao.editkin.skill-pack/v1",
    identity: { pluginId, capabilityId, version: "0.1.0" },
    title: "My Editkin Workflow",
    description: "A data-only workflow preference pack for Video Autopilot and Editkin.",
    planSchema: "hao.video-autopilot.edit-plan/v4",
    defaultPriority: 0,
    preferences: {
      pacing: "balanced",
      captionDensity: "balanced",
      captionColorPolicy: "single_primary_text_color",
      graphicDensity: "balanced",
      transitionPolicy: "motivated_only",
      colorPolicy: "single_primary_look",
      audioPolicy: "dialogue_first",
    },
    capabilityQueries: [],
    guardrails: {
      maxCapabilityDeepReads: 3,
      maxContextTokens: 600,
      maxAutomaticActions: 16,
      structuredCommandsOnly: true,
      auditBeforeApply: true,
      humanReviewRequired: true,
      publishAllowed: false,
    },
    outcomeLearning: {
      checkpoints: ["D2", "D7", "D28"],
      learnFromHumanReview: true,
      automaticCoreMutation: false,
    },
  });
  const packSource = `${JSON.stringify(pack, null, 2)}\n`;
  const manifest = pluginManifestSchema.parse({
    schema: "editkin.plugin/v1",
    id: pluginId,
    name: "My Editkin Workflow Skill",
    version: "0.1.0",
    minimumHostVersion: "0.15.0",
    publisher: { name: "Replace with publisher name" },
    license: { spdx: "LicenseRef-Choose-Before-Publish", commercialUse: false },
    permissions: ["workflow.read"],
    capabilities: [{
      id: capabilityId,
      name: "My workflow",
      description: "A declarative workflow preference pack; it cannot execute code or mutate a project.",
      kind: "workflow_skill",
      automation: "assisted",
      semanticRoles: [],
      formats: ["any"],
      requires: ["User explicitly enables the exact manifest and pack hashes"],
      avoidWhen: ["Material evidence is incomplete"],
      parameters: [],
      runtime: { type: "skill_pack", index: "editkin-skill.json", sha256: skillPackSha256(packSource) },
    }],
  });
  await mkdir(dirname(target), { recursive: true });
  await mkdir(target);
  try {
    await writeFile(resolve(target, "editkin-skill.json"), packSource, { encoding: "utf8", flag: "wx" });
    await writeFile(resolve(target, "editkin-plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
  process.stdout.write(`${JSON.stringify({
    schema: "editkin.skill-pack-scaffold/v1",
    status: "GREEN",
    target,
    pluginId,
    capabilityId,
    packSha256: skillPackSha256(packSource),
    arbitraryCodeAllowed: false,
    next: `npm run plugin:validate -- ${resolve(target, "editkin-plugin.json")}`,
  }, null, 2)}\n`);
}

async function main(): Promise<void> {
  const [command, target, pluginId, capabilityId] = process.argv.slice(2);
  if (command === "validate" && target) return validate(target);
  if (command === "init-skill" && target && pluginId && capabilityId) return initSkill(target, pluginId, capabilityId);
  throw new Error([
    "驗證：npm run plugin:validate -- path\\to\\editkin-plugin.json",
    "建立資料型 Skill：npm run plugin:skill:init -- path\\to\\new-skill com.example.workflow my-workflow",
  ].join("\n"));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
