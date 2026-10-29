import type { V3PathCommand, V3Rect } from "./types";

/** Cubic Bézier constant for a quarter circle. */
const K = .5522847498;
const round = (value: number): number => Math.round(value * 100) / 100;

export function rectPath(x: number, y: number, width: number, height: number): V3PathCommand[] {
  if (width <= 0 || height <= 0) return [];
  return [
    { op: "m", points: [x, y] }, { op: "l", points: [x + width, y] },
    { op: "l", points: [x + width, y + height] }, { op: "l", points: [x, y + height] },
  ];
}

/** Rounded rectangle; `radii` = [top-left, top-right, bottom-right, bottom-left]. */
export function roundRectPath(x: number, y: number, width: number, height: number, radius: number | [number, number, number, number]): V3PathCommand[] {
  if (width <= 0 || height <= 0) return [];
  const limit = Math.min(width, height) / 2;
  const [tl, tr, br, bl] = (Array.isArray(radius) ? radius : [radius, radius, radius, radius]).map(r => Math.max(0, Math.min(r, limit)));
  return [
    { op: "m", points: [x + tl, y] },
    { op: "l", points: [x + width - tr, y] },
    { op: "b", points: [x + width - tr + tr * K, y, x + width, y + tr - tr * K, x + width, y + tr] },
    { op: "l", points: [x + width, y + height - br] },
    { op: "b", points: [x + width, y + height - br + br * K, x + width - br + br * K, y + height, x + width - br, y + height] },
    { op: "l", points: [x + bl, y + height] },
    { op: "b", points: [x + bl - bl * K, y + height, x, y + height - bl + bl * K, x, y + height - bl] },
    { op: "l", points: [x, y + tl] },
    { op: "b", points: [x, y + tl - tl * K, x + tl - tl * K, y, x + tl, y] },
  ];
}

export function ellipsePath(cx: number, cy: number, rx: number, ry: number): V3PathCommand[] {
  if (rx <= 0 || ry <= 0) return [];
  return [
    { op: "m", points: [cx + rx, cy] },
    { op: "b", points: [cx + rx, cy + ry * K, cx + rx * K, cy + ry, cx, cy + ry] },
    { op: "b", points: [cx - rx * K, cy + ry, cx - rx, cy + ry * K, cx - rx, cy] },
    { op: "b", points: [cx - rx, cy - ry * K, cx - rx * K, cy - ry, cx, cy - ry] },
    { op: "b", points: [cx + rx * K, cy - ry, cx + rx, cy - ry * K, cx + rx, cy] },
  ];
}

export const circlePath = (cx: number, cy: number, r: number): V3PathCommand[] => ellipsePath(cx, cy, r, r);

/** A closed polygon from a point list. */
export function polygonPath(points: Array<[number, number]>): V3PathCommand[] {
  if (points.length < 3) return [];
  return points.map(([x, y], index) => ({ op: index === 0 ? "m" : "l", points: [x, y] }));
}

/** A stroked open polyline as a filled outline (both adapters only fill). */
export function strokePolylinePath(points: Array<[number, number]>, width: number): V3PathCommand[] {
  const clean = points.filter((point, index) => index === 0 || Math.hypot(point[0] - points[index - 1][0], point[1] - points[index - 1][1]) > 1e-6);
  if (clean.length < 2 || width <= 0) return [];
  const half = width / 2;
  const normals = clean.map((point, index) => {
    const before = clean[Math.max(0, index - 1)], after = clean[Math.min(clean.length - 1, index + 1)];
    const dx = after[0] - before[0], dy = after[1] - before[1], length = Math.hypot(dx, dy) || 1;
    return [-dy / length * half, dx / length * half] as [number, number];
  });
  const left = clean.map((point, index) => [point[0] + normals[index][0], point[1] + normals[index][1]] as [number, number]);
  const right = clean.map((point, index) => [point[0] - normals[index][0], point[1] - normals[index][1]] as [number, number]).reverse();
  return polygonPath([...left, ...right]);
}

/** Arc stroke from angle a0 to a1 (radians, clockwise on screen) with flat caps. */
export function arcStrokePath(cx: number, cy: number, radius: number, a0: number, a1: number, width: number): V3PathCommand[] {
  if (Math.abs(a1 - a0) < 1e-4 || width <= 0) return [];
  const steps = Math.max(8, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 32)));
  const outer: Array<[number, number]> = [], inner: Array<[number, number]> = [];
  for (let index = 0; index <= steps; index += 1) {
    const angle = a0 + (a1 - a0) * index / steps;
    outer.push([cx + Math.cos(angle) * (radius + width / 2), cy + Math.sin(angle) * (radius + width / 2)]);
    inner.push([cx + Math.cos(angle) * (radius - width / 2), cy + Math.sin(angle) * (radius - width / 2)]);
  }
  return polygonPath([...outer, ...inner.reverse()]);
}

