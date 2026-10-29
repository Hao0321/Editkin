import { describe, expect, it } from "vitest";
import { addProgressSample, elapsedWords, estimateRemainingMs, EXPORT_STEPS, exportStepIndex, parseRenderProgress, remainingWords, spentWords, type ProgressSample } from "./renderProgressModel";

const snapshot = (patch: Record<string, unknown> = {}) => ({ schema: "editkin.render-progress/v1", stage: "encode", totalSeconds: 60, sequence: 3, ...patch });

describe("export progress shown to the creator", () => {
  it("reads only the renderer's own snapshots", () => {
    expect(parseRenderProgress(null)).toBeUndefined();
    expect(parseRenderProgress({ schema: "other", stage: "encode" })).toBeUndefined();
    expect(parseRenderProgress(snapshot({ stage: "launch" }))).toBeUndefined();
    expect(parseRenderProgress(snapshot({ fraction: 1.7, doneSeconds: 30 }))).toMatchObject({ stage: "encode", fraction: 1, doneSeconds: 30, totalSeconds: 60 });
    expect(parseRenderProgress(snapshot({ part: 3, parts: 2 }))).not.toHaveProperty("part");
    expect(parseRenderProgress(snapshot({ part: 1, parts: 2 }))).toMatchObject({ part: 1, parts: 2 });
  });

  it("groups the renderer stages into four plain steps", () => {
    expect(EXPORT_STEPS.map(step => step.label)).toEqual(["準備素材", "處理畫面和聲音", "合成影片", "最後檢查一次"]);
    expect(exportStepIndex("prepare")).toBe(0);
    for (const stage of ["precompose", "scene3d", "frames", "audio", "effects"] as const) expect(exportStepIndex(stage)).toBe(1);
    expect(exportStepIndex("encode")).toBe(2);
    expect(exportStepIndex("verify")).toBe(3);
  });

  it("estimates the remaining time only from measured speed, never from elapsed time alone", () => {
    let samples: ProgressSample[] = [];
    const view = (doneSeconds: number) => parseRenderProgress(snapshot({ doneSeconds, fraction: doneSeconds / 60 }));
    samples = addProgressSample(samples, view(6), 0);
    expect(estimateRemainingMs(samples)).toBeUndefined();
    samples = addProgressSample(samples, view(6), 1_000);
    expect(samples).toHaveLength(1);
    samples = addProgressSample(samples, view(12), 2_000);
    expect(estimateRemainingMs(samples)).toBeUndefined(); // under three seconds of evidence
    samples = addProgressSample(samples, view(18), 4_000);
    // 12 output seconds in 4 s of wall time → 3 output seconds per second; 42 s of output left → 14 s.
    expect(estimateRemainingMs(samples)).toBe(14_000);
    // A stage without measured output resets the evidence.
    expect(addProgressSample(samples, parseRenderProgress(snapshot({ stage: "verify", totalSeconds: undefined })), 5_000)).toEqual([]);
    // A new part of the same length starts its own measurement.
    const next = parseRenderProgress(snapshot({ stage: "precompose", part: 2, parts: 2, doneSeconds: 1, fraction: 1 / 60 }));
    expect(addProgressSample(samples, next, 5_000)).toHaveLength(1);
  });

  it("words the time like a person would", () => {
    expect(remainingWords(20_000)).toEqual({ key: "剩不到 1 分鐘" });
    expect(remainingWords(61_000)).toEqual({ key: "大約還要 {minutes} 分鐘", values: { minutes: 2 } });
    expect(remainingWords(3_600_000)).toEqual({ key: "大約還要 {hours} 小時", values: { hours: 1 } });
    expect(remainingWords(4_000_000)).toEqual({ key: "大約還要 {hours} 小時 {minutes} 分鐘", values: { hours: 1, minutes: 7 } });
    expect(elapsedWords(5_400)).toEqual({ key: "已經過 {seconds} 秒", values: { seconds: 5 } });
    expect(elapsedWords(125_000)).toEqual({ key: "已經過 {minutes} 分 {seconds} 秒", values: { minutes: 2, seconds: 5 } });
    expect(spentWords(3_725_000)).toEqual({ key: "花了 {hours} 小時 {minutes} 分", values: { hours: 1, minutes: 2 } });
  });
});
