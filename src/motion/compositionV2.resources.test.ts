import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareGlyphRun } from "../typography/preparedGlyphRun";
import { createMotionGraphic } from "./composition";
import { motionGraphicV2FrameReceipt, motionGraphicV2LayoutReceipt, motionGraphicV2PhysicalLayoutReceipt,
  prepareMotionGraphicV2FrameLayout } from "./compositionV2";

const faceId = "EditkinFace-bebas-neue-400";
const fontBytes = readFile(resolve("public/fonts", bundledFontFaceSpec(faceId).fontFile));
const project = createEmptyProject("Owned frame layout", { width: 1080, height: 1920, fps: 30 });
function graphic(text = "AV ONE") {
  const result = createMotionGraphic("resource-title", "title", text, 0, 3, undefined,
    findMotionGraphicPreset("v2-word-cascade").seed);
  result.fontFamily = "Bebas Neue";
  result.fontWeight = 400;
  result.fontSize = 60;
  result.layoutV2 = { ...result.layoutV2!, widthMode: "fit_content", align: "left", minFontSize: 60 };
  return result;
}
async function physical(item = graphic()) {
  const run = await prepareGlyphRun(faceId, item.text, new Uint8Array(await fontBytes));
  return { item, run, layout: motionGraphicV2PhysicalLayoutReceipt(project, item, run) };
}

