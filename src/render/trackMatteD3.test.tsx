import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { activeMediaLayers } from "../application/previewMedia";
import { createDemoProject } from "../domain/demo";
import { applyCommand } from "../domain/commands";
import { validateProject } from "../domain/editGraph";
import { matteOnlySourceIdsV1 } from "../domain/trackMatteSourcesV1";
import type { EditProject, TimelineClip, TrackMatteMode } from "../domain/types";
import { Preview } from "../ui/Preview";
import { buildEngineRenderGraph } from "./engineGraph";
import { buildGpuEngineVideoPreviewGraph } from "./gpuCompositor";
import { buildRenderPlan } from "./planner";

/**
 * Track matte parity (P3, design D3): a clip used as a track matte source draws nothing itself (unless it sets
 * `layer.showMatteSource`), on a visible or a hidden track, in the export plan, the native engine graph and admission,
 * and the compatible preview; the target's matte still applies in every route.
 */
function matteProject(options: { hidden?: boolean; show?: boolean; mode?: TrackMatteMode; backdrop?: boolean } = {}): EditProject {
  const project = createDemoProject();
  project.width = 960; project.height = 540;
  project.captions = []; project.motionGraphics = [];
  project.assets[0].width = 960; project.assets[0].height = 540; project.assets[0].uri = "C:/fixtures/base.mp4";
  const base = project.tracks[0].clips[0];
  project.assets.push({ ...structuredClone(project.assets[0]), id: "asset-matte", name: "matte", uri: "C:/fixtures/matte.mp4" },
    { ...structuredClone(project.assets[0]), id: "asset-target", name: "target", uri: "C:/fixtures/target.mp4" });
  const clip = (id: string, assetId: string, trackId: string, extra: Partial<TimelineClip> = {}): TimelineClip =>
    ({ ...structuredClone(base), id, assetId, trackId, ...extra });
  if (options.backdrop === false) project.tracks[0].clips = [];
  project.tracks.push(
    { id: "matte-track", name: "matte", kind: "video", locked: false, muted: true, ...(options.hidden ? { hidden: true } : {}),
      clips: [clip("matte", "asset-matte", "matte-track", { volume: 0, ...(options.show ? { layer: { enabled: true, blendMode: "normal", showMatteSource: true } } : {}) })] },
    { id: "target-track", name: "target", kind: "video", locked: false, muted: true,
      clips: [clip("target", "asset-target", "target-track", { volume: 0, layer: { enabled: true, blendMode: "normal", role: "content", trackMatte: { sourceClipId: "matte", mode: options.mode ?? "luma" } } })] },
  );
  return validateProject(project);
}

describe("track matte sources draw nothing (D3)", () => {
  it("names every matte source unless it opts back in", () => {
    expect([...matteOnlySourceIdsV1(matteProject())]).toEqual(["matte"]);
    expect([...matteOnlySourceIdsV1(matteProject({ show: true }))]).toEqual([]);
    const disabled = matteProject();
    disabled.tracks.find(track => track.id === "target-track")!.clips[0].layer!.enabled = false;
    expect(matteOnlySourceIdsV1(disabled).size).toBe(0);
    expect(matteOnlySourceIdsV1(createDemoProject()).size).toBe(0);
  });

  it("set_clip_layer stores and validates showMatteSource", () => {
    const project = applyCommand(matteProject(), { type: "set_clip_layer", clipId: "matte", patch: { showMatteSource: true } });
    expect(project.tracks.find(track => track.id === "matte-track")!.clips[0].layer?.showMatteSource).toBe(true);
    expect(matteOnlySourceIdsV1(project).size).toBe(0);
  });

  it("the export plan leaves the source out of the drawn layers, visible or hidden, and keeps it with showMatteSource", () => {
    const drawn = (project: EditProject) => buildRenderPlan(project, uri => uri).videoLayers.flatMap(layer => layer.segments)
      .flatMap(segment => segment.kind === "clip" ? [segment.clip.id] : []);
    expect(drawn(matteProject())).toEqual(["clip-demo", "target"]);
    expect(drawn(matteProject({ hidden: true }))).toEqual(["clip-demo", "target"]);
    expect(drawn(matteProject({ show: true }))).toEqual(["clip-demo", "matte", "target"]);
  });

  it("the native engine graph reads a visible or hidden source as the matte input and never composites it", () => {
    for (const hidden of [false, true]) {
      const graph = buildEngineRenderGraph(matteProject({ hidden }));
      const composites = graph.nodes.filter(node => node.kind === "composite");
      expect(composites.some(node => node.matteMode === "luma" && typeof node.matteInput === "string")).toBe(true);
      expect(composites.flatMap(node => node.inputs).some(input => input.includes("matte") && !input.startsWith("composite"))).toBe(false);
      expect(graph.nodes.some(node => node.id === "source:matte")).toBe(true);
    }
    // Matted first layer: seeded with transparency instead of losing its matte.
    const seeded = buildEngineRenderGraph(matteProject({ backdrop: false }));
    expect(seeded.nodes.some(node => node.id === "source:transparent")).toBe(true);
    expect(seeded.nodes.find(node => node.kind === "composite")).toMatchObject({ inputs: ["source:transparent", expect.any(String)], matteMode: "luma" });
  });

  it("native video admission accepts a hidden source over a drawn backdrop and declines a matted first layer", () => {
    for (const hidden of [false, true]) {
      const preview = buildGpuEngineVideoPreviewGraph(matteProject({ hidden }), 1);
      expect(preview).toBeDefined();
      expect(preview!.assetBindings["asset-matte"]).toBe("C:/fixtures/matte.mp4");
      expect(preview!.graph.nodes.find(node => node.kind === "composite" && node.matteMode)).toMatchObject({ matteMode: "luma" });
    }
    expect(buildGpuEngineVideoPreviewGraph(matteProject({ backdrop: false }), 1)).toBeUndefined();
  });

  it("the compatible preview keeps the source (also from a hidden track) for the mask and does not draw it", () => {
    const project = matteProject({ hidden: true });
    project.assets = project.assets.map(asset => (asset.id === "asset-matte" ? { ...asset, kind: "image" as const, uri: "file:///C:/fixtures/matte.png" } : asset));
    const layers = activeMediaLayers(project, 1, {}, "video");
    expect(layers.map(layer => [layer.clip.id, layer.matteOnly ?? false])).toEqual([["clip-demo", false], ["matte", true], ["target", false]]);
    const html = renderToStaticMarkup(<Preview layers={layers} audioLayers={[]} projectWidth={project.width} projectHeight={project.height} playhead={1}
      projectDuration={3} projectFps={project.fps} captions={[]} captionStyle={project.captionStyle} project={project} playing={false}
      onPlayingChange={() => undefined} onPlayheadChange={() => undefined} />);
    expect(html).not.toContain('alt="matte"');
    expect(html).toContain("mask-image:url(&quot;file:///C:/fixtures/matte.png&quot;)");
    expect(html).not.toContain("Track Matte 來源目前不在預覽畫面中");
    // Without track mattes the layer list is unchanged.
    expect(activeMediaLayers(createDemoProject(), 1, {}, "video").every(layer => layer.matteOnly === undefined)).toBe(true);
  });
});
