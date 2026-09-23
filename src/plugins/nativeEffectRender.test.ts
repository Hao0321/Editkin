import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { buildRenderPlan } from "../render/planner";
import { materializeNativeEffectSegments, projectAfterNativeEffectMaterialization, type NativeEffectRenderReceipt } from "./nativeEffectRender";

describe("formal GPU effect graph output boundary", () => {
  it("fails closed before process or filesystem work when the GPU compositor runtime is absent", async () => {
    const project = createDemoProject();
    project.tracks[0].clips[0].creative = { effectPresetIds: [], nativeEffectInstances: [{
      id: "gpu-effect", pluginId: "creator.gpu", capabilityId: "gain", pluginVersion: "1.0.0",
      manifestSha256: "a".repeat(64), runtimeType: "gpu_effect_graph", enabled: true, parameters: { gain: .8 },
    }] };
    const plan = buildRenderPlan(project, (uri) => uri);
    await expect(materializeNativeEffectSegments(project, plan, {
      ffmpegPath: "missing-ffmpeg", nativeCorePath: "missing-core", pluginRoots: ["missing-plugin-root"], workspace: "missing-workspace", timeoutMs: 100,
    })).rejects.toThrow(/缺少 GPU compositor runtime/);
  });

  it("suppresses only typography and adjustment layers proven baked by the native receipt without mutating authored state", () => {
    const project = createDemoProject();
    project.captions.push(
      { id: "baked-caption", text: "Baked", start: 0, duration: 1 },
      { id: "later-caption", text: "Keep", start: 1, duration: 1 },
    );
    project.motionGraphics.push(
      { schema: "hao.motion-composition/v1", id: "baked-graphic", name: "Baked", kind: "tag", text: "Baked", timelineStart: 0, duration: 1, x: .1, y: .1, width: .3, fontSize: 36, textColor: "#FFFFFFFF", backgroundColor: "#000000DD", accentColor: "#A8FF3EFF", animation: "fade", offsetX: 0, offsetY: 0 },
      { schema: "hao.motion-composition/v1", id: "later-graphic", name: "Keep", kind: "tag", text: "Keep", timelineStart: 1, duration: 1, x: .1, y: .1, width: .3, fontSize: 36, textColor: "#FFFFFFFF", backgroundColor: "#000000DD", accentColor: "#A8FF3EFF", animation: "fade", offsetX: 0, offsetY: 0 },
    );
    const bakedAdjustment = structuredClone(project.tracks[0].clips[0]); bakedAdjustment.id = "baked-adjustment"; bakedAdjustment.layer = { enabled: true, blendMode: "normal", role: "adjustment" };
    const laterAdjustment = structuredClone(bakedAdjustment); laterAdjustment.id = "later-adjustment";
    project.tracks.push({ id: "adjustments", name: "Adjustments", kind: "video", locked: false, muted: false, clips: [bakedAdjustment, laterAdjustment] });
    const receipt = { clips: [{ gpu: {
      typography: { captionCueIds: ["baked-caption"], motionGraphicIds: ["baked-graphic"] },
      adjustment: { adjustmentClipIds: ["baked-adjustment"] },
      matte: { targetClipIds: ["matte-target"] },
    } }] } as NativeEffectRenderReceipt;
    const matteTarget = structuredClone(project.tracks[0].clips[0]); matteTarget.id = "matte-target";
    project.tracks[0].clips.push(matteTarget);
    const filtered = projectAfterNativeEffectMaterialization(project, receipt);
    expect(filtered.captions.map((cue) => cue.id)).toEqual(["later-caption"]);
    expect(filtered.motionGraphics.map((graphic) => graphic.id)).toEqual(["later-graphic"]);
    expect(filtered.tracks.find((track) => track.id === "adjustments")?.clips.map((clip) => clip.id)).toEqual(["later-adjustment"]);
    expect(filtered.tracks[0].clips.some((clip) => clip.id === "matte-target")).toBe(false);
    expect(project.captions).toHaveLength(2);
    expect(project.motionGraphics).toHaveLength(2);
    expect(project.tracks.find((track) => track.id === "adjustments")?.clips).toHaveLength(2);
    expect(project.tracks[0].clips.some((clip) => clip.id === "matte-target")).toBe(true);
    expect(projectAfterNativeEffectMaterialization(project, undefined)).toBe(project);
  });

  it("removes only a receipt-bound partial overlay interval and preserves both editable tails", () => {
    const project = createDemoProject();
    project.fps = 30;
    const overlay = structuredClone(project.tracks[0].clips[0]);
    overlay.id = "partial-overlay";
    overlay.trackId = "overlay-track";
    overlay.timelineStart = 2;
    overlay.sourceStart = 1;
    overlay.duration = 4;
    overlay.keyframes = [];
    overlay.expressions = {};
    project.tracks.push({ id: "overlay-track", name: "Overlay", kind: "video", locked: false, muted: false, clips: [overlay] });
    const receipt = { clips: [{ gpu: { composite: {
      overlayClipIds: [],
      timelineRanges: [{ clipId: overlay.id, timelineStartFrame: 90, durationFrames: 60, fullyMaterialized: false }],
    } } }] } as unknown as NativeEffectRenderReceipt;

    const filtered = projectAfterNativeEffectMaterialization(project, receipt);
    expect(filtered.tracks.find((track) => track.id === "overlay-track")?.clips.map((clip) => ({
      id: clip.id, timelineStart: clip.timelineStart, sourceStart: clip.sourceStart, duration: clip.duration,
    }))).toEqual([
      { id: "partial-overlay", timelineStart: 2, sourceStart: 1, duration: 1 },
      { id: "partial-overlay__unbaked_150", timelineStart: 5, sourceStart: 4, duration: 1 },
    ]);
    expect(project.tracks.find((track) => track.id === "overlay-track")?.clips[0]).toMatchObject({ timelineStart: 2, sourceStart: 1, duration: 4 });
  });
});
