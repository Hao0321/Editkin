import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createEmptyProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type MotionGraphic } from "../domain/types";
import { REFERENCE_MOTION_EDITORIAL_CONTRACT, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { motionGraphicV2FrameReceipt, motionGraphicV2LayoutReceipt, type MotionGraphicV2LayoutReceipt } from "../motion/compositionV2";
import { motionSceneContourInk, type MotionSceneInk } from "../motion/sceneCamera2d";
import { motionVectorPaths } from "../motion/vectorGeometry";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareGlyphRun } from "../typography/preparedGlyphRun";
import { canonicalJson } from "../shared/canonicalJson";
import { verifyReferenceMotionPlan } from "../mcp/referenceMotionPlanVerification";
import type { ReferenceMotionPlan } from "./referenceMotionPlan";
import { decodeProjectBytes, encodeProjectBytes, parseProject } from "./projectCodec";
import { inspectReferenceMotionTemplateInstance, prepareReferenceMotionTemplateInstance,
  prepareReferenceMotionTemplateRevision } from "./referenceMotionTemplateInstances";

// Synthetic graph metadata (no file probe, rights or pixels); real bundled glyph bytes; outlines observed per frame.
const faces = new Map<string, Uint8Array>();
async function physicalText(faceId: string, text: string) {
  let bytes = faces.get(faceId);
  if (!bytes) {
    bytes = new Uint8Array(await readFile(join(resolve("public/fonts"), bundledFontFaceSpec(faceId).fontFile)));
    faces.set(faceId, bytes);
  }
  return prepareGlyphRun(faceId, text, bytes);
}
function ids() {
  let ordinal = 0;
  return (prefix: string, role?: string) => `${prefix}-${role?.replaceAll(":", "-")}-${ordinal++}`;
}
const BRAND = { palette: { surface: "#1a0f35", text: "#ffffff", accent: "#ffd23f", muted: "#9696b4", separator: "#8a5cff" },
  typography: { headingFamily: "Noto Sans TC", bodyFamily: "Noto Sans TC" }, animationSpeed: 1 };
// Hao's verified travel face (Bold-only physical family) runs through the same observers as Noto.
const TRAVEL_BRAND = { ...BRAND, typography: { headingFamily: "LXGW WenKai TC", bodyFamily: "LXGW WenKai TC" } };
type Family = "level_bridge" | "context_stack" | "brand_recap";
type Brand = "default" | "travel";
const COPY: Record<Family, Partial<ReferenceMotionTemplateInput>> = {
  level_bridge: { kicker: "苗栗泰安｜大興村", title: "烏嘎彥竹林", subtitle: "兩邊竹梢往中間彎，太陽從竹縫透進來" },
  context_stack: { title: "大溪老街 蔡記", items: [{ label: "現場手工做", detail: "鋪粉、壓條全程看得到" }, { label: "麥芽花生 一盒150" },
    { label: "全台僅此一家", detail: "申明板寫別無分店" }] },
  brand_recap: { kicker: "苗栗三義｜龍騰村", title: "龍騰斷橋", items: [{ label: "1907", detail: "紅磚拱橋完工" }, { label: "1935", detail: "關刀山大地震震斷" },
    { label: "1999", detail: "九二一又斷一次" }, { label: "2003", detail: "列為縣定古蹟" }], focusRegion: { x: .1, y: .62, width: .8, height: .3 } },
};
const REGION = { x: .085, y: .1, width: .83, height: .46 };
function fixture(family: Family, frames = 420, brand: Brand = "default") {
  const project = createEmptyProject("Synthetic on-footage editorial control", { id: `editorial-${family}`, width: 1080, height: 1920, fps: 30 });
  project.assets = [{ id: "primary-media", name: "Synthetic source metadata", kind: "video", uri: "D:/synthetic/editorial.mov", duration: 30,
    width: 1080, height: 1920, color: { interpretation: "rec709" }, provenance: "Synthetic graph only; not a file, rights or footage-content verification" }];
  project.tracks[0].clips = [{ id: "primary", trackId: project.tracks[0].id, assetId: "primary-media", timelineStart: 0, sourceStart: 1,
    duration: frames / 30, volume: .7, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }];
  const input = { templateId: family, clipId: "primary", startFrame: 0, durationFrames: frames, sources: [], graphicCadence: "kinetic",
    overlayPresentation: "source_editorial_v1", textRegion: REGION, intent: "shortform", style: brand === "travel" ? TRAVEL_BRAND : BRAND,
    evidenceRefs: ["synthetic:editorial"], purpose: "Synthetic on-footage editorial control; no rendered art or ownership assertion",
    ...COPY[family] } as ReferenceMotionTemplateInput;
  return { project: parseProject(project), input };
}
type Packet = Awaited<ReturnType<typeof prepareReferenceMotionTemplateInstance>>;
const cache = new Map<string, Promise<ReturnType<typeof fixture> & { packet: Packet; current: EditProject }>>();
function saved(family: Family, brand: Brand = "default") {
  const key = `${family}:${brand}`;
  if (!cache.has(key)) cache.set(key, (async () => {
    const f = fixture(family, 420, brand);
    const packet = await prepareReferenceMotionTemplateInstance(f.project, f.input, ids(), { prepareText: physicalText });
    return { ...f, packet, current: applyCommand(f.project, { type: "batch", commands: packet.commands }) };
  })());
  return cache.get(key)!;
}
const sourceState = (project: EditProject) => canonicalJson({ assets: project.assets, tracks: project.tracks, captions: project.captions,
  colorManagement: project.colorManagement, width: project.width, height: project.height, fps: project.fps });
