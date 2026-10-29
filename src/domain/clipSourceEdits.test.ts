import { describe, expect, it } from "vitest";
import { applyCommand } from "./commands";
import type { EditorCommand } from "./commandTypes";
import { animatedClipState, createEmptyProject, validateProject } from "./editGraph";
import { createHistory, dispatchCommand, dispatchCommandSafely, redo, undo } from "./history";
import { createClipMask } from "./masks";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type TemplateApplicationState, type TimelineClip } from "./types";
import { clipExtensionLimits, clipSlipError, clipSourceEditBlocker, clipSourceWindow, planClipExtension } from "./clipSourceEdits";
import { decodeProjectBytes, encodeProjectBytes } from "../application/projectCodec";
import { createMotionGraphic, legacyMotionGraphicSeed } from "../motion/composition";
import { DEFAULT_REFERENCE_MOTION_STYLE } from "../motion/referenceMotionTemplates";

type Extend = Extract<EditorCommand, { type: "extend_clip" }>;
type Slip = Extract<EditorCommand, { type: "slip_clip" }>;

function clip(id: string, trackId: string, assetId: string, timelineStart: number, sourceStart: number, duration: number, patch: Partial<TimelineClip> = {}): TimelineClip {
  return { id, assetId, trackId, timelineStart, sourceStart, duration, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR },
    keyframes: [], layer: { ...DEFAULT_CLIP_LAYER }, ...patch };
}

/** 主畫面: A [0,3) from source 2s, B [3,5) from source 0s; synced content after B's start. */
function fixture(fps = 30): EditProject {
  const project = createEmptyProject("Source range edits", { id: "source-range", width: 1920, height: 1080, fps });
  project.assets = [
    { id: "a", name: "A.mp4", kind: "video", uri: "C:/owned/a.mp4", duration: 10, width: 1920, height: 1080 },
    { id: "b", name: "B.mp4", kind: "video", uri: "C:/owned/b.mp4", duration: 6, width: 1920, height: 1080 },
    { id: "still", name: "Still.png", kind: "image", uri: "C:/owned/still.png", duration: 5, width: 1920, height: 1080 },
    { id: "short", name: "Short.mov", kind: "video", uri: "C:/owned/short.mov", duration: 5.468333, width: 1080, height: 1920 },
  ];
  project.tracks[0].clips = [clip("A", "video-main", "a", 0, 2, 3), clip("B", "video-main", "b", 3, 0, 2)];
  project.tracks.push(
    { id: "overlay", name: "畫面軌 2", kind: "video", locked: false, muted: false, clips: [
      clip("early-overlay", "overlay", "b", 1, 0, 1), clip("late-overlay", "overlay", "b", 3.2, 1, 1)] },
    { id: "locked-overlay", name: "鎖定軌", kind: "video", locked: true, muted: false, clips: [clip("locked-late", "locked-overlay", "b", 4, 0, 1)] },
  );
  project.captions = [{ id: "early-caption", text: "早", start: 1, duration: 1 }, { id: "late-caption", text: "晚", start: 3.5, duration: 1 }];
  project.motionGraphics = [createMotionGraphic("late-title", "title", "標題", 4, 1, undefined, legacyMotionGraphicSeed("title"))];
  project.director.markers = [{ id: "late-marker", time: 4.5, title: "註記", note: "", kind: "note", status: "open", createdAt: "2026-10-10T00:00:00Z" }];
  return validateProject(project);
}
const find = (project: EditProject, id: string) => project.tracks.flatMap(track => track.clips).find(item => item.id === id)!;
/** Saved bytes read back by the product codec; it adds the default aesthetic standard to projects without one. */
const reopen = (project: EditProject) => ({ ...decodeProjectBytes(encodeProjectBytes(project)), aestheticSystem: undefined });
const withoutCodecDefaults = (project: EditProject) => ({ ...project, aestheticSystem: undefined });
const extend = (clipId: string, edge: "start" | "end", seconds: number): Extend => ({ type: "extend_clip", clipId, edge, seconds });
const slip = (clipId: string, sourceStart: number): Slip => ({ type: "slip_clip", clipId, sourceStart });
function refuses(project: EditProject, command: EditorCommand, reason: RegExp) {
  const before = structuredClone(project), history = createHistory(project);
  const result = dispatchCommandSafely(history, command);
  expect(result.error).toMatch(reason);
  expect(result.state).toBe(history);
  expect(project).toEqual(before);
}
function referenceManaged(project: EditProject, clipId: string) {
  return applyCommand(project, { type: "upsert_reference_motion_instance", instance: {
    schema: "editkin.reference-motion-instance/v1", id: "owner", authoringGeneration: 2, instanceRevision: 1,
    input: { templateId: "level_bridge", clipId, startFrame: 0, durationFrames: 60, title: "Owned", sources: [],
      intent: "shortform", purpose: "ownership control", evidenceRefs: ["fixture:source"], style: structuredClone(DEFAULT_REFERENCE_MOTION_STYLE) },
    frameFormat: { width: project.width, height: project.height, fps: project.fps },
    roles: [{ key: "source:0:clip", kind: "clip", id: clipId, parentId: "video-main" }],
    primaryBefore: { layout: null }, appliedScopeSha256: "d".repeat(64), dependencies: { recipeVersion: "fixture:ownership", presetHashes: [], fonts: [] },
  } });
}
/** A saved template on main clip "B" that generated `clipId` (a copy it owns), as a template's own layer. */
function referenceGenerated(project: EditProject, clipId: string) {
  return applyCommand(project, { type: "upsert_reference_motion_instance", instance: {
    schema: "editkin.reference-motion-instance/v1", id: "generator", authoringGeneration: 2, instanceRevision: 1,
    input: { templateId: "level_bridge", clipId: "B", startFrame: 90, durationFrames: 60, title: "Owned", sources: [],
      intent: "shortform", purpose: "ownership control", evidenceRefs: ["fixture:source"], style: structuredClone(DEFAULT_REFERENCE_MOTION_STYLE) },
    frameFormat: { width: project.width, height: project.height, fps: project.fps },
    roles: [{ key: "source:1:clip", kind: "clip", id: clipId, parentId: "video-main" }],
    primaryBefore: { layout: null }, appliedScopeSha256: "d".repeat(64), dependencies: { recipeVersion: "fixture:ownership", presetHashes: [], fonts: [] },
  } });
}
function templateApplied(project: EditProject, clipId: string) {
  const snapshot = { editorialProfile: project.editorialProfile, aestheticSystem: null, captionStyle: structuredClone(project.captionStyle),
    clips: [{ clipId, creativePresent: false, lookPresetId: null, effectPresetIds: [], transitionIn: null, transitionOut: null }] };
  const application: TemplateApplicationState = { schema: "editkin.template-application/v1", sessionId: "s", templateId: "t", templateName: "T",
    format: "short", createdAt: "2026-10-10T00:00:00Z", before: structuredClone(snapshot), applied: structuredClone(snapshot) };
  return applyCommand(project, { type: "set_template_application", application });
}

