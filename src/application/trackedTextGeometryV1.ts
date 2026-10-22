import type { EditProject, MotionGraphic } from "../domain/types";
import { assertTrackedTextBindingV1 } from "../domain/trackedTextBindingV1";
import { assertVectorTrackingProjectV1, vectorTrackingPoseAtV1 } from "../domain/vectorTrackingV1";
import { motionGraphicV2FrameReceipt, type MotionGraphicV2LayoutReceipt } from "../motion/compositionV2";
import { motionPanelPaths } from "../motion/panelGeometry";
import { projectMotionScenePoint } from "../motion/sceneCamera2d";
import type { MotionGlyphPathCommand } from "../motion/motionGlyphPaths";
import { vectorTrackingHomographyV1, vectorTrackingClipMatrixV1, vectorTrackingInverseV1, vectorTrackingTransformPointV1 } from "./trackedVectorPathsV1";

type Point = { x: number; y: number };
type Camera = Parameters<typeof projectMotionScenePoint>[1];
type Command = MotionGlyphPathCommand;
export const TRACKED_TEXT_CURVE_ERROR_PIXELS_V1 = .125;
export const TRACKED_TEXT_COMMAND_BUDGET_V1 = 65_536;
export interface TrackedTextPathV1 {
  slot: number; layer: 1 | 2; color: string; opacity: number; blurPixels: number;
  svg: string; ass: string; commands: readonly Command[];
}
export interface TrackedTextFrameV1 {
  schema: "editkin.tracked-text-frame/v1"; timelineFrame: number; visible: boolean;
  trackId: string; mode: "anchor" | "surface"; fontSha256: string; paths: readonly TrackedTextPathV1[];
}
export function trackedTextNumberV1(n: number): string {
  if (!Number.isFinite(n) || Math.abs(n) > 32768) throw Error("TRACKED_TEXT_COORDINATE_LIMIT");
  return String(Number(n.toFixed(6)) || 0);
}
const canonical = (p: Point): Point => ({ x: Number(trackedTextNumberV1(p.x)), y: Number(trackedTextNumberV1(p.y)) });

/** The existing vector tracker owns clip matrices and homography. Its old path
 * consumer is unchanged; these are its existing numeric leaves, not new pose math. */
function projection(project: EditProject, graphic: MotionGraphic, timelineFrame: number, camera: Camera) {
  const { track, clip } = assertVectorTrackingProjectV1(project, graphic, false)!, binding = graphic.vectorTrackingV1!;
  const reference = vectorTrackingPoseAtV1(track, binding.referenceTime)!;
  const current = vectorTrackingPoseAtV1(track, timelineFrame / project.fps - clip.timelineStart);
  if (!current) return undefined;
  const before = vectorTrackingInverseV1(vectorTrackingClipMatrixV1(project, clip, clip.timelineStart + binding.referenceTime));
  const after = vectorTrackingClipMatrixV1(project, clip, timelineFrame / project.fps);
  let follow: number[];
  if (binding.mode === "surface") {
    if (!reference.quad || !current.quad) throw Error("TRACKED_TEXT_SURFACE_QUAD_REQUIRED");
    follow = vectorTrackingHomographyV1(reference.quad, current.quad);
  } else {
    const asset = project.assets.find(a => a.id === clip.assetId)!, ratio = asset.displayAspectRatio ?? asset.width! / asset.height!;
    const radians = (current.rotationDegrees - reference.rotationDegrees) * Math.PI / 180, scale = current.scale / reference.scale;
    const c = Math.cos(radians) * scale, s = Math.sin(radians) * scale;
    const rx = reference.rect.x + reference.rect.width / 2, ry = reference.rect.y + reference.rect.height / 2;
    const cx = current.rect.x + current.rect.width / 2, cy = current.rect.y + current.rect.height / 2;
    follow = [c, -s / ratio, cx - c * rx + s * ry / ratio, s * ratio, c, cy - s * ratio * rx - c * ry, 0, 0, 1];
  }
  return (p: Point): Point => {
    const source = vectorTrackingTransformPointV1(before, p);
    // Positive rational weights make the projected control-hull curve bound valid.
    const weight = follow[6] * source.x + follow[7] * source.y + follow[8];
    if (!Number.isFinite(weight) || weight <= 1e-7) throw Error("TRACKED_TEXT_PROJECTIVE_HORIZON");
    return projectMotionScenePoint(vectorTrackingTransformPointV1(after, vectorTrackingTransformPointV1(follow, source)), camera);
  };
}

