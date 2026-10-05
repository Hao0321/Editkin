import type { MotionGraphic, MotionGraphicV2Easing, MotionGraphicV2Motion, MotionGraphicV2SequenceUnit } from "./types";
import { assertContinuityVectorContract } from "./motionContinuityContract";
import { assertMotionPaintContract } from "./motionPaint";

export const MOTION_V2_MAX_TEXT_UNITS = 128;
export const MOTION_V2_MAX_SEGMENT_FRAMES = 18_000;

/** True when a phase declares rotation or blur, so frame receipts carry them. */
export function motionGraphicV2HasPoseEffects(motion: MotionGraphicV2Motion): boolean {
  return [motion.entrance, motion.exit].some(phase => (phase.rotationDegrees ?? 0) !== 0 || (phase.blurPixels ?? 0) !== 0);
}

/** Independent exit cadence; historical projects retain their original timing. */
export function motionGraphicV2ExitStaggerFrames(motion: MotionGraphicV2Motion): number {
  return motion.sequence.exitStaggerFrames ?? motion.sequence.staggerFrames;
}

export function motionGraphicV2UnitCount(graphic: Pick<MotionGraphic, "text"> & { motionV2?: { sequence: { unit: MotionGraphicV2SequenceUnit } } }): number {
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

/** Authored flat shapes: bounded numeric contours, fills only, never native paint. */
function assertShapeVector(vector: Extract<NonNullable<MotionGraphic["vectorV2"]>, { kind: "shape" }>, graphic: MotionGraphic): void {
  if (vector.schema !== "editkin.motion-vector-shape/v1") throw new Error("形狀向量需要 shape/v1");
  if (vector.revealFrom !== undefined && !["left", "right", "top", "bottom"].includes(vector.revealFrom)) throw new Error("形狀擦入方向不合法");
  if (graphic.paintV1 !== undefined || graphic.visualStyle === "native_paint") throw new Error("形狀向量尚未接入原生 paint；請使用一般向量輸出");
  if (!Array.isArray(vector.commands) || vector.commands.length < 2 || vector.commands.length > 4096 || vector.commands[0]?.type !== "M") throw new Error("形狀向量需要 2–4096 個以 M 開始的指令");
  for (const command of vector.commands) {
    const values = command.type === "Z" ? [] : command.type === "C" ? [command.x1, command.y1, command.x2, command.y2, command.x, command.y] : [command.x, command.y];
    if (!["M", "L", "C", "Z"].includes(command.type) || values.some(value => !Number.isFinite(value) || Math.abs(value) > 16_384)) throw new Error("形狀向量座標不合法");
  }
}

/** Runtime guard shared by EditGraph validation and the deterministic evaluator. */
export function assertMotionGraphicV2Contract(graphic: MotionGraphic, fps: number): void {
  assertMotionPaintContract(graphic);
  if (graphic.schema !== "hao.motion-composition/v2") {
    if (graphic.motionV2 !== undefined || graphic.layoutV2 !== undefined || graphic.vectorV2 !== undefined) throw new Error("v1 不可攜帶 v2 motion/layout/vector 參數");
    return;
  }
  const motion = graphic.motionV2;
  const layout = graphic.layoutV2;
  if (!motion || !layout) throw new Error("v2 必須同時包含 motionV2 與 layoutV2");
  if (graphic.trackId || graphic.trackingMode) throw new Error("v2 追蹤／平面貼合尚未完成共享 receipt，禁止降級到 v1");
  if (!Number.isFinite(fps) || fps <= 0 || fps > 240) throw new Error("v2 fps 不合法");
  const durationFrames = Math.max(1, Math.round(graphic.duration * fps));
  const vector = graphic.vectorV2;
  if (vector) {
    if (vector.kind !== "spring_panel" && "geometry" in vector) throw new Error("未知原生向量幾何欄位：連續輪廓需要其版本與種類");
    if (vector.kind === "spring_panel") assertContinuityVectorContract(graphic, fps);
    else if (vector.kind === "shape") assertShapeVector(vector, graphic);
    else if (!["editkin.motion-vector/v1", "editkin.motion-vector-stage/v1", "editkin.motion-vector-annotation/v1"].includes(vector.schema) || !["rule", "panel", "ellipse", "step_progress", "dot_grid", "line_grid", "connection_field"].includes(vector.kind)) throw new Error("未知原生向量種類");
    if (vector.schema === "editkin.motion-vector-annotation/v1" && vector.kind !== "rule") throw new Error("文字上方註記只接受 rule 向量");
    if (graphic.compositeLayer === "background" && vector.schema !== "editkin.motion-vector-stage/v1") throw new Error("背景合成需要 stage 向量版本，避免舊程式忽略合成位置");
    if (graphic.text !== "" || motion.sequence.unit !== "all" || motion.sequence.staggerFrames !== 0 || motionGraphicV2ExitStaggerFrames(motion) !== 0) throw new Error("原生向量必須使用空文字及整層動畫，文字請另加可編輯文字層");
    assertFiniteRange(vector.heightPixels, 1, 4096, "vector heightPixels");
    if (!Number.isInteger(vector.revealFrames) || vector.revealFrames < 1 || vector.revealFrames > 600 || vector.revealFrames > durationFrames - motion.exit.durationFrames) throw new Error("向量 revealFrames 超出有效停留段");
    if (vector.kind === "step_progress") {
      if (!Number.isInteger(vector.steps) || vector.steps < 1 || vector.steps > 12 || !Number.isInteger(vector.activeStep) || vector.activeStep < 0 || vector.activeStep > vector.steps) throw new Error("章節進度步數不合法");
      assertFiniteRange(vector.gapPixels, 0, 128, "vector gapPixels");
    }
    if (vector.kind === "dot_grid") {
      assertFiniteRange(vector.spacingPixels, 8, 512, "vector spacingPixels");
      assertFiniteRange(vector.dotRadiusPixels, .25, 32, "vector dotRadiusPixels");
      if (vector.dotRadiusPixels * 2 > vector.spacingPixels) throw new Error("點陣半徑不可超過間隔一半");
    }
    if (vector.kind === "line_grid") {
      assertFiniteRange(vector.spacingPixels, 8, 512, "vector spacingPixels");
      assertFiniteRange(vector.lineWidthPixels, .25, 8, "vector lineWidthPixels");
      if (vector.lineWidthPixels * 2 >= vector.spacingPixels) throw new Error("網格線不可占滿間隔");
      if (!Number.isInteger(vector.majorEvery) || vector.majorEvery < 2 || vector.majorEvery > 12) throw new Error("網格主線間隔不合法");
    }
    if (vector.kind === "connection_field") {
      for (const [name, value, min, max] of [["seed", vector.seed, 0, 0xffffffff], ["points", vector.points, 8, 64],
        ["burstFrames", vector.burstFrames, 1, 180], ["gatherStartFrame", vector.gatherStartFrame, 0, 1800],
        ["gatherFrames", vector.gatherFrames, 1, 180], ["connectStartFrame", vector.connectStartFrame, 0, 1800],
        ["connectFrames", vector.connectFrames, 1, 180]] as const) {
        assertFiniteRange(value, min, max, `connection_field.${name}`);
        if (!Number.isInteger(value)) throw new Error(`connection_field.${name} 必須是整數`);
      }
      assertFiniteRange(vector.dotRadiusPixels, .5, 12, "connection_field.dotRadiusPixels");
      assertFiniteRange(vector.lineWidthPixels, .5, 8, "connection_field.lineWidthPixels");
      if (vector.groupColors && (vector.groupColors.length !== 3 || vector.groupColors.some(color => !/^#[0-9a-f]{6}$/i.test(color)))) throw new Error("點群配色需要三個有效 HEX 色碼");
      if (vector.gatherStartFrame < vector.burstFrames || vector.connectStartFrame < vector.gatherStartFrame + vector.gatherFrames
        || vector.connectStartFrame + vector.connectFrames > durationFrames - motion.exit.durationFrames) throw new Error("連線場的場景交接重疊或超出時長");
    }
  }
  const glyphs = [...graphic.text].length;
  const units = motionGraphicV2UnitCount(graphic);
  if (glyphs > MOTION_V2_MAX_TEXT_UNITS || units > MOTION_V2_MAX_TEXT_UNITS) throw new Error(`v2 文字單元超過 ${MOTION_V2_MAX_TEXT_UNITS} 上限`);
  if (!["all", "word", "character"].includes(motion.sequence.unit)
    || !["forward", "reverse", "center_out"].includes(motion.sequence.order)
    || !["forward", "reverse", "center_out"].includes(motion.sequence.exitOrder)
    || !Number.isInteger(motion.sequence.staggerFrames) || motion.sequence.staggerFrames < 0 || motion.sequence.staggerFrames > 120
    || motion.sequence.exitStaggerFrames !== undefined && (!Number.isInteger(motion.sequence.exitStaggerFrames) || motion.sequence.exitStaggerFrames < 0 || motion.sequence.exitStaggerFrames > 120)
    || motion.sequence.scaleOrigin !== undefined && !["top_left", "center"].includes(motion.sequence.scaleOrigin)) {
    throw new Error("v2 sequence/stagger 參數不合法");
  }
  if (motion.sequence.holdScale !== undefined) {
    assertFiniteRange(motion.sequence.holdScale, .8, 1.25, "v2 sequence.holdScale");
    if (motion.sequence.scaleOrigin !== "center") throw new Error("停留緩推 holdScale 需要 scaleOrigin=center，避免從左上角放大");
  }
  for (const [name, phase] of [["entrance", motion.entrance], ["exit", motion.exit]] as const) {
    if (!Number.isInteger(phase.durationFrames) || phase.durationFrames < 1 || phase.durationFrames > 600) throw new Error(`v2 ${name}.durationFrames 不合法`);
    assertFiniteRange(phase.offsetXPixels, -4_096, 4_096, `v2 ${name}.offsetXPixels`);
    assertFiniteRange(phase.offsetYPixels, -4_096, 4_096, `v2 ${name}.offsetYPixels`);
    assertFiniteRange(phase.scale, .01, 4, `v2 ${name}.scale`);
    assertFiniteRange(phase.opacity, 0, 1, `v2 ${name}.opacity`);
    assertEasing(phase.easing, `v2 ${name}.easing`);
    if (phase.blurPixels !== undefined) assertFiniteRange(phase.blurPixels, 0, 64, `v2 ${name}.blurPixels`);
    if (phase.rotationDegrees !== undefined) assertFiniteRange(phase.rotationDegrees, -180, 180, `v2 ${name}.rotationDegrees`);
    if (phase.spreadPixels !== undefined) assertFiniteRange(phase.spreadPixels, -1_024, 1_024, `v2 ${name}.spreadPixels`);
  }
  if (motionGraphicV2HasPoseEffects(motion)) {
    // Vector panels and native paint consume the four-field pose only; fail
    // closed instead of rendering a preview the export cannot reproduce.
    if (graphic.vectorV2) throw new Error("原生向量尚未支援旋轉／模糊；請只用於文字圖層");
    if (graphic.paintV1 !== undefined || graphic.visualStyle === "native_paint") throw new Error("原生 paint 尚未支援旋轉／模糊；請改用一般文字或移除旋轉／模糊");
  }
  const entranceFrames = motion.entrance.durationFrames + Math.max(0, units - 1) * motion.sequence.staggerFrames;
  const exitFrames = motion.exit.durationFrames + Math.max(0, units - 1) * motionGraphicV2ExitStaggerFrames(motion);
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