describe("clip source window", () => {
  it("counts whole frames of real media on both sides, never rounding up past the file", () => {
    const project = fixture();
    expect(clipSourceWindow(project, "A")).toMatchObject({ headFrames: 60, tailFrames: 150, maxSourceStartFrame: 210 });
    project.tracks[0].clips.push(clip("S", "video-main", "short", 6, 0, 164 / 30));
    // 5.468333 s at 30 fps is 164.05 frames: 164 whole frames exist, so nothing is left after 164.
    expect(clipSourceWindow(validateProject(project), "S")).toMatchObject({ headFrames: 0, tailFrames: 0, maxSourceStartFrame: 0 });
  });
});

describe("extend_clip", () => {
  it("grows the end into free space as one Undo/Redo step and survives save/reopen exactly", () => {
    const project = fixture();
    project.tracks[0].clips = [project.tracks[0].clips[0]];
    const history = dispatchCommand(createHistory(validateProject(project)), extend("A", "end", 1.5), "extend-end");
    const a = find(history.present, "A");
    expect(a).toMatchObject({ timelineStart: 0, sourceStart: 2, duration: 4.5 });
    expect(history.past).toHaveLength(1);
    expect(undo(history).present).toEqual(history.past[0]);
    expect(redo(undo(history)).present.tracks).toEqual(history.present.tracks);
    const reopened = reopen(history.present);
    expect(reopened).toEqual(withoutCodecDefaults(history.present));
    expect(find(reopened, "A").duration * 30).toBe(135);
  });

  it("allows exactly the last real frame and refuses one frame more with the remaining length", () => {
    const project = fixture();
    project.tracks[0].clips = [project.tracks[0].clips[0]];
    const valid = validateProject(project);
    expect(find(applyCommand(valid, extend("A", "end", 5)), "A").duration).toBe(8);
    refuses(valid, extend("A", "end", 5 + 1 / 30), /結尾最多只能再延長 5\.00 秒/);
    refuses(valid, extend("A", "start", 2 + 1 / 30), /開頭最多只能再延長 2\.00 秒/);
    refuses(valid, extend("A", "end", 0.5 + 1 / 60), /對齊專案影格/);
    refuses(valid, extend("A", "end", 0), /至少要一個影格/);
  });

  it("explains a clip that already uses the first or last frame of its media", () => {
    const project = fixture();
    refuses(project, extend("B", "start", 1 / 30), /已從素材的第一格開始/);
    project.tracks[0].clips[1] = clip("B", "video-main", "b", 3, 4, 2);
    refuses(validateProject(project), extend("B", "end", 1 / 30), /已用到素材的最後一格/);
  });

  it("moves the start into free space before the clip and keeps the animation on the same pictures", () => {
    const project = fixture();
    const b = project.tracks[0].clips[1];
    project.tracks[0].clips = [b];
    b.timelineStart = 4; b.sourceStart = 3; b.duration = 2;
    b.keyframes = [{ id: "pose", time: 1, transform: { ...DEFAULT_TRANSFORM, x: 300 }, color: { ...DEFAULT_COLOR }, easing: "linear" }];
    const before = validateProject(project), original = find(before, "B");
    const after = find(applyCommand(before, extend("B", "start", 1)), "B");
    expect(after).toMatchObject({ timelineStart: 3, sourceStart: 2, duration: 3 });
    // Same source moment, same animated pose; the new head holds the old first pose.
    for (const local of [0, 0.5, 1, 1.5, 2]) {
      expect(animatedClipState(after, local + 1).transform).toEqual(animatedClipState(original, local).transform);
    }
    expect(animatedClipState(after, 0).transform).toEqual(animatedClipState(original, 0).transform);
    expect(after.keyframes.map(keyframe => keyframe.time)).toEqual([1, 2]);
  });

  it("holds an authored first-frame key at the new head and moves manual mask keys with the content", () => {
    const project = fixture();
    const b = project.tracks[0].clips[1];
    project.tracks[0].clips = [b];
    b.timelineStart = 4; b.sourceStart = 3; b.duration = 2;
    b.keyframes = [
      { id: "k0", time: 0, transform: { ...DEFAULT_TRANSFORM, scale: 1.2 }, color: { ...DEFAULT_COLOR }, easing: "ease_in_out" },
      { id: "k1", time: 2, transform: { ...DEFAULT_TRANSFORM, scale: 1.4 }, color: { ...DEFAULT_COLOR }, easing: "linear" },
    ];
    const mask = createClipMask("manual", "rectangle");
    mask.keyframes = [{ frame: 15, time: 0.5, confidence: 1, status: "manual", points: structuredClone(mask.path) }];
    b.masks = [mask];
    const before = validateProject(project), original = find(before, "B");
    const after = find(applyCommand(before, extend("B", "start", 0.5)), "B");
    expect(after.keyframes.map(keyframe => [keyframe.id, keyframe.time])).toEqual([["k0", 0.5], ["k1", 2.5]]);
    expect(after.transform.scale).toBe(1.2);
    expect(animatedClipState(after, 0).transform.scale).toBe(1.2);
    expect(animatedClipState(after, 1.5).transform).toEqual(animatedClipState(original, 1).transform);
    expect(after.masks![0].keyframes[0]).toMatchObject({ frame: 30, time: 1 });
  });

  it("pushes the following 主畫面 content later by exactly the overlap, keeping locked tracks and earlier content still", () => {
    const project = fixture(), history = dispatchCommand(createHistory(project), extend("A", "end", 1), "extend-push");
    const next = history.present;
    expect(find(next, "A")).toMatchObject({ timelineStart: 0, sourceStart: 2, duration: 4 });
    expect(find(next, "B").timelineStart).toBe(4);
    expect(find(next, "late-overlay").timelineStart).toBeCloseTo(4.2, 9);
    expect(find(next, "early-overlay").timelineStart).toBe(1);
    expect(find(next, "locked-late").timelineStart).toBe(4);
    expect(next.captions.map(caption => caption.start)).toEqual([1, 4.5]);
    expect(next.motionGraphics[0].timelineStart).toBe(5);
    expect(next.director.markers[0].time).toBe(5.5);
    expect(undo(history).present).toEqual(project);
    // Save/reopen through the real project codec keeps every moved item exactly.
    expect(reopen(next)).toEqual(withoutCodecDefaults(next));
  });

  it("only moves the same track's later clips for an extension on another track", () => {
    const project = fixture();
    project.tracks.find(track => track.id === "overlay")!.clips.push(clip("overlay-third", "overlay", "b", 4.2, 0, 1));
    const next = applyCommand(validateProject(project), extend("late-overlay", "end", 0.5));
    expect(find(next, "overlay-third").timelineStart).toBeCloseTo(4.7, 9);
    expect(find(next, "B").timelineStart).toBe(3);
    expect(next.captions[1].start).toBe(3.5);
  });

  it("grows later when the start meets the previous clip, pushing what follows instead of overwriting", () => {
    const project = fixture();
    project.tracks[0].clips[1] = clip("B", "video-main", "b", 3, 2, 2);
    const plan = planClipExtension(validateProject(project), "B", "start", 30);
    expect(plan).toMatchObject({ timelineStart: 3, sourceStart: 1, duration: 3, grewLater: true });
    const next = applyCommand(validateProject(project), extend("B", "start", 1));
    expect(find(next, "B")).toMatchObject({ timelineStart: 3, sourceStart: 1, duration: 3 });
    expect(find(next, "A")).toMatchObject({ timelineStart: 0, duration: 3 });
  });

  it("keeps a transition pair adjacent after a push", () => {
    const project = fixture();
    project.tracks[0].clips[0].creative = { effectPresetIds: [], transitionOut: { presetId: "cross-dissolve", duration: 0.3 } };
    project.tracks[0].clips[1].creative = { effectPresetIds: [], transitionIn: { presetId: "cross-dissolve", duration: 0.3 } };
    const next = applyCommand(validateProject(project), extend("A", "end", 0.5));
    expect(find(next, "A").creative?.transitionOut?.presetId).toBe("cross-dissolve");
    expect(find(next, "B").creative?.transitionIn?.presetId).toBe("cross-dissolve");
    expect(find(next, "B").timelineStart).toBe(3.5);
  });

  it("refuses locked tracks, template-generated clips and source-bound analysis with a reason", () => {
    const project = fixture();
    expect(clipSourceEditBlocker(project, "locked-late", "extend")).toMatch(/軌道已鎖定/);
    refuses(project, extend("locked-late", "end", 1 / 30), /軌道已鎖定.*延長片段/);
    // A saved title template's own main clip may grow: the editor lays the template out again on it in the same command.
    expect(clipSourceEditBlocker(referenceManaged(project, "A"), "A", "extend")).toBeUndefined();
    expect(find(applyCommand(referenceManaged(project, "A"), extend("A", "end", 1 / 30)), "A").duration).toBeCloseTo(3 + 1 / 30, 9);
    // A clip the template generated keeps the template's timing and in-point. The template's own main clip may take a
    // new in-point too: the editor lays the template out again on it, as for a trim.
    refuses(referenceGenerated(project, "A"), extend("A", "end", 1 / 30), /此片段由模板管理.*延長片段/);
    expect(clipSourceEditBlocker(referenceGenerated(project, "A"), "A", "slip")).toMatch(/此片段由模板管理.*換入點/);
    expect(clipSourceEditBlocker(referenceManaged(project, "A"), "A", "slip")).toBeUndefined();
    refuses(templateApplied(project, "A"), extend("A", "start", 1 / 30), /此片段由模板管理/);
    const tracked = structuredClone(project);
    tracked.motionTracks = [{ id: "track-a", clipId: "A", name: "臉", analysisFps: 30, initialRect: { x: .4, y: .4, width: .2, height: .2 }, points: [], lostRatio: 0 } as unknown as EditProject["motionTracks"][number]];
    expect(clipSourceEditBlocker(tracked, "A", "extend")).toMatch(/追蹤或逐格遮罩/);
  });

  it("pushes a saved title template further on (a ripple insert the editor lays it out again for), never a movie template's clips", () => {
    const saved = referenceManaged(fixture(), "B");
    expect(clipExtensionLimits(saved, "A", "end")).toMatchObject({ sourceFrames: 150, freeFrames: 0, maxFrames: 150, pushBlockedReason: undefined });
    expect(find(applyCommand(saved, extend("A", "end", 1)), "B").timelineStart).toBe(4);
    const movie = templateApplied(fixture(), "B");
    const limits = clipExtensionLimits(movie, "A", "end");
    expect(limits).toMatchObject({ sourceFrames: 150, freeFrames: 0, maxFrames: 0 });
    expect(typeof limits !== "string" && limits.pushBlockedReason).toMatch(/模板管理的片段/);
    refuses(movie, extend("A", "end", 1 / 30), /模板管理的片段/);
  });

  it.each([24, 30000 / 1001, 60])("lands every edited value on the %s fps frame grid", fps => {
    // Same layout with every time on this project's frame grid (3 s is not a 29.97 fps frame).
    const project = fixture(fps), grid = (time: number) => Math.round(time * fps) / fps;
    for (const item of project.tracks.flatMap(track => track.clips)) {
      item.timelineStart = grid(item.timelineStart); item.sourceStart = grid(item.sourceStart); item.duration = grid(item.duration);
    }
    for (const caption of project.captions) { caption.start = grid(caption.start); caption.duration = grid(caption.duration); }
    validateProject(project);
    const next = applyCommand(project, extend("A", "end", 7 / fps));
    for (const value of [find(next, "A").duration, find(next, "B").timelineStart, next.captions[1].start]) {
      expect(Math.abs(value * fps - Math.round(value * fps))).toBeLessThan(1e-6);
    }
  });
});