/** Strict parser for the existing panel factory's ASS m/l/b grammar. Glyphs use
 * their actual prepared command arrays directly; text is never parsed or reshaped. */
function panelCommands(ass: string): Command[] {
  if (ass.length > 65_536) throw Error("TRACKED_TEXT_PANEL_BUDGET");
  const tokens = ass.trim().split(/\s+/), commands: Command[] = []; let i = 0, op = "", open = false;
  while (i < tokens.length) {
    if (["m", "l", "b"].includes(tokens[i])) op = tokens[i++];
    const count = op === "b" ? 6 : op === "m" || op === "l" ? 2 : 0;
    if (!count || i + count > tokens.length) throw Error("TRACKED_TEXT_PANEL_GRAMMAR");
    const values = tokens.slice(i, i + count).map(v => /^-?\d+(?:\.\d+)?$/.test(v) ? Number(v) : NaN); i += count;
    if (!values.every(Number.isFinite)) throw Error("TRACKED_TEXT_PANEL_GRAMMAR");
    if (op === "m") { if (open) commands.push({ type: "Z" }); commands.push({ type: "M", x: values[0], y: values[1] }); open = true; op = "l"; }
    else if (!open) throw Error("TRACKED_TEXT_PANEL_GRAMMAR");
    else if (op === "l") commands.push({ type: "L", x: values[0], y: values[1] });
    else commands.push({ type: "C", x1: values[0], y1: values[1], x2: values[2], y2: values[3], x: values[4], y: values[5] });
  }
  if (open) commands.push({ type: "Z" }); return commands;
}
function distance(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x, dy = b.y - a.y, square = dx * dx + dy * dy;
  const t = square ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / square)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
function paths(commands: readonly Command[]) {
  const svg: string[] = [], ass: string[] = []; let start: Point | undefined;
  for (const c of commands) {
    if (c.type === "Z") { if (!start) throw Error("TRACKED_TEXT_CONTOUR_INVALID"); svg.push("Z"); ass.push(`l ${start.x} ${start.y}`); start = undefined; continue; }
    if (c.type === "M") { if (start) throw Error("TRACKED_TEXT_CONTOUR_INVALID"); start = c; }
    else if (!start) throw Error("TRACKED_TEXT_CONTOUR_INVALID");
    const values = c.type === "C" ? [c.x1, c.y1, c.x2, c.y2, c.x, c.y] : [c.x, c.y];
    svg.push(c.type + " " + values.join(" ")); ass.push((c.type === "C" ? "b" : c.type.toLowerCase()) + " " + values.join(" "));
  }
  if (start) throw Error("TRACKED_TEXT_CONTOUR_INVALID"); return { svg: svg.join(" "), ass: ass.join(" ") };
}

/** One geometry function feeds actual SVG and ASS consumers. Surface cubics are
 * positive-weight rational Beziers; their projected control hull bounds error. */
