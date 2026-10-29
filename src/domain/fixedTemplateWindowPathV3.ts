import { animatedClipState } from "./editGraph";
import type { ClipMask, EditProject, MaskPathPoint, TimelineClip, Transform2D } from "./types";

const fail = (code: string, message: string) => Object.assign(new Error(message), { code });
const layoutError = () => fail("FIXED_TEMPLATE_WINDOW_LAYOUT", "固定影像窗需要有效的逐格片段與獨立窗口版面。");

export function fixedTemplateWindowFrameCountV3(project: EditProject, clip: TimelineClip, mask: ClipMask): number {
  const frames = Math.round(clip.duration * project.fps), layout = clip.layout;
  const dimensions = [project.width, project.height, project.fps, layout?.crop.width, layout?.crop.height, layout?.viewport.width, layout?.viewport.height];
  if (!dimensions.every(value => typeof value === "number" && Number.isFinite(value) && value > 0)
    || frames < 2 || frames > 1800 || Math.abs(clip.duration * project.fps - frames) > 1e-7 || clip.floatingFrame || clip.layer?.parentClipId) throw layoutError();
  if (mask.kind !== "polygon" || !mask.enabled || mask.trackId || mask.keyframes.length || mask.matteSequence || mask.frozenRange
    || mask.path.length < 3 || mask.path.some(point => ![point.x, point.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1))) {
    throw fail("FIXED_TEMPLATE_WINDOW_MASK", "固定影像窗需要模板自有的靜態多邊形遮罩。");
  }
  if (mask.fixedWindowV3) {
    const { schema, fromFrame, toFrame } = mask.fixedWindowV3;
    if (schema !== "editkin.fixed-template-window/v3" || ((fromFrame !== undefined || toFrame !== undefined)
      && (fromFrame === undefined || toFrame === undefined || !Number.isInteger(fromFrame) || !Number.isInteger(toFrame)
        || fromFrame < 0 || fromFrame > toFrame || toFrame >= frames))) throw layoutError();
  }
  return frames;
}

/** Invert crop -> viewport -> pixel translation/rotation/scale, around the crop centre in mask space. */
export function inverseTemplateWindowPointV3(project: EditProject, clip: TimelineClip, point: MaskPathPoint, transform: Transform2D): MaskPathPoint {
  if (![transform.x, transform.y, transform.scale, transform.rotation].every(Number.isFinite) || transform.scale < .0001) throw layoutError();
  if (transform.x === 0 && transform.y === 0 && transform.scale === 1 && transform.rotation === 0 && !transform.flipX && !transform.flipY) return { ...point };
  const { crop, viewport } = clip.layout!;
  const cx = crop.x + crop.width / 2, cy = crop.y + crop.height / 2;
  const px = project.width * viewport.width / crop.width, py = project.height * viewport.height / crop.height;
  const x = (point.x - cx) * px - transform.x, y = (point.y - cy) * py - transform.y;
  const radians = transform.rotation * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
  const out = { ...point,
    x: cx + (x * cos + y * sin) / (transform.scale * (transform.flipX ? -1 : 1) * px),
    y: cy + (-x * sin + y * cos) / (transform.scale * (transform.flipY ? -1 : 1) * py) };
  if (![out.x, out.y].every(value => Number.isFinite(value) && value >= -1e-10 && value <= 1 + 1e-10)) {
    throw fail("FIXED_TEMPLATE_WINDOW_OUTSIDE_SOURCE", "固定影像窗超出素材可用範圍；請調整窗口或移動畫面。");
  }
  return { ...out, x: Math.max(0, Math.min(1, out.x)), y: Math.max(0, Math.min(1, out.y)) };
}

/** Continuous preview time and integer output frames use the same transform evaluator and inverse. */
export function fixedTemplateWindowPathV3(project: EditProject, clip: TimelineClip, mask: ClipMask, localTime: number): MaskPathPoint[] {
  const count = fixedTemplateWindowFrameCountV3(project, clip, mask);
  if (!Number.isFinite(localTime)) throw layoutError();
  const time = Math.max(0, Math.min((count - 1) / project.fps, localTime));
  const range = mask.fixedWindowV3;
  if (range?.fromFrame !== undefined && range.toFrame !== undefined
    && (time * project.fps < range.fromFrame - 1e-7 || time * project.fps > range.toFrame + 1e-7)) return mask.path.map(point => ({ ...point }));
  const transform = animatedClipState(clip, time, project.fps).transform;
  return mask.path.map(point => inverseTemplateWindowPointV3(project, clip, point, transform));
}

export function fixedTemplateWindowSamplesV3(project: EditProject, clip: TimelineClip, mask: ClipMask) {
  return Array.from({ length: fixedTemplateWindowFrameCountV3(project, clip, mask) }, (_, frame) => {
    const time = frame / project.fps;
    return { time, points: fixedTemplateWindowPathV3(project, clip, mask, time) };
  });
}
