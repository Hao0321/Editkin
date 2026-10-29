import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { createClipMask } from "../domain/masks";
import { DEFAULT_COLOR, DEFAULT_PARTICLE_SIMULATION, DEFAULT_SCENE_25D, DEFAULT_TRANSFORM, type EditProject, type TimelineClip } from "../domain/types";
import { assertExportFeaturesRenderableV1, LEGACY_PREVIEW_MISMATCH_EFFECT_IDS_V1 } from "./exportFeatureGuardV1";
import { EXPORT_REFUSAL_MESSAGES_V1, exportRefusalMessageKeysV1, fillExportRefusalMessageV1, isExportFeatureRefusalV1, type ExportFeatureRefusalErrorV1 } from "./exportFeatureRefusalV1";
import { MASK_TIMELINE_SAMPLE_LIMIT } from "./maskFilters";
import { problemCause } from "../application/plainProblems";
import { renderProject } from "./ffmpeg";

function project(kind: "image" | "video" = "image"): EditProject {
  const p = createEmptyProject("Guard", { id: "guard", width: 320, height: 180, fps: 30 });
  p.assets.push({ id: "media", name: "海邊.mp4", uri: "C:/fixture/media.mp4", kind, duration: 10, width: 320, height: 180 });
  p.tracks[0].clips.push(clip("clip-1"));
  return p;
}
function clip(id: string, patch: Partial<TimelineClip> = {}): TimelineClip {
  return { id, assetId: "media", trackId: "video-main", timelineStart: 0, sourceStart: 0, duration: 2, volume: 1,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], ...patch };
}
function refusal(run: () => void): ExportFeatureRefusalErrorV1 {
  try { run(); } catch (error) { if (isExportFeatureRefusalV1(error)) return error; throw error; }
  throw new Error("expected an export refusal");
}

