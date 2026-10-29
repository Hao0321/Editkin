import { describe, expect, it } from "vitest";
import {
  audioKeepRangesFromSmartCut, planNarrationPauseTrim, planSemanticAutoEdit, planVisualQualityAutoEdit, visualHighlightTargetSeconds,
  type SemanticCue,
} from "./semanticAutoEdit";

const FPS = 30;

function spokenCoverage(cues: readonly SemanticCue[], ranges: ReadonlyArray<{ start: number; end: number }>): number {
  let spoken = 0; let kept = 0;
  for (const cue of cues) {
    spoken += cue.end - cue.start;
    for (const range of ranges) kept += Math.max(0, Math.min(cue.end, range.end) - Math.max(cue.start, range.start));
  }
  return kept / spoken;
}

/** A 10-minute talk: 4 s sentences separated by pauses of 0.3–2.5 s (deterministic). */
function lecture(): { duration: number; cues: SemanticCue[] } {
  const cues: SemanticCue[] = [];
  let cursor = 1.2;
  for (let index = 0; cursor < 590; index += 1) {
    const length = 2 + (index * 7 % 5) * 0.6;
    cues.push({ start: cursor, end: cursor + length, text: index % 9 === 0 ? "嗯 那個" : `第 ${index} 句完整旁白內容` });
    cursor += length + [0.3, 0.5, 0.8, 1.6, 2.5][index % 5];
  }
  return { duration: 600, cues };
}

describe("long-form narration keeps every spoken word (roadmap 1.14)", () => {
  it("keeps 100% of the narration and removes only pauses — the 0.65 highlight default drops a third of it", () => {
    const { duration, cues } = lecture();
    const narration = planNarrationPauseTrim({ duration, fps: FPS, cues });
    expect(narration.engine).toBe("editkin-narration-pause-trim-0.1");
    expect(narration.targetRatio).toBe(1);
    expect(spokenCoverage(cues, narration.keepRanges)).toBeCloseTo(1, 9);
    expect(narration.removedDuration).toBeGreaterThan(30);
    // Filler-only sentences are narration too; nothing is dropped for scoring low.
    expect(narration.segments.filter((segment) => !segment.selected).every((segment) => !segment.text)).toBe(true);
    const highlight = planSemanticAutoEdit({ duration, fps: FPS, cues });
    expect(spokenCoverage(cues, highlight.keepRanges)).toBeLessThan(0.8);
  });

  it("removes only pauses of at least 0.75 s and leaves breathing room around the words", () => {
    const cues = [
      { start: 0.1, end: 2, text: "第一句" }, { start: 2.5, end: 4, text: "短停頓後第二句" }, { start: 6, end: 8, text: "長停頓後第三句" },
    ];
    const plan = planNarrationPauseTrim({ duration: 10, fps: FPS, cues });
    expect(plan.keepRanges).toEqual([{ start: 0, end: 4.3 }, { start: 5.833333333333333, end: 8.3 }]);
    for (const range of plan.keepRanges) {
      expect(Math.round(range.start * FPS)).toBeCloseTo(range.start * FPS, 9);
      expect(Math.round(range.end * FPS)).toBeCloseTo(range.end * FPS, 9);
    }
    expect(spokenCoverage(cues, plan.keepRanges)).toBe(1);
  });

  it("keeps audible speech the transcript missed when the silence detector heard it", () => {
    const cues = [{ start: 0, end: 2, text: "辨識到的第一句" }, { start: 8, end: 10, text: "辨識到的最後一句" }];
    const transcriptOnly = planNarrationPauseTrim({ duration: 10, fps: FPS, cues });
    expect(transcriptOnly.keepRanges).toHaveLength(2);
    const smartCut = { fps: FPS, ranges: [{ startFrame: 0, endFrame: 90 }, { startFrame: 120, endFrame: 300 }] };
    const withAudio = planNarrationPauseTrim({ duration: 10, fps: FPS, cues, audioKeepRanges: audioKeepRangesFromSmartCut(smartCut) });
    // 4–7.85 s was speech Whisper skipped: it survives; only the true 3–4 s silence goes.
    expect(withAudio.keepRanges).toEqual([{ start: 0, end: 3 }, { start: 4, end: 10 }]);
  });

  it("is a no-op when there is no removable pause, and still refuses an empty transcript", () => {
    const plan = planNarrationPauseTrim({ duration: 21.95, fps: FPS, cues: [{ start: 0, end: 21.95, text: "完整語句" }] });
    expect(plan.keepRanges).toEqual([{ start: 0, end: 658 / 30 }]);
    expect(() => planNarrationPauseTrim({ duration: 5, fps: FPS, cues: [] })).toThrow("沒有可用來判斷重點");
    expect(() => planNarrationPauseTrim({ duration: 5, fps: FPS, cues: [{ start: 0, end: 1, text: "a" }], audioKeepRanges: [{ start: 2, end: 1 }] })).toThrow("聲音區間");
  });
});

