import type { MotionGraphic, MotionVectorShapeCommand } from "../domain/types";
import { assertMotionPaintContract } from "../domain/motionPaint";
import type { MotionGraphicV2FrameReceipt, MotionGraphicV2LayoutReceipt } from "./compositionV2";
import { motionPanelPaths, motionPanelContourCommands } from "./panelGeometry";
import type { NativeVectorPath } from "./nativeGlyphPaint";
import type { PreparedGlyphPathCommand } from "../typography/preparedGlyphRun";
import { connectionFieldGeometry } from "./connectionField";
import { springGeometryPaths } from "./springGeometryPaths";

export interface MotionVectorPath { color: string; ass: string; svg: string;
  /** Box-local visible rectangle while a shape wipes in; absent when fully shown. */
  clip?: { x0: number; y0: number; x1: number; y1: number } }
const r = (value: number) => Math.round(value * 100) / 100;

export function shapeBounds(commands: readonly MotionVectorShapeCommand[]) {
  const xs: number[] = [], ys: number[] = [];
  for (const command of commands) {
    if (command.type === "Z") continue;
    if (command.type === "C") { xs.push(command.x1, command.x2, command.x); ys.push(command.y1, command.y2, command.y); }
    else { xs.push(command.x); ys.push(command.y); }
  }
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** Authored shape contours as one non-zero fill for both libass and SVG. */
export function shapePaths(commands: readonly MotionVectorShapeCommand[]): { ass: string; svg: string } {
  const ass: string[] = [], svg: string[] = [];
  for (const command of commands) {
    if (command.type === "Z") { svg.push("Z"); continue; }
    const p = command.type === "C" ? [command.x1, command.y1, command.x2, command.y2, command.x, command.y].map(r) : [command.x, command.y].map(r);
    ass.push(`${command.type === "M" ? "m" : command.type === "L" ? "l" : "b"} ${p.join(" ")}`);
    svg.push(`${command.type} ${p.join(" ")}`);
  }
  return { ass: ass.join(" "), svg: svg.join(" ") };
}

/** Cubic ellipse contours are authored here once for SVG and libass. */
function ellipseCommands(cx: number, cy: number, rx: number, ry: number) {
  const k = .5522847498;
  const commands = [
    { op: "m", p: [cx + rx, cy] },
    { op: "b", p: [cx + rx, cy + ry * k, cx + rx * k, cy + ry, cx, cy + ry] },
    { op: "b", p: [cx - rx * k, cy + ry, cx - rx, cy + ry * k, cx - rx, cy] },
    { op: "b", p: [cx - rx, cy - ry * k, cx - rx * k, cy - ry, cx, cy - ry] },
    { op: "b", p: [cx + rx * k, cy - ry, cx + rx, cy - ry * k, cx + rx, cy] },
  ];
  return commands;
}
function ellipse(cx: number, cy: number, rx: number, ry: number) {
  const commands = ellipseCommands(cx, cy, rx, ry);
  return {
    ass: commands.map(c => `${c.op} ${c.p.map(r).join(" ")}`).join(" "),
    svg: commands.map(c => `${c.op === "b" ? "C" : "M"} ${c.p.map(r).join(" ")}`).join(" ") + " Z",
  };
}

type StrokePoint = { x: number; y: number };
type StrokeRun = { points: StrokePoint[]; closed: boolean };

/** Authored centerline commands as polylines (cubics in fixed steps, so every frame flattens identically). */
function strokeSubpaths(commands: readonly MotionVectorShapeCommand[]): StrokeRun[] {
  const runs: StrokeRun[] = [];
  let current: StrokeRun | undefined, last: StrokePoint = { x: 0, y: 0 };
  for (const command of commands) {
    if (command.type === "M") { current = { points: [{ x: command.x, y: command.y }], closed: false }; runs.push(current); last = { x: command.x, y: command.y }; continue; }
    if (!current) continue;
    if (command.type === "L") { current.points.push({ x: command.x, y: command.y }); last = { x: command.x, y: command.y }; }
    else if (command.type === "C") {
      for (let step = 1; step <= 24; step++) {
        const t = step / 24, u = 1 - t;
        current.points.push({ x: u * u * u * last.x + 3 * u * u * t * command.x1 + 3 * u * t * t * command.x2 + t * t * t * command.x,
          y: u * u * u * last.y + 3 * u * u * t * command.y1 + 3 * u * t * t * command.y2 + t * t * t * command.y });
      }
      last = { x: command.x, y: command.y };
    } else {
      const first = current.points[0];
      if (Math.hypot(first.x - last.x, first.y - last.y) > 1e-6) current.points.push({ ...first });
      current.closed = true; last = { ...first };
    }
  }
  return runs.map(run => ({ ...run, points: run.points.filter((p, i, all) => i === 0 || Math.hypot(p.x - all[i - 1].x, p.y - all[i - 1].y) > 1e-6) }))
    .filter(run => run.points.length >= 2);
}

const strokeLength = (run: StrokeRun) => run.points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - run.points[i].x, p.y - run.points[i].y), 0);