function layoutFor(project: EditProject, graphic: MotionGraphic, layouts: readonly MotionGraphicV2LayoutReceipt[]) {
  if (graphic.vectorV2) return motionGraphicV2LayoutReceipt(project, graphic);
  const layout = layouts.find(row => row.graphicId === graphic.id);
  if (!layout?.physicalFont) throw new Error("Observer requires actual physical text outlines");
  return layout;
}
const transformed = (ink: MotionSceneInk, x: number, y: number, scale: number): MotionSceneInk =>
  ({ xMin: x + ink.xMin * scale, yMin: y + ink.yMin * scale, xMax: x + ink.xMax * scale, yMax: y + ink.yMax * scale });
function inks(project: EditProject, graphic: MotionGraphic, layout: MotionGraphicV2LayoutReceipt, frame: number): MotionSceneInk[] {
  const receipt = motionGraphicV2FrameReceipt(project, graphic, frame, layout);
  if (!receipt.visible) return [];
  if (graphic.vectorV2) {
    const state = receipt.vectorState;
    if (!state || state.opacity <= .001) return [];
    return motionVectorPaths(graphic, layout, receipt).flatMap(path => {
      const ink = motionSceneContourInk(path.svg);
      return ink ? [transformed(ink, layout.box.x + state.translateXPixels, layout.box.y + state.translateYPixels, state.scale)] : [];
    });
  }
  return receipt.segments.flatMap(state => {
    if (state.opacity <= .001) return [];
    const segment = layout.segments.find(value => value.id === state.segmentId)!;
    return segment.outline?.ink ? [transformed(segment.outline.ink, segment.x + state.translateXPixels, segment.y + state.translateYPixels, state.scale)] : [];
  });
}
function settledInk(layout: MotionGraphicV2LayoutReceipt) {
  const bounds = layout.segments.filter(segment => segment.outline?.ink).map(segment => transformed(segment.outline!.ink!, segment.x, segment.y, 1));
  return { xMin: Math.min(...bounds.map(b => b.xMin)), xMax: Math.max(...bounds.map(b => b.xMax)), yMin: Math.min(...bounds.map(b => b.yMin)), yMax: Math.max(...bounds.map(b => b.yMax)) };
}

