import { describe, expect, it } from "vitest";
import { compileAgentInstruction, isAutomaticCaptionInstruction, isSceneSplitInstruction, isSemanticAutoEditInstruction, isSmartCutInstruction } from "./agent";
import { createDemoProject } from "./demo";

describe("high-level agent compiler", () => {
  it("routes silence removal to the asynchronous Smart Cut pipeline", () => {
    expect(isSmartCutInstruction("自動把前面停頓和空白刪掉")).toBe(true);
    expect(isSmartCutInstruction("Smart Cut this clip")).toBe(true);
    expect(isSmartCutInstruction("音量 80%")).toBe(false);
  });
  it("routes transcription language to the local automatic caption pipeline", () => {
    expect(isAutomaticCaptionInstruction("幫我自動字幕")).toBe(true);
    expect(isAutomaticCaptionInstruction("transcribe this clip")).toBe(true);
    expect(isAutomaticCaptionInstruction("幫我做中英雙語字幕")).toBe(true);
    expect(isAutomaticCaptionInstruction("加字幕：哈囉")).toBe(false);
  });
  it("routes scene detection to the local asynchronous pipeline", () => {
    expect(isSceneSplitInstruction("幫我自動分鏡")).toBe(true);
    expect(isSceneSplitInstruction("detect scenes")).toBe(true);
    expect(isSceneSplitInstruction("在這裡分割")).toBe(false);
  });
  it("routes highlight requests to the semantic automatic-edit pipeline", () => {
    expect(isSemanticAutoEditInstruction("幫我智慧成片，只留下重點")).toBe(true);
    expect(isSemanticAutoEditInstruction("automatic edit this clip")).toBe(true);
    expect(isSemanticAutoEditInstruction("自動分鏡")).toBe(false);
  });
  it("compiles natural-language split to one bounded command", () => {
    const plan = compileAgentInstruction(
      createDemoProject(),
      "請在 5 秒切開",
      { selectedClipId: "clip-demo", playhead: 2 },
      "clip-right",
    );
    expect(plan.command).toEqual({
      type: "split_clip",
      clipId: "clip-demo",
      at: 5,
      newClipId: "clip-right",
    });
  });

  it("uses playhead when split time is omitted", () => {
    const plan = compileAgentInstruction(
      createDemoProject(),
      "在這裡分割",
      { selectedClipId: "clip-demo", playhead: 3.5 },
      "clip-right",
    );
    expect(plan.command).toMatchObject({ type: "split_clip", at: 3.5 });
  });

  it("fails closed when no clip is selected", () => {
    expect(() => compileAgentInstruction(
      createDemoProject(),
      "刪除選取片段",
      { playhead: 0 },
    )).toThrow("先在 Timeline 選一個片段");
  });

  it("adds a caption at an explicit time", () => {
    const plan = compileAgentInstruction(createDemoProject(), "在 3 秒加字幕：哈囉世界", { playhead: 0 }, "clip-caption");
    expect(plan.command).toEqual({
      type: "add_caption",
      caption: { id: "caption-caption", text: "哈囉世界", start: 3, duration: 3 },
    });
  });

  it("compiles simple audio and out-point instructions", () => {
    const project = createDemoProject();
    expect(compileAgentInstruction(project, "音量 65%", { selectedClipId: "clip-demo", playhead: 0 }).command)
      .toEqual({ type: "set_clip_volume", clipId: "clip-demo", volume: 0.65 });
    expect(compileAgentInstruction(project, "刪掉後 2 秒", { selectedClipId: "clip-demo", playhead: 0 }).command)
      .toEqual({ type: "trim_clip_end", clipId: "clip-demo", seconds: 2 });
  });
});
