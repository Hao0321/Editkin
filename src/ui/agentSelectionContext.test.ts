// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
import { describe, expect, it } from "vitest";
import { agentSelectionContext, agentCaptionReplacementHint, agentClipVolumeHint, agentSelectionLabel, type AgentSelection } from "./agentSelectionContext";

describe("native Agent selection packets", () => {
  const clip: AgentSelection = { kind: "clip", clipId: "selected-one", assetName: "來源", assetKind: "video", timelineStart: 0, duration: 2, playhead: 0 };
  it("hints only one absolute volume on the submitted clip, including zero", () => {
    for (const percent of [0, 65, 200]) {
      const hint = agentClipVolumeHint(clip, `請把這個片段音量設為 ${percent}%`, "D:/fixture/movie.editkin.json");
      const args = JSON.parse(/片段音量參數：(.+?)。僅為/.exec(hint)![1]);
      expect(args).toEqual({ name: "apply_edit_commands", arguments: { projectPath: "D:/fixture/movie.editkin.json", commands: [{ type: "set_clip_volume", clipId: "selected-one", volume: percent / 100 }] } });
    }
  });
  it.each(["不要把這個片段音量改到65%", "這個片段音量降低20%", "這個片段音量增加20%", "是否把這個片段音量設為65%？", "這個片段音量改到-20%", "這個片段音量300%", "這個片段音量65%，另一段音量50%", "把音量設成65%"])("does not invent an absolute volume for %s", message => {
    expect(agentClipVolumeHint(clip, message, "D:/fixture/movie.editkin.json")).toBe("");
  });
  it("builds the exact requested word correction without normalizing other words or punctuation", () => {
    const selection: AgentSelection = { kind: "caption", captionId: "cue-one", text: "今天，我要把影片检好。其他话不变！", start: 3, duration: 2, playhead: 3 };
    const hint = agentCaptionReplacementHint(selection, "請把這句字幕的「检好」改成「剪好」，只校對這個字詞。", "D:/fixture-only/current.editkin.json");
    selection.text = "另一句字幕"; selection.captionId = "cue-two";
    const args = JSON.parse(/精確校對參數是 (.+?)。僅替換/.exec(hint)![1]);
    expect(args.arguments.commands).toEqual([{ type: "update_caption", captionId: "cue-one", patch: { text: "今天，我要把影片剪好。其他话不变！" } }]);
    expect(args.arguments.projectPath).toBe("D:/fixture-only/current.editkin.json");
  });
  it.each(["不要把這句字幕的「检好」改成「剪好」", "是否把這句字幕的「检好」改成「剪好」？", "請把這句字幕的「不存在」改成「剪好」", "請把這句字幕的「检好」改成「剪好」，再把「今天」改成「今日」", "請把這句字幕改得更自然"])("does not invent a direct edit for an ambiguous, conditional, or different request: %s", message => {
    const selection: AgentSelection = { kind: "caption", captionId: "cue-one", text: "今天我要检好。", start: 0, duration: 2, playhead: 0 };
    expect(agentCaptionReplacementHint(selection, message, "D:/fixture-only/current.editkin.json")).toBe("");
  });
  it("does not infer a replacement when its location is repeated or reference is omitted", () => {
    const selection: AgentSelection = { kind: "caption", captionId: "cue-one", text: "检好，检好。", start: 0, duration: 2, playhead: 0 };
    const message = "請把這句字幕的「检好」改成「剪好」";
    expect(agentCaptionReplacementHint(selection, message, "D:/fixture-only/current.editkin.json")).toBe("");
    expect(agentCaptionReplacementHint(undefined, message, "D:/fixture-only/current.editkin.json")).toBe("");
  });
  it("keeps caption targets distinct from source clips and freezes the submitted text", () => {
    const selection: AgentSelection = { kind: "caption", captionId: "cue-one", text: "檢好", start: 3, duration: 2, playhead: 3 };
    const prompt = agentSelectionContext(selection, "D:/fixture-only/current.editkin.json");
    selection.captionId = "cue-two";
    selection.text = "後來選取的字幕";
    expect(prompt).toContain('"captionId":"cue-one"');
    expect(prompt).toContain('"text":"檢好"');
    expect(prompt).not.toContain('"clipId"');
    expect(prompt).toContain("update_caption");
    const encodedEnvelope = /完整參數格式為 (.+?)。以實際/.exec(prompt)![1];
    const envelope = JSON.parse(encodedEnvelope);
    expect(envelope).toMatchObject({ name: "apply_edit_commands", arguments: {
      projectPath: "D:/fixture-only/current.editkin.json", commands: [{ type: "update_caption", captionId: "cue-one", patch: { text: expect.any(String) } }] } });
    expect(envelope.projectPath).toBeUndefined();
    expect(envelope.arguments.commands[0].text).toBeUndefined();
    expect(prompt).toContain("patch.text");
    expect(agentSelectionContext()).toBe("");
    expect(agentSelectionContext(undefined, "D:/fixture-only/current.editkin.json")).toBe("");
  });
  it("retains exact source clip scoping for the existing image workflow", () => {
    const prompt = agentSelectionContext({ kind: "clip", clipId: "image-one", assetName: "圖片", assetKind: "image", timelineStart: 5, duration: 4, playhead: 6 });
    expect(prompt).toContain('clipIds: ["image-one"]');
    expect(prompt).toContain('policy:"visual-only"');
    expect(prompt).not.toContain('"captionId"');
  });
  it("bounds long subtitle data without losing its target or disguising truncation", () => {
    const selection: AgentSelection = { kind: "caption", captionId: "long-cue", text: "字".repeat(4000), start: 0, duration: 10, playhead: 0 };
    const prompt = agentSelectionContext(selection);
    expect(prompt).toContain('"textTruncated":true');
    expect(prompt.length).toBeLessThan(3500);
    expect(agentCaptionReplacementHint(selection, "把這句字幕的「字」改成「詞」", "D:/fixture/movie.editkin.json")).toBe("");
    expect(agentSelectionLabel(selection).length).toBeLessThan(80);
  });
});
