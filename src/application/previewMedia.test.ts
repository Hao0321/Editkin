import { describe, expect, it } from "vitest";
import { applyCommand } from "../domain/commands";
import { createDemoProject } from "../domain/demo";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { activeMediaLayers } from "./previewMedia";

describe("preview media selection", () => {
  it("selects an independent audio layer and respects track mute", () => {
    let project = applyCommand(createDemoProject(), {
      type: "import_asset",
      asset: { id: "audio", name: "voice.wav", kind: "audio", uri: "file:///voice.wav", duration: 6 },
    });
    project = applyCommand(project, {
      type: "add_clip",
      clip: { id: "voice", assetId: "audio", trackId: "audio-main", timelineStart: 1, sourceStart: 0, duration: 4, volume: 0.8, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] },
    });
    expect(activeMediaLayers(project, 2, { audio: "editkin-media://voice.wav" }, "audio"))
      .toMatchObject([{ clip: { id: "voice", volume: 0.8 }, source: "editkin-media://voice.wav" }]);
    project = applyCommand(project, { type: "toggle_track_mute", trackId: "audio-main" });
    expect(activeMediaLayers(project, 2, {}, "audio")).toEqual([]);
  });

  it("recursively resolves an in-project precomposition to its live source layer", () => {
    const project = applyCommand(createDemoProject(), {
      type: "precompose_clips", compositionId: "comp-demo", assetId: "asset-comp-demo", replacementClipId: "clip-comp-demo",
      targetTrackId: "video-main", name: "Demo precomp", clipIds: ["clip-demo"],
    });
    const layers = activeMediaLayers(project, 0.5, { "asset-demo": "editkin-media://demo.mp4" }, "video");
    expect(layers).toHaveLength(1);
    expect(layers[0]).toMatchObject({
      asset: { id: "asset-demo" }, source: "editkin-media://demo.mp4", displayClip: { id: "clip-demo" },
      compositionAncestors: [{ clip: { id: "clip-comp-demo" } }],
    });
    expect(layers[0].clip.id).toContain("comp-demo/clip-demo");
    expect(layers[0].clip.sourceStart).toBeCloseTo(0.5);
  });

  it("does not decode or display a Null controller as media", () => {
    const project = createDemoProject();
    project.tracks[0].clips[0].layer = { enabled: true, blendMode: "normal", role: "controller" };
    expect(activeMediaLayers(project, 1, { "asset-demo": "editkin-media://demo.mp4" }, "video")).toEqual([]);
  });
});
