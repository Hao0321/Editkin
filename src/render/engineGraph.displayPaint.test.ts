import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { createMotionGraphic } from "../motion/composition";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { prepareNativeMotionPaint } from "../motion/nativeMotionPaint";
import { prepareNativeMotionPaintReceiptExpectations } from "../motion/nativeMotionPaintReceipt";
import { prepareGlyphRun } from "../typography/preparedGlyphRun";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { buildEngineRenderGraph } from "./engineGraph";

async function fixture(display = true, reversed = false) {
  const project = createDemoProject();
  project.captions = [];
  project.colorManagement = { ...project.colorManagement!, mode: "aces2", outputTransform: "rec709_sdr" };
  const scene = createMotionGraphic("scene-paint", "title", "SCENE", .5, 3, undefined,
    findMotionGraphicPreset("v2-word-cascade").seed);
  Object.assign(scene, { fontFamily: "Bebas Neue", fontWeight: 400, fontSize: 48,
    backgroundColor: "#00000000", shadowDepth: 0, outlineWidth: 0, visualStyle: "native_paint" });
  scene.layoutV2 = { ...scene.layoutV2!, minFontSize: 48, maxLines: 4 };
  scene.paintV1 = { schema: "editkin.motion-paint/v1", fill: { kind: "solid", color: "#175CD3" }, clips: [] };
  const top = structuredClone(scene);
  top.id = "display-paint"; top.text = "DISPLAY";
  top.paintV1 = { schema: "editkin.motion-paint/v2", colorIntent: "display_rec709_sdr",
    fill: { kind: "solid", color: "#FFFFFFF2" }, clips: [] };
  project.motionGraphics = display ? reversed ? [top, scene] : [scene, top] : [scene];
  const faceId = "EditkinFace-bebas-neue-400";
  const bytes = new Uint8Array(await readFile(resolve("public/fonts", bundledFontFaceSpec(faceId).fontFile)));
  const runs = new Map(await Promise.all(project.motionGraphics.map(async graphic =>
    [graphic.id, await prepareGlyphRun(faceId, graphic.text, bytes)] as const)));
  return { project, handle: prepareNativeMotionPaint(project, runs) };
}

describe("actual producer display paint boundary", () => {
  it("connects true prepared scene paint before ACES and display paint after it, accepted independently", async () => {
    const { project, handle } = await fixture();
    const graph = buildEngineRenderGraph(project, { nativeMotionPaint: handle });
    const display = graph.nodes.find(node => node.id === "display:aces2")!;
    expect(graph.nodes.find(node => node.id === display.inputs[0])?.inputs[1]).toBe("motion-graphic:scene-paint");
    const output = graph.nodes.find(node => node.id === graph.outputNode)!;
    expect(graph.nodes.find(node => node.id === output.inputs[0])?.inputs).toEqual([display.id, "motion-graphic:display-paint"]);
    expect((await prepareNativeMotionPaintReceiptExpectations(graph)).graphicIds).toEqual(["scene-paint", "display-paint"]);
  });

  it("refuses an authored scene graphic after display rather than silently changing stacking", async () => {
    const { project, handle } = await fixture(true, true), before = JSON.stringify(project);
    expect(() => buildEngineRenderGraph(project, { nativeMotionPaint: handle })).toThrow(/cannot follow/);
    expect(JSON.stringify(project)).toBe(before);
  });

  it("retains the old scene-only output boundary and wire without display intent", async () => {
    const { project, handle } = await fixture(false);
    const graph = buildEngineRenderGraph(project, { nativeMotionPaint: handle });
    expect(graph.nodes.find(node => node.id === graph.outputNode)?.inputs).toEqual(["display:aces2"]);
    expect(graph.nodes.find(node => node.kind === "native_motion_paint")?.track).not.toHaveProperty("colorIntent");
    expect((await prepareNativeMotionPaintReceiptExpectations(graph)).graphicIds).toEqual(["scene-paint"]);
  });
});
