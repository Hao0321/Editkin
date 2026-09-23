import { describe, expect, it } from "vitest";
import { applyCommand } from "../domain/commands";
import { createEmptyProject } from "../domain/editGraph";
import { createHistory, dispatchCommand, undo } from "../domain/history";
import { conservativePolicy, validatePolicy } from "./nativeAutopilotPolicy";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { parseProject } from "./projectFiles";
import { planSemanticAutoEdit } from "./semanticAutoEdit";
import { buildNativeAutopilotCommand, planNativeAutopilotCreative } from "./nativeAutopilot";

function fixture() {
  let project = createEmptyProject("policy", { id: "policy-project", width: 1920, height: 1080, fps: 30 });
  const asset = { id: "source", name: "synthetic", uri: "synthetic.mp4", kind: "video" as const, duration: 40, width: 1920, height: 1080 };
  const clip = { id: "selected", assetId: asset.id, trackId: "video-main", sourceStart: 10, timelineStart: 1, duration: 12, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] };
  project = applyCommand(project, { type: "batch", commands: [
    { type: "import_asset", asset },
    { type: "add_clip", clip: { ...clip, id: "before", sourceStart: 0, timelineStart: 0, duration: 1 } },
    { type: "add_clip", clip },
    { type: "add_clip", clip: { ...clip, id: "after", sourceStart: 30, timelineStart: 13, duration: 1 } },
    { type: "set_clip_creative", clipId: clip.id, patch: { transitionIn: { presetId: "luma_fade", duration: .2 }, transitionOut: { presetId: "luma_fade", duration: .3 } } },
    { type: "set_caption_style", patch: { color: "#ABCDEF", backgroundColor: "#123456", translationColor: "#FEDCBA" } },
  ] });
  return { project, clip: project.tracks[0].clips.find(c => c.id === clip.id)! };
}
function run(ownership: "automatic" | "manual", format: "longform" | "shorts" | "unknown", trimEdges = false) {
  const { project, clip } = fixture();
  const cues = [{ start: 0, end: 2, text: "first" }, { start: 6, end: 8, text: "middle" }, { start: 10, end: 12, text: "last" }];
  const semantic = { ...planSemanticAutoEdit({ duration: 12, fps: 30, cues, targetRatio: .5 }), keepRanges: [{ start: trimEdges ? 1 : 0, end: 2 }, { start: 6, end: 8 }, { start: 10, end: trimEdges ? 11 : 12 }], keptDuration: trimEdges ? 4 : 6 };
  const creative = planNativeAutopilotCreative({ duration: 12, width: 1920, height: 1080, cues, video: true, ...{ policy: { ownership, format } } });
  const built = buildNativeAutopilotCommand({ project, clip, transcript: { cues }, semantic, creative, idFactory: (kind, index) => `${kind}-${index}` });
  const result = applyCommand(project, built.command);
  const segments = result.tracks[0].clips.filter(c => c.id !== "before" && c.id !== "after");
  return { project, result, segments, built, creative };
}
describe("native autopilot explicit policy via actual commands", () => {
  for (const format of ["longform", "shorts", "unknown"] as const) it(`automatic ${format} clears inherited in/out transitions`, () => {
    const { result, segments } = run("automatic", format);
    expect(segments).toHaveLength(3);
    expect(segments.every(c => !c.creative?.transitionIn && !c.creative?.transitionOut)).toBe(true);
    expect(() => parseProject(JSON.parse(JSON.stringify(result)))).not.toThrow();
  });
  it("manual retains only corresponding original outside edges", () => {
    const { project, result, segments } = run("manual", "longform");
    expect(segments.map(c => Boolean(c.creative?.transitionIn))).toEqual([true, false, false]);
    expect(segments.map(c => Boolean(c.creative?.transitionOut))).toEqual([false, false, true]);
    expect(segments[0].creative?.transitionIn).toEqual({ presetId: "luma_fade", duration: .2 });
    expect(result.captionStyle).toEqual(project.captionStyle);
  });
  it("manual removes transitions whose original source edges were cut away", () => {
    expect(run("manual", "longform", true).segments.every(c => !c.creative?.transitionIn && !c.creative?.transitionOut)).toBe(true);
  });
  it("automatic longform sets editable white-on-black primary and translation subtitles", () => {
    const { result } = run("automatic", "longform");
    expect(result.captionStyle).toMatchObject({ color: "#FFFFFF", backgroundColor: "#000000B3", translationColor: "#FFFFFF" });
    expect(result.director.markers.at(-1)?.note).toContain("format=longform");
    expect(result.director.markers.at(-1)?.note).toContain("styleOwnership=automatic");
    expect(result.director.markers.at(-1)?.note).toContain("caption=longform-monochrome");
    expect(result.director.markers.at(-1)?.note).toContain("transition=clean-cut");
    expect(() => parseProject(JSON.parse(JSON.stringify(result)))).not.toThrow();
  });
  it("unknown does not infer route from landscape geometry or replace custom subtitles", () => {
    const { project, result } = run("automatic", "unknown");
    expect(result.captionStyle).toEqual(project.captionStyle);
  });
  it("explicit Shorts keeps preset selection on a landscape project", () => {
    const { result, creative } = run("automatic", "shorts");
    expect(result.captionStyle.presetId).toBe(creative.captionPresetId);
  });
  it("preserves manual style through JSON reopen and a single Undo restores every source field", () => {
    const { project, built, result } = run("manual", "longform");
    expect(parseProject(JSON.parse(JSON.stringify(result))).captionStyle).toEqual(project.captionStyle);
    const history = dispatchCommand(createHistory(project), built.command);
    expect(history.past).toHaveLength(1);
    expect(undo(history).present).toEqual(project);
  });
  it("rejects an invalid policy and snapshots only explicit known fields", () => {
    expect(() => validatePolicy({ format: "wide", ownership: "automatic" } as never)).toThrow();
    expect(() => validatePolicy({ format: "longform", ownership: "inferred" } as never)).toThrow();
    expect(Object.isFrozen(validatePolicy(conservativePolicy))).toBe(true);
    const creative = planNativeAutopilotCreative({ duration: 1, width: 1920, height: 1080, cues: [], video: true });
    expect(creative.policy).toEqual(conservativePolicy);
  });
  it("does not silently shorten an original transition when its surviving edge is only two frames", () => {
    const initial = fixture();
    const project = applyCommand(initial.project, { type: "set_clip_creative", clipId: initial.clip.id, patch: { transitionIn: { presetId: "luma_fade", duration: .5 } } });
    const clip = project.tracks[0].clips.find(c => c.id === initial.clip.id)!;
    const cues = [{ start: 0, end: 1, text: "first" }, { start: 10, end: 12, text: "last" }];
    const semantic = { ...planSemanticAutoEdit({ duration: 12, fps: 30, cues }), keepRanges: [{ start: 0, end: 2 / 30 }, { start: 10, end: 12 }], keptDuration: 2 + 2 / 30 };
    const creative = planNativeAutopilotCreative({ duration: 12, width: 1920, height: 1080, cues, video: true, policy: { format: "longform", ownership: "manual" } });
    const built = buildNativeAutopilotCommand({ project, clip, transcript: { cues }, semantic, creative, idFactory: (kind, index) => `${kind}-${index}` });
    const result = applyCommand(project, built.command);
    expect(result.tracks[0].clips.find(c => c.id === clip.id)?.creative?.transitionIn).toBeUndefined();
    expect(result.tracks[0].clips.at(-2)?.creative?.transitionOut).toEqual({ presetId: "luma_fade", duration: .3 });
    expect(() => parseProject(JSON.parse(JSON.stringify(result)))).not.toThrow();
  });
});
