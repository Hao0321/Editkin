import { describe, expect, it, vi } from "vitest";
import { applyCommand } from "./commands";
import { createDemoProject } from "./demo";
import { animatedClipState, findClip } from "./editGraph";
import { createClipMask } from "./masks";
import { createHistory, dispatchCommand, redo, undo } from "./history";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "./types";

describe("EditGraph command engine", () => {
  it("persists source alpha interpretation as an undoable asset command", () => {
    const project = applyCommand(createDemoProject(), { type: "set_asset_alpha_mode", assetId: "asset-demo", alphaMode: "premultiplied" });
    expect(project.assets[0].alphaMode).toBe("premultiplied");
  });

  it("persists editable masks, tracking bindings, manual corrections and frozen ranges", () => {
    let project = createDemoProject();
    const clip = project.tracks[0].clips[0];
    const mask = createClipMask("mask-1", "subject");
    project = applyCommand(project, { type: "add_clip_mask", clipId: clip.id, mask });
    const track = { id: "track-mask", clipId: clip.id, name: "主體追蹤", engine: "fixture", analysisFps: 30, initialRect: { x: .2, y: .2, width: .3, height: .4 }, points: [{ frame: 0, time: 0, rect: { x: .2, y: .2, width: .3, height: .4 }, confidence: .95, status: "tracked" as const }], lostRatio: 0, createdAt: new Date().toISOString() };
    project = applyCommand(project, { type: "add_motion_track", track });
    project = applyCommand(project, { type: "set_clip_mask_track", clipId: clip.id, maskId: mask.id, trackId: track.id });
    project = applyCommand(project, { type: "set_clip_mask_keyframe", clipId: clip.id, maskId: mask.id, keyframe: { frame: 3, time: .1, points: mask.path, confidence: .6, status: "tracked" } });
    project = applyCommand(project, { type: "freeze_clip_mask_range", clipId: clip.id, maskId: mask.id, fromFrame: 0, toFrame: 30 });
    const result = project.tracks[0].clips[0].masks![0];
    expect(result.trackId).toBe(track.id);
    expect(result.keyframes[0]).toMatchObject({ frame: 3, confidence: 1, status: "manual" });
    expect(result.frozenRange).toEqual({ fromFrame: 0, toFrame: 30 });
  });

  it("invalidates a frozen pixel matte when baked edge controls change", () => {
    let project = createDemoProject();
    const clip = project.tracks[0].clips[0];
    const mask = createClipMask("auto-roto", "subject");
    mask.matteSequence = { schema: "editkin.auto-roto-matte/v1", engine: "editkin-native-color-temporal-roto/v1", width: 160, height: 90, analysisFps: 12, frameCount: 24, sequenceUri: "matte.alpha8", manifestUri: "matte.json", meanBoundaryChatter: .02, frozen: true, qualityState: "diagnostic" };
    const frozenMatte = mask.matteSequence;
    mask.matteSequence = undefined;
    mask.frozenRange = { fromFrame: 0, toFrame: 60 };
    project = applyCommand(project, { type: "add_clip_mask", clipId: clip.id, mask });
    project.tracks[0].clips[0].masks![0].matteSequence = frozenMatte;
    project = applyCommand(project, { type: "update_clip_mask", clipId: clip.id, maskId: mask.id, patch: { feather: .06 } });
    expect(project.tracks[0].clips[0].masks![0]).toMatchObject({ feather: .06, matteSequence: undefined, frozenRange: undefined });
  });

  it("rejects a retired external Auto Roto matte from formal authoring", () => {
    const clip = createDemoProject().tracks[0].clips[0];
    const mask = createClipMask("retired-roto", "subject") as unknown as Record<string, unknown>;
    mask.matteSequence = {
      schema: "editkin.auto-roto-matte/v1", engine: "editkin-native-onnx-assisted-roto/v1", width: 160, height: 90,
      analysisFps: 12, frameCount: 24, sequenceUri: "matte.alpha8", manifestUri: "matte.json", meanBoundaryChatter: .02,
      frozen: true, qualityState: "diagnostic",
    };
    expect(() => applyCommand(createDemoProject(), {
      type: "add_clip_mask", clipId: clip.id, mask: mask as unknown as ReturnType<typeof createClipMask>,
    })).toThrow(/matte sequence/);
  });

  it("rejects a retired research Auto Roto matte from formal authoring", () => {
    const clip = createDemoProject().tracks[0].clips[0];
    const mask = createClipMask("retired-research-roto", "subject") as unknown as Record<string, unknown>;
    mask.matteSequence = {
      schema: "editkin.auto-roto-matte/v1", engine: "editkin-sam21-video-memory-roto/v1", width: 480, height: 848,
      analysisFps: 12, frameCount: 18, sequenceUri: "sam21.alpha8", manifestUri: "sam21.json", meanBoundaryChatter: .04,
      frozen: true, qualityState: "diagnostic",
    };
    expect(() => applyCommand(createDemoProject(), {
      type: "add_clip_mask", clipId: clip.id, mask: mask as unknown as ReturnType<typeof createClipMask>,
    })).toThrow(/matte sequence/);
  });

  it("rejects binding a mask to another clip's tracker", () => {
    let project = createDemoProject();
    const clip = project.tracks[0].clips[0];
    const mask = createClipMask("mask-1", "ellipse");
    project = applyCommand(project, { type: "add_clip_mask", clipId: clip.id, mask });
    project.tracks[0].clips.push({ ...structuredClone(clip), id: "other-clip", timelineStart: clip.duration, sourceStart: 0, duration: 1, masks: [] });
    project.assets[0].duration = Math.max(project.assets[0].duration, clip.duration + 1);
    project.motionTracks.push({ id: "wrong-track", clipId: "other-clip", name: "其他片段", engine: "fixture", analysisFps: 30, initialRect: { x: .2, y: .2, width: .3, height: .4 }, points: [], lostRatio: 0, createdAt: new Date().toISOString() });
    expect(() => applyCommand(project, { type: "set_clip_mask_track", clipId: clip.id, maskId: mask.id, trackId: "wrong-track" })).toThrow("同一片段");
  });
  it("splits a clip without changing total duration", () => {
    const result = applyCommand(createDemoProject(), {
      type: "split_clip",
      clipId: "clip-demo",
      at: 4,
      newClipId: "clip-right",
    });
    const clips = result.tracks[0].clips;
    expect(clips).toHaveLength(2);
    expect(clips[0]).toMatchObject({ duration: 4, sourceStart: 0, timelineStart: 0 });
    expect(clips[1]).toMatchObject({ duration: 8, sourceStart: 4, timelineStart: 4 });
  });

  it("rejects a split outside the clip", () => {
    expect(() => applyCommand(createDemoProject(), {
      type: "split_clip",
      clipId: "clip-demo",
      at: 12,
      newClipId: "bad",
    })).toThrow("片段內部");
  });

  it("undoes and redoes the exact graph", () => {
    const initial = createHistory(createDemoProject());
    const changed = dispatchCommand(initial, {
      type: "trim_clip_start",
      clipId: "clip-demo",
      seconds: 2,
    }, "cmd-trim");
    expect(changed.present.tracks[0].clips[0].duration).toBe(10);
    const undone = undo(changed);
    expect(undone.present.tracks[0].clips[0].duration).toBe(12);
    const redone = redo(undone);
    expect(redone.present.tracks[0].clips[0].duration).toBe(10);
    expect(redone.journal[0].id).toBe("cmd-trim");
  });

  it("stores ACES color management in the undoable project graph", () => {
    const initial = createHistory(createDemoProject());
    const changed = dispatchCommand(initial, { type: "set_project_color_management", patch: { mode: "aces2", outputTransform: "p3d65_sdr" } }, "aces-mode");
    expect(changed.present.colorManagement).toMatchObject({ mode: "aces2", workingSpace: "ACEScct", outputTransform: "p3d65_sdr" });
    expect(undo(changed).present.colorManagement?.mode).toBe("rec709");
  });

  it("trims the out point and controls clip volume", () => {
    let project = createDemoProject();
    project = applyCommand(project, { type: "trim_clip_end", clipId: "clip-demo", seconds: 2 });
    project = applyCommand(project, { type: "set_clip_volume", clipId: "clip-demo", volume: 0.65 });
    expect(findClip(project, "clip-demo")).toMatchObject({ sourceStart: 0, duration: 10, volume: 0.65 });
    expect(() => applyCommand(project, { type: "set_clip_volume", clipId: "clip-demo", volume: 2.1 })).toThrow(/音量/);
  });

  it("compacts gaps deterministically", () => {
    let project = applyCommand(createDemoProject(), {
      type: "split_clip",
      clipId: "clip-demo",
      at: 4,
      newClipId: "clip-right",
    });
    project = applyCommand(project, { type: "move_clip", clipId: "clip-right", timelineStart: 8 });
    project = applyCommand(project, { type: "compact_track", trackId: "video-main" });
    expect(project.tracks[0].clips[1].timelineStart).toBe(4);
  });

  it("ripple deletes a main shot and keeps downstream picture, captions, graphics and markers synchronized", () => {
    let project = applyCommand(createDemoProject(), { type: "split_clip", clipId: "clip-demo", at: 4, newClipId: "clip-middle" });
    project = applyCommand(project, { type: "split_clip", clipId: "clip-middle", at: 8, newClipId: "clip-end" });
    project = applyCommand(project, { type: "add_caption", caption: { id: "caption-after", text: "after", start: 9, duration: 1 } });
    project = applyCommand(project, { type: "add_motion_graphic", graphic: { schema: "hao.motion-composition/v1", id: "graphic-after", name: "after", kind: "tag", text: "after", timelineStart: 9, duration: 1, x: 0.5, y: 0.5, width: 0.2, fontSize: 42, textColor: "#ffffff", backgroundColor: "#000000", accentColor: "#00ff00", animation: "fade", offsetX: 0, offsetY: 0 } });
    project = applyCommand(project, { type: "add_director_marker", marker: { id: "marker-after", time: 9, title: "after", note: "", kind: "beat", status: "open", createdAt: "2026-08-23T00:00:00.000Z" } });
    const changed = dispatchCommand(createHistory(project), { type: "ripple_delete_clip", clipId: "clip-middle" }, "ripple-delete");
    expect(changed.present.tracks[0].clips.map((clip) => ({ id: clip.id, start: clip.timelineStart }))).toEqual([
      { id: "clip-demo", start: 0 },
      { id: "clip-end", start: 4 },
    ]);
    expect(changed.present.captions[0].start).toBe(5);
    expect(changed.present.motionGraphics[0].timelineStart).toBe(5);
    expect(changed.present.director.markers[0].time).toBe(5);
    expect(undo(changed).present).toEqual(project);
  });

  it("adds and edits captions through the same command engine", () => {
    let project = createDemoProject();
    project = applyCommand(project, { type: "add_caption", caption: { id: "caption-1", text: "第一版", start: 1, duration: 2 } });
    project = applyCommand(project, { type: "update_caption", captionId: "caption-1", patch: { text: "完成版", start: 2 } });
    expect(project.captions[0]).toMatchObject({ text: "完成版", start: 2, duration: 2 });
  });

  it("edits both bilingual lines and can intentionally return a cue to one line", () => {
    let project = createDemoProject();
    project = applyCommand(project, { type: "add_caption", caption: { id: "caption-bi", text: "原文", start: 1, duration: 2, translation: { text: "Translation", language: "en" } } });
    project = applyCommand(project, { type: "update_caption", captionId: "caption-bi", patch: { translation: { text: "Edited English", language: "en" } } });
    expect(project.captions[0].translation?.text).toBe("Edited English");
    project = applyCommand(project, { type: "update_caption", captionId: "caption-bi", patch: { translation: null } });
    expect(project.captions[0].translation).toBeUndefined();
  });

  it("adds a layer, moves a clip, and edits transform and color", () => {
    let project = createDemoProject();
    project = applyCommand(project, { type: "add_track", track: { id: "video-overlay", name: "疊加", kind: "video", locked: false, muted: false, clips: [] } });
    project = applyCommand(project, { type: "move_clip_to_track", clipId: "clip-demo", trackId: "video-overlay", timelineStart: 1 });
    project = applyCommand(project, { type: "update_clip_transform", clipId: "clip-demo", patch: { x: 120, opacity: 0.8 } });
    project = applyCommand(project, { type: "set_clip_color", clipId: "clip-demo", patch: { saturation: 1.5 } });
    expect(project.tracks.find((track) => track.id === "video-overlay")?.clips[0]).toMatchObject({ timelineStart: 1, transform: { x: 120, opacity: 0.8 }, color: { saturation: 1.5 } });
  });

  it("manages user-created tracks through undoable commands", () => {
    let project = createDemoProject();
    project = applyCommand(project, { type: "add_track", track: { id: "video-pip", name: "畫中畫 1", kind: "video", locked: false, muted: false, clips: [] } });
    project = applyCommand(project, { type: "rename_track", trackId: "video-pip", name: "產品特寫" });
    project = applyCommand(project, { type: "toggle_track_lock", trackId: "video-pip" });
    expect(project.tracks.find((track) => track.id === "video-pip")).toMatchObject({ name: "產品特寫", locked: true });
    project = applyCommand(project, { type: "toggle_track_lock", trackId: "video-pip" });
    project = applyCommand(project, { type: "delete_track", trackId: "video-pip" });
    expect(project.tracks.some((track) => track.id === "video-pip")).toBe(false);
    expect(() => applyCommand(project, { type: "delete_track", trackId: "video-main" })).toThrow(/主軌/);
  });

  it("keeps keyframes deterministic when splitting", () => {
    let project = createDemoProject();
    project = applyCommand(project, { type: "add_keyframe", clipId: "clip-demo", keyframe: { id: "kf-a", time: 2, transform: { ...DEFAULT_TRANSFORM, x: 20 }, color: { ...DEFAULT_COLOR, hue: 20 }, easing: "linear" } });
    project = applyCommand(project, { type: "add_keyframe", clipId: "clip-demo", keyframe: { id: "kf-b", time: 8, transform: { ...DEFAULT_TRANSFORM, x: 80 }, color: { ...DEFAULT_COLOR, hue: 80 }, easing: "hold" } });
    expect(animatedClipState(findClip(project, "clip-demo"), 10)).toMatchObject({ transform: { x: 80 }, color: { hue: 80 } });
    project = applyCommand(project, { type: "split_clip", clipId: "clip-demo", at: 4, newClipId: "clip-right" });
    expect(project.tracks[0].clips[0].keyframes.map((keyframe) => keyframe.time)).toEqual([2, 4]);
    expect(project.tracks[0].clips[1].keyframes).toMatchObject([{ id: "clip-right-kf-b", time: 4 }]);
  });

  it("preserves transform and grading animation across split and trim boundaries", () => {
    let project = createDemoProject();
    project = applyCommand(project, {
      type: "add_keyframe",
      clipId: "clip-demo",
      keyframe: {
        id: "animated-end", time: 8,
        transform: { ...DEFAULT_TRANSFORM, x: 80, opacity: 0.6 },
        color: { ...DEFAULT_COLOR, brightness: 0.4, hue: 80 },
        easing: "linear",
      },
    });
    const expectedAtFour = animatedClipState(findClip(project, "clip-demo"), 4);
    const split = applyCommand(project, { type: "split_clip", clipId: "clip-demo", at: 4, newClipId: "clip-right" });
    const left = findClip(split, "clip-demo");
    const right = findClip(split, "clip-right");
    expect(animatedClipState(left, 4)).toEqual(expectedAtFour);
    expect(animatedClipState(right, 0)).toEqual(expectedAtFour);
    expect(animatedClipState(right, 4)).toMatchObject({ transform: { x: 80, opacity: 0.6 }, color: { brightness: 0.4, hue: 80 } });

    const trimmed = applyCommand(project, { type: "trim_clip_start", clipId: "clip-demo", seconds: 4 });
    const trimmedClip = findClip(trimmed, "clip-demo");
    expect(animatedClipState(trimmedClip, 0)).toEqual(expectedAtFour);
    expect(trimmedClip.keyframes).toMatchObject([{ id: "animated-end", time: 4 }]);
  });

  it("rejects invalid keyframes and cross-kind moves", () => {
    expect(() => applyCommand(createDemoProject(), { type: "add_keyframe", clipId: "clip-demo", keyframe: { id: "bad", time: 20, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, easing: "linear" } })).toThrow(/關鍵幀時間/);
    expect(() => applyCommand(createDemoProject(), { type: "move_clip_to_track", clipId: "clip-demo", trackId: "audio-main", timelineStart: 0 })).toThrow(/相同類型/);
  });

  it("persists layer modes and safe expressions through the command engine", () => {
    let project = applyCommand(createDemoProject(), { type: "set_clip_layer", clipId: "clip-demo", patch: { blendMode: "screen", enabled: true } });
    project = applyCommand(project, { type: "set_clip_expression", clipId: "clip-demo", property: "opacity", expression: "hao.expression/v1:value * entrance * exit" });
    const clip = findClip(project, "clip-demo");
    expect(clip.layer).toEqual({ enabled: true, blendMode: "screen", role: "content" });
    expect(clip.expressions?.opacity).toBe("hao.expression/v1:value * entrance * exit");
    expect(animatedClipState(clip, 0, project.fps).transform.opacity).toBe(0);
    expect(() => applyCommand(project, { type: "set_clip_expression", clipId: "clip-demo", property: "x", expression: "hao.expression/v1:globalThis.process.exit()" })).toThrow();
  });

  it("persists parenting, track matte and adjustment roles while rejecting reference cycles", () => {
    let project = createDemoProject();
    project = applyCommand(project, { type: "add_track", track: { id: "video-overlay", name: "覆疊", kind: "video", locked: false, muted: false, clips: [] } });
    project = applyCommand(project, { type: "add_clip", clip: {
      ...structuredClone(findClip(project, "clip-demo")), id: "clip-overlay", trackId: "video-overlay", duration: 6,
    } });
    project = applyCommand(project, { type: "set_clip_layer", clipId: "clip-overlay", patch: {
      parentClipId: "clip-demo", trackMatte: { sourceClipId: "clip-demo", mode: "luma_inverted" },
    } });
    expect(findClip(project, "clip-overlay").layer).toMatchObject({
      role: "content", parentClipId: "clip-demo", trackMatte: { sourceClipId: "clip-demo", mode: "luma_inverted" },
    });
    expect(() => applyCommand(project, { type: "set_clip_layer", clipId: "clip-demo", patch: { parentClipId: "clip-overlay" } })).toThrow(/循環/);
    project = applyCommand(project, { type: "set_clip_layer", clipId: "clip-overlay", patch: { parentClipId: undefined, trackMatte: undefined, role: "adjustment" } });
    expect(findClip(project, "clip-overlay").layer?.role).toBe("adjustment");
    expect(() => applyCommand(project, { type: "set_clip_layer", clipId: "clip-demo", patch: { parentClipId: "clip-overlay" } })).toThrow(/父圖層/);
    expect(() => applyCommand(project, { type: "set_clip_layer", clipId: "clip-demo", patch: { trackMatte: { sourceClipId: "clip-overlay", mode: "alpha" } } })).toThrow(/Track Matte/);
  });

  it("turns a visual clip into a parentable Null controller without matte or blend state", () => {
    let project = createDemoProject();
    project = applyCommand(project, { type: "add_track", track: { id: "video-child", name: "Child", kind: "video", locked: false, muted: false, clips: [] } });
    project = applyCommand(project, { type: "add_clip", clip: {
      ...structuredClone(findClip(project, "clip-demo")), id: "clip-child", trackId: "video-child",
    } });
    project = applyCommand(project, { type: "set_clip_layer", clipId: "clip-demo", patch: {
      role: "controller", blendMode: "screen", trackMatte: { sourceClipId: "clip-child", mode: "alpha" },
    } });
    project = applyCommand(project, { type: "set_clip_layer", clipId: "clip-child", patch: { parentClipId: "clip-demo" } });
    expect(findClip(project, "clip-demo").layer).toMatchObject({ role: "controller", blendMode: "normal", trackMatte: undefined });
    expect(findClip(project, "clip-child").layer?.parentClipId).toBe("clip-demo");
    project = applyCommand(project, { type: "set_clip_layer", clipId: "clip-demo", patch: { trackMatte: { sourceClipId: "clip-child", mode: "luma" } } });
    expect(findClip(project, "clip-demo").layer?.trackMatte).toBeUndefined();
  });

  it("clears dependent layer references when a source clip is deleted", () => {
    let project = createDemoProject();
    project = applyCommand(project, { type: "add_track", track: { id: "video-overlay", name: "覆疊", kind: "video", locked: false, muted: false, clips: [] } });
    project = applyCommand(project, { type: "add_clip", clip: {
      ...structuredClone(findClip(project, "clip-demo")), id: "clip-overlay", trackId: "video-overlay", duration: 6,
      layer: { enabled: true, blendMode: "normal", parentClipId: "clip-demo", trackMatte: { sourceClipId: "clip-demo", mode: "alpha" } },
    } });
    project = applyCommand(project, { type: "delete_clip", clipId: "clip-demo" });
    expect(findClip(project, "clip-overlay").layer).toMatchObject({ parentClipId: undefined, trackMatte: undefined });
  });

  it("keeps updatedAt monotonic when multiple edits land in one millisecond", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T12:00:00.000Z"));
    try {
      const project = { ...createDemoProject(), updatedAt: "2026-08-21T12:00:00.000Z" };
      const first = applyCommand(project, { type: "rename_project", name: "first" });
      const second = applyCommand(first, { type: "rename_project", name: "second" });
      expect(first.updatedAt).toBe("2026-08-21T12:00:00.001Z");
      expect(second.updatedAt).toBe("2026-08-21T12:00:00.002Z");
    } finally { vi.useRealTimers(); }
  });

  it("stores Creator Pack choices in EditGraph and undoes them exactly", () => {
    let project = applyCommand(createDemoProject(), { type: "split_clip", clipId: "clip-demo", at: 4, newClipId: "clip-right" });
    const history = createHistory(project);
    const changed = dispatchCommand(history, {
      type: "set_clip_creative",
      clipId: "clip-demo",
      patch: {
        lookPresetId: "ai_cobalt_crisp",
        effectPresetIds: ["film_grain_soft", "film_grain_soft", "scanline_focus"],
        transitionOut: { presetId: "prism_flash_cut", duration: 0.18 },
      },
    }, "cmd-creative");
    expect(findClip(changed.present, "clip-demo").creative).toEqual({
      lookPresetId: "ai_cobalt_crisp",
      effectPresetIds: ["film_grain_soft", "scanline_focus"],
      transitionOut: { presetId: "prism_flash_cut", duration: 0.18 },
    });
    expect(findClip(undo(changed).present, "clip-demo").creative).toBeUndefined();
  });

  it("persists native effect instances as undoable EditGraph state", () => {
    const initial = createHistory(createDemoProject());
    const instance = {
      id: "native-effect-1",
      pluginId: "creator.native-effects",
      capabilityId: "gain",
      pluginVersion: "1.2.0",
      manifestSha256: "a".repeat(64),
      enabled: true,
      parameters: { gain: 0.8, invert: false },
    };
    const added = dispatchCommand(initial, { type: "add_native_effect", clipId: "clip-demo", instance }, "native-add");
    expect(findClip(added.present, "clip-demo").creative?.nativeEffectInstances).toEqual([instance]);
    const second = { ...instance, id: "native-effect-2", capabilityId: "contrast" };
    const stacked = dispatchCommand(added, { type: "add_native_effect", clipId: "clip-demo", instance: second }, "native-stack");
    const reordered = dispatchCommand(stacked, { type: "reorder_native_effect", clipId: "clip-demo", instanceId: second.id, toIndex: 0 }, "native-reorder");
    expect(findClip(reordered.present, "clip-demo").creative?.nativeEffectInstances?.map((item) => item.id)).toEqual([second.id, instance.id]);
    const updated = dispatchCommand(reordered, { type: "update_native_effect", clipId: "clip-demo", instanceId: instance.id, patch: { enabled: false, parameters: { gain: 1.1 } } }, "native-update");
    expect(findClip(updated.present, "clip-demo").creative?.nativeEffectInstances?.[1]).toMatchObject({ enabled: false, parameters: { gain: 1.1 } });
    const removed = dispatchCommand(updated, { type: "remove_native_effect", clipId: "clip-demo", instanceId: instance.id }, "native-remove");
    expect(findClip(removed.present, "clip-demo").creative?.nativeEffectInstances?.map((item) => item.id)).toEqual([second.id]);
    expect(findClip(undo(removed).present, "clip-demo").creative?.nativeEffectInstances?.[1]).toMatchObject({ enabled: false, parameters: { gain: 1.1 } });
    expect(findClip(undo(added).present, "clip-demo").creative).toBeUndefined();
  });

  it("bounds GPU effect stacks and rejects CPU/GPU mixing at the command boundary", () => {
    let project = createDemoProject();
    const gpu = (index: number) => ({
      id: `gpu-${index}`, pluginId: "creator.gpu", capabilityId: "look", pluginVersion: "1.0.0",
      manifestSha256: "b".repeat(64), runtimeType: "gpu_effect_graph" as const, enabled: true, parameters: { gain: 1 },
    });
    for (let index = 0; index < 4; index += 1) project = applyCommand(project, { type: "add_native_effect", clipId: "clip-demo", instance: gpu(index) });
    expect(() => applyCommand(project, { type: "add_native_effect", clipId: "clip-demo", instance: gpu(4) })).toThrow(/最多 4 個 GPU graph/);
    expect(() => applyCommand(project, { type: "add_native_effect", clipId: "clip-demo", instance: { ...gpu(5), id: "cpu", runtimeType: "native_effect" } })).toThrow(/不可混用/);
  });

  it("rejects a transition when there is no real adjacent shot", () => {
    expect(() => applyCommand(createDemoProject(), {
      type: "set_clip_creative", clipId: "clip-demo",
      patch: { transitionOut: { presetId: "luma_fade", duration: 0.4 } },
    })).toThrow(/相鄰片段/);
  });

  it("persists director review notes through the command engine and undo", () => {
    const initial = createHistory(createDemoProject());
    const marked = dispatchCommand(initial, {
      type: "add_director_marker",
      marker: { id: "director-risk-1", time: 3.5, title: "節奏風險", note: "這裡需要 B-roll", kind: "risk", status: "open", createdAt: "2026-08-22T12:00:00.000Z" },
    }, "director-marker");
    const ready = dispatchCommand(marked, { type: "set_director_review_state", reviewState: "ready_for_hao_review" }, "director-ready");
    expect(ready.present.director).toMatchObject({ reviewState: "ready_for_hao_review", markers: [{ id: "director-risk-1", status: "open" }] });
    expect(undo(ready).present.director.reviewState).toBe("draft");
    expect(undo(undo(ready)).present.director.markers).toEqual([]);
  });
});
