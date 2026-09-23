import { strict as assert } from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDemoProject } from "../src/domain/demo";
import { applyCommand } from "../src/domain/commands";
import { projectSchema } from "../src/domain/schema";
import { DEFAULT_PARTICLE_SIMULATION } from "../src/domain/types";
import { buildEngineRenderGraph } from "../src/render/engineGraph";
import { compilePluginAutomationApplication, discoverInstalledPlugins } from "../src/plugins/registry";

const root = resolve(import.meta.dirname, "..");
const evidenceRoot = resolve(root, "../../.rd/benchmarks/editkin-particle-vfx-timeline");
const baseline = process.argv.includes("--baseline");
const selfTest = process.argv.includes("--self-test");

interface GreenReport {
  schema: "editkin.particle-vfx-timeline-gate/v1";
  status: "GREEN";
  pluginTimeParameters: true;
  persistedTimelineRange: true;
  exactFrameRange: true;
  boundedNegativeControls: string[];
}

function assertGreen(report: GreenReport): void {
  assert.equal(report.schema, "editkin.particle-vfx-timeline-gate/v1");
  assert.equal(report.status, "GREEN");
  assert.equal(report.pluginTimeParameters, true);
  assert.equal(report.persistedTimelineRange, true);
  assert.equal(report.exactFrameRange, true);
  assert.deepEqual(report.boundedNegativeControls, ["zero-duration", "past-project-end"]);
}

function runEvaluatorSelfTest(): void {
  const valid: GreenReport = {
    schema: "editkin.particle-vfx-timeline-gate/v1", status: "GREEN",
    pluginTimeParameters: true, persistedTimelineRange: true, exactFrameRange: true,
    boundedNegativeControls: ["zero-duration", "past-project-end"],
  };
  assertGreen(valid);
  let calibratedNegatives = 0;
  for (const candidate of [
    { ...valid, pluginTimeParameters: false },
    { ...valid, persistedTimelineRange: false },
    { ...valid, exactFrameRange: false },
    { ...valid, boundedNegativeControls: ["zero-duration"] },
  ]) {
    try { assertGreen(candidate as GreenReport); } catch { calibratedNegatives += 1; }
  }
  assert.equal(calibratedNegatives, 4);
  process.stdout.write(`${JSON.stringify({ status: "GREEN", evaluator: valid.schema, calibratedNegatives })}\n`);
}

async function run(): Promise<void> {
  const registry = await discoverInstalledPlugins([resolve(root, "plugins")]);
  const plugin = registry.plugins.find((item) => item.manifest.id === "studio.hao.creator-accelerators");
  const capability = plugin?.capabilities.find((item) => item.id === "particle-highlight-vfx");
  assert(plugin && capability, "bundled particle VFX capability is missing");
  const parameters = {
    start: 0.6, duration: 0.8, rate: 72, lifetime: 1.5, radius: 4.5,
    velocity_x: 18, velocity_y: -82, gravity_y: 96, emitter_x: 0.5, emitter_y: 0.74, seed: 32021,
  };
  if (baseline) {
    const project = createDemoProject();
    project.particleSimulation = {
      ...structuredClone(DEFAULT_PARTICLE_SIMULATION),
      timeline: { start: parameters.start, duration: parameters.duration },
    } as typeof DEFAULT_PARTICLE_SIMULATION;
    const reopened = projectSchema.parse(JSON.parse(JSON.stringify(project)));
    const particle = buildEngineRenderGraph(project).nodes.find((node) => node.kind === "particle_emitter");
    let pluginTimeParameters = true;
    try { compilePluginAutomationApplication(plugin, capability, "project-context", parameters); }
    catch { pluginTimeParameters = false; }
    const report = {
      schema: "editkin.particle-vfx-timeline-baseline/v1",
      status: "BLOCK",
      reason: "particle VFX has no persisted or native frame-range contract and uses global timeline time",
      pluginTimeParameters,
      persistedTimelineRange: "timeline" in (reopened.particleSimulation ?? {}),
      graphTimelineRange: particle?.timeline ?? null,
      localClockResetContract: false,
      inactiveFrameSuppressesGpuWrites: false,
    };
    assert.equal(report.pluginTimeParameters, false);
    assert.equal(report.persistedTimelineRange, false);
    assert.equal(report.graphTimelineRange, null);
    await mkdir(evidenceRoot, { recursive: true });
    await writeFile(resolve(evidenceRoot, "baseline-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }

  const commands = compilePluginAutomationApplication(plugin, capability, "project-context", parameters);
  const settingsCommand = commands.find((command) => command.type === "set_particle_simulation_settings");
  assert(settingsCommand?.type === "set_particle_simulation_settings");
  const pluginTimeParameters = settingsCommand.settings.timeline?.start === 0.6
    && settingsCommand.settings.timeline.duration === 0.8;
  assert(pluginTimeParameters, "plugin did not compile the requested particle interval");
  let project = createDemoProject();
  for (const command of commands) project = applyCommand(project, command);
  const reopened = projectSchema.parse(JSON.parse(JSON.stringify(project)));
  const persistedTimelineRange = reopened.particleSimulation?.timeline?.start === 0.6
    && reopened.particleSimulation.timeline.duration === 0.8;
  assert(persistedTimelineRange, "particle interval was not persisted");
  const particle = buildEngineRenderGraph(reopened).nodes.find((node) => node.kind === "particle_emitter");
  const exactFrameRange = JSON.stringify(particle?.timeline) === JSON.stringify({
    timelineStartFrame: 18, sourceStartFrame: 0, durationFrames: 24,
  });
  assert(exactFrameRange, "particle interval was not lowered to an exact native frame range");
  const boundedNegativeControls: string[] = [];
  assert.throws(
    () => compilePluginAutomationApplication(plugin, capability, "project-context", { ...parameters, duration: 0 }),
    /不得小於/,
  );
  boundedNegativeControls.push("zero-duration");
  const pastEndCommands = compilePluginAutomationApplication(plugin, capability, "project-context", {
    ...parameters, start: 86_399, duration: 1,
  });
  assert.throws(() => {
    let candidate = createDemoProject();
    for (const command of pastEndCommands) candidate = applyCommand(candidate, command);
  }, /不可超出專案內容/);
  boundedNegativeControls.push("past-project-end");
  const report: GreenReport & Record<string, unknown> = {
    schema: "editkin.particle-vfx-timeline-gate/v1", status: "GREEN",
    pluginTimeParameters, persistedTimelineRange, exactFrameRange, boundedNegativeControls,
    timeline: particle?.timeline,
  };
  assertGreen(report);
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(resolve(evidenceRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (selfTest) runEvaluatorSelfTest();
else run().catch((error) => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; });
