import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import { createHistory, dispatchCommand, undo, redo } from "../domain/history";
import { editorCommandSchema, projectSchema } from "../domain/schema";
import { motionPaintV1Schema, type MotionPaintV1 } from "../domain/motionPaint";
import { createMotionGraphic } from "./composition";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { prepareGlyphRun } from "../typography/preparedGlyphRun";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { motionGraphicV2PhysicalLayoutReceipt, prepareMotionGraphicV2FrameLayout, motionGraphicV2FrameReceipt } from "./compositionV2";
import { prepareNativeMotionPaint, nativeMotionPaintFrame, nativeMotionPaintTrack } from "./nativeMotionPaint";
import { prepareMotionNativePaintForRender } from "../render/motionPhysicalGlyphLayouts";
import { motionGraphicV2LayoutReceipt } from "./compositionV2";
import { assertScopedPaletteRevisionEffects } from "../application/scopedPaletteRevision";

const paint: MotionPaintV1 = { schema: "editkin.motion-paint/v1", fill: { kind: "linear", start: { x: 0, y: 0 }, end: { x: 1, y: 0 },
  stops: [{ at: 0, color: "#175CD3" }, { at: 1, color: "#A9E9F7" }] }, clips: [] };
const faceId = "EditkinFace-bebas-neue-400";
function fixture(text = "KEEP\nMOTION") {
  const project = createEmptyProject("Paint", { width: 640, height: 360, fps: 30 });
  const graphic = createMotionGraphic("paint-title", "title", text, .5, 3, undefined, findMotionGraphicPreset("v2-word-cascade").seed);
  Object.assign(graphic, { fontFamily: "Bebas Neue", fontWeight: 400, fontSize: 48, backgroundColor: "#00000000", shadowDepth: 0, outlineWidth: 0 });
  graphic.layoutV2 = { ...graphic.layoutV2!, minFontSize: 48, maxLines: 4 };
  project.motionGraphics = [graphic]; return { project, graphic };
}
async function physical(text: string) { return prepareGlyphRun(faceId, text, new Uint8Array(await readFile(resolve("public/fonts", bundledFontFaceSpec(faceId).fontFile)))); }
const enable = { type: "update_motion_graphic" as const, graphicId: "paint-title", patch: { visualStyle: "native_paint" as const, paintV1: paint } };