export function pathBounds(path: V3PathCommand[]): V3Rect | undefined {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const command of path) {
    for (let index = 0; index < command.points.length; index += 2) {
      minX = Math.min(minX, command.points[index]); maxX = Math.max(maxX, command.points[index]);
      minY = Math.min(minY, command.points[index + 1]); maxY = Math.max(maxY, command.points[index + 1]);
    }
  }
  return Number.isFinite(minX) ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : undefined;
}

/** libass aligns a drawing by its bounding box, so emit it relative to that box. */
export function pathToAss(path: V3PathCommand[], originX: number, originY: number): string {
  return path.map(command => `${command.op} ${command.points.map((value, index) => round(value - (index % 2 === 0 ? originX : originY))).join(" ")}`).join(" ");
}

export function pathToSvg(path: V3PathCommand[]): string {
  const parts: string[] = [];
  for (const command of path) {
    if (command.op === "m" && parts.length) parts.push("Z");
    parts.push(`${command.op === "b" ? "C" : command.op.toUpperCase()} ${command.points.map(round).join(" ")}`);
  }
  if (parts.length) parts.push("Z");
  return parts.join(" ");
}

export function translatePath(path: V3PathCommand[], dx: number, dy: number): V3PathCommand[] {
  return path.map(command => ({ op: command.op, points: command.points.map((value, index) => value + (index % 2 === 0 ? dx : dy)) }));
}

/** Scale around (cx, cy). */
export function scalePath(path: V3PathCommand[], scaleX: number, scaleY: number, cx: number, cy: number): V3PathCommand[] {
  return path.map(command => ({ op: command.op, points: command.points.map((value, index) => index % 2 === 0 ? cx + (value - cx) * scaleX : cy + (value - cy) * scaleY) }));
}

/** The same contour traversed backwards (an inner contour of a ring must wind the other way). */
export function reversePath(path: V3PathCommand[]): V3PathCommand[] {
  if (!path.length) return [];
  const ends = path.map(command => command.points.slice(-2));
  const reversed: V3PathCommand[] = [{ op: "m", points: ends.at(-1)! }];
  for (let index = path.length - 1; index > 0; index -= 1) {
    const command = path[index], previousEnd = ends[index - 1];
    reversed.push(command.op === "b"
      ? { op: "b", points: [command.points[2], command.points[3], command.points[0], command.points[1], ...previousEnd] }
      : { op: "l", points: previousEnd });
  }
  return reversed;
}

/** A rounded-rectangle outline of `stroke` width (outer contour plus reversed inner contour). */
export function roundRectRingPath(x: number, y: number, width: number, height: number, radius: number, stroke: number): V3PathCommand[] {
  if (stroke <= 0 || width <= stroke * 2 || height <= stroke * 2) return [];
  return [...roundRectPath(x, y, width, height, radius),
    ...reversePath(roundRectPath(x + stroke, y + stroke, width - stroke * 2, height - stroke * 2, Math.max(0, radius - stroke)))];
}

/** Concatenate subpaths into one shape (filled with the nonzero rule). */
export const joinPaths = (...paths: V3PathCommand[][]): V3PathCommand[] => paths.flat();

/** A circular ring of `stroke` width (outer circle plus reversed inner circle). */
export function ringPath(cx: number, cy: number, radius: number, stroke: number): V3PathCommand[] {
  if (radius <= 0 || stroke <= 0) return [];
  if (stroke >= radius) return ellipsePath(cx, cy, radius, radius);
  return [...ellipsePath(cx, cy, radius, radius), ...reversePath(ellipsePath(cx, cy, radius - stroke, radius - stroke))];
}

/** Map-pin silhouette: a circle of `radius` at (cx, cy) whose tangents meet at the tip below it. */
export function pinPath(cx: number, cy: number, radius: number, tipY: number, holeRadius = 0): V3PathCommand[] {
  const distance = tipY - cy;
  if (radius <= 0 || distance <= radius) return [];
  const alpha = Math.acos(radius / distance);
  const start = Math.PI / 2 + alpha, sweep = Math.PI * 2 - alpha * 2, steps = 40;
  const points: Array<[number, number]> = [[cx, tipY]];
  for (let index = 0; index <= steps; index += 1) {
    const angle = start + sweep * index / steps;
    points.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius]);
  }
  const outline = polygonPath(points);
  return holeRadius > 0 ? [...outline, ...reversePath(ellipsePath(cx, cy, holeRadius, holeRadius))] : outline;
}

export function polylineLength(points: Array<[number, number]>): number {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) length += Math.hypot(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1]);
  return length;
}

/** The first `length` pixels of a polyline, for lines that draw on. */
export function truncatePolyline(points: Array<[number, number]>, length: number): Array<[number, number]> {
  if (!points.length || length <= 0) return points.slice(0, 1);
  const result: Array<[number, number]> = [points[0]];
  let remaining = length;
  for (let index = 1; index < points.length; index += 1) {
    const [x0, y0] = points[index - 1], [x1, y1] = points[index];
    const segment = Math.hypot(x1 - x0, y1 - y0);
    if (segment >= remaining) {
      const t = segment > 0 ? remaining / segment : 0;
      result.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
      return result;
    }
    result.push([x1, y1]);
    remaining -= segment;
  }
  return result;
}