/** The drawn part between lengths a and b, in drawing order across subpaths. */
function strokeRange(runs: readonly StrokeRun[], a: number, b: number): StrokeRun[] {
  const out: StrokeRun[] = [];
  let offset = 0;
  for (const run of runs) {
    const part: StrokePoint[] = [];
    let acc = offset;
    for (let i = 1; i < run.points.length; i++) {
      const p0 = run.points[i - 1], p1 = run.points[i], length = Math.hypot(p1.x - p0.x, p1.y - p0.y), s0 = acc, s1 = acc + length;
      if (s1 > a && s0 < b && length > 0) {
        const t0 = Math.max(0, (a - s0) / length), t1 = Math.min(1, (b - s0) / length);
        if (!part.length) part.push({ x: p0.x + (p1.x - p0.x) * t0, y: p0.y + (p1.y - p0.y) * t0 });
        part.push({ x: p0.x + (p1.x - p0.x) * t1, y: p0.y + (p1.y - p0.y) * t1 });
      }
      acc = s1;
    }
    if (part.length >= 2) out.push({ points: part, closed: run.closed && a <= offset + 1e-6 && b >= acc - 1e-6 });
    offset = acc;
  }
  return out;
}

/** One band polygon per run (left side forward, right side back, round or butt caps) plus round joins at sharp turns;
 * every contour is wound the same way so libass and SVG fill the union with the non-zero rule. */
function strokeOutline(run: StrokeRun, half: number, cap: "round" | "butt"): Array<{ ass: string; svg: string }> {
  const points = run.points, n = points.length;
  const normals = points.slice(1).map((p, i) => { const dx = p.x - points[i].x, dy = p.y - points[i].y, l = Math.hypot(dx, dy) || 1; return { x: -dy / l, y: dx / l }; });
  const left: StrokePoint[] = [], right: StrokePoint[] = [], joins: StrokePoint[] = [];
  for (let i = 0; i < n; i++) {
    const before = i > 0 ? normals[i - 1] : run.closed ? normals[normals.length - 1] : undefined;
    const after = i < n - 1 ? normals[i] : run.closed ? normals[0] : undefined;
    let nx = (before?.x ?? 0) + (after?.x ?? 0), ny = (before?.y ?? 0) + (after?.y ?? 0);
    const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
    // Clamped miter: the offset grows as the corner tightens, up to twice the half width.
    const cos = before && after ? Math.max(.5, nx * after.x + ny * after.y) : 1;
    if (before && after && before.x * after.x + before.y * after.y < .64) joins.push(points[i]);
    left.push({ x: points[i].x + nx * half / cos, y: points[i].y + ny * half / cos });
    right.push({ x: points[i].x - nx * half / cos, y: points[i].y - ny * half / cos });
  }
  const arc = (center: StrokePoint, from: StrokePoint, sweep: number) => {
    const start = Math.atan2(from.y - center.y, from.x - center.x);
    return Array.from({ length: 8 }, (_, k) => { const angle = start + sweep * (k + 1) / 9; return { x: center.x + Math.cos(angle) * half, y: center.y + Math.sin(angle) * half }; });
  };
  const capped = cap === "round" && !run.closed;
  const endCap = capped ? arc(points[n - 1], left[n - 1], -Math.PI) : [];
  const startCap = capped ? arc(points[0], right[0], -Math.PI) : [];
  let polygon = [...left, ...endCap, ...right.reverse(), ...startCap];
  const area = polygon.reduce((sum, p, i) => { const q = polygon[(i + 1) % polygon.length]; return sum + p.x * q.y - q.x * p.y; }, 0);
  if (area < 0) polygon = polygon.reverse();
  const contours = [{ ass: `m ${r(polygon[0].x)} ${r(polygon[0].y)} l ${polygon.slice(1).map(p => `${r(p.x)} ${r(p.y)}`).join(" ")}`,
    svg: `M ${r(polygon[0].x)} ${r(polygon[0].y)} L ${polygon.slice(1).map(p => `${r(p.x)} ${r(p.y)}`).join(" ")} Z` }];
  return [...contours, ...joins.map(p => ellipse(p.x, p.y, half, half))];
}

