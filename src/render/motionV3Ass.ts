import type { EditProject, MotionGraphic } from "../domain/types";
import { motionGraphicV3Frame, motionGraphicV3Layout } from "../motion/compositionV3";
import { pathBounds, pathToAss } from "../motion/v3/geometry";
import { assTextMetrics } from "../motion/v3/textMetrics";
import type { V3Op, V3ShapeOp, V3TextOp } from "../motion/v3/types";
import { assFace, assFontName, assMotionFrameTime, assOverrideColor, roundAss } from "./assText";

/** libass `\blur r` is a Gaussian with σ = r / √(2 ln 2); ops carry σ in pixels. */
const ASS_BLUR_PER_SIGMA = Math.sqrt(2 * Math.LN2);
/** libass clamps `\blur` at 100. */
const ASS_BLUR_MAX = 100;
const LAYER_BASE = 10;
const LAYERS_PER_GRAPHIC = 16;

function effectTags(op: V3Op): string {
  const blur = op.blur ? `\\blur${roundAss(Math.min(ASS_BLUR_MAX, op.blur * ASS_BLUR_PER_SIGMA))}` : "";
  const clip = op.clip ? `\\clip(${roundAss(op.clip.x)},${roundAss(op.clip.y)},${roundAss(op.clip.x + op.clip.width)},${roundAss(op.clip.y + op.clip.height)})` : "";
  return blur + clip;
}

function shapeBody(op: V3ShapeOp): string {
  // libass places a drawing by its bounding box, so draw relative to that box.
  const bounds = pathBounds(op.path)!;
  return `{\\an7\\pos(${roundAss(bounds.x)},${roundAss(bounds.y)})\\p1\\bord0\\shad0${assOverrideColor(op.color, 1, op.opacity)}${effectTags(op)}}${pathToAss(op.path, bounds.x, bounds.y)}{\\p0}`;
}

function textBody(op: V3TextOp): string {
  const face = assFace(op.fontFamily, op.fontWeight, true);
  const metrics = assTextMetrics({ family: op.fontFamily, weight: op.fontWeight, size: op.fontSize, lineHeight: op.lineHeight });
  const scale = op.scale ?? 1;
  const scaleTags = scale === 1 ? "" : `\\fscx${roundAss(scale * 100)}\\fscy${roundAss(scale * 100)}`;
  return `{\\an7\\q2\\fn${assFontName(face.fontFamily)}\\b${face.fontWeight}\\fsp${roundAss(op.letterSpacing)}\\fs${roundAss(metrics.fontSize)}${scaleTags}`
    + `${assOverrideColor(op.color, 1, op.opacity)}\\bord0\\shad0${effectTags(op)}\\pos(${roundAss(op.x)},${roundAss(op.y + metrics.topOffset * scale)})}${op.text}`;
}

/** One event per op per run of identical frames; each graphic owns a band of layers. */
export function motionGraphicV3Events(project: EditProject, graphic: MotionGraphic, bundledFaces: boolean, order: number): string[] {
  if (!bundledFaces) throw new Error("v3 動態設計輸出需要已驗證的內建字型，不能改用未驗證替代字型");
  const layout = motionGraphicV3Layout(project, graphic);
  const startFrame = Math.round(graphic.timelineStart * project.fps);
  const total = layout.context.durationFrames;
  assMotionFrameTime(startFrame, project.fps);
  const layerBase = LAYER_BASE + order * LAYERS_PER_GRAPHIC;
  const events = [`; MotionDesignV3: ${graphic.id},${layout.template},${total}`];
  const open = new Map<string, { body: string; layer: number; from: number }>();
  const close = (id: string, until: number) => {
    const run = open.get(id)!;
    events.push(`Dialogue: ${run.layer},${assMotionFrameTime(startFrame + run.from, project.fps)},${assMotionFrameTime(startFrame + until, project.fps)},Motion,,0,0,0,,${run.body}`);
    open.delete(id);
  };
  for (let localFrame = 0; localFrame < total; localFrame += 1) {
    const frame = motionGraphicV3Frame(project, graphic, startFrame + localFrame, layout);
    const seen = new Set<string>();
    for (const op of frame.ops) {
      const body = op.kind === "shape" ? shapeBody(op) : textBody(op);
      const layer = layerBase + Math.max(0, Math.min(LAYERS_PER_GRAPHIC - 1, op.layer));
      seen.add(op.id);
      const run = open.get(op.id);
      if (run && run.body === body && run.layer === layer) continue;
      if (run) close(op.id, localFrame);
      open.set(op.id, { body, layer, from: localFrame });
    }
    for (const id of [...open.keys()]) if (!seen.has(id)) close(id, localFrame);
  }
  for (const id of [...open.keys()]) close(id, total);
  return events;
}
