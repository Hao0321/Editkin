import type { EditProject, MotionGraphic } from "../domain/types";
import { assertMotionPaintContract } from "../domain/motionPaint";
import { resolveBundledFontFace } from "../typography/fontFaces";
import { prepareGlyphRun, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { motionGraphicV2PhysicalLayoutReceipt, prepareMotionGraphicV2FrameLayout, type MotionGraphicV2LayoutReceipt } from "../motion/compositionV2";
import { readBundledFontFace } from "./bundledFontSource";
import { prepareNativeMotionPaint, type PreparedNativeMotionPaint } from "../motion/nativeMotionPaint";

const MAX_TEXT_GRAPHICS = 128;
const MAX_OUTLINE_CODE_UNITS = 8 * 1024 * 1024;

/** The argument is the original pack root, not libass's root/render directory.
 * Exact verified bytes are owned only within this render preparation. Missing
 * delivery or unsupported shaping is a hard stop, never estimated typography. */
async function withPhysicalGlyphRuns(project: EditProject, fontPackRoot: string | undefined,
  consume: (graphic: MotionGraphic, run: PreparedGlyphRun) => void): Promise<void> {
  const graphics = project.motionGraphics.filter(graphic => graphic.schema === "hao.motion-composition/v2" && !graphic.vectorV2);
  if (!graphics.length) return;
  if (!fontPackRoot) throw new Error("實體 glyph 輸出缺少已驗證字型 pack root");
  if (graphics.length > MAX_TEXT_GRAPHICS) throw new Error(`實體 glyph 輸出超過 ${MAX_TEXT_GRAPHICS} 個文字圖形`);
  const ids = new Set<string>();
  const bytes = new Map<string, Uint8Array>();
  const runs = new Map<string, PreparedGlyphRun>();
  for (const graphic of graphics) {
    if (ids.has(graphic.id)) throw new Error("實體 glyph 圖形 identity 重複");
    ids.add(graphic.id);
    const face = resolveBundledFontFace(graphic.fontFamily ?? "Noto Sans TC", graphic.fontWeight ?? 700);
    if (!face) throw new Error(`實體 glyph ${graphic.id} 缺少已驗證內建字型`);
    const text = graphic.text.replaceAll("\r", "");
    const key = JSON.stringify([face.faceId, text]);
    let run = runs.get(key);
    if (!run) {
      let selected = bytes.get(face.faceId);
      if (!selected) {
        selected = await readBundledFontFace(fontPackRoot, face.faceId);
        if (bytes.size >= 2) bytes.delete(bytes.keys().next().value!);
        bytes.set(face.faceId, selected);
      }
      run = await prepareGlyphRun(face.faceId, text, selected);
      if (runs.size >= 8) runs.delete(runs.keys().next().value!);
      runs.set(key, run);
    }
    consume(graphic, run);
  }
}

export async function prepareMotionPhysicalLayouts(project: EditProject, fontPackRoot?: string): Promise<ReadonlyMap<string, MotionGraphicV2LayoutReceipt>> {
  const layouts = new Map<string, MotionGraphicV2LayoutReceipt>();
  let outlineCodeUnits = 0;
  await withPhysicalGlyphRuns(project, fontPackRoot, (graphic, run) => {
    const layout = motionGraphicV2PhysicalLayoutReceipt(project, graphic, run);
    for (const segment of layout.segments) outlineCodeUnits += (segment.outline?.svg.length ?? 0) + (segment.outline?.ass.length ?? 0);
    if (outlineCodeUnits > MAX_OUTLINE_CODE_UNITS) throw new Error("實體 glyph 輸出輪廓資料超過有界預算");
    layouts.set(graphic.id, prepareMotionGraphicV2FrameLayout(project, graphic, layout));
  });
  return layouts;
}

/** The resident formal route consumes actual factory runs from the pinned bundled
 * pack. An ordinary v2 graphic cannot join this route through plain-color fallback. */
export async function prepareMotionNativePaintForRender(project: EditProject, fontPackRoot?: string): Promise<PreparedNativeMotionPaint> {
  const graphics = project.motionGraphics.filter(graphic => graphic.schema === "hao.motion-composition/v2");
  if (!graphics.length || graphics.some(graphic => !graphic.paintV1 || graphic.visualStyle !== "native_paint")) {
    throw new Error("Native paint 正式輸出要求全部 v2 都是 paintV1 實體文字或已支援靜態向量；禁止普通 v2 降級");
  }
  for (const graphic of graphics) assertMotionPaintContract(graphic);
  if (project.motionGraphics.length > 4) throw new Error("Native paint resident 正式輸出最多接受 4 個 Motion overlay");
  const runs = new Map<string, PreparedGlyphRun>();
  await withPhysicalGlyphRuns(project, fontPackRoot, (graphic, run) => runs.set(graphic.id, run));
  return prepareNativeMotionPaint(project, runs);
}
