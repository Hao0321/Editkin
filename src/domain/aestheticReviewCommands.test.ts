import { describe, expect, it } from "vitest";
import { applyCommand } from "./commands";
import { createDemoProject } from "./demo";
import { resolveAestheticSystem } from "../application/editkinAesthetic";
import { AESTHETIC_BENCHMARKS, BENCHMARK_AXES } from "./aestheticBenchmarks";
import type { AestheticBenchmarkReview } from "./types";

function benchmarkFixture(): AestheticBenchmarkReview {
  return { schema: "editkin.aesthetic-benchmark-review/v1", artifact: { outputSha256: "a".repeat(64), fps: 30, durationFrames: 300 }, axes: Object.fromEntries(BENCHMARK_AXES.map(axis => [axis, Object.fromEntries(AESTHETIC_BENCHMARKS[axis].map(item => [item.id, { rating: 5, evidence: [{ fromFrame: 0, toFrame: 30, observation: "Synthetic test only" }] }]))])) };
}

describe("aesthetic review command data consistency (not human authentication)", () => {
  for (const mode of ["empty", "low", "missing"] as const) {
    it(`does not accept forged PASSED/100 with ${mode} ratings`, () => {
      const project = createDemoProject();
      project.aestheticSystem = resolveAestheticSystem("gaming", "shorts");
      const dimensions = project.aestheticSystem.dimensions;
      const ratings = mode === "empty" ? {} : Object.fromEntries(dimensions.slice(0, mode === "missing" ? -1 : undefined).map(d => [d.id, mode === "low" ? 1 : 5]));
      const result = applyCommand(project, { type: "set_aesthetic_review", review: {
        status: "PASSED", score: 100, ratings, machineBlockers: [], completedAt: "2026-08-31T00:00:00.000Z",
      } });
      // Missing the new benchmark subreviews means an incomplete REVIEW, even for legacy low totals.
      expect(result.aestheticSystem!.review.status).toBe("REVIEW");
      expect(result.aestheticSystem!.review.score).toBeLessThan(100);
      expect(project.aestheticSystem.review.status).toBe("REVIEW");
    });
  }
  it("recomputes legacy ratings but does not promote them without benchmark evidence", () => {
    const project = createDemoProject();
    project.aestheticSystem = resolveAestheticSystem("gaming", "shorts");
    const ratings = Object.fromEntries(project.aestheticSystem.dimensions.map(d => [d.id, 5]));
    const next = applyCommand(project, { type: "set_aesthetic_review", review: {
      status: "REVIEW", score: 0, ratings, machineBlockers: [], completedAt: "2026-08-31T00:00:00.000Z",
    } });
    expect(next.aestheticSystem!.review.status).toBe("REVIEW");
    expect(next.aestheticSystem!.review.score).toBeLessThan(100);
    expect(next.aestheticSystem!.review.ratings.mrbeast_information_energy).toBeUndefined();
  });
  it.each([undefined, "not-a-date"])("requires usable completion metadata (%s)", completedAt => {
    const project = createDemoProject();
    project.aestheticSystem = resolveAestheticSystem("gaming", "shorts");
    const ratings = Object.fromEntries(project.aestheticSystem.dimensions.map(d => [d.id, 5]));
    const next = applyCommand(project, { type: "set_aesthetic_review", review: { status: "PASSED", score: 100, ratings, machineBlockers: [], completedAt } });
    expect(next.aestheticSystem!.review).toMatchObject({ status: "REVIEW", completedAt: undefined });
  });
  it("does not clear existing blockers when a caller supplies an empty list", () => {
    const project = createDemoProject();
    project.aestheticSystem = resolveAestheticSystem("gaming", "shorts");
    project.aestheticSystem.review.machineBlockers = ["unsafe-text"];
    const ratings = Object.fromEntries(project.aestheticSystem.dimensions.map(d => [d.id, 5]));
    const next = applyCommand(project, { type: "set_aesthetic_review", review: { status: "PASSED", score: 100, ratings, machineBlockers: [], completedAt: "2026-08-31T00:00:00.000Z" } });
    expect(next.aestheticSystem!.review).toMatchObject({ status: "BLOCKED", machineBlockers: ["unsafe-text"] });
  });
  it("reconciles a system supplied inside a batch rather than trusting its score", () => {
    const system = resolveAestheticSystem("gaming", "shorts");
    system.review = { status: "PASSED", score: 100, ratings: {}, machineBlockers: [], completedAt: "2026-08-31T00:00:00.000Z" };
    const next = applyCommand(createDemoProject(), { type: "batch", commands: [{ type: "set_aesthetic_system", aestheticSystem: system }] });
    expect(next.aestheticSystem!.review).toMatchObject({ status: "REVIEW", score: 0, ratings: {} });
    expect(system.review.status).toBe("PASSED");
  });
  it("keeps a high total with a below-minimum dimension in REVIEW", () => {
    const project = createDemoProject();
    project.aestheticSystem = resolveAestheticSystem("gaming", "shorts");
    project.aestheticSystem.review.benchmarkReview = benchmarkFixture();
    const dimensions = [...project.aestheticSystem.dimensions].sort((a,b) => a.weight-b.weight);
    const ratings = Object.fromEntries(dimensions.map(d => [d.id, 5]));
    ratings[dimensions[0].id] = 3;
    const next = applyCommand(project, { type: "set_aesthetic_review", review: { status: "PASSED", score: 100, ratings, machineBlockers: [], completedAt: "2026-08-31T00:00:00.000Z" } });
    expect(next.aestheticSystem!.review.score).toBeGreaterThan(90);
    expect(next.aestheticSystem!.review.status).toBe("REVIEW");
  });
});
