import { strict as assert } from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { applyCommand } from "../src/domain/commands";
import { createDemoProject } from "../src/domain/demo";
import { projectSchema } from "../src/domain/schema";
import { buildEngineRenderGraph } from "../src/render/engineGraph";
import { buildGpuEngineVideoPreviewGraph } from "../src/render/gpuCompositor";
import {
  compactPluginRegistry,
  compilePluginAutomationApplication,
  discoverInstalledPlugins,
  findInstalledCapability,
} from "../src/plugins/registry";

const root = resolve(import.meta.dirname, "..");
const evidenceRoot = resolve(root, "../../.rd/benchmarks/editkin-particle-plugin-automation");
const baseline = process.argv.includes("--baseline");
const selfTest = process.argv.includes("--self-test");

interface GreenReport {
  schema: "editkin.particle-plugin-automation-gate/v1";
  status: "GREEN";
  automationReady: true;
  projectScopedCommands: true;
  commandCount: 2;
  persistedProjectRoundTrip: true;
  particleGraphNode: true;
  residentVideoExpectation: true;
  dynamicRegistryVisible: true;
  rejectedNegativeControls: string[];
}

function assertGreen(report: GreenReport): void {
  assert.equal(report.schema, "editkin.particle-plugin-automation-gate/v1");
  assert.equal(report.status, "GREEN");
  assert.equal(report.automationReady, true);
  assert.equal(report.projectScopedCommands, true);
  assert.equal(report.commandCount, 2);
  assert.equal(report.persistedProjectRoundTrip, true);
  assert.equal(report.particleGraphNode, true);
  assert.equal(report.residentVideoExpectation, true);
  assert.equal(report.dynamicRegistryVisible, true);
  assert.equal(report.rejectedNegativeControls.length, 3);
}

function runEvaluatorSelfTest(): void {
  const valid: GreenReport = {
    schema: "editkin.particle-plugin-automation-gate/v1",
    status: "GREEN",
    automationReady: true,
    projectScopedCommands: true,
    commandCount: 2,
    persistedProjectRoundTrip: true,
    particleGraphNode: true,
    residentVideoExpectation: true,
    dynamicRegistryVisible: true,
    rejectedNegativeControls: ["bounds", "unknown-parameter", "clip-id-injection"],
  };
  assertGreen(valid);
  let calibratedNegatives = 0;
  for (const candidate of [
    { ...valid, automationReady: false },
    { ...valid, projectScopedCommands: false },
    { ...valid, particleGraphNode: false },
    { ...valid, rejectedNegativeControls: ["bounds"] },
  ]) {
    try { assertGreen(candidate as GreenReport); }
    catch { calibratedNegatives += 1; }
  }
  assert.equal(calibratedNegatives, 4);
  process.stdout.write(`${JSON.stringify({ status: "GREEN", evaluator: valid.schema, calibratedNegatives })}\n`);
}