describe("bounded typography and owned immutable frame layouts", () => {
  it("rejects nonprogressing, nonfinite, nonpositive and over-limit text sizes before either auto-fit loop", async () => {
    const { item, run } = await physical();
    for (const fontSize of [1e20, Infinity, NaN, -1, 0, 4097]) {
      const changed = { ...item, fontSize };
      expect(() => motionGraphicV2LayoutReceipt(project, changed)).toThrow();
      expect(() => motionGraphicV2PhysicalLayoutReceipt(project, changed, run)).toThrow();
    }
  });

  it("rejects an invalid minimum instead of changing or clamping authored sizes", async () => {
    const { item, run } = await physical();
    for (const minFontSize of [NaN, Infinity, -1, 0, 4097, 61]) {
      const changed = { ...item, layoutV2: { ...item.layoutV2!, minFontSize } };
      expect(() => motionGraphicV2LayoutReceipt(project, changed)).toThrow();
      expect(() => motionGraphicV2PhysicalLayoutReceipt(project, changed, run)).toThrow();
      expect(changed.fontSize).toBe(60);
      expect(Object.is(changed.layoutV2.minFontSize, minFontSize)).toBe(true);
    }
  });

  it("keeps a vector's unused extreme font size out of typography auto-fit", () => {
    const item = graphic("");
    item.fontSize = 1e20;
    item.motionV2!.sequence = { ...item.motionV2!.sequence, unit: "all", staggerFrames: 0 };
    item.vectorV2 = { schema: "editkin.motion-vector/v1", kind: "panel", heightPixels: 100, revealFrames: 1 };
    const layout = motionGraphicV2LayoutReceipt(project, item);
    expect(layout.box.height).toBe(100);
    const prepared = prepareMotionGraphicV2FrameLayout(project, item, layout);
    expect(motionGraphicV2FrameReceipt(project, item, 30, prepared).vectorState).toBeDefined();
  });

  it("owns an equal estimated layout without freezing the caller's input", () => {
    const item = graphic(), layout = motionGraphicV2LayoutReceipt(project, item);
    const prepared = prepareMotionGraphicV2FrameLayout(project, item, layout);
    expect(prepared).toEqual(layout);
    expect(prepared).not.toBe(layout);
    expect(prepared.segments).not.toBe(layout.segments);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.segments)).toBe(true);
    expect(Object.isFrozen(layout)).toBe(false);
    expect(Object.isFrozen(layout.segments[0])).toBe(false);
    expect(prepareMotionGraphicV2FrameLayout(project, item, prepared)).toBe(prepared);
  });

  it("deeply freezes authentic physical outlines and identities while retaining an independent owned copy", async () => {
    const { item, layout } = await physical();
    const prepared = prepareMotionGraphicV2FrameLayout(project, item, layout);
    const before = motionGraphicV2FrameReceipt(project, item, 30, prepared);
    expect(Object.isFrozen(prepared.physicalFont)).toBe(true);
    expect(Object.isFrozen(prepared.box)).toBe(true);
    expect(Object.isFrozen(prepared.segments[0])).toBe(true);
    expect(Object.isFrozen(prepared.segments[0].outline)).toBe(true);
    expect(Object.isFrozen(prepared.segments[0].outline!.ink)).toBe(true);
    expect(Reflect.set(prepared.segments[0].outline!, "ass", "m 1 1")).toBe(false);
    expect(Reflect.set(prepared.physicalFont!, "fontSha256", "0".repeat(64))).toBe(false);
    layout.segments[0].outline!.ass += " m 1 1";
    layout.physicalFont!.fontSha256 = "0".repeat(64);
    expect(motionGraphicV2FrameReceipt(project, item, 30, prepared)).toEqual(before);
    expect(prepared.physicalFont!.fontSha256).toBe(bundledFontFaceSpec(faceId).sha256);
  });

  it("still rejects ordinary mutated bodies in the sampler and preparation", async () => {
    const { item, layout } = await physical();
    layout.segments[0].outline!.svg += " M 1 1";
    expect(() => motionGraphicV2FrameReceipt(project, item, 30, layout)).toThrow(/layout receipt.*不一致/);
    expect(() => prepareMotionGraphicV2FrameLayout(project, item, layout)).toThrow(/layout receipt.*不一致/);
    expect(Object.isFrozen(layout)).toBe(false);
  });

  it("does not transfer the private seal to a clone with modified contour data", async () => {
    const { item, layout } = await physical();
    const prepared = prepareMotionGraphicV2FrameLayout(project, item, layout);
    const clone = structuredClone(prepared);
    expect(motionGraphicV2FrameReceipt(project, item, 30, clone)).toEqual(motionGraphicV2FrameReceipt(project, item, 30, prepared));
    clone.segments[0].outline!.ass += " l 9 9";
    expect(() => motionGraphicV2FrameReceipt(project, item, 30, clone)).toThrow(/layout receipt.*不一致/);
  });

  it("invalidates a prepared layout when current project or authored layout source changes", async () => {
    const { item, layout } = await physical();
    const prepared = prepareMotionGraphicV2FrameLayout(project, item, layout);
    expect(() => motionGraphicV2FrameReceipt({ ...project, width: project.width + 1 }, item, 30, prepared)).toThrow();
    for (const changed of [
      { ...item, text: "NEW TITLE" }, { ...item, x: item.x + .01 }, { ...item, fontSize: 59 },
      { ...item, layoutV2: { ...item.layoutV2!, align: "right" as const } },
    ]) {
      expect(() => motionGraphicV2FrameReceipt(project, changed, 30, prepared)).toThrow();
      expect(() => prepareMotionGraphicV2FrameLayout(project, changed, prepared)).toThrow();
    }
  });

  it("rechecks the current face and paint style instead of accepting stale prepared values", async () => {
    const { item, layout } = await physical();
    const prepared = prepareMotionGraphicV2FrameLayout(project, item, layout);
    for (const changed of [
      { ...item, fontFamily: "Fredoka" }, { ...item, fontWeight: 700 },
      { ...item, textColor: "#123456" }, { ...item, shadowDepth: (item.shadowDepth ?? 0) + 1 },
      { ...item, backgroundColor: "#ABCDEF" }, { ...item, cornerRadius: (item.cornerRadius ?? 0) + 1 },
    ]) {
      expect(() => motionGraphicV2FrameReceipt(project, changed, 30, prepared)).toThrow();
      expect(() => prepareMotionGraphicV2FrameLayout(project, changed, prepared)).toThrow();
    }
  });

  it("keeps prepared and ordinary integer-frame sampling equal during nonsequential seeking", async () => {
    const { item, layout } = await physical();
    const prepared = prepareMotionGraphicV2FrameLayout(project, item, layout);
    const first = motionGraphicV2FrameReceipt(project, item, 42, prepared);
    for (const frame of [89, 0, 30, 2, 75, 42, 90, -1, 42]) {
      expect(motionGraphicV2FrameReceipt(project, item, frame, prepared))
        .toEqual(motionGraphicV2FrameReceipt(project, item, frame, layout));
    }
    expect(motionGraphicV2FrameReceipt(project, item, 42, prepared)).toEqual(first);
  });

  it("observes no whole-outline serialization for sealed sampling while the ordinary control still serializes it", async () => {
    const { item, layout } = await physical();
    const prepared = prepareMotionGraphicV2FrameLayout(project, item, layout);
    const stringify = vi.spyOn(JSON, "stringify");
    let preparedBodySerializations = -1, ordinaryBodySerializations = -1;
    const countOutlines = () => stringify.mock.calls.filter(([value]: readonly unknown[]) => {
      if (!value || typeof value !== "object" || !("segments" in value) || !Array.isArray(value.segments)) return false;
      return value.segments.some(segment => segment?.outline?.svg && segment?.outline?.ass);
    }).length;
    try {
      for (const frame of [0, 42, 89, 2, 42]) motionGraphicV2FrameReceipt(project, item, frame, prepared);
      preparedBodySerializations = countOutlines();
      motionGraphicV2FrameReceipt(project, item, 42, layout);
      ordinaryBodySerializations = countOutlines() - preparedBodySerializations;
    } finally { stringify.mockRestore(); }
    expect(preparedBodySerializations).toBe(0);
    expect(ordinaryBodySerializations).toBe(1);
  });
});
