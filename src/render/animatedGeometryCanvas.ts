import { animatedClipState } from "../domain/editGraph";
import { clipAnimationPoints } from "../domain/clipAnimation";
import type { EditProject, TimelineClip } from "../domain/types";
import { findTransitionPreset } from "../creative/corePack";
import { composedTransformExpressions } from "./ffmpegExpressions";
import { transitionScaleExpression } from "./creativeFilters";

const cache = new WeakMap<EditProject, Map<string, { width: number; height: number } | undefined>>();

/** Bound a fixed alpha canvas before animated affine resampling.
 * Variable-sized scale/pad links copy their initial negotiated extent; merely
 * padding after scale cannot fix the first-frame crop. */
export function animatedGeometryCanvas(project: EditProject, clip: TimelineClip, width: number, height: number) {
  let entries = cache.get(project);
  if (!entries) { entries = new Map(); cache.set(project, entries); }
  const key = `${clip.id}:${width}:${height}`;
  if (entries.has(key)) return entries.get(key);
  const composed = composedTransformExpressions(project, clip, "t", project.fps);
  if (!/\b(?:t|T|n|N)\b/.test(`${composed.scale} ${transitionScaleExpression(clip)}`)) { entries.set(key, undefined); return undefined; }
  const allClips = new Map(project.tracks.flatMap(t => t.clips).map(c => [c.id, c]));
  const visited = new Set<string>(); let bound = 1, current: TimelineClip | undefined = clip;
  while (current) {
    if (visited.has(current.id)) throw new Error("Animated geometry parenting cycle");
    visited.add(current.id);
    const points = clipAnimationPoints(current), scales = points.map(p => p.transform.scale);
    const maximum = Math.max(...scales), minimum = Math.min(...scales);
    let local = maximum + (points.some(p => p.easing === "spring_soft") ? (maximum - minimum) * .08 : 0);
    if (current.expressions?.scale) {
      for (let frame = 0; frame <= Math.ceil(current.duration * project.fps); frame++) local = Math.max(local, animatedClipState(current, Math.min(current.duration, frame / project.fps), project.fps).transform.scale);
    }
    bound *= local;
    current = current.layer?.parentClipId ? allClips.get(current.layer.parentClipId) : undefined;
  }
  for (const transition of [clip.creative?.transitionIn, clip.creative?.transitionOut]) {
    if (!transition) continue;
    const preset = findTransitionPreset(transition.presetId);
    if (preset.renderer === "transition-zoom") bound *= 1 + Number(preset.parameters?.zoomAmount ?? .08);
  }
  const baseWidth = clip.layout && !clip.floatingFrame ? Math.max(2, Math.round(width * clip.layout.viewport.width)) : width;
  const baseHeight = clip.layout && !clip.floatingFrame ? Math.max(2, Math.round(height * clip.layout.viewport.height)) : height;
  // A diagonal is conservative for every rotation and keeps the pad invariant.
  const rotating = composed.rotation !== "0";
  const w = Math.ceil(Math.max(baseWidth, (rotating ? Math.hypot(baseWidth, baseHeight) : baseWidth) * bound) / 2) * 2 + 2;
  const h = Math.ceil(Math.max(baseHeight, (rotating ? Math.hypot(baseWidth, baseHeight) : baseHeight) * bound) / 2) * 2 + 2;
  if (![w, h].every(Number.isFinite) || w > 16384 || h > 16384 || w * h > 64_000_000) throw new Error("Animated geometry exceeds the bounded alpha canvas; precompose the intended crop explicitly");
  const result = { width: w, height: h }; entries.set(key, result); return result;
}

/** Keep every AVFrame and link the same size; move the actual pixels instead. */
export function fixedAnimatedAffineFilters(project: EditProject, clip: TimelineClip, width: number, height: number): string[] | undefined {
  const canvas = animatedGeometryCanvas(project, clip, width, height);
  if (!canvas) return undefined;
  const localTime = `(on/${project.fps})`, globalTime = `(${localTime}+${clip.timelineStart})`;
  const composed = composedTransformExpressions(project, clip, globalTime, project.fps);
  const scale = `((${composed.scale})*(${transitionScaleExpression(clip, localTime)}))`;
  const angle = `((${composed.rotation})*PI/180)`;
  const coordinates = [["0", "0"], ["W", "0"], ["0", "H"], ["W", "H"]].flatMap(([x, y], i) => [
    `x${i}='W/2+((${x}-W/2)*cos(${angle})-(${y}-H/2)*sin(${angle}))*${scale}'`,
    `y${i}='H/2+((${x}-W/2)*sin(${angle})+(${y}-H/2)*cos(${angle}))*${scale}'`,
  ]);
  return [`pad=${canvas.width}:${canvas.height}:(ow-iw)/2:(oh-ih)/2:color=black@0`,
    `perspective=${coordinates.join(":")}:sense=destination:interpolation=cubic:eval=frame`];
}
