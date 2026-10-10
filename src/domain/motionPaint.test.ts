import { describe, expect, it } from "vitest";
import type { MotionGraphic } from "./types";
import { assertMotionPaintContract, motionPaintV1Schema, type MotionPaintV1 } from "./motionPaint";
import { createMotionGraphic } from "../motion/composition";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";

const paint: MotionPaintV1 = { schema: "editkin.motion-paint/v1", fill: { kind: "solid", color: "#F2F7FFFF" }, clips: [],
  stroke: { color: "#FFFFFF60", widthPixels: .75 },
  shadow: { color: "#06132260", offsetXPixels: -2, offsetYPixels: 8, blurPixels: 12 } };
const graphic = (): MotionGraphic => createMotionGraphic("native-shape", "card", "", 0, 4, undefined, {
  ...findMotionGraphicPreset("reel_native_panel").seed,
  schema: "hao.motion-composition/v2", visualStyle: "native_paint", paintV1: structuredClone(paint), backgroundColor: "#00000000", outlineWidth: 0, shadowDepth: 0,
  vectorV2: { schema: "editkin.motion-vector/v1", kind: "panel", heightPixels: 100, revealFrames: 1 },
});

describe("native paint authoring boundaries", () => {
  it("preserves explicit translucent stroke and natural shadow, admitting only static typed geometry", () => {
    expect(motionPaintV1Schema.parse(paint)).toEqual(paint);
    for (const kind of ["panel", "ellipse", "rule"] as const) {
      const item = graphic(); item.vectorV2 = { schema: "editkin.motion-vector-stage/v1", kind, heightPixels: 100, revealFrames: 1 };
      expect(() => assertMotionPaintContract(item)).not.toThrow();
    }
    const glyph = graphic(); delete glyph.vectorV2; glyph.text = "REAL GLYPHS";
    expect(() => assertMotionPaintContract(glyph)).not.toThrow();
  });

  it("rejects source descriptor ambiguity, unknown fields and silent legacy shadow or outline", () => {
    for (const mutation of [
      (item: MotionGraphic) => { item.text = "fake shape text"; },
      (item: MotionGraphic) => { item.vectorV2!.revealFrames = 2; },
      (item: MotionGraphic) => { Object.assign(item.vectorV2!, { kind: "dot_grid", spacingPixels: 16, dotRadiusPixels: 2 }); },
      (item: MotionGraphic) => { Object.assign(item.vectorV2!, { geometry: { arbitrary: true } }); },
      (item: MotionGraphic) => { item.shadowDepth = 1; },
      (item: MotionGraphic) => { item.outlineWidth = 1; },
      (item: MotionGraphic) => { item.backgroundColor = "#FFFFFF"; },
      (item: MotionGraphic) => { delete item.paintV1; },
      (item: MotionGraphic) => { delete item.visualStyle; },
    ]) {
      const item = graphic(); mutation(item);
      expect(() => assertMotionPaintContract(item)).toThrow();
    }
    const empty = graphic(); delete empty.vectorV2;
    expect(() => assertMotionPaintContract(empty)).toThrow(/physical glyphs/);
  });

  it("rejects excessive blur, offsets, stroke and unknown native effects without stripping them", () => {
    const invalid = [
      { ...paint, stroke: { ...paint.stroke!, widthPixels: 0 } },
      { ...paint, stroke: { ...paint.stroke!, widthPixels: 24.01 } },
      { ...paint, stroke: { ...paint.stroke!, blend: "screen" } },
      { ...paint, shadow: { ...paint.shadow!, blurPixels: 32.01 } },
      { ...paint, shadow: { ...paint.shadow!, blurPixels: Infinity } },
      { ...paint, shadow: { ...paint.shadow!, offsetXPixels: -128.01 } },
      { ...paint, shadow: { ...paint.shadow!, spread: 10 } },
      { ...paint, glow: { radius: 8 } },
    ];
    invalid.forEach(value => expect(motionPaintV1Schema.safeParse(value).success).toBe(false));
  });
});