describe("slip_clip", () => {
  it("changes only the in-point: timeline position, length and authored animation stay; one Undo/Redo; exact reopen", () => {
    const project = fixture();
    project.tracks[0].clips[0].keyframes = [{ id: "pose", time: 1, transform: { ...DEFAULT_TRANSFORM, x: 40 }, color: { ...DEFAULT_COLOR }, easing: "linear" }];
    const start = validateProject(project), history = dispatchCommand(createHistory(start), slip("A", 4), "slip");
    const original = find(start, "A"), slipped = find(history.present, "A");
    expect(slipped).toEqual({ ...original, sourceStart: 4 });
    expect(find(history.present, "B")).toEqual(find(start, "B"));
    expect(undo(history).present).toEqual(start);
    expect(redo(undo(history)).present.tracks).toEqual(history.present.tracks);
    expect(reopen(history.present)).toEqual(withoutCodecDefaults(history.present));
  });

  it("refuses an in-point past the end with the latest possible start", () => {
    const project = fixture();
    expect(clipSlipError(project, "A", 7)).toBeUndefined();
    refuses(project, slip("A", 7 + 1 / 30), /最晚只能從 7\.00 秒開始/);
    refuses(project, slip("A", -1 / 30), /不能早於素材開頭/);
    refuses(project, slip("A", 1.01), /對齊專案影格/);
    refuses(project, slip("A", 2), /入點沒有改變/);
    const whole = fixture();
    whole.tracks[0].clips = [clip("W", "video-main", "a", 0, 0, 10)];
    refuses(validateProject(whole), slip("W", 1), /用到整段素材/);
  });

  it("refuses photos, locked tracks and clips a template generated; a template's own main clip may take a new in-point", () => {
    const project = fixture();
    project.tracks[0].clips.push(clip("photo", "video-main", "still", 6, 0, 2));
    const withPhoto = validateProject(project);
    refuses(withPhoto, slip("photo", 1), /照片/);
    refuses(withPhoto, slip("locked-late", 1), /軌道已鎖定.*換入點/);
    refuses(referenceGenerated(withPhoto, "A"), slip("A", 3), /此片段由模板管理.*換入點/);
    expect(find(applyCommand(referenceManaged(withPhoto, "A"), slip("A", 3)), "A").sourceStart).toBe(3);
  });
});