describe("saved native paint authoring and current physical frame consumer", () => {
  it("keeps editable versioned paint through atomic command, Undo/redo and normal schema reopen", () => {
    const { project } = fixture(); const before = JSON.stringify(project);
    const history = dispatchCommand(createHistory(project), editorCommandSchema.parse(enable));
    expect(history.past).toHaveLength(1); expect(history.present.motionGraphics[0].paintV1).toEqual(paint);
    expect(undo(history).present.motionGraphics[0].paintV1).toBeUndefined();
    const restored = redo(undo(history)); const reopened = projectSchema.parse(JSON.parse(JSON.stringify(restored.present)));
    expect(validateProject(reopened).motionGraphics[0]).toEqual(restored.present.motionGraphics[0]);
    expect(reopened.schemaVersion).toBe(project.schemaVersion); expect(JSON.stringify(project)).toBe(before);
  });
  it("rejects dropped discriminator, missing paint, old v1 and unsupported shadow without mutation", () => {
    const { project } = fixture(); const before = JSON.stringify(project);
    for (const patch of [{ paintV1: paint }, { visualStyle: "native_paint" as const },
      { ...enable.patch, schema: "hao.motion-composition/v1" as const }, { ...enable.patch, shadowDepth: 2 }]) {
      expect(() => applyCommand(project, { ...enable, patch })).toThrow();
    }
    expect(JSON.stringify(project)).toBe(before);
  });
  it("refuses unknown paint data, zero gradients, unsorted stops and open clips", () => {
    expect(() => motionPaintV1Schema.parse({ ...paint, css: "linear-gradient(blue,white)" })).toThrow();
    expect(() => motionPaintV1Schema.parse({ ...paint, fill: { ...paint.fill, end: { x: 0, y: 0 } } })).toThrow();
    expect(() => motionPaintV1Schema.parse({ ...paint, fill: { ...paint.fill, stops: [{ at: 0, color: "#000000" }, { at: 0, color: "#ffffff" }] } })).toThrow();
    expect(() => motionPaintV1Schema.parse({ ...paint, clips: [{ fillRule: "non_zero", commands: [
      { type: "M", x: 0, y: 0 }, { type: "L", x: 1, y: 0 }, { type: "L", x: 1, y: 1 }, { type: "L", x: 0, y: 1 }] }] })).toThrow();
  });
  it("preserves saved template owner and refuses ineffective legacy palette credits", () => {
    const { project, graphic } = fixture();
    graphic.templateOwner = { schema: "editkin.template-element-owner/v1", sessionId: "saved", templateId: "current", format: "short", role: "title" };
    expect(() => applyCommand(project, enable)).toThrow(/owner-managed/);
    const assignedOwner = graphic.templateOwner;
    delete graphic.templateOwner;
    expect(() => applyCommand(project, { ...enable, patch: { ...enable.patch, templateOwner: assignedOwner } })).toThrow(/owner-managed/);
    const painted = applyCommand(project, enable);
    expect(() => assertScopedPaletteRevisionEffects(painted, [{ type: "update_motion_graphic", graphicId: graphic.id, patch: { textColor: "#FF0000" } }])).toThrow(/active paint/);
  });
  it("compiles true multiline factory geometry and the same seek/stagger frame transforms", async () => {
    const { project } = fixture(); const painted = applyCommand(project, enable), graphic = painted.motionGraphics[0], run = await physical(graphic.text);
    const handle = prepareNativeMotionPaint(painted, new Map([[graphic.id, run]]));
    const layout = prepareMotionGraphicV2FrameLayout(painted, graphic, motionGraphicV2PhysicalLayoutReceipt(painted, graphic, run));
    expect(layout.lineCount).toBe(2);
    for (const frameNumber of [15, 31, 62, 31]) {
      const native = nativeMotionPaintFrame(painted, handle, frameNumber), frame = motionGraphicV2FrameReceipt(painted, graphic, frameNumber, layout);
      expect(native.scene.layers).toHaveLength(layout.segments.length);
      layout.segments.forEach((segment, i) => {
        const state = frame.segments.find(state => state.segmentId === segment.id)!;
        expect(native.scene.layers[i].path.commands).toEqual(segment.outline!.commands);
        expect(native.poses[i]).toEqual({ x: segment.x + state.translateXPixels, y: segment.y + state.translateYPixels, scale: state.scale, opacity: state.opacity });
      });
      expect(native.bakedIds).toEqual([graphic.id]);
    }
    expect(nativeMotionPaintFrame(painted, handle, 0).scene.layers).toHaveLength(0);
    expect(() => nativeMotionPaintFrame(painted, structuredClone(handle), 31)).toThrow(/factory-owned/);
    expect(() => prepareNativeMotionPaint(painted, new Map([[graphic.id, structuredClone(run)]]))).toThrow();
    expect(() => nativeMotionPaintFrame(painted, handle, 31.5)).toThrow(/integer/);
    const modified = structuredClone(painted); modified.motionGraphics[0].paintV1!.fill = { kind: "solid", color: "#FFFFFF" };
    expect(() => nativeMotionPaintFrame(modified, handle, 31)).toThrow(/stale/);
  });
  it("rebinds normalized paint and clips to current layout and protects immutable prepared layers", async () => {
    const { project } = fixture("MOTION");
    const descriptor = structuredClone(paint); descriptor.clips = [{ fillRule: "non_zero", commands: [
      { type: "M", x: 0, y: 0 }, { type: "L", x: 1, y: 0 }, { type: "L", x: 1, y: 1 }, { type: "L", x: 0, y: 1 }, { type: "Z" }] }];
    const painted = applyCommand(project, { ...enable, patch: { ...enable.patch, paintV1: descriptor } });
    const g = painted.motionGraphics[0], run = await physical(g.text), handle = prepareNativeMotionPaint(painted, new Map([[g.id, run]]));
    const { scene } = nativeMotionPaintFrame(painted, handle, 62);
    expect(scene.layers[0].clips[0].commands.at(-1)).toEqual({ type: "Z" });
    expect(Object.isFrozen(scene.layers[0])).toBe(true); expect(Object.isFrozen(scene.layers[0].paint)).toBe(true);
    expect(() => { (scene.layers[0].paint as { kind: string }).kind = "radial"; }).toThrow();
  });

  it("renders typed rounded panels without a fake glyph or font request, retaining exact seek poses and current source", async () => {
    const { project, graphic } = fixture("");
    graphic.vectorV2 = { schema: "editkin.motion-vector/v1", kind: "panel", heightPixels: 100, revealFrames: 1 };
    graphic.motionV2!.sequence = { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0 };
    graphic.cornerRadius = 16;
    const descriptor: MotionPaintV1 = { ...paint,
      stroke: { color: "#D9E8FF80", widthPixels: 1 },
      shadow: { color: "#00000060", blurPixels: 8, offsetXPixels: 0, offsetYPixels: 6 } };
    const painted = applyCommand(project, { ...enable, patch: { ...enable.patch, paintV1: descriptor } });
    const handle = await prepareMotionNativePaintForRender(painted);
    const saved = projectSchema.parse(JSON.parse(JSON.stringify(painted)));
    const handleAfterReopen = prepareNativeMotionPaint(saved, new Map());
    const track = nativeMotionPaintTrack(painted, handle, graphic.id);
    expect(track.scene.layers).toHaveLength(1); expect(track.frames).toHaveLength(90);
    expect(track.scene.layers[0].path.commands.filter(command => command.type === "C")).toHaveLength(4);
    expect(track.scene.layers[0].path.commands.at(-1)).toEqual({ type: "Z" });
    expect(track.scene.layers[0].stroke!.width).toBe(1);
    expect(track.scene.layers[0].shadow).toMatchObject({ offset_x: 0, offset_y: 6, blur: 8 });
    const current = painted.motionGraphics[0], layout = motionGraphicV2LayoutReceipt(painted, current);
    for (const timelineFrame of [15, 31, 62, 31]) {
      const frame = motionGraphicV2FrameReceipt(painted, current, timelineFrame, layout), state = frame.vectorState!;
      const native = nativeMotionPaintFrame(painted, handle, timelineFrame);
      expect(native).toEqual(nativeMotionPaintFrame(saved, handleAfterReopen, timelineFrame));
      expect(native.poses[0]).toEqual({ x: layout.box.x + state.translateXPixels, y: layout.box.y + state.translateYPixels,
        scale: state.scale, opacity: state.opacity });
      expect(track.frames[timelineFrame - track.timeline.timelineStartFrame]).toEqual(native.poses);
    }
    const changed = structuredClone(painted); changed.motionGraphics[0].paintV1!.shadow!.blurPixels = 9;
    expect(() => nativeMotionPaintTrack(changed, handle, graphic.id)).toThrow(/stale/);
  });

  it("does not silently replace dynamic vector reveal with a static native shape", async () => {
    const { project, graphic } = fixture("");
    graphic.vectorV2 = { schema: "editkin.motion-vector/v1", kind: "rule", heightPixels: 4, revealFrames: 12 };
    graphic.motionV2!.sequence = { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0 };
    graphic.paintV1 = paint; graphic.visualStyle = "native_paint";
    await expect(prepareMotionNativePaintForRender(project)).rejects.toThrow(/static/);
  });
});
