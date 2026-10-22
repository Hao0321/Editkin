import { describe, expect, it } from "vitest";
import { applyCommand } from "../domain/commands";
import { createEmptyProject } from "../domain/editGraph";
import { createHistory, dispatchCommand, undo } from "../domain/history";
import { DEFAULT_CAPTION_STYLE, DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditorialProfileId, type MediaAsset } from "../domain/types";
import { shortsCaptionStyle } from "../creative/shortsCaptionStyle";
import { buildNativeAutopilotCommand, planNativeAutopilotCreative } from "./nativeAutopilot";
import type { NativeEditingPolicy } from "./nativeAutopilotPolicy";
import { parseProject } from "./projectFiles";
import { planNarrationPauseTrim, planSemanticAutoEdit, planVisualQualityAutoEdit } from "./semanticAutoEdit";

const CUES = [{ start: 0.2, end: 3, text: "這家拉麵湯頭很濃" }, { start: 5, end: 8, text: "麵條是自己做的" }];

function fixture(width: number, height: number, profile: EditorialProfileId = "auto") {
  let project = createEmptyProject("shorts captions", { id: "shorts-captions", width, height, fps: 30 });
  project.editorialProfile = profile;
  const asset: MediaAsset = { id: "source", name: "source.mov", kind: "video", uri: "C:/fixture/source.mov", duration: 12, width, height };
  const clip = { id: "clip", assetId: asset.id, trackId: "video-main", timelineStart: 0, sourceStart: 0, duration: 12, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] };
  project = applyCommand(project, { type: "batch", commands: [{ type: "import_asset", asset }, { type: "add_clip", clip }] });
  return { project, clip: project.tracks[0].clips[0] };
}

function run(width: number, height: number, policy: NativeEditingPolicy, profile: EditorialProfileId = "auto", options: { cues?: typeof CUES; customStyle?: boolean } = {}) {
  const base = fixture(width, height, profile);
  const project = options.customStyle ? applyCommand(base.project, { type: "set_caption_style", patch: { fontSize: 70, color: "#FFE066" } }) : base.project;
  const cues = options.cues ?? CUES;
  const semantic = cues.length
    ? planNarrationPauseTrim({ duration: 12, fps: 30, cues })
    : planVisualQualityAutoEdit({ duration: 12, fps: 30, targetDuration: 8 });
  const creative = planNativeAutopilotCreative({ duration: 12, width, height, cues, video: true, profile, policy });
  const built = buildNativeAutopilotCommand({ project, clip: base.clip, transcript: { cues }, semantic, creative, idFactory: (kind, index) => `${kind}-${index}` });
  const result = applyCommand(project, built.command);
  return { project, built, result, note: result.director.markers.at(-1)?.note ?? "" };
}

describe("automatic captions on a 9:16 canvas use the Shorts white style (roadmap 1.7)", () => {
  it.each([
    { format: "longform", ownership: "automatic" },
    { format: "shorts", ownership: "automatic" },
    { format: "unknown", ownership: "automatic" },
  ] as const)("%o writes 64 px white soft-shadow captions above the platform UI", (policy) => {
    const { result, built, note } = run(1080, 1920, policy);
    expect(built.captionStyle).toBe("shorts-vertical");
    expect(result.captionStyle).toMatchObject({ fontFamily: "Noto Sans TC", fontSize: 95, marginV: 300, maxLineEm: 11, color: "#FFFFFF", backgroundColor: "#00000000", shadowColor: "#00000099" });
    expect(note).toContain("caption=hao_shorts_white（");
    expect(note).toContain("基線不低於 y1640");
    expect(() => parseProject(JSON.parse(JSON.stringify(result)))).not.toThrow();
    expect(parseProject(JSON.parse(JSON.stringify(result))).captionStyle.shadowBlur).toBe(4);
  });

  it("follows the genre: handbook Kai for travel/food, a green edge for gaming", () => {
    expect(run(1080, 1920, { format: "shorts", ownership: "automatic" }, "food").result.captionStyle.fontFamily).toBe("LXGW WenKai TC");
    expect(run(1080, 1920, { format: "longform", ownership: "automatic" }, "travel").result.captionStyle.fontFamily).toBe("LXGW WenKai TC");
    const gaming = run(1080, 1920, { format: "shorts", ownership: "automatic" }, "gaming").result.captionStyle;
    expect(gaming).toMatchObject({ color: "#FFFFFF", outlineColor: "#3FC9B0", presetId: "hao_shorts_white_green_edge" });
  });

  it("keeps a creator's own style when the run does not own styling", () => {
    const manual = run(1080, 1920, { format: "shorts", ownership: "manual" });
    expect(manual.result.captionStyle).toEqual(manual.project.captionStyle);
    const custom = run(1080, 1920, { format: "unknown", ownership: "automatic" }, "auto", { customStyle: true });
    expect(custom.built.captionStyle).toBe("preserved");
    expect(custom.result.captionStyle).toEqual(custom.project.captionStyle);
  });

  it("leaves horizontal long-video captions exactly as before", () => {
    const { result, built, note } = run(1920, 1080, { format: "longform", ownership: "automatic" });
    expect(built.captionStyle).toBe("longform-monochrome");
    expect(result.captionStyle).toMatchObject({ ...DEFAULT_CAPTION_STYLE, color: "#FFFFFF", backgroundColor: "#000000B3", outlineColor: "#000000", outlineWidth: 16, shadow: 0, translationColor: "#FFFFFF" });
    expect(result.captionStyle.shadowColor).toBeUndefined();
    expect(note).toContain("caption=longform-monochrome");
    const unknown = run(1920, 1080, { format: "unknown", ownership: "automatic" });
    expect(unknown.result.captionStyle).toEqual(unknown.project.captionStyle);
  });

  it("never renders Chinese Shorts captions in Fredoka on a horizontal canvas", () => {
    const { result, note } = run(1920, 1080, { format: "shorts", ownership: "automatic" }, "food");
    expect(result.captionStyle.presetId).toBe("candy_ticket");
    expect(result.captionStyle.fontFamily).toBe("Noto Sans TC");
    expect(note).toContain("Fredoka 沒有中文字形");
  });

  it("writes the style in the same single undoable batch", () => {
    const { project, built } = run(1080, 1920, { format: "longform", ownership: "automatic" });
    const history = dispatchCommand(createHistory(project), built.command);
    expect(history.past).toHaveLength(1);
    expect(history.present.captionStyle).toEqual({ ...DEFAULT_CAPTION_STYLE, ...shortsCaptionStyle(project, "auto") });
    expect(undo(history).present).toEqual(project);
  });
});

