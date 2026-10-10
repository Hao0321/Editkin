import { z } from "zod/v4";
import { applyCommand, type EditorCommand } from "../domain/commands";
import { projectDuration, validateProject } from "../domain/editGraph";
import { editorCommandSchema, projectSchema } from "../domain/schema";
import type { EditProject, MotionGraphic } from "../domain/types";
import {
  assertMotionGraphicV2Contract,
  MOTION_V2_MAX_SEGMENT_FRAMES,
  motionGraphicV2UnitCount,
  motionGraphicV2ExitStaggerFrames,
} from "../domain/motionCompositionV2Contract";
import { assertMotionGraphicPresetBinding, findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { createMotionGraphic } from "../motion/composition";
import { defaultMotionGraphicV2Seed } from "../motion/defaultGraphicSeedsV2";
import {
  motionGraphicV2FrameReceipt,
  motionGraphicV2PhysicalLayoutReceipt,
  prepareMotionGraphicV2FrameLayout,
  type MotionGraphicV2LayoutReceipt,
} from "../motion/compositionV2";
import { motionPanelPaths } from "../motion/panelGeometry";
import { motionSceneContourInk, type MotionSceneInk } from "../motion/sceneCamera2d";
import { posedSegmentInkBounds } from "../motion/motionPoseInk";
import type { MotionGraphicV2SegmentFrame } from "../motion/compositionV2";
import { assertPreparedGlyphRun, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { resolveBundledFontFace } from "../typography/fontFaces";
import { canonicalJson } from "../shared/canonicalJson";
import { assertScopedMotionReadingHold } from "./scopedMotionRevision";

const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const creationText = z.string().max(256)
  .refine(text => !text.includes("\r"), "圖文不可含 CR 換行字元，請使用一般換行")
  .transform(text => text.trim())
  .refine(text => text.length > 0 && [...text].length <= 128, "圖文需有 1 至 128 個字元");

export const motionGraphicCreationInputSchema = z.strictObject({
  expectedRevision: safeInteger,
  graphicId: z.string().min(1).refine(id => id.trim().length > 0, "圖卡識別不可空白"),
  kind: z.enum(["title", "card", "tag", "counter"]),
  text: creationText,
  startFrame: safeInteger,
  preferredDurationFrames: z.number().int().min(1).max(960),
  scope: z.enum(["existing_timeline", "empty_canvas"]),
  presetId: z.string().min(1).optional(),
});

export type MotionGraphicCreationInput = z.infer<typeof motionGraphicCreationInputSchema>;

export interface MotionGraphicCreationDependencies {
  prepareText: (faceId: string, text: string) => Promise<PreparedGlyphRun>;
  signal?: AbortSignal;
}

function fail(code: string, message: string): never {
  throw new Error("MOTION_CREATION_" + code + ": " + message);
}

function colorVisible(color: string): boolean {
  return !/^#[0-9a-f]{6}00$/i.test(color);
}

function assertSafeInk(
  ink: MotionSceneInk,
  originX: number,
  originY: number,
  scale: number,
  layout: MotionGraphicV2LayoutReceipt,
  frame: number,
  pose?: { state: MotionGraphicV2SegmentFrame; pivot: { width: number; height: number } },
): void {
  // Rotation/blur (Motion Language) grow the visible ink; plain poses keep the historical box.
  const bounds = pose && (pose.state.rotationDegrees || pose.state.blurPixels)
    ? posedSegmentInkBounds(ink, { x: originX, y: originY }, pose.state, pose.pivot)
    : {
      xMin: originX + ink.xMin * scale,
      yMin: originY + ink.yMin * scale,
      xMax: originX + ink.xMax * scale,
      yMax: originY + ink.yMax * scale,
    };
  if (![originX, originY, scale, ...Object.values(bounds)].every(Number.isFinite)
    || scale <= 0 || bounds.xMax <= bounds.xMin || bounds.yMax <= bounds.yMin) {
    fail("INK", "第 " + frame + " 格的實體字形變換範圍不合法");
  }
  const safe = layout.safeRect;
  if (bounds.xMin < safe.x || bounds.yMin < safe.y
    || bounds.xMax > safe.x + safe.width || bounds.yMax > safe.y + safe.height) {
    fail("INK", "第 " + frame + " 格的實體字形或輪廓超出安全區，請選擇適合的文字或預設");
  }
}

/** Standalone new graphics have no scene owner; inspect real ink directly. */
function assertAllFrameInk(
  project: EditProject,
  graphic: MotionGraphic,
  layout: MotionGraphicV2LayoutReceipt,
  startFrame: number,
  endFrame: number,
  checkCancelled: () => void,
): number {
  if (!layout.physicalFont || !layout.segments.length
    || layout.segments.some(segment => !segment.outline)
    || !layout.segments.some(segment => Boolean(segment.outline?.svg)
      && Boolean(segment.outline?.ass) && segment.outline?.ink !== null)) {
    fail("INK", "新建圖文需要已驗證的實體字型輪廓");
  }
  if (!colorVisible(graphic.textColor)) fail("INK", "此預設的文字完全透明，無法準備可讀圖文");
  const durationFrames = endFrame - startFrame;
  if (layout.segments.length * durationFrames > MOTION_V2_MAX_SEGMENT_FRAMES) {
    fail("INK", "實體字形逐格預算超過 " + MOTION_V2_MAX_SEGMENT_FRAMES + "，請縮短文字或明選時長");
  }
  const panel = motionPanelPaths(layout.box.width, layout.box.height,
    graphic.cornerRadius ?? 10, graphic.outlineWidth ?? 2);
  const fillInk = motionSceneContourInk(panel.fillSvg);
  const borderInk = motionSceneContourInk(panel.borderSvg);
  let framesChecked = 0;
  for (let frameNumber = startFrame; frameNumber < endFrame; frameNumber++) {
    checkCancelled();
    const frame = motionGraphicV2FrameReceipt(project, graphic, frameNumber, layout);
    if (!frame.visible || frame.localFrame !== frameNumber - startFrame
      || frame.segments.length !== layout.segments.length) {
      fail("INK", "新建圖文的影格不符合已準備範圍");
    }
    const states = new Map(frame.segments.map(state => [state.segmentId, state]));
    if (states.size !== layout.segments.length) fail("INK", "實體字形影格的段落識別重複");
    for (const segment of layout.segments) {
      const state = states.get(segment.id);
      if (!state || ![state.opacity, state.scale, state.translateXPixels, state.translateYPixels].every(Number.isFinite)
        || state.opacity < 0 || state.opacity > 1 || state.scale <= 0) {
        fail("INK", "實體字形影格缺少合法的段落狀態");
      }
      const ink = segment.outline!.ink;
      // Blank line/space segments may have no ink. Every nonzero SVG opacity is
      // checked, including values below the ASS event visibility threshold.
      if (!ink || state.opacity === 0) continue;
      const originX = segment.x + state.translateXPixels;
      const originY = segment.y + state.translateYPixels;
      assertSafeInk(ink, originX, originY, state.scale, layout, frameNumber, { state, pivot: segment });
      if (graphic.shadowDepth && colorVisible(graphic.accentColor)) {
        const offset = graphic.shadowDepth * state.scale;
        assertSafeInk(ink, originX + offset, originY + offset, state.scale, layout, frameNumber, { state, pivot: segment });
      }
    }
    // Panels are fixed contours at the layout origin, not glyph translations.
    if (frame.backgroundOpacity > 0 && colorVisible(graphic.backgroundColor)) {
      if (fillInk) assertSafeInk(fillInk, layout.box.x, layout.box.y, 1, layout, frameNumber);
      if (borderInk && colorVisible(graphic.accentColor)) {
        assertSafeInk(borderInk, layout.box.x, layout.box.y, 1, layout, frameNumber);
      }
    }
    framesChecked++;
  }
  for (const frameNumber of [startFrame - 1, endFrame]) {
    if (motionGraphicV2FrameReceipt(project, graphic, frameNumber, layout).visible) {
      fail("WINDOW", "新建圖文出現在已準備影格範圍之外");
    }
  }
  return framesChecked;
}

/** Preparation only. The caller still owns v4 audit, atomic apply and delivery. */
export async function prepareMotionGraphicCreation(
  project: EditProject,
  raw: unknown,
  dependencies: MotionGraphicCreationDependencies,
) {
  if (typeof dependencies?.prepareText !== "function") {
    fail("FONT", "新建圖文需要真正的實體字型準備服務，請確認字型資源已就緒");
  }
  const prepareText = dependencies.prepareText;
  const signal = dependencies.signal;
  // Capture both original sources before any async boundary. Work only on owned
  // clones; even a provider that changes the caller's objects cannot late-commit.
  const projectPin = canonicalJson(project), inputPin = canonicalJson(raw);
  const snapshot = structuredClone(project), ownedRaw = structuredClone(raw);
  const checkCurrent = () => {
    if (signal?.aborted) fail("CANCELLED", "圖文準備已取消，尚未新增任何圖卡");
    if (canonicalJson(project) !== projectPin || canonicalJson(raw) !== inputPin) {
      fail("STALE", "準備期間專案或圖文輸入已變更，請以目前內容重新準備");
    }
  };
  checkCurrent();
  if (canonicalJson(snapshot) !== projectPin || canonicalJson(ownedRaw) !== inputPin) {
    fail("STALE", "擷取圖文來源時內容已變更，請以目前內容重新準備");
  }
  const input = motionGraphicCreationInputSchema.parse(ownedRaw);
  projectSchema.parse(snapshot);
  validateProject(snapshot);
  if (snapshot.revision !== input.expectedRevision) fail("STALE", "專案版本已變更，請讀取目前專案後重新準備");
  if (snapshot.motionGraphics.some(graphic => graphic.id === input.graphicId)) {
    fail("INPUT", "這個圖卡識別已存在，請提供新的識別");
  }
  const fps = snapshot.fps;
  if (!Number.isFinite(fps) || fps <= 0 || fps > 240
    || !Number.isFinite(snapshot.width) || !Number.isFinite(snapshot.height)
    || snapshot.width <= 0 || snapshot.height <= 0) {
    fail("WINDOW", "專案畫布尺寸或影格率不合法，請先修正專案設定");
  }
  const currentDuration = projectDuration(snapshot);
  if (!Number.isFinite(currentDuration) || currentDuration < 0) fail("WINDOW", "目前時間軸片長不合法");
  let timelineEndFrame: number | undefined;
  let availableFrames = input.preferredDurationFrames;
  if (input.scope === "empty_canvas") {
    if (currentDuration !== 0 || input.startFrame !== 0) {
      fail("WINDOW", "「空白畫布」只接受真正零片長的時間軸，且必須從第 0 格開始；已有內容請明選目前時間軸範圍");
    }
  } else {
    timelineEndFrame = Math.floor(currentDuration * fps + 1e-7);
    if (!Number.isSafeInteger(timelineEndFrame) || timelineEndFrame < 0) {
      fail("WINDOW", "目前時間軸無法表示為合法整數影格範圍");
    }
    availableFrames = Math.max(0, timelineEndFrame - input.startFrame);
  }
  const durationFrames = Math.min(input.preferredDurationFrames, availableFrames);
  const endFrame = input.startFrame + durationFrames;
  if (!Number.isSafeInteger(endFrame) || durationFrames < 0) {
    fail("WINDOW", "新增範圍超出目前時間軸或整數影格上限；請將播放頭移早或調整明選時長");
  }
  const seed = input.presetId === undefined
    ? defaultMotionGraphicV2Seed(input.kind)
    : structuredClone(findMotionGraphicPreset(input.presetId).seed);
  const preset = findMotionGraphicPreset(seed.presetId);
  if (preset.renderer !== "hao-motion-composition/v2" || seed.schema !== "hao.motion-composition/v2"
    || seed.kind !== input.kind || seed.vectorV2 !== undefined || seed.trackingMode !== undefined
    || preset.routing?.requires.some(requirement => requirement !== "none")) {
    fail("PRESET", "請選擇種類相符、已註冊且不含向量或追蹤的 v2 圖文預設");
  }
  const graphic = createMotionGraphic(input.graphicId, input.kind, input.text,
    input.startFrame / fps, durationFrames / fps, undefined, seed);
  if (Math.round(graphic.timelineStart * fps) !== input.startFrame
    || Math.round(graphic.duration * fps) !== durationFrames) {
    fail("WINDOW", "此開始位置或時長無法精確表示為專案整數影格");
  }
  assertMotionGraphicPresetBinding(graphic, preset.id);
  const motion = graphic.motionV2;
  if (!motion || !graphic.layoutV2) fail("PRESET", "此預設缺少完整 v2 動作或版面，無法準備");
  const staggerTailFrames = Math.max(0, motionGraphicV2UnitCount(graphic) - 1) * (motion.sequence.staggerFrames + motionGraphicV2ExitStaggerFrames(motion));
  const minimumReadingHoldFrames = Math.ceil(.8 * fps);
  const readingHoldFrames = durationFrames - motion.entrance.durationFrames - motion.exit.durationFrames - staggerTailFrames;
  const requiredFrames = motion.entrance.durationFrames + motion.exit.durationFrames
    + staggerTailFrames + minimumReadingHoldFrames;
  if (!Number.isSafeInteger(requiredFrames) || requiredFrames < 1) {
    fail("PRESET", "此預設的入退場或段落隊尾影格不合法");
  }
  if (readingHoldFrames < minimumReadingHoldFrames) {
    fail("WINDOW", "這次可用 " + durationFrames + " 格，需要 " + requiredFrames + " 格"
      + "（入場 " + motion.entrance.durationFrames + "、退場 " + motion.exit.durationFrames
      + "、兩個段落隊尾共 " + staggerTailFrames + "、至少 0.8 秒閱讀停留 "
      + minimumReadingHoldFrames + "）。請"
      + (input.scope === "existing_timeline" ? "將播放頭移早，或" : "")
      + "調整明選時長；準備不會改動原時間軸或預設動作。"
      + (timelineEndFrame === 0 ? "真正空白專案需明選「空白畫布」範圍。" : ""));
  }
  if (durationFrames < 1 || timelineEndFrame !== undefined && endFrame > timelineEndFrame) {
    fail("WINDOW", "新增範圍超出目前時間軸，請將播放頭移早或調整明選時長");
  }
  assertMotionGraphicV2Contract(graphic, fps);
  assertScopedMotionReadingHold(graphic, fps);
  const command: Extract<EditorCommand, { type: "add_motion_graphic" }> = { type: "add_motion_graphic", graphic };
  editorCommandSchema.parse(command);
  const candidate = applyCommand(snapshot, command);
  projectSchema.parse(candidate);
  const candidateGraphic = candidate.motionGraphics.find(item => item.id === graphic.id);
  if (!candidateGraphic || canonicalJson(candidateGraphic) !== canonicalJson(graphic)) {
    fail("PRESET", "圖卡命令的唯讀試套用改變了已註冊配方，無法提交");
  }
  assertMotionGraphicPresetBinding(candidateGraphic, preset.id);
  for (const field of ["assets", "tracks", "compositions", "captions", "captionStyle", "motionTracks",
    "motionScenes", "director", "referenceMotionInstances", "revision", "width", "height", "fps"] as const) {
    if (canonicalJson(candidate[field]) !== canonicalJson(snapshot[field])) {
      fail("PRESERVATION", "圖卡命令的唯讀試套用改變了既有專案資料：" + field);
    }
  }
  if (canonicalJson(candidate.motionGraphics.filter(item => item.id !== graphic.id)) !== canonicalJson(snapshot.motionGraphics)
    || input.scope === "existing_timeline" && projectDuration(candidate) > currentDuration + 1e-7 / fps) {
    fail("PRESERVATION", "圖卡命令的唯讀試套用改變了舊圖卡或延長原時間軸");
  }
  const face = resolveBundledFontFace(graphic.fontFamily ?? "Noto Sans TC", graphic.fontWeight ?? 700);
  if (!face || face.weightSubstituted) fail("FONT", "此預設的確切實體字型或字重未就緒，請確認內附字型資源");
  const spec = bundledFontFaceSpec(face.faceId);
  checkCurrent();
  const abortablePreparation = new Promise<PreparedGlyphRun>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = () => finish(() => reject(new Error("MOTION_CREATION_CANCELLED: 圖文準備已取消，尚未新增任何圖卡")));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    try {
      Promise.resolve(prepareText(face.faceId, graphic.text)).then(
        run => finish(() => resolve(run)),
        error => finish(() => reject(error)),
      );
    } catch (error) {
      finish(() => reject(error));
    }
  });
  let run: PreparedGlyphRun;
  try {
    run = await abortablePreparation;
  } catch (error) {
    fail("FONT", "實體字型準備失敗，尚未新增圖卡："
      + (error instanceof Error ? error.message : String(error)));
  } finally {
    checkCurrent();
  }
  try {
    assertPreparedGlyphRun(run);
  } catch (error) {
    fail("FONT", "收到的字形不是當代字型服務的真實準備結果："
      + (error instanceof Error ? error.message : String(error)));
  }
  if (run.faceId !== face.faceId || run.text !== graphic.text
    || run.fontSha256 !== spec.sha256 || run.manifestSha256 !== spec.manifestSha256) {
    fail("FONT", "準備的字型、文字或來源雜湊與目前請求不同，請重新準備");
  }
  const physicalLayout = prepareMotionGraphicV2FrameLayout(snapshot, graphic,
    motionGraphicV2PhysicalLayoutReceipt(snapshot, graphic, run));
  const framesChecked = assertAllFrameInk(snapshot, graphic, physicalLayout, input.startFrame, endFrame, () => {
    if (signal?.aborted) fail("CANCELLED", "圖文準備已取消，尚未新增任何圖卡");
  });
  checkCurrent();
  return {
    schema: "editkin.motion-graphic-creation/v1" as const,
    readOnly: true as const,
    status: "PREPARED_NOT_APPLIED" as const,
    projectRevision: snapshot.revision,
    graphic: structuredClone(graphic),
    commands: [structuredClone(command)] as [Extract<EditorCommand, { type: "add_motion_graphic" }>],
    timing: {
      scope: input.scope, fps, startFrame: input.startFrame, endFrame, durationFrames,
      ...(timelineEndFrame !== undefined ? { timelineEndFrame } : {}),
      readingHoldFrames, minimumReadingHoldFrames,
    },
    physicalLayout,
    validation: { framesChecked, segmentFramesChecked: framesChecked * physicalLayout.segments.length,
      maximumSegmentFrames: MOTION_V2_MAX_SEGMENT_FRAMES, actualContourInkChecked: true as const },
    preserved: { projectUnchanged: true as const, inputUnchanged: true as const,
      revisionUnchanged: true as const, mediaAndSourceClocksUnchanged: true as const,
      audioUnchanged: true as const, existingGraphicsUnchanged: true as const },
    next: "v4 audit/atomic apply/render/QA/art required" as const,
  };
}
