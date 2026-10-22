import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import type { ProofStillV1 } from "../domain/proofStillV1";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { buildGpuEnginePreviewGraph, buildGpuEngineVideoPreviewGraph, buildGpuRenderGraph, buildGpuVideoPreviewSource } from "./gpuCompositor";

const proofStill: ProofStillV1 = { schema: "editkin.proof-still/v1", sourceSha256: "d".repeat(64), sourceWidth: 960, sourceHeight: 540,
  crop: { x: 0, y: 0, width: 960, height: 540 }, redactions: [{ id: "name", rect: { x: 10, y: 10, width: 100, height: 20 }, fill: "#000000" }],
  hold: "static", confirmation: { by: "agent", note: "Fixture." } };

describe("native GPU executors decline proof stills (design P3)", () => {
  it("the resident image executors decline even a proof still that lost its layout, which they would otherwise draw raw", () => {
    const project = createDemoProject();
    project.assets[0].kind = "image";
    project.assets[0].uri = "C:/fixtures/still.png";
    // Control: the same still without proofStill is admitted by both image executors.
    expect(buildGpuEnginePreviewGraph(project, 2)).toBeDefined();
    expect(buildGpuRenderGraph(project, 2)).toBeDefined();
    project.tracks[0].clips[0].proofStill = structuredClone(proofStill);
    expect(project.tracks[0].clips[0].layout).toBeUndefined();
    expect(buildGpuEnginePreviewGraph(project, 2)).toBeUndefined();
    expect(buildGpuRenderGraph(project, 2)).toBeUndefined();
  });

  it("the resident video executors decline the whole project when any clip is a proof still, even off the playhead", () => {
    const project = createDemoProject();
    project.width = 960; project.height = 540;
    project.assets[0].width = 960; project.assets[0].height = 540; project.assets[0].uri = "C:/fixtures/not-decoded.mp4";
    project.captions = []; project.motionGraphics = [];
    expect(buildGpuEngineVideoPreviewGraph(project, 1)).toBeDefined();
    expect(buildGpuVideoPreviewSource(project, 1)).toBeDefined();
    project.assets.push({ id: "shot", name: "Shot", kind: "image", uri: "C:/fixtures/shot.png", duration: 5, width: 960, height: 540 });
    project.tracks.push({ id: "proof-track", name: "Proof", kind: "video", locked: false, muted: false, clips: [{ id: "proof", assetId: "shot", trackId: "proof-track",
      timelineStart: 100, sourceStart: 0, duration: 2, volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
      layout: { crop: { x: 0, y: 0, width: 1, height: 1 }, viewport: { x: 0, y: 0, width: 1, height: 1 } }, proofStill: structuredClone(proofStill) }] });
    expect(buildGpuEngineVideoPreviewGraph(project, 1)).toBeUndefined();
    expect(buildGpuVideoPreviewSource(project, 1)).toBeUndefined();
  });
});