describe("export preflight refuses silent drops with a clip-named message", () => {
  it("passes projects that use none of the refused features", () => {
    expect(() => assertExportFeaturesRenderableV1(project())).not.toThrow();
    const p = project();
    p.tracks[0].clips[0].keyframes = [{ id: "k", time: 1, easing: "linear", transform: { ...DEFAULT_TRANSFORM, x: .2 }, color: { ...DEFAULT_COLOR, brightness: .1 } }];
    expect(() => assertExportFeaturesRenderableV1(p)).not.toThrow();
  });

  it("legacy scanline_focus still exports: its sharpen is what saved and published projects delivered", () => {
    const p = project();
    p.tracks[0].clips[0].creative = { effectPresetIds: ["scanline_focus"] };
    expect(LEGACY_PREVIEW_MISMATCH_EFFECT_IDS_V1.size).toBe(0);
    expect(() => assertExportFeaturesRenderableV1(p)).not.toThrow();
    // The message stays available for a future effect whose export is the wrong side.
    expect(fillExportRefusalMessageV1(EXPORT_REFUSAL_MESSAGES_V1.legacyScanlineFocus, { clip: "「海邊.mp4」" })).toContain("「海邊.mp4」");
  });

  it("a refusal names the clip, and hidden tracks are not refused", () => {
    const p = project();
    const mask = createClipMask("tracked", "rectangle");
    mask.keyframes = Array.from({ length: MASK_TIMELINE_SAMPLE_LIMIT + 1 }, (_, index) => ({ frame: index, time: index / 1000, confidence: 1, status: "tracked" as const,
      points: [{ id: "a", x: .1, y: .1 }, { id: "b", x: .4, y: .1 }, { id: "c", x: .4, y: .4 }, { id: "d", x: .1, y: .4 }] }));
    p.tracks[0].clips[0].masks = [mask];
    const error = refusal(() => assertExportFeaturesRenderableV1(p));
    expect(error.clipId).toBe("clip-1");
    expect(error.message).toContain("海邊.mp4");
    // Hidden tracks and disabled layers are not rendered, so they are not refused.
    p.tracks[0].hidden = true;
    expect(() => assertExportFeaturesRenderableV1(p)).not.toThrow();
  });

  it("refuses keyframed primary colour the export cannot animate, but not what it now animates", () => {
    const animated = project();
    animated.tracks[0].clips[0].keyframes = [{ id: "k", time: 1, easing: "linear", transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR, exposure: 1, shadows: .3 } }];
    expect(() => assertExportFeaturesRenderableV1(animated)).not.toThrow();
    const adjustment = structuredClone(animated);
    adjustment.tracks[0].clips[0].layer = { enabled: true, blendMode: "normal", role: "adjustment" };
    expect(refusal(() => assertExportFeaturesRenderableV1(adjustment)).messageId).toBe("colorKeyframesAdjustment");
    const hdr = structuredClone(animated);
    hdr.assets[0].color = { interpretation: "hlg", transfer: "arib-std-b67", primaries: "bt2020", matrix: "bt2020nc", range: "tv" };
    expect(refusal(() => assertExportFeaturesRenderableV1(hdr)).messageId).toBe("colorKeyframesHdrExposure");
    const long = project();
    long.tracks[0].clips[0] = clip("long", { duration: 70, keyframes: [{ id: "k", time: 69, easing: "linear", transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR, exposure: 2 } }] });
    const tooLong = refusal(() => assertExportFeaturesRenderableV1(long));
    expect(tooLong.messageId).toBe("colorKeyframesTooLong");
    expect(tooLong.message).toContain("曝光");
  });

  it("refuses 2.5D and particles without a native route, names the planes, and admits Rec.709 image planes", () => {
    const scene = project("image");
    scene.tracks[0].clips[0] = clip("plane", { volume: 0, transform3d: { position: [0, 0, 0], rotationDegrees: [0, 40, 0], scale: [1, 1, 1] } });
    scene.scene25d = structuredClone(DEFAULT_SCENE_25D);
    const noRuntime = refusal(() => assertExportFeaturesRenderableV1(scene));
    expect(noRuntime.feature).toBe("scene25d");
    expect(noRuntime.message).toContain("片段「海邊.mp4」等 1 個平面");
    expect(() => assertExportFeaturesRenderableV1(scene, { gpuCompositorPath: "C:/fixture/editkin-gpu-compositor.exe" })).not.toThrow();
    const video = structuredClone(scene);
    video.assets[0].kind = "video";
    expect(refusal(() => assertExportFeaturesRenderableV1(video, { gpuCompositorPath: "C:/fixture/editkin-gpu-compositor.exe" })).messageId).toBe("scene25dVideoPlanes");
    const hdrOutput = structuredClone(scene);
    hdrOutput.colorManagement = { ...hdrOutput.colorManagement!, mode: "aces2", outputTransform: "rec2100_pq_1000" };
    expect(refusal(() => assertExportFeaturesRenderableV1(hdrOutput, { gpuCompositorPath: "C:/fixture/editkin-gpu-compositor.exe" })).messageId).toBe("scene25dColorRoute");
    const particles = project("image");
    particles.particleSimulation = structuredClone(DEFAULT_PARTICLE_SIMULATION);
    expect(refusal(() => assertExportFeaturesRenderableV1(particles)).messageId).toBe("particlesNoRuntime");
    expect(() => assertExportFeaturesRenderableV1(particles, { gpuCompositorPath: "C:/fixture/editkin-gpu-compositor.exe" })).not.toThrow();
  });

  it("refuses 2.5D inside a nested composition (the precomposition route is flat)", () => {
    const p = project();
    p.compositions.push({ id: "nest", name: "立體段落", width: 320, height: 180, fps: 30, duration: 2, tracks: [], scene25d: structuredClone(DEFAULT_SCENE_25D) } as unknown as EditProject["compositions"][number]);
    p.assets.push({ id: "nest-asset", name: "立體段落", uri: "composition://nest", kind: "video", duration: 2, compositionId: "nest" });
    p.tracks[0].clips.push(clip("nested", { assetId: "nest-asset", timelineStart: 2 }));
    const error = refusal(() => assertExportFeaturesRenderableV1(p));
    expect(error.feature).toBe("nestedScene");
    expect(error.message).toContain("「立體段落」");
  });

  it("refuses mask timelines past the export limit", () => {
    const p = project();
    const mask = createClipMask("tracked", "rectangle");
    mask.keyframes = Array.from({ length: MASK_TIMELINE_SAMPLE_LIMIT + 1 }, (_, index) => ({ frame: index, time: index / 1000, confidence: 1, status: "tracked" as const,
      points: [{ id: "a", x: .1, y: .1 }, { id: "b", x: .4, y: .1 }, { id: "c", x: .4, y: .4 }, { id: "d", x: .1, y: .4 }] }));
    p.tracks[0].clips[0].masks = [mask];
    const error = refusal(() => assertExportFeaturesRenderableV1(p));
    expect(error.feature).toBe("trackedMask");
    expect(error.params.samples).toBe(MASK_TIMELINE_SAMPLE_LIMIT + 1);
  });

  it("renderProject (the GUI, service and MCP export entry) refuses before any render work", async () => {
    const p = project();
    const mask = createClipMask("tracked", "rectangle");
    mask.keyframes = Array.from({ length: MASK_TIMELINE_SAMPLE_LIMIT + 1 }, (_, index) => ({ frame: index, time: index / 1000, confidence: 1, status: "tracked" as const,
      points: [{ id: "a", x: .1, y: .1 }, { id: "b", x: .4, y: .1 }, { id: "c", x: .4, y: .4 }, { id: "d", x: .1, y: .4 }] }));
    p.tracks[0].clips[0].masks = [mask];
    await expect(renderProject(p, "Z:/never-written/out.mp4", { ffmpegPath: "Z:/missing/ffmpeg.exe" })).rejects.toMatchObject({ code: "EXPORT_FEATURE_REFUSED", feature: "trackedMask", clipId: "clip-1" });
  });

  it("every message is an interface key that plain-problem classification files as an unsupported combination", () => {
    for (const key of exportRefusalMessageKeysV1()) {
      expect(problemCause("export", fillExportRefusalMessageV1(key, { clip: "a", count: 1, route: "r", composition: "c", feature: "f", fields: "曝光", frames: 2, limit: 1, mask: "m", samples: 2 }))).toBe("unsupportedCombination");
      expect(key).toMatch(/\{[a-z]+\}/i);
    }
  });
});
