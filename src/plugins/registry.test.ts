import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compilePluginApplication, compilePluginAutomationApplication, compilePluginCommands, discoverInstalledPlugins, findInstalledCapability, resolveGpuEffectGraphBinding, resolveGpuEffectGraphBindings, resolveNativeEffectBinding } from "./registry";

const manifest = {
  schema: "editkin.plugin/v1",
  id: "test.creator.tool",
  name: "Test Creator Tool",
  version: "1.0.0",
  minimumHostVersion: "0.15.0",
  publisher: { name: "Fixture" },
  license: { spdx: "MIT", commercialUse: true },
  permissions: ["project.write"],
  capabilities: [{
    id: "punch",
    name: "Punch",
    description: "A bounded test command",
    kind: "workflow_tool",
    automation: "full",
    semanticRoles: ["hook"],
    formats: ["shorts"],
    requires: [],
    avoidWhen: [],
    parameters: [{ id: "scale", name: "Scale", type: "number", default: 1.04, min: 1, max: 1.2 }],
    runtime: { type: "editgraph_commands", operations: [{ command: "update_clip_transform", template: { patch: { scale: "$parameter.scale" } } }] },
  }],
};

async function fixtureRoot(value: unknown = manifest): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "editkin-plugin-test-"));
  const directory = join(root, "fixture");
  await mkdir(directory);
  await writeFile(join(directory, "editkin-plugin.json"), JSON.stringify(value));
  return root;
}

