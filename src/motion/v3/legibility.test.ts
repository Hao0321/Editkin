import { describe, expect, it } from "vitest";
import { MOTION_DESIGN_V3_PRESETS } from "../../creative/motionDesignV3Presets";
import { createEmptyProject } from "../../domain/editGraph";
import type { MotionGraphic } from "../../domain/types";
import { motionGraphicV3Frame, motionGraphicV3Layout } from "../compositionV3";
import { MIN_SECONDARY_PX, SECONDARY_INK_ALPHA, secondary, textShadow } from "./kit";
import type { V3TextOp } from "./types";

// Most short-form and YouTube viewers watch on a phone: secondary copy keeps a floor size, secondary ink keeps enough
// alpha, and light ink always carries a soft dark halo so it stays readable over bright footage.
const HOLD_FRAME = 60;
// The product requirement, written out here so that lowering the kit constant cannot silently pass this suite.
const PHONE_FLOOR_PX = 26;
const formats = [["16:9", 1920, 1080], ["9:16", 1080, 1920]] as const;

function holdTexts(width: number, height: number, presetId: string): V3TextOp[] {
  const project = createEmptyProject("legibility", { id: "legibility", width, height, fps: 30 });
  const preset = MOTION_DESIGN_V3_PRESETS.find(item => item.id === presetId)!;
  const graphic = { ...preset.seed, id: preset.id, timelineStart: 0, duration: 3 } as MotionGraphic;
  const layout = motionGraphicV3Layout(project, graphic);
  return motionGraphicV3Frame(project, graphic, HOLD_FRAME, layout).ops.filter((op): op is V3TextOp => op.kind === "text");
}

describe("Motion Design v3 legibility", () => {
  it.each(formats)("keeps every preset's copy at or above the secondary floor at the hold (%s)", (_name, width, height) => {
    const unit = Math.min(width, height) / 1080;
    for (const preset of MOTION_DESIGN_V3_PRESETS) {
      const copy = holdTexts(width, height, preset.id).filter(op => !op.id.endsWith(":shadow") && op.opacity > .05);
      expect(copy.length, preset.id).toBeGreaterThan(0);
      for (const op of copy) expect(op.fontSize / unit, `${preset.id} ${op.id}`).toBeGreaterThanOrEqual(PHONE_FLOOR_PX - 1e-9);
    }
  });

  it("raises small secondary sizes to the floor and leaves larger ones alone", () => {
    expect(MIN_SECONDARY_PX).toBeGreaterThanOrEqual(PHONE_FLOOR_PX);
    expect(secondary(18, 1)).toBe(MIN_SECONDARY_PX);
    expect(secondary(40, 1)).toBe(40);
    expect(secondary(18, 2)).toBe(MIN_SECONDARY_PX * 2);
  });

  it("gives light ink a soft dark halo and dark ink none", () => {
    const base: V3TextOp = { kind: "text", id: "copy", layer: 4, text: "東京", x: 0, y: 0, lineHeight: 40, fontFamily: "Noto Sans TC", fontWeight: 700,
      fontSize: 32, letterSpacing: 0, color: "#FFFFFF", opacity: 1 };
    const halo = textShadow(base);
    expect(halo.color).toBe("#000000");
    expect(halo.layer).toBe(base.layer - 1);
    expect(halo.opacity).toBeGreaterThanOrEqual(.7);
    expect(halo.blur).toBeGreaterThanOrEqual(base.fontSize * .15);
    expect(textShadow({ ...base, color: "#15171C" }).opacity).toBe(0);
  });

  it("keeps secondary ink at a legible alpha", () => {
    expect(SECONDARY_INK_ALPHA).toBeGreaterThanOrEqual(.86);
  });
});