/** In-out cubic pen speed: a stroke starts and lands gently, like a hand drawing it. */
const penProgress = (t: number) => t < .5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

/** Static typed geometry only. Animated reveal/deformation needs its own retained track,
 * so those kinds cannot silently reuse an unchanging native path. */
export function motionStaticVectorPath(graphic: MotionGraphic, layout: MotionGraphicV2LayoutReceipt): NativeVectorPath {
  assertMotionPaintContract(graphic);
  const vector = graphic.vectorV2;
  if (!vector || !["editkin.motion-vector/v1", "editkin.motion-vector-stage/v1"].includes(vector.schema) || vector.revealFrames !== 1
    || !["panel", "ellipse", "rule"].includes(vector.kind)) throw new Error("Native paint requires a supported static typed vector");
  const { width, height } = layout.box;
  const commands: readonly PreparedGlyphPathCommand[] = vector.kind === "ellipse"
    ? [...ellipseCommands(width / 2, height / 2, width / 2, height / 2).map((command): PreparedGlyphPathCommand => {
      const p = command.p.map(r);
      return command.op === "b" ? { type: "C", x1: p[0], y1: p[1], x2: p[2], y2: p[3], x: p[4], y: p[5] }
        : { type: "M", x: p[0], y: p[1] };
    }), { type: "Z" }]
    : motionPanelContourCommands(width, height, graphic.cornerRadius ?? 8);
  return { commands, fill_rule: "non_zero" };
}