describe("Editkin plugin registry", () => {
  it("blocks a Skill Pack index symlink that escapes the plugin directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "editkin-plugin-symlink-"));
    const directory = join(root, "fixture");
    await mkdir(directory);
    const pack = {
      schema: "hao.editkin.skill-pack/v1",
      identity: { pluginId: "test.escape.skill", capabilityId: "workflow", version: "1.0.0" },
      title: "Escaped",
      description: "Must remain blocked even when the bytes and hash are otherwise valid.",
      planSchema: "hao.video-autopilot.edit-plan/v4",
      defaultPriority: 0,
      preferences: {},
      capabilityQueries: [],
      guardrails: { maxCapabilityDeepReads: 1, maxContextTokens: 120, maxAutomaticActions: 1, structuredCommandsOnly: true, auditBeforeApply: true, humanReviewRequired: true, publishAllowed: false },
      outcomeLearning: { checkpoints: ["D2"], learnFromHumanReview: true, automaticCoreMutation: false },
    };
    const source = JSON.stringify(pack);
    const outside = join(root, "outside-skill.json");
    await writeFile(outside, source);
    await symlink(outside, join(directory, "skill.json"), "file");
    await writeFile(join(directory, "editkin-plugin.json"), JSON.stringify({
      schema: "editkin.plugin/v1", id: "test.escape.skill", name: "Escape", version: "1.0.0", minimumHostVersion: "0.15.0",
      publisher: { name: "Fixture" }, license: { spdx: "MIT", commercialUse: true }, permissions: ["workflow.read"],
      capabilities: [{ id: "workflow", name: "Workflow", description: "Escaping fixture", kind: "workflow_skill", automation: "assisted", semanticRoles: [], formats: ["any"], requires: [], avoidWhen: [], parameters: [], runtime: { type: "skill_pack", index: "skill.json", sha256: createHash("sha256").update(source).digest("hex") } }],
    }));
    const registry = await discoverInstalledPlugins([root]);
    expect(registry.plugins[0].capabilities[0]).toMatchObject({ planningReady: false, readiness: "BLOCKED" });
    expect(registry.plugins[0].capabilities[0].readinessDetail).toMatch(/symlink|junction/);
  });

  it("ships three bounded GPU looks that the UI and automatic editor can apply", async () => {
    const registry = await discoverInstalledPlugins([join(process.cwd(), "plugins")]);
    expect(registry.diagnostics).toEqual([]);
    const installed = registry.plugins.find((plugin) => plugin.manifest.id === "studio.hao.creator-accelerators");
    expect(installed?.manifest.version).toBe("1.5.0");
    expect(installed?.manifest.permissions).toContain("render.effect");
    const gpuCapabilities = installed?.capabilities.filter((capability) => capability.runtime.type === "gpu_effect_graph") ?? [];
    expect(gpuCapabilities.map((capability) => capability.id)).toEqual([
      "clean-punch-gpu", "warm-cinematic-gpu", "mono-editorial-gpu",
    ]);
    expect(gpuCapabilities.every((capability) => capability.readiness === "AUTOMATION_READY" && capability.automationReady)).toBe(true);
    if (!installed) throw new Error("bundled creator accelerator plugin missing");
    const warm = gpuCapabilities.find((capability) => capability.id === "warm-cinematic-gpu");
    if (!warm) throw new Error("bundled warm GPU look missing");
    expect(compilePluginAutomationApplication(installed, warm, "clip-demo", {})[0]).toMatchObject({
      type: "add_native_effect",
      clipId: "clip-demo",
      instance: {
        runtimeType: "gpu_effect_graph",
        pluginId: "studio.hao.creator-accelerators",
        capabilityId: "warm-cinematic-gpu",
        pluginVersion: "1.5.0",
        parameters: { contrast: 1.07, saturation: 0.94, vignette: 0.16 },
      },
    });
  });

  it("compiles the bundled particle VFX as project-scoped commands without clip pollution", async () => {
    const registry = await discoverInstalledPlugins([join(process.cwd(), "plugins")]);
    const { plugin, capability } = findInstalledCapability(registry, "studio.hao.creator-accelerators", "particle-highlight-vfx");
    expect(capability).toMatchObject({ readiness: "AUTOMATION_READY", automationReady: true });
    expect(compilePluginAutomationApplication(plugin, capability, "clip-context", {})).toEqual([
      { type: "configure_particle_simulation", enabled: true },
      {
        type: "set_particle_simulation_settings",
        settings: {
          schema: "editkin.particle-simulation/v1",
          enabled: true,
          timeline: { start: 0, duration: 1.2 },
          seed: 32021,
          ratePerSecond: 48,
          lifetimeSeconds: 1.25,
          maxParticles: 64,
          emitterPosition: [0.5, 0.72],
          initialVelocity: [18, -76],
          gravity: [0, 82],
          radiusPixels: 3.25,
          color: [1, 0.42, 0.06, 0.92],
        },
      },
    ]);
    expect(() => compilePluginAutomationApplication(plugin, capability, "clip-context", { rate: 241 })).toThrow(/不得大於/);
    expect(() => compilePluginAutomationApplication(plugin, capability, "clip-context", { duration: 0 })).toThrow(/不得小於/);
    expect(() => compilePluginAutomationApplication(plugin, capability, "clip-context", { seed: 32021.5 })).toThrow();
    const dual = findInstalledCapability(registry, "studio.hao.creator-accelerators", "dual-particle-burst-vfx");
    const dualCommands = compilePluginAutomationApplication(dual.plugin, dual.capability, "project-context", {
      start: .6, duration: .8, secondary_start: .8, secondary_duration: .6,
    });
    expect(dualCommands).toHaveLength(2);
    expect(dualCommands.every((command) => !("clipId" in command))).toBe(true);
    expect(dualCommands[1]).toMatchObject({
      type: "set_particle_simulation_settings",
      settings: {
        timeline: { start: .6, duration: .8 }, maxParticles: 64,
        additionalEmitters: [{
          id: "cool-trail", timeline: { start: .8, duration: .6 }, maxParticles: 48,
          color: [.1, .65, 1, .85],
        }],
      },
    });
  });

  it("discovers an automation-ready tool and compiles schema-checked commands", async () => {
    const registry = await discoverInstalledPlugins([await fixtureRoot()]);
    expect(registry.diagnostics).toEqual([]);
    const { capability } = findInstalledCapability(registry, "test.creator.tool", "punch");
    expect(capability.automationReady).toBe(true);
    expect(compilePluginCommands(capability, "clip-demo", { scale: 1.12 })).toEqual([
      { type: "update_clip_transform", clipId: "clip-demo", patch: { scale: 1.12 } },
    ]);
    expect(() => compilePluginCommands(capability, "clip-demo", { scale: 2 })).toThrow(/不得大於/);
    expect(() => compilePluginCommands(capability, "clip-demo", { mystery: 1 })).toThrow(/參數不存在/);
  });

  it("fails closed on duplicate capabilities and unsupported command templates", async () => {
    const duplicate = structuredClone(manifest);
    duplicate.capabilities.push(structuredClone(duplicate.capabilities[0]));
    const registry = await discoverInstalledPlugins([await fixtureRoot(duplicate)]);
    expect(registry.plugins).toHaveLength(0);
    expect(registry.diagnostics[0]?.status).toBe("BLOCKED");

    const valid = await discoverInstalledPlugins([await fixtureRoot()]);
    const { capability } = findInstalledCapability(valid, "test.creator.tool", "punch");
    if (capability.runtime.type !== "editgraph_commands") throw new Error("fixture runtime changed");
    capability.runtime.operations[0].template = { patch: { scale: "$parameter.nope" } };
    expect(() => compilePluginCommands(capability, "clip-demo", {})).toThrow(/不存在的參數/);

    capability.runtime.operations[0].template = { type: "set_clip_layer", clipId: "somebody-else", patch: {} };
    expect(() => compilePluginCommands(capability, "clip-demo", {})).toThrow(/不得覆寫/);
  });

  it("blocks incompatible hosts and missing least-privilege permissions", async () => {
    const future = structuredClone(manifest);
    future.minimumHostVersion = "99.0.0";
    const incompatible = await discoverInstalledPlugins([await fixtureRoot(future)]);
    expect(incompatible.plugins).toHaveLength(0);
    expect(incompatible.diagnostics[0]?.error).toMatch(/需要 Editkin 99\.0\.0/);

    const underprivileged = structuredClone(manifest);
    underprivileged.permissions = [];
    const denied = await discoverInstalledPlugins([await fixtureRoot(underprivileged)]);
    expect(denied.plugins).toHaveLength(0);
    expect(denied.diagnostics[0]?.error).toMatch(/project\.write/);
  });

  it("discovers user roots while keeping bundled ids authoritative and blocking duplicates", async () => {
    const bundled = structuredClone(manifest);
    bundled.name = "Bundled Creator Tool";
    const duplicate = structuredClone(manifest);
    duplicate.name = "User Replacement Must Be Blocked";
    const user = structuredClone(manifest);
    user.id = "user.creator.tool";
    user.name = "User Creator Tool";
    const registry = await discoverInstalledPlugins([
      await fixtureRoot(bundled),
      await fixtureRoot(duplicate),
      await fixtureRoot(user),
    ]);
    expect(registry.plugins.map((plugin) => plugin.manifest.id)).toEqual(["test.creator.tool", "user.creator.tool"]);
    expect(registry.plugins.find((plugin) => plugin.manifest.id === "test.creator.tool")?.manifest.name).toBe("Bundled Creator Tool");
    expect(registry.diagnostics).toHaveLength(1);
    expect(registry.diagnostics[0]?.error).toBe("外掛 id 重複：test.creator.tool");
  });

  it("resolves a hash-pinned numeric native effect instance and blocks identity drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "editkin-native-plugin-test-"));
    const directory = join(root, "fixture");
    await mkdir(directory);
    const library = Buffer.from("diagnostic native library fixture");
    const librarySha256 = createHash("sha256").update(library).digest("hex");
    await writeFile(join(directory, "effect.dll"), library);
    const native = {
      schema: "editkin.plugin/v1", id: "test.native.effect", name: "Native", version: "2.0.0", minimumHostVersion: "0.15.0",
      publisher: { name: "Fixture" }, license: { spdx: "MIT", commercialUse: true }, permissions: ["render.effect"],
      capabilities: [{
        id: "gain", name: "Gain", description: "Native gain", kind: "effect", automation: "manual", semanticRoles: [], formats: ["any"], requires: [], avoidWhen: [],
        parameters: [{ id: "gain", name: "Gain", type: "number", default: 1, min: 0, max: 2 }, { id: "enabled", name: "Enabled", type: "boolean", default: true }],
        runtime: { type: "native_effect", abiVersion: 2, entrySymbol: "editkin_effect_plugin_v2", libraries: { [`${process.platform}-${process.arch}`]: { path: "effect.dll", sha256: librarySha256 } }, supportedFormats: ["rgba32_float"], maxTemporalRadius: 0, timeoutMs: 100 },
      }],
    };
    const text = JSON.stringify(native);
    await writeFile(join(directory, "editkin-plugin.json"), text);
    const registry = await discoverInstalledPlugins([root]);
    expect(registry.diagnostics).toEqual([]);
    const installed = findInstalledCapability(registry, native.id, "gain");
    expect(compilePluginApplication(installed.plugin, installed.capability, "clip-demo", {})).toEqual([
      expect.objectContaining({ type: "add_native_effect", clipId: "clip-demo", instance: expect.objectContaining({ pluginId: native.id, capabilityId: "gain", parameters: { gain: 1, enabled: true } }) }),
    ]);
    const binding = resolveNativeEffectBinding(registry, {
      id: "instance", pluginId: native.id, capabilityId: "gain", pluginVersion: native.version,
      manifestSha256: createHash("sha256").update(text).digest("hex"), enabled: true, parameters: { gain: 0.75, enabled: false },
    });
    expect(binding.numericParameters).toEqual([0.75, 0]);
    expect(() => resolveNativeEffectBinding(registry, {
      id: "stale", pluginId: native.id, capabilityId: "gain", pluginVersion: native.version,
      manifestSha256: "0".repeat(64), enabled: true, parameters: {},
    })).toThrow(/identity/);
  });

  it("rebinds a bounded GPU effect graph to the installed manifest and rejects stale identity", async () => {
    const gpu = {
      schema: "editkin.plugin/v1", id: "test.gpu.effect", name: "GPU", version: "1.0.0", minimumHostVersion: "0.15.0",
      publisher: { name: "Fixture" }, license: { spdx: "MIT", commercialUse: true }, permissions: ["render.effect"],
      capabilities: [{
        id: "cinematic", name: "Cinematic", description: "Bounded safe GPU graph", kind: "effect", automation: "assisted",
        semanticRoles: [], formats: ["any"], requires: [], avoidWhen: [],
        parameters: [
          { id: "gain", name: "Gain", type: "number", default: .8, min: 0, max: 2 },
          { id: "mix", name: "Mix", type: "number", default: .25, min: 0, max: 1 },
          { id: "contrast", name: "Contrast", type: "number", default: 1.15, min: 0, max: 2 },
          { id: "pivot", name: "Pivot", type: "number", default: .5, min: 0, max: 1 },
        ],
        runtime: { type: "gpu_effect_graph", abiVersion: 1, supportedFormats: ["rgba16_float"], maxTemporalRadius: 0, operations: [
          { op: "gain", args: ["$parameter.gain"] }, { op: "invert", args: ["$parameter.mix"] },
          { op: "contrast", args: ["$parameter.contrast", "$parameter.pivot"] },
        ] },
      }],
    };
    const registry = await discoverInstalledPlugins([await fixtureRoot(gpu)]);
    expect(registry.diagnostics).toEqual([]);
    const installed = registry.plugins[0];
    const capability = installed.capabilities[0];
    expect(capability).toMatchObject({ readiness: "AUTOMATION_READY", automationReady: true });
    const automationInput = { gain: .8, mix: .25, contrast: 1.15, pivot: .5 };
    const firstAutomationCompile = compilePluginAutomationApplication(installed, capability, "clip-demo", automationInput);
    const secondAutomationCompile = compilePluginAutomationApplication(installed, capability, "clip-demo", automationInput);
    expect(secondAutomationCompile).toEqual(firstAutomationCompile);
    expect(firstAutomationCompile[0])
      .toMatchObject({ type: "add_native_effect", clipId: "clip-demo", instance: { runtimeType: "gpu_effect_graph", pluginId: gpu.id, capabilityId: "cinematic" } });
    const identity = `${gpu.id}/cinematic@${gpu.version}#${installed.manifestSha256}`;
    const graph = { schema: "editkin.engine-graph/v1", nodes: [{ id: "effect", kind: "effect", pluginId: identity, parameters: { gain: .8, mix: .25, contrast: 1.15, pivot: .5 } }] };
    const resolved = await resolveGpuEffectGraphBindings(graph, [installed.root.replace(/[\\/]fixture$/, "")]);
    expect(resolved).toEqual({ schema: "editkin.gpu-effect-bindings/v1", bindings: { effect: expect.objectContaining({
      schema: "editkin.gpu-effect-graph/v1", nodeId: "effect", pluginIdentity: identity,
      programSha256: expect.stringMatching(/^[a-f0-9]{64}$/), operations: [
        { opcode: 1, args: [.8, 0, 0] }, { opcode: 2, args: [.25, 0, 0] }, { opcode: 5, args: [1.15, .5, 0] },
      ],
    }) } });
    await expect(resolveGpuEffectGraphBindings({ ...graph, nodes: [{ ...graph.nodes[0], pluginId: `${gpu.id}/cinematic@${gpu.version}#${"0".repeat(64)}` }] }, [installed.root.replace(/[\\/]fixture$/, "")]))
      .rejects.toThrow(/identity/);
  });

  it("compiles a third-party GPU effect module SDK graph into hash-pinned runtime bytecode", async () => {
    const sdk = {
      schema: "editkin.plugin/v1", id: "test.gpu.module", name: "GPU SDK", version: "1.0.0", minimumHostVersion: "0.15.0",
      publisher: { name: "Fixture" }, license: { spdx: "MIT", commercialUse: true }, permissions: ["render.effect"],
      capabilities: [{
        id: "filmic", name: "Filmic", description: "SDK-authored safe module", kind: "effect", automation: "assisted",
        semanticRoles: ["cinematic"], formats: ["any"], requires: [], avoidWhen: [],
        parameters: [
          { id: "temperature", name: "Temperature", type: "number", default: .1, min: -1, max: 1 },
          { id: "tint", name: "Tint", type: "number", default: .02, min: -1, max: 1 },
          { id: "strength", name: "Strength", type: "number", default: .25, min: 0, max: 1 },
          { id: "toe", name: "Toe", type: "number", default: .1, min: 0, max: 1 },
          { id: "shoulder", name: "Shoulder", type: "number", default: .2, min: 0, max: 1 },
        ],
        runtime: { type: "gpu_effect_module", abiVersion: 1, supportedFormats: ["rgba16_float"], maxTemporalRadius: 0, module: {
          schema: "editkin.gpu-effect-module/v1", nodes: [
            { id: "curve", input: "balance", op: "filmic_curve", args: ["$parameter.strength", "$parameter.toe", "$parameter.shoulder"] },
            { id: "balance", input: "$source", op: "temperature_tint", args: ["$parameter.temperature", "$parameter.tint"] },
          ], output: "curve",
        } },
      }],
    };
    const registry = await discoverInstalledPlugins([await fixtureRoot(sdk)]);
    expect(registry.diagnostics).toEqual([]);
    const plugin = registry.plugins[0];
    const capability = plugin.capabilities[0];
    expect(capability).toMatchObject({ readiness: "AUTOMATION_READY", automationReady: true, runtime: { type: "gpu_effect_module" } });
    expect(compilePluginAutomationApplication(plugin, capability, "clip-demo", {})[0]).toMatchObject({
      type: "add_native_effect", instance: { runtimeType: "gpu_effect_graph", pluginId: sdk.id, capabilityId: "filmic" },
    });
    const identity = `${sdk.id}/filmic@${sdk.version}#${plugin.manifestSha256}`;
    const resolved = resolveGpuEffectGraphBinding(plugin, capability, "effect", identity, {});
    expect(resolved.operations).toEqual([
      { opcode: 12, args: [.1, .02, 0] },
      { opcode: 11, args: [.25, .1, .2] },
    ]);
    expect(resolved.programSha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
