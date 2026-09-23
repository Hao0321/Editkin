import { strict as assert } from "node:assert";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDemoProject } from "../src/domain/demo";
import { validateProject } from "../src/domain/editGraph";
import { projectSchema } from "../src/domain/schema";
import { DEFAULT_PARTICLE_SIMULATION } from "../src/domain/types";
import { buildEngineRenderGraph } from "../src/render/engineGraph";
import { buildGpuEngineVideoPreviewGraph } from "../src/render/gpuCompositor";
import { compilePluginAutomationApplication, findInstalledCapability, discoverInstalledPlugins } from "../src/plugins/registry";

const root = resolve(import.meta.dirname, "..");
const evidenceRoot = resolve(root, "../../.rd/benchmarks/editkin-multi-emitter-particle-vfx");
const baseline = process.argv.includes("--baseline");
const selfTest = process.argv.includes("--self-test");

interface GreenReport {
  schema: "editkin.multi-emitter-particle-vfx-gate/v1";
  status: "GREEN";
  persistedEmitterCount: 2;
  nativeNodeCount: 2;
  previewEmitterCount: 2;
  pluginEmitterCount: 2;
  pluginProjectScoped: true;
  totalParticleCeiling: 112;
  calibratedNegativeControls: ["fifth-emitter", "aggregate-particle-budget", "duplicate-emitter-id"];
}

function assertGreen(report: GreenReport): void {
  assert.equal(report.schema, "editkin.multi-emitter-particle-vfx-gate/v1");
  assert.equal(report.status, "GREEN");
  assert.equal(report.persistedEmitterCount, 2);
  assert.equal(report.nativeNodeCount, 2);
  assert.equal(report.previewEmitterCount, 2);
  assert.equal(report.pluginEmitterCount, 2);
  assert.equal(report.pluginProjectScoped, true);
  assert.equal(report.totalParticleCeiling, 112);
  assert.deepEqual(report.calibratedNegativeControls, ["fifth-emitter", "aggregate-particle-budget", "duplicate-emitter-id"]);
}

function projectWithTwoEmitters() {
  const project = createDemoProject();
  project.width = 960;
  project.height = 540;
  project.assets[0].width = 960;
  project.assets[0].height = 540;
  project.assets[0].uri = "C:/fixtures/demo-source.mp4";
  project.particleSimulation = {
    ...structuredClone(DEFAULT_PARTICLE_SIMULATION),
    timeline: { start: 0.6, duration: 0.8 },
  };
  (project.particleSimulation as unknown as { additionalEmitters: unknown[] }).additionalEmitters = [{
    id: "cool-trail",
    timeline: { start: 0.8, duration: 0.6 },
    seed: 90210,
    ratePerSecond: 36,
    lifetimeSeconds: 0.9,
    maxParticles: 48,
    emitterPosition: [0.35, 0.62],
    initialVelocity: [-22, -58],
    gravity: [0, 70],
    radiusPixels: 2.5,
    color: [0.1, 0.65, 1, 0.85],
  }];
  return project;
}

function evaluatorSelfTest(): void {
  const valid: GreenReport = {
    schema: "editkin.multi-emitter-particle-vfx-gate/v1", status: "GREEN",
    persistedEmitterCount: 2, nativeNodeCount: 2, previewEmitterCount: 2, pluginEmitterCount: 2, pluginProjectScoped: true, totalParticleCeiling: 112,
    calibratedNegativeControls: ["fifth-emitter", "aggregate-particle-budget", "duplicate-emitter-id"],
  };
  assertGreen(valid);
  let rejected = 0;
  for (const candidate of [
    { ...valid, persistedEmitterCount: 1 },
    { ...valid, nativeNodeCount: 1 },
    { ...valid, previewEmitterCount: 1 },
    { ...valid, pluginEmitterCount: 1 },
    { ...valid, pluginProjectScoped: false },
    { ...valid, totalParticleCeiling: 256 },
    { ...valid, calibratedNegativeControls: ["fifth-emitter"] },
  ]) {
    try { assertGreen(candidate as GreenReport); } catch { rejected += 1; }
  }
  assert.equal(rejected, 7);
  process.stdout.write(`${JSON.stringify({ status: "GREEN", evaluator: valid.schema, calibratedNegatives: rejected })}\n`);
}