/** Integer-frame geometry, independent of seek order and browser clocks. */
export function motionVectorPaths(graphic: MotionGraphic, layout: MotionGraphicV2LayoutReceipt, frame: MotionGraphicV2FrameReceipt): MotionVectorPath[] {
  const vector = graphic.vectorV2;
  if (!vector || !frame.visible || !frame.vectorState || frame.vectorState.opacity <= .001) return [];
  if (vector.kind === "spring_panel") return springGeometryPaths(graphic, layout, frame);
  const { width, height } = layout.box;
  const progress = vector.revealFrames === 1 ? 1 : Math.max(0, Math.min(1, frame.localFrame / (vector.revealFrames - 1)));
  const reveal = 1 - (1 - progress) ** 3;
  const radius = graphic.cornerRadius ?? 8;
  if (vector.kind === "connection_field") {
    const geometry = connectionFieldGeometry(vector, width, height, frame.localFrame);
    const edgeShapes = geometry.edges.flatMap(({ from, to }) => {
      const dx = to.x - from.x, dy = to.y - from.y, length = Math.hypot(dx, dy);
      if (length < .1) return [];
      const ox = -dy / length * vector.lineWidthPixels / 2, oy = dx / length * vector.lineWidthPixels / 2;
      const coordinates = [[from.x + ox, from.y + oy], [to.x + ox, to.y + oy], [to.x - ox, to.y - oy], [from.x - ox, from.y - oy]];
      return [{ ass: `m ${coordinates[0].map(r).join(" ")} l ${coordinates.slice(1).flat().map(r).join(" ")}`,
        svg: `M ${coordinates[0].map(r).join(" ")} L ${coordinates.slice(1).flat().map(r).join(" ")} Z` }];
    });
    const paths: MotionVectorPath[] = [];
    if (edgeShapes.length) paths.push({ color: graphic.backgroundColor, ass: edgeShapes.map(p => p.ass).join(" "), svg: edgeShapes.map(p => p.svg).join(" ") });
    for (const group of [2, 1, 0]) {
      const nodes = geometry.points.filter(p => p.group === group).map(p => ellipse(p.x, p.y, p.radius, p.radius));
      paths.push({ color: vector.groupColors?.[group] ?? (group === 0 ? graphic.accentColor : graphic.textColor),
        ass: nodes.map(p => p.ass).join(" "), svg: nodes.map(p => p.svg).join(" ") });
    }
    if (geometry.connect > 0) paths.push({ color: graphic.accentColor, ...ellipse(geometry.center.x, geometry.center.y,
      vector.dotRadiusPixels * (1 + geometry.connect * 1.7), vector.dotRadiusPixels * (1 + geometry.connect * 1.7)) });
    return paths;
  }
  if (vector.kind === "step_progress") {
    const cellWidth = (width - vector.gapPixels * (vector.steps - 1)) / vector.steps;
    const background = [], foreground = [];
    const fill = vector.activeStep * reveal;
    for (let i = 0; i < vector.steps; i += 1) {
      const origin = { x: i * (cellWidth + vector.gapPixels), y: 0 };
      background.push(motionPanelPaths(cellWidth, height, radius, 0, origin));
      const filledWidth = cellWidth * Math.max(0, Math.min(1, fill - i));
      if (filledWidth > .01) foreground.push(motionPanelPaths(filledWidth, height, radius, 0, origin));
    }
    return [
      { color: graphic.backgroundColor, ass: background.map(p => p.fillAss).join(" "), svg: background.map(p => p.fillSvg).join(" ") },
      ...(foreground.length ? [{ color: graphic.accentColor, ass: foreground.map(p => p.fillAss).join(" "), svg: foreground.map(p => p.fillSvg).join(" ") }] : []),
    ];
  }
  if (vector.kind === "line_grid") {
    const buckets: Array<Array<{ ass: string; svg: string }>> = [[], []];
    const line = (x0: number, y0: number, x1: number, y1: number, major: boolean) => {
      const coordinates = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
      buckets[major ? 1 : 0].push({ ass: `m ${coordinates[0].map(r).join(" ")} l ${coordinates.slice(1).flat().map(r).join(" ")}`,
        svg: `M ${coordinates[0].map(r).join(" ")} L ${coordinates.slice(1).flat().map(r).join(" ")} Z` });
    };
    if (Math.ceil(width / vector.spacingPixels) + Math.ceil(height / vector.spacingPixels) > 256) throw new Error("網格超出每層 256 線預算");
    // Inset half a cell so no line straddles the clipping edge. The background
    // stays still: its lattice supplies spatial structure without camera sway.
    for (let axis = 0; axis < 2; axis++) {
      const limit = axis === 0 ? width : height;
      for (let index = 0, position = vector.spacingPixels / 2; position < limit; position += vector.spacingPixels, index++) {
        const major = index % vector.majorEvery === 0, half = vector.lineWidthPixels * (major ? 1.25 : 1) / 2;
        if (axis === 0) line(Math.max(0, position - half), 0, Math.min(width, position + half), height, major);
        else line(0, Math.max(0, position - half), width, Math.min(height, position + half), major);
      }
    }
    return buckets.flatMap((paths, index) => paths.length ? [{ color: index ? graphic.textColor : graphic.accentColor,
      ass: paths.map(p => p.ass).join(" "), svg: paths.map(p => p.svg).join(" ") }] : []);
  }
  if (vector.kind === "dot_grid") {
    const dots = [];
    for (let y = vector.spacingPixels / 2; y + vector.dotRadiusPixels <= height; y += vector.spacingPixels) {
      for (let x = vector.spacingPixels / 2; x + vector.dotRadiusPixels <= width; x += vector.spacingPixels) {
        dots.push(ellipse(x, y, vector.dotRadiusPixels, vector.dotRadiusPixels));
        if (dots.length > 512) throw new Error("點陣超出每層 512 點預算");
      }
    }
    return dots.length ? [{ color: graphic.accentColor, ass: dots.map(d => d.ass).join(" "), svg: dots.map(d => d.svg).join(" ") }] : [];
  }
  if (vector.kind === "stroke") {
    // The drawn length advances with a hand-like in-out pace over revealFrames, then holds; the pen tip shows only while drawing.
    const runs = strokeSubpaths(vector.commands), total = runs.reduce((sum, run) => sum + strokeLength(run), 0);
    const pen = vector.revealFrames <= 1 ? 1 : penProgress(progress);
    const from = (vector.from ?? 0) * total, head = from + ((vector.to ?? 1) - (vector.from ?? 0)) * total * pen;
    const drawn = head - from > .01 ? strokeRange(runs, from, head) : [];
    const contours = drawn.flatMap(run => strokeOutline(run, vector.widthPixels / 2, vector.cap ?? "round"));
    const paths: MotionVectorPath[] = contours.length ? [{ color: graphic.backgroundColor, ass: contours.map(c => c.ass).join(" "), svg: contours.map(c => c.svg).join(" ") }] : [];
    const tip = vector.tipRadiusPixels ?? 0, last = drawn.at(-1)?.points.at(-1);
    if (tip > 0 && last && pen > 0 && pen < 1) paths.push({ color: graphic.accentColor, ...ellipse(last.x, last.y, tip, tip) });
    return paths;
  }
  if (vector.kind === "ellipse") return [{ color: graphic.backgroundColor, ...ellipse(width / 2, height / 2, width / 2, height / 2) }];
  if (vector.kind === "shape") {
    const paths = { color: graphic.backgroundColor, ...shapePaths(vector.commands) };
    if (vector.revealFrames <= 1 || progress >= 1) return [paths];
    // Wipe reveal: one growing rectangle uncovers the shape from the chosen edge.
    const bounds = shapeBounds(vector.commands), wipe = 1 - (1 - progress) ** 4;
    const from = vector.revealFrom ?? "left", w = bounds.x1 - bounds.x0, h = bounds.y1 - bounds.y0;
    const clip = from === "left" ? { ...bounds, x1: bounds.x0 + w * wipe } : from === "right" ? { ...bounds, x0: bounds.x1 - w * wipe }
      : from === "top" ? { ...bounds, y1: bounds.y0 + h * wipe } : { ...bounds, y0: bounds.y1 - h * wipe };
    return clip.x1 - clip.x0 > .01 && clip.y1 - clip.y0 > .01 ? [{ ...paths, clip }] : [];
  }
  const drawnWidth = vector.kind === "rule" ? width * reveal : width;
  if (drawnWidth <= .01) return [];
  const paths = motionPanelPaths(drawnWidth, height, radius, vector.kind === "panel" ? graphic.outlineWidth ?? 0 : 0);
  return [
    { color: vector.kind === "rule" ? graphic.accentColor : graphic.backgroundColor, ass: paths.fillAss, svg: paths.fillSvg },
    ...(paths.borderAss ? [{ color: graphic.accentColor, ass: paths.borderAss, svg: paths.borderSvg }] : []),
  ];
}
