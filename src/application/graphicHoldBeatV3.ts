import { graphicHoldBeatV3Schema, graphicHoldEnvelopeV3Schema, GRAPHIC_HOLD_BEAT_V3_CONTRACT } from "../domain/graphicHoldBeatV3";
import { motionPresetOverridesSchema } from "../domain/schema";
import type { EditorCommand } from "../domain/commandTypes";
import type { EditProject, MotionGraphic } from "../domain/types";
import type { ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { motionGraphicV2FrameReceipt, motionGraphicV2LayoutReceipt, prepareMotionGraphicV2FrameLayout, type MotionGraphicV2LayoutReceipt, type MotionGraphicV2FrameReceipt } from "../motion/compositionV2";
import type { ReferenceMotionGraphicBinding, ReferenceMotionTemplateCompileOptions } from "./referenceMotionTemplateCommands";

interface Packet { commands: EditorCommand[]; bindings: ReferenceMotionGraphicBinding[]; layouts: MotionGraphicV2LayoutReceipt[];
  phases: Array<{ role: string; startFrame: number; endFrame: number }>; roles?: Array<{ id: string; key: string; kind: string }> }
function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }); }
const transparent = (color: string) => color === "transparent" || /^#[0-9a-f]{6}00$/i.test(color);

function assertReadableInk(project: EditProject, graphic: MotionGraphic, layout: MotionGraphicV2LayoutReceipt,
  frame: MotionGraphicV2FrameReceipt) {
  if (!frame.visible || frame.segments.some(pose => Math.round(pose.opacity * 255) !== 255)
    || (frame.vectorState && Math.round(frame.vectorState.opacity * 255) !== 255))
    fail("HOLD_BEAT_NOT_READABLE", "第二拍只能放在整組文字與圖形完全可讀的停留期間。");
  const safe = layout.safeRect, clip = graphic.clipRegion;
  const left = Math.max(safe.x, clip ? clip.x * project.width : 0);
  const top = Math.max(safe.y, clip ? clip.y * project.height : 0);
  const right = Math.min(safe.x + safe.width, clip ? (clip.x + clip.width) * project.width : project.width);
  const bottom = Math.min(safe.y + safe.height, clip ? (clip.y + clip.height) * project.height : project.height);
  const inside = (x0: number, y0: number, x1: number, y1: number) => {
    if (x0 < left - .05 || y0 < top - .05 || x1 > right + .05 || y1 > bottom + .05)
      fail("HOLD_BEAT_INK_WINDOW", "第二拍會把字形或卡片移出既有安全範圍／文字窗；請縮短位移或推近。");
  };
  if (graphic.vectorV2) {
    const pose = frame.vectorState!, box = layout.box;
    inside(box.x + pose.translateXPixels, box.y + pose.translateYPixels,
      box.x + pose.translateXPixels + box.width * pose.scale, box.y + pose.translateYPixels + box.height * pose.scale);
  } else {
    for (let index = 0; index < layout.segments.length; index++) {
      const segment = layout.segments[index], ink = segment.outline?.ink, pose = frame.segments[index];
      if (!ink || ink.xMax <= ink.xMin || ink.yMax <= ink.yMin) continue;
      inside(segment.x + pose.translateXPixels + ink.xMin * pose.scale, segment.y + pose.translateYPixels + ink.yMin * pose.scale,
        segment.x + pose.translateXPixels + ink.xMax * pose.scale, segment.y + pose.translateYPixels + ink.yMax * pose.scale);
    }
  }
}

export interface GraphicHoldBeatReceiptV3 {
  schema: "editkin.graphic-hold-beat-receipt/v3";
  holdIndex: number; projectWindow: { fromFrame: number; peakFrame: number; toFrame: number }; roleKeys: string[];
  checkedFrames: number; checkedSegmentFrames: number; certification: "ART_PENDING_CLAUDE";
}

