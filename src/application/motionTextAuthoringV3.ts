import type { EditProject, MotionGraphic } from "../domain/types";
import { motionGraphicV2PhysicalLayoutReceipt, type MotionGraphicV2LayoutReceipt } from "../motion/compositionV2";
import { resolveBundledFontFace } from "../typography/fontFaces";
import { layoutMeasuredTextV2, type MeasuredTextLayoutResult } from "../typography/measuredTextLayoutV2";
import type { PreparedGlyphRun } from "../typography/preparedGlyphRun";

export const MOTION_TEXT_AUTHORING_V3 = { schema: "editkin.motion-text-authoring/v3", artStatus: "ART_PENDING_CLAUDE", defaultEnabled: false } as const;
export interface MotionTextAuthoringDeps {
  prepareText(faceId: string, text: string): Promise<PreparedGlyphRun>;
  signal?: AbortSignal;
}

/** Every text role in new compilers uses the same measured authoring path. No certified project is silently rewritten. */
export async function prepareMotionTextV3(project: EditProject, input: MotionGraphic, deps: MotionTextAuthoringDeps,
  options: { locale?: string; neverSplit?: readonly string[] } = {}): Promise<{
    graphic: MotionGraphic; layout: MotionGraphicV2LayoutReceipt; authoring: MeasuredTextLayoutResult;
  }> {
  if (input.schema !== "hao.motion-composition/v2" || input.vectorV2 || !input.layoutV2) throw new Error("新文字排版只接受可編輯的文字圖層。");
  const check = () => { if (deps.signal?.aborted) throw new Error("文字排版已取消，專案未修改。"); };
  check();
  const graphic = structuredClone(input), face = resolveBundledFontFace(graphic.fontFamily ?? "Noto Sans TC", graphic.fontWeight ?? 700);
  if (!face) throw new Error("這個字型沒有可驗證的實體字型檔。");
  const run = await deps.prepareText(face.faceId, graphic.text.replaceAll("\r", "")); check();
  const config = graphic.layoutV2!, safe = config.safeArea;
  const authoring = layoutMeasuredTextV2(run, {
    slotWidth: Math.min(graphic.width * project.width, (1 - safe.left - safe.right) * project.width),
    fontSize: graphic.fontSize, minFontSize: config.minFontSize, maxLines: config.maxLines, letterSpacing: graphic.letterSpacing,
    maxHeight: (1 - safe.top - safe.bottom) * project.height, lineGap: config.lineGap,
    locale: options.locale, neverSplit: options.neverSplit, signal: deps.signal,
  });
  graphic.text = authoring.text; graphic.fontSize = authoring.fontSize;
  // Explicit, measured lines are persisted, so preview, GPU and ASS render the same authored boundaries.
  const finalRun = graphic.text === run.text ? run : await deps.prepareText(face.faceId, graphic.text); check();
  const layout = motionGraphicV2PhysicalLayoutReceipt(project, graphic, finalRun);
  if (layout.fontSize !== authoring.fontSize || layout.lineCount !== authoring.lines.length) throw new Error("實體字型排版與新文字規則不一致，專案未修改。");
  return { graphic, layout, authoring };
}
