import { describe, expect, it } from "vitest";
import { AESTHETIC_BENCHMARKS, BENCHMARK_AXES, evaluateAestheticBenchmarks } from "./aestheticBenchmarks";
import { scoreAestheticReview } from "./aestheticReview";
import { aestheticBenchmarkReviewSchema, projectSchema } from "./schema";
import { resolveAestheticSystem } from "../application/editkinAesthetic";
import { createDemoProject } from "./demo";
import { applyCommand } from "./commands";
import type { AestheticBenchmarkReview } from "./types";

const artifact = { outputSha256: "a".repeat(64), fps: 30, durationFrames: 300 };
function fixture(rating = 5): AestheticBenchmarkReview {
  return { schema: "editkin.aesthetic-benchmark-review/v1", artifact, axes: Object.fromEntries(BENCHMARK_AXES.map(axis => [axis, Object.fromEntries(AESTHETIC_BENCHMARKS[axis].map(item => [item.id, { rating, evidence: [{ fromFrame: 0, toFrame: 30, observation: "Synthetic test review, not a human approval" }] }]))])) };
}
function score(review?: AestheticBenchmarkReview, currentArtifact = artifact) {
  const system = resolveAestheticSystem("gaming", "shorts");
  return scoreAestheticReview(system, Object.fromEntries(system.dimensions.map(d => [d.id, 5])), { complete: true, benchmarkReview: review, currentArtifact });
}
describe("dual benchmark decomposition, not certification", () => {
  it("keeps each eight-item rubric at ten points and maps to the existing two axes", () => {
    for (const axis of BENCHMARK_AXES) {
      expect(AESTHETIC_BENCHMARKS[axis]).toHaveLength(8);
      expect(AESTHETIC_BENCHMARKS[axis].reduce((s,i) => s+i.points,0)).toBe(10);
    }
    expect(score(fixture())).toMatchObject({ status: "PASSED", score: 100 });
  });
  it("requires both current output binding and all sixteen evidence-backed ratings", () => {
    expect(score().status).toBe("REVIEW");
    const review = fixture();
    delete review.axes.mrbeast_information_energy!.promise_stakes;
    expect(score(review).status).toBe("REVIEW");
    expect(score(fixture(), { ...artifact, outputSha256: "b".repeat(64) }).status).toBe("REVIEW");
    expect(evaluateAestheticBenchmarks(fixture()).complete).toBe(false);
    const draft = fixture(); delete draft.artifact;
    expect(score(draft).status).toBe("REVIEW");
  });
  it("does not round 6.99 up or allow the other axis to compensate", () => {
    const review = fixture();
    for (const value of Object.values(review.axes.mrbeast_information_energy!)) value.rating = 3.495;
    const evaluated = evaluateAestheticBenchmarks(review, artifact);
    expect(evaluated.scores.mrbeast_information_energy).toBeCloseTo(6.99);
    expect(evaluated.floorsPassed).toBe(false);
    expect(score(review).status).toBe("REVIEW");
    for (const value of Object.values(review.axes.mrbeast_information_energy!)) value.rating = 3.5;
    expect(evaluateAestheticBenchmarks(review, artifact).floorsPassed).toBe(true);
  });
  it("roundtrips drafts and complete evidence through actual project schema and commands", () => {
    const project = createDemoProject(); project.aestheticSystem = resolveAestheticSystem("gaming", "shorts");
    const review = score(fixture());
    const next = applyCommand(project, { type: "set_aesthetic_review", review });
    // Commands have no output-owner binding context; never trust the embedded artifact as current.
    expect(next.aestheticSystem!.review.status).toBe("REVIEW");
    const restored = projectSchema.parse(JSON.parse(JSON.stringify(next)));
    expect(restored.aestheticSystem!.review.benchmarkReview).toEqual(fixture());
    expect(projectSchema.parse(JSON.parse(JSON.stringify(project))).aestheticSystem!.review.status).toBe("REVIEW");
    expect(aestheticBenchmarkReviewSchema.parse({ schema: "editkin.aesthetic-benchmark-review/v1", axes: {} }).axes).toEqual({});
  });
  it("rejects out-of-output, inverted and unknown evidence keys", () => {
    for (const end of [0, 301]) {
      const review = fixture(); review.axes.mrbeast_information_energy!.promise_stakes.evidence[0].toFrame = end;
      expect(aestheticBenchmarkReviewSchema.safeParse(review).success).toBe(false);
      expect(score(review).status).toBe("REVIEW");
    }
    const review = fixture(); review.axes.mrbeast_information_energy!.unknown = { rating: 5, evidence: [] };
    expect(aestheticBenchmarkReviewSchema.safeParse(review).success).toBe(false);
  });
  it("keeps missing evidence REVIEW, blockers BLOCKED, and derives axes over caller totals", () => {
    const review = fixture(); review.axes.mrbeast_information_energy!.promise_stakes.evidence = [];
    expect(score(review).status).toBe("REVIEW");
    const system = resolveAestheticSystem("gaming", "shorts"); system.review.benchmarkReview = fixture(1);
    const result = scoreAestheticReview(system, Object.fromEntries(system.dimensions.map(d => [d.id,5])), { complete: true, currentArtifact: artifact });
    expect(result.ratings.mrbeast_information_energy).toBe(1);
    expect(result.status).not.toBe("PASSED");
    expect(scoreAestheticReview(system, {}, { machineBlockers: ["unsafe-text"] }).status).toBe("BLOCKED");
  });
});