describe("on-footage editorial presentation (source_editorial_v1)", () => {
  it.each([["level_bridge", "default"], ["context_stack", "default"], ["brand_recap", "default"], ["level_bridge", "travel"], ["context_stack", "travel"],
    ["brand_recap", "travel"]] as const)("keeps the live source full-bleed, adds no backing and ends on a clean tail (%s, %s brand)", async (family, brand) => {
    const f = await saved(family, brand);
    expect(sourceState(f.current)).toBe(sourceState(f.project));
    expect(f.packet.commands.every(command => command.type === "add_motion_graphic" || command.type === "upsert_reference_motion_instance")).toBe(true);
    expect(f.current.motionGraphics.some(graphic => graphic.vectorV2?.kind === "panel" || graphic.vectorV2?.kind === "line_grid")).toBe(false);
    expect(f.packet.instance.dependencies.recipeVersion).toMatch(/^editkin\.reference-motion-recipes\/source-editorial-v1:/);
    for (const graphic of f.current.motionGraphics.filter(item => !item.vectorV2)) {
      expect(graphic.shadowBlurPixels).toBeGreaterThan(0); expect(graphic.accentColor).toMatch(/^#000000[0-9a-f]{2}$/i);
      expect(parseInt(graphic.textColor.slice(1, 3), 16)).toBeGreaterThanOrEqual(0xf0);
    }
    let tail = 0;
    for (let frame = 0; frame < f.input.durationFrames; frame++) {
      const visible = f.current.motionGraphics.some(graphic => inks(f.current, graphic, layoutFor(f.current, graphic, f.packet.layouts), frame).length > 0);
      tail = visible ? 0 : tail + 1;
      for (const graphic of f.current.motionGraphics) for (const ink of inks(f.current, graphic, layoutFor(f.current, graphic, f.packet.layouts), frame)) {
        expect(ink.xMin).toBeGreaterThanOrEqual(-.03); expect(ink.xMax).toBeLessThanOrEqual(f.current.width + .03);
        expect(ink.yMin).toBeGreaterThanOrEqual(-.03); expect(ink.yMax).toBeLessThanOrEqual(f.current.height + .03);
      }
    }
    expect(tail).toBeGreaterThanOrEqual(Math.round(REFERENCE_MOTION_EDITORIAL_CONTRACT.cleanTailSeconds * 30));
    const reopened = decodeProjectBytes(encodeProjectBytes(f.current));
    expect(reopened.motionGraphics).toEqual(f.current.motionGraphics);
    expect((await inspectReferenceMotionTemplateInstance(reopened, f.packet.instance.id)).status).toBe("CURRENT");
  });

  it("sets every settled text line in one left ink column inside the observed region", async () => {
    for (const [family, brand] of [["level_bridge", "default"], ["context_stack", "default"], ["brand_recap", "default"], ["level_bridge", "travel"],
      ["context_stack", "travel"], ["brand_recap", "travel"]] as const) {
      const f = await saved(family, brand), column = REGION.x * f.current.width;
      const texts = f.current.motionGraphics.filter(graphic => !graphic.vectorV2);
      const lefts = texts.map(graphic => settledInk(layoutFor(f.current, graphic, f.packet.layouts)));
      for (const ink of lefts) {
        expect(ink.yMin).toBeGreaterThanOrEqual(REGION.y * f.current.height - 1);
        expect(ink.yMax).toBeLessThanOrEqual((REGION.y + REGION.height) * f.current.height + 1);
        expect(ink.xMin).toBeGreaterThanOrEqual(column - 20);
      }
      expect(Math.min(...lefts.map(ink => ink.xMin))).toBeLessThan(column + 20);
    }
  });

  it("grows one accent thread with a node per step instead of numbered rows", async () => {
    const f = await saved("context_stack");
    const keys = f.packet.instance.roles.map(role => role.key);
    expect(keys).toContain("thread"); expect(keys.filter(key => key.endsWith(":node"))).toHaveLength(3);
    expect(keys.some(key => key.endsWith(":index") || key.endsWith(":panel"))).toBe(false);
    const thread = f.current.motionGraphics.find(graphic => graphic.vectorV2?.kind === "shape")!;
    expect(thread.vectorV2).toMatchObject({ revealFrom: "top" });
    expect(thread.backgroundColor.toLowerCase()).toBe(BRAND.palette.accent);
  });

  it("never covers the observed recap subject and takes the points in turn", async () => {
    const f = await saved("brand_recap");
    const labels = [0, 1, 2, 3].map(index => f.current.motionGraphics.find(graphic => graphic.id === f.packet.instance.roles.find(role => role.key === `item:${index}:label`)!.id)!);
    for (let i = 1; i < labels.length; i++) expect(labels[i].timelineStart).toBeGreaterThanOrEqual(labels[i - 1].timelineStart + labels[i - 1].duration - 1e-9);
    const avoid = COPY.brand_recap.focusRegion!;
    for (const graphic of f.current.motionGraphics.filter(item => !item.vectorV2)) {
      const ink = settledInk(layoutFor(f.current, graphic, f.packet.layouts));
      expect(ink.yMax <= avoid.y * f.current.height || ink.yMin >= (avoid.y + avoid.height) * f.current.height).toBe(true);
    }
    const covering = fixture("brand_recap");
    await expect(prepareReferenceMotionTemplateInstance(covering.project, { ...covering.input, focusRegion: { x: .05, y: .1, width: .9, height: .4 } }, ids(),
      { prepareText: physicalText })).rejects.toThrow(/主體範圍/);
  });

  it("allows trusted v4 recompile and rejects a moved line", async () => {
    const f = await saved("level_bridge"), declaration: ReferenceMotionPlan = { schema: "editkin.reference-motion-plan/v1", instances: [{
      mode: "create", instanceId: f.packet.instance.id, commandIndexes: f.packet.commands.map((_, index) => index) }] };
    const environment = { ...process.env, EDITKIN_FONT_ROOT: resolve("public/fonts") };
    expect((await verifyReferenceMotionPlan(declaration, f.project, f.packet.commands, environment)).instanceCount).toBe(1);
    const commands = structuredClone(f.packet.commands);
    const moved = commands.find(command => command.type === "add_motion_graphic" && !command.graphic.vectorV2);
    if (!moved || moved.type !== "add_motion_graphic") throw new Error("Tamper control needs a compiled line");
    moved.graphic.y += .2;
    await expect(verifyReferenceMotionPlan(declaration, f.project, commands, environment)).rejects.toThrow(/independently recompiled/);
  });

  it("upgrades a saved original scene to the editorial presentation by revision and can return", async () => {
    const f = fixture("level_bridge"); delete (f.input as Partial<ReferenceMotionTemplateInput>).overlayPresentation; delete f.input.textRegion;
    const original = await prepareReferenceMotionTemplateInstance(f.project, f.input, ids(), { prepareText: physicalText });
    const current = applyCommand(f.project, { type: "batch", commands: original.commands });
    expect(current.motionGraphics.some(graphic => graphic.vectorV2?.kind === "panel")).toBe(true);
    const revised = await prepareReferenceMotionTemplateRevision(current, original.instance.id, { overlayPresentation: "source_editorial_v1", textRegion: REGION },
      { expectedInstanceRevision: 1, prepareText: physicalText, idFactory: ids() });
    const next = applyCommand(current, { type: "batch", commands: revised.commands });
    expect(next.motionGraphics.some(graphic => graphic.vectorV2?.kind === "panel")).toBe(false);
    expect((await inspectReferenceMotionTemplateInstance(decodeProjectBytes(encodeProjectBytes(next)), original.instance.id)).status).toBe("CURRENT");
    const back = await prepareReferenceMotionTemplateRevision(next, original.instance.id, { overlayPresentation: null },
      { expectedInstanceRevision: 2, prepareText: physicalText, idFactory: ids() });
    expect(back.instance.input.overlayPresentation).toBeUndefined(); expect(back.instance.input.textRegion).toBeUndefined();
  });

  it("rejects the presentation on unsupported families, with native paint, or when copy leaves the region", async () => {
    const f = fixture("level_bridge"), observed = vi.fn(physicalText);
    await expect(prepareReferenceMotionTemplateInstance(f.project, { ...f.input, templateId: "focus_wall" }, ids(), { prepareText: observed })).rejects.toThrow(/source_editorial|實拍留白/);
    await expect(prepareReferenceMotionTemplateInstance(f.project, { ...f.input, graphicPresentation: "native_paint_v1" }, ids(), { prepareText: observed })).rejects.toThrow(/實拍留白|native/);
    await expect(prepareReferenceMotionTemplateInstance(f.project, { ...f.input, textRegion: { ...REGION, height: .1 } }, ids(), { prepareText: physicalText })).rejects.toThrow(/留白範圍/);
  });
});