/** Attach an explicit bounded event after the final graphic clock. Source clips/audio and all authored poses stay intact. */
export function compileGraphicHoldBeatPacketV3<T extends Packet>(project: EditProject, input: ReferenceMotionTemplateInput,
  original: T, options: ReferenceMotionTemplateCompileOptions): T & { graphicHoldBeatV3Receipt: GraphicHoldBeatReceiptV3 } {
  const choice = graphicHoldBeatV3Schema.parse(input.holdBeatV3);
  const hold = original.phases.filter(phase => phase.role === "hold" && phase.endFrame > phase.startFrame)
    .sort((a, b) => a.startFrame - b.startFrame)[choice.holdIndex];
  if (!hold) fail("HOLD_BEAT_MISSING_HOLD", "找不到指定的既有停留區間。");
  const span = hold.endFrame - 1 - hold.startFrame;
  const projectWindow = {
    fromFrame: hold.startFrame + Math.round(span * choice.fromFraction),
    peakFrame: hold.startFrame + Math.round(span * choice.peakFraction),
    toFrame: hold.startFrame + Math.round(span * choice.toFraction) };
  if (!(projectWindow.fromFrame < projectWindow.peakFrame && projectWindow.peakFrame < projectWindow.toFrame)
    || projectWindow.toFrame - projectWindow.fromFrame > GRAPHIC_HOLD_BEAT_V3_CONTRACT.maxFrames)
    fail("HOLD_BEAT_WINDOW", "第二拍在既有停留區間內沒有三個不同的整數格，或超過逐幀範圍。");
  const selected = choice.roleKeys.map(key => {
    const role = original.roles?.find(role => role.key === key && role.kind === "graphic");
    const binding = role && original.bindings.find(binding => binding.graphic.id === role.id);
    if (!binding) fail("HOLD_BEAT_ROLE", `第二拍找不到此實例的圖形角色：${key}`);
    const graphic = binding.graphic;
    if (graphic.schema !== "hao.motion-composition/v2" || graphic.paintV1 || graphic.trackId
      || (!graphic.vectorV2 && (!transparent(graphic.backgroundColor) || !transparent(graphic.accentColor))))
      fail("HOLD_BEAT_GRAPHIC", "第二拍只接受實體 v2 字形或向量卡片；文字的背景需以獨立卡片角色同行。");
    const start = Math.round(graphic.timelineStart * project.fps);
    const envelope = graphicHoldEnvelopeV3Schema.parse({ schema: "editkin.graphic-hold-envelope/v3", clock: "graphic_local_frames",
      fromFrame: projectWindow.fromFrame - start, peakFrame: projectWindow.peakFrame - start, toFrame: projectWindow.toFrame - start,
      originXPixels: project.width * choice.origin.x, originYPixels: project.height * choice.origin.y,
      peakScale: choice.peakScale, translateXPixels: choice.translateXPixels, translateYPixels: choice.translateYPixels });
    const marked: MotionGraphic = { ...graphic, holdBeatV3: envelope };
    const layout = prepareMotionGraphicV2FrameLayout(project, marked, marked.vectorV2 ? motionGraphicV2LayoutReceipt(project, marked) : options.layoutForGraphic(marked));
    const originalLayout = prepareMotionGraphicV2FrameLayout(project, graphic, graphic.vectorV2 ? motionGraphicV2LayoutReceipt(project, graphic) : options.layoutForGraphic(graphic));
    return { key, binding, marked, layout, originalLayout };
  });
  const unitCount = selected.reduce((sum, row) => sum + Math.max(1, row.layout.segments.length), 0);
  const frameCount = projectWindow.toFrame - projectWindow.fromFrame + 1;
  if (unitCount * frameCount > GRAPHIC_HOLD_BEAT_V3_CONTRACT.maxSegmentFrames)
    fail("HOLD_BEAT_BUDGET", "第二拍超過既有實體字形逐幀預算；請縮短區間或减少同行角色。");
  let changed = false;
  for (const row of selected) {
    for (let frame = projectWindow.fromFrame; frame <= projectWindow.toFrame; frame++) {
      const actual = motionGraphicV2FrameReceipt(project, row.marked, frame, row.layout);
      assertReadableInk(project, row.marked, row.layout, actual);
      if (frame === projectWindow.peakFrame) {
        const before = motionGraphicV2FrameReceipt(project, row.binding.graphic, frame, row.originalLayout);
        changed ||= JSON.stringify(actual) !== JSON.stringify(before);
      }
    }
  }
  if (!changed) fail("HOLD_BEAT_NO_VISIBLE_CHANGE", "第二拍的變換在實際字形精度下沒有可見位移。");
  const map = new Map(selected.map(row => [row.marked.id, row]));
  return Object.assign({}, original, {
    commands: original.commands.map(command => command.type === "add_motion_graphic" && map.has(command.graphic.id)
      ? { ...command, graphic: map.get(command.graphic.id)!.marked } : command),
    bindings: original.bindings.map(binding => map.has(binding.graphic.id) ? { ...binding, graphic: map.get(binding.graphic.id)!.marked,
      overrides: motionPresetOverridesSchema.parse({ ...binding.overrides, holdBeatV3: map.get(binding.graphic.id)!.marked.holdBeatV3 }) } : binding),
    layouts: original.layouts.map(layout => map.get(layout.graphicId)?.layout ?? layout),
    graphicHoldBeatV3Receipt: { schema: "editkin.graphic-hold-beat-receipt/v3" as const, holdIndex: choice.holdIndex,
      projectWindow, roleKeys: [...choice.roleKeys], checkedFrames: frameCount, checkedSegmentFrames: unitCount * frameCount,
      certification: "ART_PENDING_CLAUDE" as const },
  });
}