describe("receipts say what the run did", () => {
  it("records the narration pause trim and any skipped transcript blocks", () => {
    const base = fixture(1920, 1080);
    const semantic = planNarrationPauseTrim({ duration: 12, fps: 30, cues: CUES });
    const creative = planNativeAutopilotCreative({ duration: 12, width: 1920, height: 1080, cues: CUES, video: true, policy: { format: "longform", ownership: "automatic" } });
    const transcript = { cues: CUES, skippedCaptionBlocks: [{ block: 3, reason: "missing-timing" }, { block: 1, reason: "unparseable-window", window: 2 }] };
    const built = buildNativeAutopilotCommand({ project: base.project, clip: base.clip, transcript, semantic, creative, idFactory: (kind, index) => `${kind}-${index}` });
    const note = applyCommand(base.project, built.command).director.markers.at(-1)?.note ?? "";
    expect(note).toContain("editMode=narration-pause-trim");
    expect(note).toContain("captionParse=skipped-2");
    expect(note).toContain("第3段");
    expect(note).toContain("窗3・第1段");
  });

  it("an explicit Shorts highlight run is recorded as such", () => {
    const base = fixture(1080, 1920);
    const semantic = planSemanticAutoEdit({ duration: 12, fps: 30, cues: CUES });
    const creative = planNativeAutopilotCreative({ duration: 12, width: 1080, height: 1920, cues: CUES, video: true, policy: { format: "shorts", ownership: "automatic" } });
    const built = buildNativeAutopilotCommand({ project: base.project, clip: base.clip, transcript: { cues: CUES }, semantic, creative, idFactory: (kind, index) => `${kind}-${index}` });
    expect(applyCommand(base.project, built.command).director.markers.at(-1)?.note).toContain("editMode=highlight");
  });
});

describe("footage without speech (roadmap 1.14)", () => {
  it("cuts by picture, adds music and adds no transcript captions instead of failing", () => {
    const base = fixture(1080, 1920, "travel");
    // A creator caption on kept footage stays (Smart Cut only drops captions whose footage was removed).
    const project = applyCommand(base.project, { type: "add_caption", caption: { id: "manual", text: "手打的地名", start: 4, duration: 1 } });
    const semantic = planVisualQualityAutoEdit({ duration: 12, fps: 30, targetDuration: 8 });
    expect(semantic.keepRanges).toEqual([{ start: 0.4, end: 8.8 }]);
    const creative = planNativeAutopilotCreative({ duration: 12, width: 1080, height: 1920, cues: [], video: true, profile: "travel", policy: { format: "longform", ownership: "automatic" } });
    const music: MediaAsset = { id: "music", name: "music.wav", kind: "audio", uri: "creative://music", duration: 30, role: "background-music" };
    const built = buildNativeAutopilotCommand({ project, clip: project.tracks[0].clips[0], transcript: { cues: [] }, semantic, creative, musicAsset: music, musicSelectionId: "music:travel", idFactory: (kind, index) => `${kind}-${index}` });
    const result = applyCommand(project, built.command);
    expect(built.addedCaptions).toBe(0);
    expect(result.captions.map((caption) => caption.text)).toEqual(["手打的地名"]);
    expect(result.tracks[0].clips.reduce((sum, clip) => sum + clip.duration, 0)).toBeCloseTo(semantic.keptDuration, 6);
    expect(result.tracks.find((track) => track.id === "audio-auto-music")?.clips.every((clip) => clip.volume === 0.25)).toBe(true);
    expect(result.director.markers.at(-1)?.note).toContain("editMode=visual-quality");
    expect(() => parseProject(JSON.parse(JSON.stringify(result)))).not.toThrow();
  });
});
