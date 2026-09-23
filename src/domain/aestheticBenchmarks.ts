import type { AestheticArtifactBinding, AestheticBenchmarkAxis, AestheticBenchmarkReview } from "./types";
export const AESTHETIC_BENCHMARK_PROVENANCE = {
  rubric: { reference: "references/mrbeast-and-yingshi-benchmark.md", sha256: "6be63bf903c1ebd8fd3d2e23fbfde69a0453c23b9b4e417fa5c65c2943a9f080" },
  parentStandard: { reference: "references/hao-aesthetic-standard.md", sha256: "c56b4734b347e01575c7f25e7be8c75f36c3b44e5c47750f9bb8136b49549f23" },
} as const;

/** Canonical rubric: video-autopilot/references/mrbeast-and-yingshi-benchmark.md §1.
 * These are the two existing ten-dimension axes, not another overall score. */
export const AESTHETIC_BENCHMARKS = {
  mrbeast_information_energy: [
    { id: "promise_stakes", label: "承諾與 stakes", points: 1.5 },
    { id: "state_visualization", label: "狀態可視化", points: 1.5 },
    { id: "focus_guidance", label: "焦點引導", points: 1.5 },
    { id: "scale_value", label: "尺度／價值對比", points: 1 },
    { id: "pattern_interrupt", label: "Pattern interrupt", points: 1 },
    { id: "payoff", label: "Payoff 回報", points: 1.5 },
    { id: "rhythm_wave", label: "節奏波", points: 1 },
    { id: "finish", label: "完成度", points: 1 },
  ],
  yingshi_hurricane_cinematic_craft: [
    { id: "shot_motivation", label: "鏡頭動機", points: 1.5 },
    { id: "cut_continuity", label: "剪點與連續性", points: 1.5 },
    { id: "audiovisual_rhythm", label: "聲畫節奏", points: 1.5 },
    { id: "color_exposure", label: "調色與曝光", points: 1.5 },
    { id: "light_material", label: "光影與材質", points: 1 },
    { id: "space_scale", label: "空間與尺度", points: 1 },
    { id: "narrative_wave", label: "敘事能量波", points: 1 },
    { id: "restraint", label: "克制與隱形工藝", points: 1 },
  ],
} as const;
export const BENCHMARK_AXES = Object.keys(AESTHETIC_BENCHMARKS) as AestheticBenchmarkAxis[];
export function validAestheticArtifact(binding?: AestheticArtifactBinding): binding is AestheticArtifactBinding {
  return !!binding && /^[a-f0-9]{64}$/i.test(binding.outputSha256)
    && Number.isFinite(binding.fps) && binding.fps > 0
    && Number.isSafeInteger(binding.durationFrames) && binding.durationFrames > 0;
}
/** currentArtifact must come from the current output owner, never from the submitted review. */
export function evaluateAestheticBenchmarks(review?: AestheticBenchmarkReview, currentArtifact?: AestheticArtifactBinding) {
  const binding = review?.artifact;
  const bound = review?.schema === "editkin.aesthetic-benchmark-review/v1" && validAestheticArtifact(binding) && validAestheticArtifact(currentArtifact)
    && binding.outputSha256 === currentArtifact.outputSha256 && binding.fps === currentArtifact.fps
    && binding.durationFrames === currentArtifact.durationFrames;
  const missing: string[] = [];
  const scores: Partial<Record<AestheticBenchmarkAxis, number>> = {};
  for (const axis of BENCHMARK_AXES) {
    let total = 0;
    let complete = true;
    const items = review?.axes[axis];
    for (const id of Object.keys(items ?? {})) if (!AESTHETIC_BENCHMARKS[axis].some(item => item.id === id)) {
      complete = false; missing.push(`${axis}.${id}:unknown`);
    }
    for (const item of AESTHETIC_BENCHMARKS[axis]) {
      const value = items?.[item.id];
      const valid = value && Number.isFinite(value.rating) && value.rating! >= 1 && value.rating! <= 5
        && validAestheticArtifact(binding) && value.evidence.length > 0
        && value.evidence.every(e => Number.isSafeInteger(e.fromFrame) && Number.isSafeInteger(e.toFrame)
          && e.fromFrame >= 0 && e.toFrame > e.fromFrame && e.toFrame <= binding.durationFrames && e.observation.trim().length > 0);
      if (!valid) { complete = false; missing.push(`${axis}.${item.id}`); }
      else total += item.points * value.rating! / 5;
    }
    if (complete) scores[axis] = total;
  }
  return { bound, missing, scores, complete: bound && missing.length === 0,
    floorsPassed: BENCHMARK_AXES.every(axis => (scores[axis] ?? -1) >= 7) };
}
