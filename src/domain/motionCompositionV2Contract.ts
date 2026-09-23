import type { MotionGraphic, MotionGraphicV2Easing } from "./types";

export const MOTION_V2_MAX_TEXT_UNITS = 128;
export const MOTION_V2_MAX_SEGMENT_FRAMES = 18_000;

export function motionGraphicV2UnitCount(graphic: MotionGraphic): number {
  const mode = graphic.motionV2?.sequence.unit;
  if (mode === "all") return 1;
  if (mode === "word") return Math.max(1, graphic.text.trim().split(/\s+/u).filter(Boolean).length);
  return Math.max(1, [...graphic.text].filter((character) => !/\s/u.test(character)).length);
}

function assertFiniteRange(value: number, min: number, max: number, label: string): void {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${label} 超出支援範圍`);
}

function assertEasing(easing: MotionGraphicV2Easing, label: string): void {
  if (easing.type === "linear" || easing.type === "ease_in" || easing.type === "ease_out" || easing.type === "ease_in_out") return;
  if (easing.type === "cubic_bezier") {
    assertFiniteRange(easing.x1, 0, 1, `${label}.x1`);
    assertFiniteRange(easing.x2, 0, 1, `${label}.x2`);
    assertFiniteRange(easing.y1, -2, 2, `${label}.y1`);
    assertFiniteRange(easing.y2, -2, 2, `${label}.y2`);
    return;
  }
  if (easing.type === "spring") {
    assertFiniteRange(easing.stiffness, 1, 1_000, `${label}.stiffness`);
    assertFiniteRange(easing.damping, 0, 100, `${label}.damping`);
    assertFiniteRange(easing.mass, .05, 10, `${label}.mass`);
    assertFiniteRange(easing.initialVelocity, -20, 20, `${label}.initialVelocity`);
    return;
  }
  const exhaustive: never = easing;
  throw new Error(`${label} 不支援：${JSON.stringify(exhaustive)}`);
}

/** Runtime guard shared by EditGraph validation and the deterministic evaluator. */
export function assertMotionGraphicV2Contract(graphic: MotionGraphic, fps: number): void {
  if (graphic.schema !== "hao.motion-composition/v2") {
    if (graphic.motionV2 !== undefined || graphic.layoutV2 !== undefined) throw new Error("v1 不可攜帶 v2 motion/layout 參數");
    return;
  }
  const motion = graphic.motionV2;
  const layout = graphic.layoutV2;
  if (!motion || !layout) throw new Error("v2 必須同時包含 motionV2 與 layoutV2");
  if (graphic.trackId || graphic.trackingMode) throw new Error("v2 追蹤／平面貼合尚未完成共享 receipt，禁止降級到 v1");
  if (!Number.isFinite(fps) || fps <= 0 || fps > 240) throw new Error("v2 fps 不合法");
  const durationFrames = Math.max(1, Math.round(graphic.duration * fps));
  const glyphs = [...graphic.text].length;
  const units = motionGraphicV2UnitCount(graphic);
  if (glyphs > MOTION_V2_MAX_TEXT_UNITS || units > MOTION_V2_MAX_TEXT_UNITS) throw new Error(`v2 文字單元超過 ${MOTION_V2_MAX_TEXT_UNITS} 上限`);
  if (!["all", "word", "character"].includes(motion.sequence.unit)
    || !["forward", "reverse", "center_out"].includes(motion.sequence.order)
    || !["forward", "reverse", "center_out"].includes(motion.sequence.exitOrder)
    || !Number.isInteger(motion.sequence.staggerFrames) || motion.sequence.staggerFrames < 0 || motion.sequence.staggerFrames > 120) {
    throw new Error("v2 sequence/stagger 參數不合法");
  }
  for (const [name, phase] of [["entrance", motion.entrance], ["exit", motion.exit]] as const) {
    if (!Number.isInteger(phase.durationFrames) || phase.durationFrames < 1 || phase.durationFrames > 600) throw new Error(`v2 ${name}.durationFrames 不合法`);
    assertFiniteRange(phase.offsetXPixels, -4_096, 4_096, `v2 ${name}.offsetXPixels`);
    assertFiniteRange(phase.offsetYPixels, -4_096, 4_096, `v2 ${name}.offsetYPixels`);
    assertFiniteRange(phase.scale, .01, 4, `v2 ${name}.scale`);
    assertFiniteRange(phase.opacity, 0, 1, `v2 ${name}.opacity`);
    assertEasing(phase.easing, `v2 ${name}.easing`);
  }
  const entranceFrames = motion.entrance.durationFrames + Math.max(0, units - 1) * motion.sequence.staggerFrames;
  const exitFrames = motion.exit.durationFrames + Math.max(0, units - 1) * motion.sequence.staggerFrames;
  if (entranceFrames + exitFrames > durationFrames) throw new Error("v2 entrance/exit sequence 超出圖卡時長");
  if (durationFrames * Math.max(1, glyphs) > MOTION_V2_MAX_SEGMENT_FRAMES) throw new Error(`v2 segment-frame 預算超過 ${MOTION_V2_MAX_SEGMENT_FRAMES}`);
  const safe = layout.safeArea;
  if (layout.widthMode !== undefined && !["fixed", "fit_content"].includes(layout.widthMode)) throw new Error("v2 widthMode 不合法");
  for (const [name, value] of Object.entries(safe)) assertFiniteRange(value, 0, .45, `v2 safeArea.${name}`);
  if (safe.left + safe.right >= .9 || safe.top + safe.bottom >= .9) throw new Error("v2 safeArea 沒有可用畫布");
  if (!Number.isInteger(layout.maxLines) || layout.maxLines < 1 || layout.maxLines > 4
    || !Number.isFinite(layout.minFontSize) || layout.minFontSize < 8 || layout.minFontSize > graphic.fontSize
    || !Number.isFinite(layout.lineGap) || layout.lineGap < 0 || layout.lineGap > 128
    || !["left", "center", "right"].includes(layout.align)) throw new Error("v2 auto-fit/wrap 參數不合法");
}
