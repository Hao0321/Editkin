import type { EditProject, MotionDesignV3TemplateId, MotionGraphic } from "../domain/types";
import { assertMotionGraphicV3Contract } from "../domain/motionCompositionV3Contract";
import { contextFor } from "./v3/kit";
import { motionV3Template } from "./v3/templates";
import type { V3Context, V3Layout, V3Op, V3Rect } from "./v3/types";

type ProjectFrame = Pick<EditProject, "width" | "height" | "fps">;

export interface MotionGraphicV3Layout {
  schema: "hao.motion-layout-receipt/v3";
  graphicId: string;
  template: MotionDesignV3TemplateId;
  /** Everything the layout depends on; a stale layout is refused rather than drawn. */
  signature: string;
  box: V3Rect;
  context: V3Context;
  layout: V3Layout;
}

export interface MotionGraphicV3Frame {
  schema: "hao.motion-frame-receipt/v3";
  graphicId: string;
  timelineFrame: number;
  localFrame: number;
  visible: boolean;
  /** Draw ops in paint order; preview and export render exactly these. */
  ops: V3Op[];
}

const LAYOUT_CACHE_LIMIT = 64;
const layoutCache = new Map<string, MotionGraphicV3Layout>();

const round2 = (value: number): number => Math.round(value * 100) / 100;
const round3 = (value: number): number => Math.round(value * 1000) / 1000;
const roundRect = (rect: V3Rect): V3Rect => ({ x: round2(rect.x), y: round2(rect.y), width: round2(rect.width), height: round2(rect.height) });

function signatureOf(project: ProjectFrame, graphic: MotionGraphic): string {
  return JSON.stringify([project.width, project.height, project.fps, graphic]);
}

export function motionGraphicV3Layout(project: ProjectFrame, graphic: MotionGraphic): MotionGraphicV3Layout {
  assertMotionGraphicV3Contract(graphic);
  if (graphic.schema !== "hao.motion-composition/v3") throw new Error(`動態圖卡 ${graphic.id} 不是 motion-composition/v3`);
  const signature = signatureOf(project, graphic);
  const cached = layoutCache.get(signature);
  if (cached) return cached;
  const template = motionV3Template(graphic.designV3!.template);
  const context = contextFor(project, graphic);
  const layout = template.layout(context);
  const receipt: MotionGraphicV3Layout = { schema: "hao.motion-layout-receipt/v3", graphicId: graphic.id, template: template.id, signature, box: roundRect(layout.box), context, layout };
  layoutCache.set(signature, receipt);
  if (layoutCache.size > LAYOUT_CACHE_LIMIT) layoutCache.delete(layoutCache.keys().next().value!);
  return receipt;
}

/** Rounded so both renderers and repeated evaluations see identical numbers. */
function roundOp(op: V3Op): V3Op {
  const common = { opacity: round3(Math.max(0, Math.min(1, op.opacity))), ...(op.blur ? { blur: round2(op.blur) } : {}), ...(op.clip ? { clip: roundRect(op.clip) } : {}) };
  if (op.kind === "shape") return { ...op, ...common, path: op.path.map(command => ({ op: command.op, points: command.points.map(round2) })) };
  return {
    ...op, ...common, x: round2(op.x), y: round2(op.y), lineHeight: round2(op.lineHeight), fontSize: round2(op.fontSize),
    letterSpacing: round2(op.letterSpacing), ...(op.scale !== undefined && op.scale !== 1 ? { scale: round3(op.scale) } : { scale: undefined }),
  };
}

function drawable(op: V3Op): boolean {
  if (op.opacity < .002) return false;
  if (op.clip && (op.clip.width <= .5 || op.clip.height <= .5)) return false;
  if (op.kind === "text") return op.text.trim().length > 0 && op.fontSize > 0 && (op.scale ?? 1) > .01;
  return op.path.length > 0;
}

export function motionGraphicV3Frame(project: ProjectFrame, graphic: MotionGraphic, timelineFrame: number, layout = motionGraphicV3Layout(project, graphic)): MotionGraphicV3Frame {
  if (!Number.isInteger(timelineFrame)) throw new Error("v3 frame evaluator 只接受整數 timeline frame");
  if (layout.graphicId !== graphic.id || layout.signature !== signatureOf(project, graphic)) throw new Error("v3 layout 與 project/graphic 不一致");
  const startFrame = Math.round(graphic.timelineStart * project.fps);
  const localFrame = timelineFrame - startFrame;
  const base = { schema: "hao.motion-frame-receipt/v3" as const, graphicId: graphic.id, timelineFrame, localFrame };
  if (localFrame < 0 || localFrame >= layout.context.durationFrames) return { ...base, visible: false, ops: [] };
  const ops = motionV3Template(layout.template).frame(layout.context, layout.layout, localFrame).map(roundOp).filter(drawable);
  const ids = new Set<string>();
  for (const op of ops) {
    if (ids.has(op.id)) throw new Error(`v3 版型 ${layout.template} 在同一格重複使用 ${op.id}`);
    ids.add(op.id);
  }
  ops.sort((left, right) => left.layer - right.layer);
  return { ...base, visible: ops.length > 0, ops };
}

export function motionGraphicV3FrameAtPlayhead(project: ProjectFrame, graphic: MotionGraphic, playhead: number): MotionGraphicV3Frame {
  return motionGraphicV3Frame(project, graphic, Math.round(playhead * project.fps));
}

/** Physical faces a v3 graphic may draw with, for export font verification. */
export function motionGraphicV3Faces(graphic: MotionGraphic): Array<{ family: string; weight: number }> {
  if (graphic.schema !== "hao.motion-composition/v3" || !graphic.designV3) return [];
  return motionV3Template(graphic.designV3.template).faces(graphic);
}
