import type { AestheticReview, AestheticSystem, AestheticBenchmarkReview, AestheticArtifactBinding } from "./types";
import { BENCHMARK_AXES, evaluateAestheticBenchmarks } from "./aestheticBenchmarks";

/** Data consistency only. Ratings and completion metadata are not proof of human identity. */
export function scoreAestheticReview(system: AestheticSystem, ratings: Record<string, number>, options: { machineBlockers?: string[]; complete?: boolean; completedAt?: string; benchmarkReview?: AestheticBenchmarkReview; currentArtifact?: AestheticArtifactBinding } = {}): AestheticReview {
  const benchmarkReview = options.benchmarkReview ?? system.review.benchmarkReview;
  const benchmarks = evaluateAestheticBenchmarks(benchmarkReview, options.currentArtifact);
  const effectiveRatings = { ...ratings };
  for (const axis of BENCHMARK_AXES) {
    delete effectiveRatings[axis];
    if (benchmarks.scores[axis] !== undefined) effectiveRatings[axis] = benchmarks.scores[axis]! / 2;
  }
  const normalized: Record<string, number> = {};
  let score = 0;
  const low: string[] = [];
  for (const dimension of system.dimensions) {
    const value = effectiveRatings[dimension.id];
    if (!Number.isFinite(value)) continue;
    const rating = Math.max(1, Math.min(5, Number(value)));
    normalized[dimension.id] = rating;
    score += rating / 5 * dimension.weight;
    if (rating < system.scoreContract.minimumDimensionRating) low.push(dimension.id);
  }
  const machineBlockers = [...new Set(options.machineBlockers ?? system.review.machineBlockers)].sort();
  const complete = options.complete === true && system.dimensions.every((dimension) => normalized[dimension.id] !== undefined);
  const rounded = Math.round(score * 10) / 10;
  const status = machineBlockers.length > 0 || (complete && rounded < system.scoreContract.blockBelow)
    ? "BLOCKED"
    : complete && benchmarks.complete && benchmarks.floorsPassed && low.length === 0 && rounded >= system.scoreContract.passScore
      ? "PASSED"
      : "REVIEW";
  return { status, score: rounded, ratings: normalized, machineBlockers,
    benchmarkReview: benchmarkReview ? structuredClone(benchmarkReview) : undefined,
    completedAt: complete ? options.completedAt ?? new Date().toISOString() : undefined };
}

export function reconcileAestheticReview(system: AestheticSystem, review: AestheticReview, currentArtifact?: AestheticArtifactBinding): AestheticReview {
  const complete = typeof review.completedAt === "string" && Number.isFinite(Date.parse(review.completedAt));
  return scoreAestheticReview(system, review.ratings, {
    complete, completedAt: complete ? review.completedAt : undefined,
    benchmarkReview: review.benchmarkReview,
    currentArtifact,
    machineBlockers: [...system.review.machineBlockers, ...review.machineBlockers],
  });
}
