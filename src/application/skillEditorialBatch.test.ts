import { describe, expect, it } from "vitest";
import { buildSkillEditorialProject, parseSkillEditorialBatchPlan, skillEditorialProjectEvidence } from "./skillEditorialBatch";

function deliverable(id: string, ordinal: number, sourceOffset: number) {
  return {
    id,
    ordinal,
    name: `成片 ${ordinal}`,
    segments: [0, 3, 6].map((offset) => ({ sourceStart: sourceOffset + offset, duration: 3 })),
    textEvents: [
      { id: `${id}-hook`, start: 0.1, end: 1.3, text: "正版對決盜版", role: "hook" as const },
      { id: `${id}-status`, start: 3.2, end: 4.5, text: "最後一轉才分勝負", role: "status" as const },
      { id: `${id}-payoff`, start: 6.2, end: 8.8, text: "SPIN FINISH +1", role: "payoff" as const },
    ],
    trackedLabels: [{
      id: `${id}-subject`, text: "正版", start: 0.1, end: 1.2, accentColor: "#FFD84D",
      points: [
        { time: 0.1, rect: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 }, confidence: 0.94 },
        { time: 1.1, rect: { x: 0.32, y: 0.31, width: 0.2, height: 0.2 }, confidence: 0.93 },
      ],
    }],
    creative: { lookPresetId: "toy_arena_punch", effectPresetIds: ["scanline_focus"], transitionPresetId: "prism_flash_cut" },
    evidence: { editorialFingerprintSha256: "a".repeat(64), visualPlanSha256: "b".repeat(64), trackingSpecSha256: "c".repeat(64) },
  };
}

function plan() {
  return {
    schema: "hao.video-autopilot.editorial-batch/v1" as const,
    batchId: "fixture-two-shorts",
    format: "shorts" as const,
    expectedDeliverableCount: 2,
    revisionPolicy: { intent: "new_cut" as const, baselineRole: "benchmark_only" as const, requireMaterialDecisionChange: false },
    source: { path: "C:\\media\\session.mp4", sha256: "d".repeat(64), duration: 60, width: 1080, height: 1920, colorInterpretation: "hlg" as const },
    music: { assetId: "music:fixture", name: "競技配樂", path: "C:\\media\\music.m4a", sha256: "e".repeat(64), duration: 30, bpm: 132, license: "HAO-COMMUNITY-ASSET-GRANT-1.0", provenance: "fixture", redistributable: true as const },
    soundEffects: [
      { assetId: "sfx:whoosh", name: "Whoosh", role: "transition-whoosh" as const, path: "C:\\media\\whoosh.wav", sha256: "1".repeat(64), duration: 0.4, license: "CC-BY-4.0" as const, provenance: "fixture", redistributable: true as const },
      { assetId: "sfx:impact", name: "Impact", role: "payoff-impact" as const, path: "C:\\media\\impact.wav", sha256: "2".repeat(64), duration: 0.5, license: "CC-BY-4.0" as const, provenance: "fixture", redistributable: true as const },
    ],
    policy: { oneEditableProjectPerDeliverable: true as const, muteOriginalAudio: true as const, addMusic: true as const, useAces2: true as const, requireVisibleTypography: true as const, preserveMeaningfulWaits: true as const, allowCompilationFallback: false as const, allowSourceReuse: false as const },
    deliverables: [deliverable("short-01", 1, 0), deliverable("short-02", 2, 10)],
  };
}

describe("Skill editorial batch bridge", () => {
  it("preserves N deliverables as N plans instead of accepting one compilation", () => {
    const parsed = parseSkillEditorialBatchPlan(plan());
    expect(parsed.deliverables).toHaveLength(2);
    expect(() => parseSkillEditorialBatchPlan({ ...plan(), deliverables: [plan().deliverables[0]] })).toThrow(/禁止退化成合輯/);
  });

  it("rejects source reuse across independent deliverables", () => {
    const overlapping = plan();
    overlapping.deliverables[1] = deliverable("short-02", 2, 6);
    expect(() => parseSkillEditorialBatchPlan(overlapping)).toThrow(/重複使用/);
  });

  it("blocks a fake recut whose editorial fingerprint did not change", () => {
    const base = plan();
    const fake = {
      ...base,
      revisionPolicy: { intent: "recut" as const, baselineRole: "benchmark_only" as const, requireMaterialDecisionChange: true },
      deliverables: base.deliverables.map((item) => ({ ...item, evidence: { ...item.evidence, previousEditorialFingerprintSha256: item.evidence.editorialFingerprintSha256 } })),
    };
    expect(() => parseSkillEditorialBatchPlan(fake)).toThrow(/重新渲染冒充重剪/);
  });

  it("builds an editable ACES2 timeline with muted source, music, typography, tracking, effects and a motivated transition", () => {
    const parsed = parseSkillEditorialBatchPlan(plan());
    const project = buildSkillEditorialProject(parsed, parsed.deliverables[0]);
    const evidence = skillEditorialProjectEvidence(project);
    expect(evidence).toMatchObject({
      sourceClipCount: 3,
      originalAudioMuted: true,
      musicClipCount: 1,
      sfxClipCount: 2,
      captionCount: 1,
      motionGraphicCount: 3,
      motionTrackCount: 1,
      aces2: true,
      transitionCount: 1,
    });
    expect(evidence.lookIds).toEqual(["toy_arena_punch"]);
    expect(evidence.effectIds).toEqual(["scanline_focus"]);
  });
});