async function run(): Promise<void> {
  const registry = await discoverInstalledPlugins([resolve(root, "plugins")]);
  assert.deepEqual(registry.diagnostics, []);
  const plugin = registry.plugins.find((item) => item.manifest.id === "studio.hao.creator-accelerators");
  const capability = plugin?.capabilities.find((item) => item.id === "particle-highlight-vfx");
  await mkdir(evidenceRoot, { recursive: true });
  if (baseline) {
    const report = {
      schema: "editkin.particle-plugin-automation-baseline/v1",
      status: "BLOCK",
      reason: capability ? "baseline unexpectedly exposes project-scoped VFX automation" : "bundled plugin cannot invoke project-scoped particle VFX",
      capabilityPresent: Boolean(capability),
    };
    assert.equal(capability, undefined, "baseline must prove the capability is absent");
    await writeFile(resolve(evidenceRoot, "baseline-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  assert(plugin && capability, "bundled particle VFX capability is missing");
  assert.equal(capability.readiness, "AUTOMATION_READY");
  assert.equal(capability.automationReady, true);
  const parameters = {
    start: 0.6,
    duration: 0.8,
    rate: 72,
    lifetime: 1.5,
    radius: 4.5,
    velocity_x: 18,
    velocity_y: -82,
    gravity_y: 96,
    emitter_x: .5,
    emitter_y: .74,
    seed: 32021,
  };
  const commands = compilePluginAutomationApplication(plugin, capability, "clip-demo", parameters);
  const projectScopedCommands = commands.length === 2
    && commands[0]?.type === "configure_particle_simulation"
    && commands[1]?.type === "set_particle_simulation_settings"
    && commands.every((command) => !("clipId" in command));
  assert(projectScopedCommands, "project-scoped plugin commands were polluted with clipId");

  let project = createDemoProject();
  project.width = 960;
  project.height = 540;
  project.assets[0].uri = resolve(root, "public/demo-source.mp4");
  for (const command of commands) project = applyCommand(project, command);
  const persisted = projectSchema.parse(JSON.parse(JSON.stringify(project)));
  const persistedProjectRoundTrip = JSON.stringify(persisted.particleSimulation) === JSON.stringify(project.particleSimulation);
  assert(persistedProjectRoundTrip);
  assert.deepEqual(project.particleSimulation, {
    schema: "editkin.particle-simulation/v1",
    enabled: true,
    timeline: { start: 0.6, duration: 0.8 },
    seed: 32021,
    ratePerSecond: 72,
    lifetimeSeconds: 1.5,
    initialVelocity: [18, -82],
    gravity: [0, 96],
    maxParticles: 64,
    emitterPosition: [.5, .74],
    radiusPixels: 4.5,
    color: [1, .42, .06, .92],
  });
  const graph = buildEngineRenderGraph(project);
  const particle = graph.nodes.find((node) => node.kind === "particle_emitter");
  const particleGraphNode = Boolean(particle && particle.id === "vfx:particles" && particle.maxParticles === 64 && particle.ratePerSecond === 72);
  assert(particleGraphNode);
  const preview = buildGpuEngineVideoPreviewGraph(project, .6);
  const residentVideoExpectation = preview?.vfxSimulationExpectation?.executor === "wgpu-resident-video-particle-overlay/v1"
    && preview.vfxSimulationExpectation.emitterCount === 1;
  assert(residentVideoExpectation);
  const compact = compactPluginRegistry(registry);
  const dynamicRegistryVisible = compact.plugins.some((item) => item.id === plugin.manifest.id
    && item.capabilities.some((item) => item.id === capability.id && item.automationReady && item.commandScopes.includes("project")));
  assert(dynamicRegistryVisible);

  const rejectedNegativeControls: string[] = [];
  for (const [name, input, marker] of [
    ["bounds", { ...parameters, rate: 241 }, "不得大於"],
    ["unknown-parameter", { ...parameters, mystery: 1 }, "參數不存在"],
  ] as const) {
    assert.throws(() => compilePluginAutomationApplication(plugin, capability, "clip-demo", input), new RegExp(marker));
    rejectedNegativeControls.push(name);
  }
  if (capability.runtime.type !== "editgraph_commands") throw new Error("particle capability runtime changed");
  const original = capability.runtime.operations[0].template;
  capability.runtime.operations[0].template = { clipId: "injected", enabled: true };
  assert.throws(() => compilePluginAutomationApplication(plugin, capability, "clip-demo", parameters), /clipId/);
  capability.runtime.operations[0].template = original;
  rejectedNegativeControls.push("clip-id-injection");

  const report: GreenReport & Record<string, unknown> = {
    schema: "editkin.particle-plugin-automation-gate/v1",
    status: "GREEN",
    pluginVersion: plugin.manifest.version,
    pluginManifestSha256: plugin.manifestSha256,
    automationReady: true,
    projectScopedCommands: true,
    commandCount: 2,
    persistedProjectRoundTrip,
    particleGraphNode,
    residentVideoExpectation,
    dynamicRegistryVisible,
    rejectedNegativeControls,
    settings: project.particleSimulation,
    graphNodeIds: graph.nodes.map((node) => node.id),
  };
  assertGreen(report);
  await writeFile(resolve(evidenceRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (selfTest) runEvaluatorSelfTest();
else run().catch((error) => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; });