async function run(): Promise<void> {
  const project = projectWithTwoEmitters();
  const reopened = projectSchema.parse(JSON.parse(JSON.stringify(project))) as unknown as {
    particleSimulation?: { additionalEmitters?: unknown[] };
  };
  const graph = buildEngineRenderGraph(project);
  const preview = buildGpuEngineVideoPreviewGraph(project, 0.9);
  if (baseline) {
    const existingNativeReport = JSON.parse(await readFile(resolve(root, "../../.rd/benchmarks/editkin-common-engine-video-particle/report.json"), "utf8")) as {
      rejectedNegativeControls?: string[];
    };
    const report = {
      schema: "editkin.multi-emitter-particle-vfx-baseline/v1",
      status: "BLOCK",
      reason: "the product schema strips additional emitters, graph lowering emits one node, and native common-video admission rejects a second emitter",
      persistedEmitterCount: 1 + (reopened.particleSimulation?.additionalEmitters?.length ?? 0),
      nativeNodeCount: graph.nodes.filter((node) => node.kind === "particle_emitter").length,
      previewEmitterCount: preview?.vfxSimulationExpectation?.emitterCount ?? null,
      nativeRejectsSecondEmitter: existingNativeReport.rejectedNegativeControls?.includes("multiple") === true,
    };
    assert.equal(report.persistedEmitterCount, 1);
    assert.equal(report.nativeNodeCount, 1);
    assert.equal(report.previewEmitterCount, 1);
    assert.equal(report.nativeRejectsSecondEmitter, true);
    await mkdir(evidenceRoot, { recursive: true });
    await writeFile(resolve(evidenceRoot, "baseline-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  const validated = validateProject(projectSchema.parse(JSON.parse(JSON.stringify(project))));
  const emitters = [validated.particleSimulation!, ...(validated.particleSimulation?.additionalEmitters ?? [])];
  const persistedEmitterCount = emitters.length;
  const nativeParticles = buildEngineRenderGraph(validated).nodes.filter((node) => node.kind === "particle_emitter");
  const nativeNodeCount = nativeParticles.length;
  const admittedPreview = buildGpuEngineVideoPreviewGraph(validated, 0.9);
  const previewEmitterCount = admittedPreview?.vfxSimulationExpectation?.emitterCount;
  const totalParticleCeiling = admittedPreview?.vfxSimulationExpectation?.particleCeiling;
  const registry = await discoverInstalledPlugins([resolve(root, "plugins")]);
  const installed = findInstalledCapability(registry, "studio.hao.creator-accelerators", "dual-particle-burst-vfx");
  const pluginCommands = compilePluginAutomationApplication(installed.plugin, installed.capability, "project-context", {
    start: .6, duration: .8, secondary_start: .8, secondary_duration: .6, primary_rate: 48, secondary_rate: 36,
  });
  const pluginSettingsCommand = pluginCommands.find((command) => command.type === "set_particle_simulation_settings");
  const pluginEmitterCount = pluginSettingsCommand?.type === "set_particle_simulation_settings"
    ? 1 + (pluginSettingsCommand.settings.additionalEmitters?.length ?? 0) : 0;
  const pluginProjectScoped = pluginCommands.every((command) => !("clipId" in command));
  assert.deepEqual(nativeParticles.map((node) => ({ id: node.id, timeline: node.timeline })), [
    { id: "vfx:particles", timeline: { timelineStartFrame: 18, sourceStartFrame: 0, durationFrames: 24 } },
    { id: "vfx:particles:cool-trail", timeline: { timelineStartFrame: 24, sourceStartFrame: 0, durationFrames: 18 } },
  ]);
  const calibratedNegativeControls: GreenReport["calibratedNegativeControls"] = [] as unknown as GreenReport["calibratedNegativeControls"];
  const expectRejected = (name: GreenReport["calibratedNegativeControls"][number], mutate: (candidate: ReturnType<typeof projectWithTwoEmitters>) => void, marker: RegExp) => {
    const candidate = projectWithTwoEmitters();
    mutate(candidate);
    assert.throws(() => validateProject(candidate), marker);
    calibratedNegativeControls.push(name);
  };
  expectRejected("fifth-emitter", (candidate) => {
    const additional = candidate.particleSimulation!.additionalEmitters!;
    additional.push(...["third", "fourth", "fifth"].map((id, index) => ({ ...structuredClone(additional[0]), id, seed: 90211 + index })));
  }, /最多 4 個發射器/);
  expectRejected("aggregate-particle-budget", (candidate) => {
    candidate.particleSimulation!.maxParticles = 64;
    const additional = candidate.particleSimulation!.additionalEmitters!;
    additional[0].maxParticles = 64;
    additional.push(
      { ...structuredClone(additional[0]), id: "third", seed: 90211 },
      { ...structuredClone(additional[0]), id: "fourth", seed: 90212 },
    );
  }, /總粒子預算不得超過 192/);
  expectRejected("duplicate-emitter-id", (candidate) => {
    const additional = candidate.particleSimulation!.additionalEmitters!;
    additional.push({ ...structuredClone(additional[0]), seed: 90211 });
  }, /ID 不可重複/);
  const report: GreenReport & Record<string, unknown> = {
    schema: "editkin.multi-emitter-particle-vfx-gate/v1", status: "GREEN",
    persistedEmitterCount: persistedEmitterCount as 2,
    nativeNodeCount: nativeNodeCount as 2,
    previewEmitterCount: previewEmitterCount as 2,
    pluginEmitterCount: pluginEmitterCount as 2,
    pluginProjectScoped: pluginProjectScoped as true,
    totalParticleCeiling: totalParticleCeiling as 112,
    calibratedNegativeControls,
    emitters: nativeParticles.map((node) => ({ id: node.id, timeline: node.timeline, maxParticles: node.maxParticles })),
  };
  assertGreen(report);
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(resolve(evidenceRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (selfTest) evaluatorSelfTest();
else run().catch((error) => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; });
