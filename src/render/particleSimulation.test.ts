import { describe, expect, it } from "vitest";
import { applyCommand } from "../domain/commands";
import { createDemoProject } from "../domain/demo";
import { migrateProject, validateProject } from "../domain/editGraph";
import { projectSchema } from "../domain/schema";
import { DEFAULT_PARTICLE_SIMULATION, DEFAULT_SCENE_25D } from "../domain/types";
import { buildEngineRenderGraph } from "./engineGraph";
import { buildGpuEnginePreviewGraph } from "./gpuCompositor";

function particleProject() {
  const project = createDemoProject();
  project.assets[0].kind = "image";
  project.assets[0].uri = "C:/plates/background.png";
  project.particleSimulation = structuredClone(DEFAULT_PARTICLE_SIMULATION);
  return project;
}

describe("persisted native particle simulation product contract", () => {
  it("round-trips the typed settings and emits a directly executable simulation graph", () => {
    const project = validateProject(particleProject());
    const reopened = validateProject(migrateProject(projectSchema.parse(JSON.parse(JSON.stringify(project)))));
    expect(reopened.particleSimulation).toEqual(DEFAULT_PARTICLE_SIMULATION);
    const graph = buildEngineRenderGraph(reopened);
    expect(graph.nodes.find((node) => node.id === "vfx:particles")).toMatchObject({
      kind: "particle_emitter", seed: 32021, ratePerSecond: 48, maxParticles: 64,
      timeline: { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 360 },
      initialVelocity: [18, -76, 0], gravity: [0, 82, 0],
    });
    expect(graph.nodes.find((node) => node.inputs.includes("vfx:particles"))).toMatchObject({ kind: "composite" });
    const preview = buildGpuEnginePreviewGraph(reopened, 0.6)!;
    expect(preview.vfxSimulationExpectation).toEqual({ emitterCount: 1, particleCeiling: 64, executor: "wgpu-bounded-particle-compute/v1" });
    expect(preview.timelineFrame).toBe(18);
  });

  it("enables, edits and removes the effect through typed undoable commands", () => {
    let project = applyCommand(createDemoProject(), { type: "configure_particle_simulation", enabled: true });
    expect(project.particleSimulation).toEqual(DEFAULT_PARTICLE_SIMULATION);
    project = applyCommand(project, {
      type: "set_particle_simulation_settings",
      settings: { ...project.particleSimulation!, ratePerSecond: 72, emitterPosition: [0.25, 0.8] },
    });
    expect(project.particleSimulation).toMatchObject({ ratePerSecond: 72, emitterPosition: [0.25, 0.8] });
    project = applyCommand(project, { type: "configure_particle_simulation", enabled: false });
    expect(project.particleSimulation).toBeUndefined();
  });

  it("fails closed for ceiling violations and incompatible 2.5D mixing", () => {
    const tooMany = particleProject();
    tooMany.particleSimulation!.maxParticles = 65;
    expect(() => validateProject(tooMany)).toThrow(/粒子 VFX/);
    const mixed = particleProject();
    mixed.scene25d = structuredClone(DEFAULT_SCENE_25D);
    expect(() => validateProject(mixed)).toThrow(/不可與 2.5D/);
  });

  it("persists a beat-bounded interval, lowers exact frames, and rejects invalid ranges", () => {
    const project = particleProject();
    project.particleSimulation!.timeline = { start: 0.6, duration: 0.8 };
    const reopened = validateProject(migrateProject(projectSchema.parse(JSON.parse(JSON.stringify(project)))));
    expect(reopened.particleSimulation?.timeline).toEqual({ start: 0.6, duration: 0.8 });
    expect(buildEngineRenderGraph(reopened).nodes.find((node) => node.id === "vfx:particles")?.timeline).toEqual({
      timelineStartFrame: 18, sourceStartFrame: 0, durationFrames: 24,
    });
    const zero = particleProject();
    zero.particleSimulation!.timeline = { start: 0, duration: 0 };
    expect(() => validateProject(zero)).toThrow(/粒子 VFX 區間/);
    const pastEnd = particleProject();
    pastEnd.particleSimulation!.timeline = { start: 11.8, duration: 0.3 };
    expect(() => validateProject(pastEnd)).toThrow(/不可超出專案內容/);
  });

  it("persists two independently timed emitters and enforces aggregate resource limits", () => {
    const project = particleProject();
    project.particleSimulation!.timeline = { start: .6, duration: .8 };
    project.particleSimulation!.additionalEmitters = [{
      id: "cool-trail", timeline: { start: .8, duration: .6 }, seed: 90210,
      ratePerSecond: 36, lifetimeSeconds: .9, maxParticles: 48,
      emitterPosition: [.35, .62], initialVelocity: [-22, -58], gravity: [0, 70],
      radiusPixels: 2.5, color: [.1, .65, 1, .85],
    }];
    const reopened = validateProject(migrateProject(projectSchema.parse(JSON.parse(JSON.stringify(project)))));
    expect(reopened.particleSimulation?.additionalEmitters).toHaveLength(1);
    expect(buildEngineRenderGraph(reopened).nodes.filter((node) => node.kind === "particle_emitter")).toMatchObject([
      { id: "vfx:particles", timeline: { timelineStartFrame: 18, durationFrames: 24 }, maxParticles: 64 },
      { id: "vfx:particles:cool-trail", timeline: { timelineStartFrame: 24, durationFrames: 18 }, maxParticles: 48 },
    ]);
    const duplicate = structuredClone(project);
    duplicate.particleSimulation!.additionalEmitters!.push({ ...structuredClone(duplicate.particleSimulation!.additionalEmitters![0]), seed: 90211 });
    expect(() => validateProject(duplicate)).toThrow(/ID 不可重複/);
    const overBudget = structuredClone(project);
    overBudget.particleSimulation!.maxParticles = 64;
    overBudget.particleSimulation!.additionalEmitters = ["two", "three", "four"].map((id, index) => ({
      ...structuredClone(project.particleSimulation!.additionalEmitters![0]), id, seed: 90210 + index, maxParticles: 64,
    }));
    expect(() => validateProject(overBudget)).toThrow(/總粒子預算不得超過 192/);
  });
});