describe("Shorts highlights never cut inside a spoken cue", () => {
  it("moves scene cuts and length caps that land mid-sentence to the sentence edge", () => {
    const cues = [
      { start: 0.2, end: 5.8, text: "第一個關鍵方法可以省下三成時間！" },
      { start: 6.1, end: 13.7, text: "接著說明為什麼這個結果很重要" },
      { start: 14.2, end: 19.6, text: "最後總結整個方法" },
    ];
    const plan = planSemanticAutoEdit({ duration: 20, fps: FPS, cues, cuts: [{ time: 3, score: 60 }, { time: 10, score: 70 }], targetRatio: 0.5 });
    for (const segment of plan.segments) {
      for (const edge of [segment.start, segment.end]) {
        expect(cues.some((cue) => edge > cue.start + 1 / FPS && edge < cue.end - 1 / FPS)).toBe(false);
      }
    }
    for (const range of plan.keepRanges) {
      for (const cue of cues) {
        const overlap = Math.max(0, Math.min(cue.end, range.end) - Math.max(cue.start, range.start));
        expect(overlap === 0 || overlap >= cue.end - cue.start - 1 / FPS).toBe(true);
      }
    }
  });
});

describe("footage without speech is cut by picture steadiness (roadmap 1.14)", () => {
  it("keeps the steadiest windows of every shot, in shooting order, within the Shorts target", () => {
    // Three shots; the middle of shot 1 and the start of shot 3 shake hard.
    const activity = [
      ...Array.from({ length: 20 }, (_, index) => ({ time: 4 + index * 0.2, score: 30 })),
      ...Array.from({ length: 10 }, (_, index) => ({ time: 20.5 + index * 0.2, score: 18 })),
      { time: 0.1, score: 45 }, { time: 29.8, score: 50 },
    ];
    expect(visualHighlightTargetSeconds(30, true)).toBeCloseTo(19.5, 9);
    expect(visualHighlightTargetSeconds(10, true)).toBe(8);
    expect(visualHighlightTargetSeconds(300, true)).toBe(30);
    expect(visualHighlightTargetSeconds(300, false)).toBe(240);
    const target = 15;
    const plan = planVisualQualityAutoEdit({ duration: 30, fps: FPS, cuts: [{ time: 10, score: 40 }, { time: 20, score: 35 }], activity, targetDuration: target });
    expect(plan.engine).toBe("editkin-visual-quality-0.1");
    expect(plan.keptDuration).toBeGreaterThanOrEqual(target - 3);
    expect(plan.keptDuration).toBeLessThanOrEqual(target + 3);
    const overlaps = (start: number, end: number) => plan.keepRanges.some((range) => range.start < end && range.end > start);
    expect(overlaps(4, 8)).toBe(false);
    expect(overlaps(20.5, 22.5)).toBe(false);
    expect(overlaps(0, 0.3)).toBe(false);
    expect(overlaps(29.7, 30)).toBe(false);
    for (const [start, end] of [[0, 10], [10, 20], [20, 30]]) expect(overlaps(start, end)).toBe(true);
    expect(plan.keepRanges.every((range, index) => index === 0 || range.start >= plan.keepRanges[index - 1].end)).toBe(true);
  });

  it("works without any activity evidence and on a single short clip", () => {
    const plan = planVisualQualityAutoEdit({ duration: 6, fps: FPS, targetDuration: visualHighlightTargetSeconds(6, true) });
    expect(plan.keepRanges.length).toBeGreaterThan(0);
    expect(plan.keptDuration).toBeGreaterThan(4.5);
    expect(plan.keptDuration).toBeLessThanOrEqual(6);
    const longform = planVisualQualityAutoEdit({ duration: 120, fps: FPS, targetDuration: visualHighlightTargetSeconds(120, false) });
    expect(longform.keptDuration).toBeGreaterThanOrEqual(90);
  });

  it("falls back to the flash shots when every shot is a flash", () => {
    const cuts = Array.from({ length: 9 }, (_, index) => ({ time: 0.4 * (index + 1), score: 50 }));
    const plan = planVisualQualityAutoEdit({ duration: 4, fps: FPS, cuts, targetDuration: 3 });
    expect(plan.keptDuration).toBeGreaterThan(0);
  });
});