export function trackedPhysicalTextFrameV1(project: EditProject, graphic: MotionGraphic, layout: MotionGraphicV2LayoutReceipt,
  timelineFrame: number, camera: Camera): TrackedTextFrameV1 {
  assertTrackedTextBindingV1(graphic);
  if (!Number.isSafeInteger(timelineFrame) || !layout.physicalFont || layout.segments.some(s => !s.outline)) throw Error("TRACKED_TEXT_PHYSICAL_LAYOUT_REQUIRED");
  const frame = motionGraphicV2FrameReceipt(project, graphic, timelineFrame, layout), binding = graphic.vectorTrackingV1!;
  const result: TrackedTextFrameV1 = { schema: "editkin.tracked-text-frame/v1", timelineFrame, visible: false,
    trackId: binding.trackId, mode: binding.mode, fontSha256: layout.physicalFont.fontSha256, paths: [] };
  const projectPoint = projection(project, graphic, timelineFrame, camera);
  if (!frame.visible || !projectPoint) return result;
  const output: TrackedTextPathV1[] = []; let used = 0;
  const draw = (source: readonly Command[], pose: (p: Point) => Point, slot: number, layer: 1 | 2, color: string, opacity: number, blurPixels = 0) => {
    if (opacity <= .001 || !source.length) return;
    const commands: Command[] = []; let prior: Point | undefined;
    const emit = (c: Command) => { if (++used > TRACKED_TEXT_COMMAND_BUDGET_V1) throw Error("TRACKED_TEXT_COMMAND_BUDGET"); commands.push(c); };
    const curve = (a: Point, b: Point, c: Point, d: Point, depth: number) => {
      const projected = [a, b, c, d].map(projectPoint);
      if (Math.max(distance(projected[1], projected[0], projected[3]), distance(projected[2], projected[0], projected[3])) <= TRACKED_TEXT_CURVE_ERROR_PIXELS_V1) {
        emit({ type: "L", ...canonical(projected[3]) }); return;
      }
      if (depth === 12) throw Error("TRACKED_TEXT_CURVE_PRECISION_BUDGET");
      const ab = midpoint(a, b), bc = midpoint(b, c), cd = midpoint(c, d), abc = midpoint(ab, bc), bcd = midpoint(bc, cd), mid = midpoint(abc, bcd);
      curve(a, ab, abc, mid, depth + 1); curve(mid, bcd, cd, d, depth + 1);
    };
    for (const c of source) {
      if (c.type === "Z") { emit(c); prior = undefined; continue; }
      const end = pose(c);
      if (c.type === "M") { emit({ type: "M", ...canonical(projectPoint(end)) }); prior = end; continue; }
      if (!prior) throw Error("TRACKED_TEXT_CONTOUR_INVALID");
      if (c.type === "C") {
        const a = pose({ x: c.x1, y: c.y1 }), b = pose({ x: c.x2, y: c.y2 });
        if (binding.mode === "surface") curve(prior, a, b, end, 0);
        else { const p = canonical(projectPoint(a)), q = canonical(projectPoint(b)); emit({ type: "C", x1: p.x, y1: p.y, x2: q.x, y2: q.y, ...canonical(projectPoint(end)) }); }
      } else emit({ type: "L", ...canonical(projectPoint(end)) });
      prior = end;
    }
    output.push({ slot, layer, color, opacity, blurPixels, commands, ...paths(commands) });
  };
  if (frame.backgroundOpacity > .001 && !/^#[0-9a-f]{6}00$/i.test(graphic.backgroundColor)) {
    const panel = motionPanelPaths(layout.box.width, layout.box.height, graphic.cornerRadius ?? 10, graphic.outlineWidth ?? 2);
    const pose = (p: Point) => ({ x: layout.box.x + p.x, y: layout.box.y + p.y });
    draw(panelCommands(panel.fillAss), pose, 0, 1, graphic.backgroundColor, frame.backgroundOpacity);
    if (panel.borderAss) draw(panelCommands(panel.borderAss), pose, 1, 1, graphic.accentColor, frame.backgroundOpacity);
  }
  const states = new Map(frame.segments.map(s => [s.segmentId, s]));
  layout.segments.forEach((segment, i) => {
    const state = states.get(segment.id); if (!state) throw Error("TRACKED_TEXT_FRAME_SEGMENT_MISSING");
    const radians = (state.rotationDegrees ?? 0) * Math.PI / 180, c = Math.cos(radians), s = Math.sin(radians);
    const pose = (offset: number) => (p: Point) => {
      const x = (p.x - segment.width / 2) * state.scale, y = (p.y - segment.height / 2) * state.scale;
      return { x: segment.x + state.translateXPixels + offset + segment.width * state.scale / 2 + c * x - s * y,
        y: segment.y + state.translateYPixels + offset + segment.height * state.scale / 2 + s * x + c * y };
    };
    const motionBlur = (state.blurPixels ?? 0) * camera.scale;
    if (graphic.shadowDepth) draw(segment.outline!.commands, pose(graphic.shadowDepth * state.scale), 2 + 2 * i, 2, graphic.accentColor, state.opacity,
      Math.hypot(motionBlur, (graphic.shadowBlurPixels ?? 0) * state.scale * camera.scale));
    draw(segment.outline!.commands, pose(0), 3 + 2 * i, 2, graphic.textColor, state.opacity, motionBlur);
  });
  return { ...result, visible: true, paths: output };
}
