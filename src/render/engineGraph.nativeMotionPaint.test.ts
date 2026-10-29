import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { createMotionGraphic, legacyMotionGraphicSeed } from "../motion/composition";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareGlyphRun } from "../typography/preparedGlyphRun";
import { nativeMotionPaintTrack, prepareNativeMotionPaint } from "../motion/nativeMotionPaint";
import { buildEngineRenderGraph } from "./engineGraph";

const faceId = "EditkinFace-bebas-neue-400";
const bytes = readFile(resolve("public/fonts", bundledFontFaceSpec(faceId).fontFile));
async function fixture() {
  const project = createDemoProject();
  const graphic = createMotionGraphic("typed-paint", "title", "AV\nO", .5, 3, undefined, findMotionGraphicPreset("v2-word-cascade").seed);
  Object.assign(graphic, { fontFamily: "Bebas Neue", fontWeight: 400, fontSize: 48, backgroundColor: "#00000000", shadowDepth: 0,
    outlineWidth: 0, visualStyle: "native_paint" });
  graphic.layoutV2 = { ...graphic.layoutV2!, minFontSize: 48, maxLines: 4 };
  graphic.paintV1 = { schema: "editkin.motion-paint/v1", fill: { kind: "solid", color: "#175CD380" }, clips: [] };
  project.motionGraphics = [graphic]; project.captions = [];
  const run = await prepareGlyphRun(faceId, graphic.text, new Uint8Array(await bytes));
  return { project, graphic, handle: prepareNativeMotionPaint(project, new Map([[graphic.id, run]])) };
}

describe("actual native motion paint in the shared typed engine graph", () => {
  it("emits the exact private prepared track with unchanged node identity, graph clock and source nodes", async () => {
    const { project, graphic, handle } = await fixture(), before = JSON.stringify(project);
    const graph = buildEngineRenderGraph(project, { nativeMotionPaint: handle, rec709PrimaryVersion: 2 });
    const node = graph.nodes.find(node => node.graphicId === graphic.id)!;
    expect(node).toEqual({ id: "motion-graphic:typed-paint", kind: "native_motion_paint", inputs: [], enabled: true,
      graphicId: graphic.id, track: nativeMotionPaintTrack(project, handle, graphic.id) });
    expect(node.track).toBe(nativeMotionPaintTrack(project, handle, graphic.id));
    expect(graph.timebase).toEqual({ numerator: 1, denominator: 30 });
    expect(graph.nodes).toContainEqual(expect.objectContaining({ id: "source:clip-demo", kind: "source", assetId: project.assets[0].id }));
    expect(graph.nodes.find(node => node.id === "color:clip-demo")?.processor).toBe("editkin-rec709-primary/v2");
    expect(graph.audio?.masterNode).toBe("audio:output");
    expect(JSON.stringify(project)).toBe(before);
  });

  it("preserves mixed legacy/paint array order and every typed composite edge after captions", async () => {
    const { project, graphic, handle } = await fixture();
    const first = createMotionGraphic("legacy-first", "title", "FIRST", 0, 3, undefined, legacyMotionGraphicSeed("title"));
    const last = createMotionGraphic("legacy-last", "tag", "LAST", 0, 3, undefined, legacyMotionGraphicSeed("tag"));
    project.motionGraphics = [first, graphic, last];
    project.captions = [{ id: "cue", text: "Caption remains typed", start: 0, duration: 3 }];
    const graph = buildEngineRenderGraph(project, { nativeMotionPaint: handle });
    const overlays = graph.nodes.filter(node => ["caption", "motion_graphic", "native_motion_paint"].includes(node.kind));
    expect(overlays.map(node => [node.id, node.kind])).toEqual([
      ["caption:cue", "caption"], ["motion-graphic:legacy-first", "motion_graphic"],
      ["motion-graphic:typed-paint", "native_motion_paint"], ["motion-graphic:legacy-last", "motion_graphic"],
    ]);
    let tail = "color:clip-demo";
    for (const overlay of overlays) {
      const composite = graph.nodes.find(node => node.kind === "composite" && node.inputs[1] === overlay.id)!;
      expect(composite).toMatchObject({ inputs: [tail, overlay.id], blendMode: "normal", opacity: 1 });
      tail = composite.id;
    }
    expect(graph.nodes.find(node => node.id === graph.outputNode)?.inputs).toEqual([tail]);
    expect(new Set(graph.nodes.map(node => node.id)).size).toBe(graph.nodes.length);
  });

  it("refuses missing, copied or stale preparation and keeps unpainted v2 fail-visible", async () => {
    const { project, graphic, handle } = await fixture();
    expect(() => buildEngineRenderGraph(project)).toThrow(/requires actual physical preparation/);
    expect(() => buildEngineRenderGraph(project, { nativeMotionPaint: structuredClone(handle) })).toThrow(/factory-owned/);
    const changed = structuredClone(project); changed.motionGraphics[0].text += "W";
    expect(() => buildEngineRenderGraph(changed, { nativeMotionPaint: handle })).toThrow(/stale/);
    const unpainted = structuredClone(project);
    delete unpainted.motionGraphics[0].paintV1; unpainted.motionGraphics[0].visualStyle = "solid_panel";
    expect(() => buildEngineRenderGraph(unpainted, { nativeMotionPaint: handle })).toThrow(/禁止降級成 v1/);
    graphic.paintV1 = undefined;
    expect(() => buildEngineRenderGraph(project, { nativeMotionPaint: handle })).toThrow(/stale/);
  });
});
