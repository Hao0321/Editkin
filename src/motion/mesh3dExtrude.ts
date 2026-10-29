import { ShapeUtils, Vector2 } from "three";
import type { Font, Glyph } from "opentype.js";

/**
 * Bevelled extrusion for glyphs, stars and rounded boxes (engine extension 2026-10-23).
 *
 * Unlike three's ExtrudeGeometry this keeps the letterform exact (the side wall
 * is the real outline, the caps are inset by the bevel) and writes analytic
 * normals: flat caps, a smooth quarter-round (or flat chamfer) bevel and side
 * walls that stay smooth along curves but crease at real corners. That is what
 * gives extruded type a clean bevel catch-light instead of faceted bands.
 */
export interface Mesh3dMeshData { positions: number[]; normals: number[]; uvs: number[]; indices: number[]; }
/** Closed polyline, flat [x0, y0, x1, y1, …], first point not repeated. */
export type Mesh3dPolyline = number[];
export interface Mesh3dShape2 { outer: Mesh3dPolyline; holes: Mesh3dPolyline[]; }
export interface Mesh3dBevelOptions {
  depth: number; bevelSize: number; bevelThickness: number; bevelSegments: number; profile: "round" | "chamfer";
  /** Turn angle (degrees) above which a side-wall vertex is split into a hard edge. */
  creaseDegrees: number;
  /** Planar UV frame [minX, minY, maxX, maxY]. */
  uvFrame: readonly [number, number, number, number];
  /** Polish: only front-facing vertices (normal z > 0) get UVs; the rest are NaN (untextured). */
  uvFrontOnly?: boolean;
}
interface PathCommand { type: string; x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number }

export function mesh3dSignedArea(poly: Mesh3dPolyline): number {
  let sum = 0;
  for (let i = 0, n = poly.length / 2; i < n; i++) { const j = (i + 1) % n; sum += poly[i * 2] * poly[j * 2 + 1] - poly[j * 2] * poly[i * 2 + 1]; }
  return sum / 2;
}
function reversed(poly: Mesh3dPolyline): Mesh3dPolyline {
  const out: number[] = [];
  for (let i = poly.length / 2 - 1; i >= 0; i--) out.push(poly[i * 2], poly[i * 2 + 1]);
  return out;
}
function pointInPolygon(x: number, y: number, poly: Mesh3dPolyline): boolean {
  let inside = false;
  for (let i = 0, n = poly.length / 2, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2], yi = poly[i * 2 + 1], xj = poly[j * 2], yj = poly[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** Remove repeated and (nearly) collinear points; drop the closing duplicate. */
export function mesh3dCleanPolyline(poly: Mesh3dPolyline, epsilon: number): Mesh3dPolyline {
  let points: number[] = [];
  for (let i = 0; i < poly.length; i += 2) {
    const n = points.length;
    if (n && Math.hypot(poly[i] - points[n - 2], poly[i + 1] - points[n - 1]) <= epsilon) continue;
    points.push(poly[i], poly[i + 1]);
  }
  while (points.length >= 4 && Math.hypot(points[0] - points[points.length - 2], points[1] - points[points.length - 1]) <= epsilon) points.length -= 2;
  for (let pass = 0; pass < 2 && points.length >= 8; pass++) {
    const kept: number[] = [], n = points.length / 2;
    for (let i = 0; i < n; i++) {
      const p = (i + n - 1) % n, q = (i + 1) % n;
      const ax = points[i * 2] - points[p * 2], ay = points[i * 2 + 1] - points[p * 2 + 1], bx = points[q * 2] - points[i * 2], by = points[q * 2 + 1] - points[i * 2 + 1];
      const cross = ax * by - ay * bx, la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      // Keep anything that turns by more than ~0.3 degrees, or that reverses direction.
      if (Math.abs(cross) <= la * lb * .005 && ax * bx + ay * by > 0) continue;
      kept.push(points[i * 2], points[i * 2 + 1]);
    }
    if (kept.length >= 6) points = kept;
  }
  return points;
}

/** Flatten opentype commands (font units, y-up) to closed polylines, subdividing curves to a chord tolerance. */
export function mesh3dFlattenCommands(commands: readonly PathCommand[], scale: number, offsetX: number, offsetY: number, tolerance: number, maxPerCurve: number): Mesh3dPolyline[] {
  const contours: Mesh3dPolyline[] = [];
  let current: number[] = [], px = 0, py = 0;
  const close = () => { if (current.length >= 6) contours.push(current); current = []; };
  const X = (v: number | undefined) => offsetX + (v ?? 0) * scale, Y = (v: number | undefined) => offsetY + (v ?? 0) * scale;
  for (const c of commands) {
    if (c.type === "M") { close(); px = X(c.x); py = Y(c.y); current.push(px, py); }
    else if (c.type === "L") { px = X(c.x); py = Y(c.y); current.push(px, py); }
    else if (c.type === "Q") {
      const x1 = X(c.x1), y1 = Y(c.y1), x = X(c.x), y = Y(c.y);
      const dd = Math.hypot(px - 2 * x1 + x, py - 2 * y1 + y);
      const n = Math.max(1, Math.min(maxPerCurve, Math.ceil(Math.sqrt(dd / (8 * tolerance)))));
      for (let i = 1; i <= n; i++) { const t = i / n, s = 1 - t; current.push(s * s * px + 2 * s * t * x1 + t * t * x, s * s * py + 2 * s * t * y1 + t * t * y); }
      px = x; py = y;
    } else if (c.type === "C") {
      const x1 = X(c.x1), y1 = Y(c.y1), x2 = X(c.x2), y2 = Y(c.y2), x = X(c.x), y = Y(c.y);
      const dd = Math.max(Math.hypot(px - 2 * x1 + x2, py - 2 * y1 + y2), Math.hypot(x1 - 2 * x2 + x, y1 - 2 * y2 + y));
      const n = Math.max(1, Math.min(maxPerCurve, Math.ceil(Math.sqrt(.75 * dd / tolerance))));
      for (let i = 1; i <= n; i++) {
        const t = i / n, s = 1 - t, a = s * s * s, b = 3 * s * s * t, d = 3 * s * t * t, e = t * t * t;
        current.push(a * px + b * x1 + d * x2 + e * x, a * py + b * y1 + d * y2 + e * y);
      }
      px = x; py = y;
    } else if (c.type === "Z") close();
  }
  close();
  return contours;
}

/**
 * Group closed contours into solids with holes by orientation (nonzero fonts may
 * overlap same-direction contours; each overlapping solid is kept and the z-buffer
 * forms the union). Output solids are clockwise and holes counter-clockwise (y-up).
 */
export function mesh3dGroupContours(contours: readonly Mesh3dPolyline[], epsilon: number): Mesh3dShape2[] {
  const clean = contours.map(c => mesh3dCleanPolyline(c, epsilon)).filter(c => c.length >= 6);
  const areas = clean.map(mesh3dSignedArea);
  const usable = clean.map((_, i) => i).filter(i => Math.abs(areas[i]) > epsilon * epsilon);
  if (!usable.length) return [];
  const largest = usable.reduce((best, i) => Math.abs(areas[i]) > Math.abs(areas[best]) ? i : best, usable[0]);
  const solidSign = Math.sign(areas[largest]);
  const solids = usable.filter(i => Math.sign(areas[i]) === solidSign);
  const shapes = new Map<number, Mesh3dShape2>(solids.map(i => [i, { outer: areas[i] < 0 ? clean[i] : reversed(clean[i]), holes: [] }]));
  for (const i of usable) {
    if (Math.sign(areas[i]) === solidSign) continue;
    const poly = clean[i], probes = [[poly[0], poly[1]], [(poly[0] + poly[2]) / 2, (poly[1] + poly[3]) / 2]];
    let owner = -1;
    for (const s of solids) {
      if (Math.abs(areas[s]) <= Math.abs(areas[i])) continue;
      if (!probes.some(([x, y]) => pointInPolygon(x, y, clean[s]))) continue;
      if (owner < 0 || Math.abs(areas[s]) < Math.abs(areas[owner])) owner = s;
    }
    if (owner >= 0) shapes.get(owner)!.holes.push(areas[i] > 0 ? poly : reversed(poly));
  }
  return [...shapes.values()];
}

interface Ring { inset: number; z: number; normal: (nx: number, ny: number) => [number, number, number] }
function profileBands(o: Mesh3dBevelOptions): Ring[][] {
  const half = o.depth / 2, B = o.bevelSize, T = o.bevelThickness, bevel = B > 1e-7 && T > 1e-7, bands: Ring[][] = [];
  const wallTop = bevel ? half - T : half;
  const side = (z: number): Ring => ({ inset: 0, z, normal: (nx, ny) => [nx, ny, 0] });
  const front: Ring[] = [];
  if (bevel && o.profile === "chamfer") {
    const length = Math.hypot(T, B), cz = B / length, cs = T / length;
    front.push({ inset: B, z: half, normal: (nx, ny) => [nx * cs, ny * cs, cz] }, { inset: 0, z: wallTop, normal: (nx, ny) => [nx * cs, ny * cs, cz] });
  } else if (bevel) {
    for (let k = 0; k <= o.bevelSegments; k++) {
      const t = k / o.bevelSegments * Math.PI / 2, s = Math.sin(t), c = Math.cos(t), a = T * s, b = B * c, l = Math.hypot(a, b);
      front.push({ inset: B * (1 - s), z: half - T * (1 - c), normal: (nx, ny) => [nx * a / l, ny * a / l, b / l] });
    }
  }
  for (let k = 0; k + 1 < front.length; k++) bands.push([front[k], front[k + 1]]);
  if (wallTop > 1e-7) bands.push([side(wallTop), side(-wallTop)]);
  const back = front.map(r => ({ inset: r.inset, z: -r.z, normal: (nx: number, ny: number) => { const n = r.normal(nx, ny); return [n[0], n[1], -n[2]] as [number, number, number]; } })).reverse();
  for (let k = 0; k + 1 < back.length; k++) bands.push([back[k], back[k + 1]]);
  return bands;
}

interface ContourFrame { n: number; xs: Float64Array; ys: Float64Array; mx: Float64Array; my: Float64Array; inX: Float64Array; inY: Float64Array; outX: Float64Array; outY: Float64Array; smooth: Uint8Array }
function contourFrame(poly: Mesh3dPolyline, creaseCos: number): ContourFrame {
  const n = poly.length / 2, xs = new Float64Array(n), ys = new Float64Array(n);
  for (let i = 0; i < n; i++) { xs[i] = poly[i * 2]; ys[i] = poly[i * 2 + 1]; }
  const ex = new Float64Array(n), ey = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, dx = xs[j] - xs[i], dy = ys[j] - ys[i], l = Math.hypot(dx, dy) || 1;
    ex[i] = -dy / l; ey[i] = dx / l; // outward: left of travel for CW solids and CCW holes (y-up)
  }
  const mx = new Float64Array(n), my = new Float64Array(n), inX = new Float64Array(n), inY = new Float64Array(n), outX = new Float64Array(n), outY = new Float64Array(n), smooth = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const p = (i + n - 1) % n, ax = ex[p], ay = ey[p], bx = ex[i], by = ey[i], dot = ax * bx + ay * by;
    let x = ax + bx, y = ay + by;
    if (1 + dot < 1e-3) { x = bx; y = by; } else { x /= 1 + dot; y /= 1 + dot; }
    const length = Math.hypot(x, y); if (length > 2.5) { x *= 2.5 / length; y *= 2.5 / length; }
    mx[i] = x; my[i] = y;
    if (dot >= creaseCos) {
      const l = Math.hypot(ax + bx, ay + by) || 1; inX[i] = outX[i] = (ax + bx) / l; inY[i] = outY[i] = (ay + by) / l; smooth[i] = 1;
    } else { inX[i] = ax; inY[i] = ay; outX[i] = bx; outY[i] = by; }
  }
  return { n, xs, ys, mx, my, inX, inY, outX, outY, smooth };
}

function pushTriangle(out: Mesh3dMeshData, a: number, b: number, c: number) {
  const p = out.positions, n = out.normals;
  const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
  const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
  const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
  const area = Math.hypot(gx, gy, gz);
  if (area < 1e-14) return;
  const sx = n[a * 3] + n[b * 3] + n[c * 3], sy = n[a * 3 + 1] + n[b * 3 + 1] + n[c * 3 + 1], sz = n[a * 3 + 2] + n[b * 3 + 2] + n[c * 3 + 2];
  if (gx * sx + gy * sy + gz * sz < 0) out.indices.push(a, c, b); else out.indices.push(a, b, c);
}
/** Append triangles with winding chosen so the geometric normal agrees with the shading normals (front = CCW). */
export function mesh3dPushOrientedTriangle(out: Mesh3dMeshData, a: number, b: number, c: number): void { pushTriangle(out, a, b, c); }

function vertex(out: Mesh3dMeshData, x: number, y: number, z: number, n: readonly number[], o: Mesh3dBevelOptions): number {
  const [x0, y0, x1, y1] = o.uvFrame, index = out.positions.length / 3;
  out.positions.push(x, y, z); out.normals.push(n[0], n[1], n[2]);
  if (o.uvFrontOnly && !(n[2] > 1e-6)) out.uvs.push(NaN, NaN);
  else out.uvs.push((x - x0) / Math.max(1e-9, x1 - x0), (y - y0) / Math.max(1e-9, y1 - y0));
  return index;
}

function segmentsCross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx), d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax), d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0)) && d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0;
}
/** Edge-direction flips plus segment crossings after insetting every contour of the shape by `inset`. */
function insetDefects(frames: readonly ContourFrame[], inset: number): number {
  let defects = 0;
  const polys = frames.map(f => { const p = new Float64Array(f.n * 2); for (let i = 0; i < f.n; i++) { p[i * 2] = f.xs[i] - f.mx[i] * inset; p[i * 2 + 1] = f.ys[i] - f.my[i] * inset; } return p; });
  for (let c = 0; c < frames.length; c++) {
    const f = frames[c], p = polys[c];
    for (let i = 0; i < f.n; i++) {
      const j = (i + 1) % f.n;
      if ((p[j * 2] - p[i * 2]) * (f.xs[j] - f.xs[i]) + (p[j * 2 + 1] - p[i * 2 + 1]) * (f.ys[j] - f.ys[i]) <= 0) defects++;
    }
  }
  const edges: number[] = [];
  polys.forEach((p, c) => { const n = p.length / 2; for (let i = 0; i < n; i++) { const j = (i + 1) % n; edges.push(c, i, p[i * 2], p[i * 2 + 1], p[j * 2], p[j * 2 + 1]); } });
  const count = edges.length / 6;
  for (let a = 0; a < count; a++) {
    const ac = edges[a * 6], ai = edges[a * 6 + 1], ax = edges[a * 6 + 2], ay = edges[a * 6 + 3], bx = edges[a * 6 + 4], by = edges[a * 6 + 5];
    const minX = Math.min(ax, bx), maxX = Math.max(ax, bx), minY = Math.min(ay, by), maxY = Math.max(ay, by);
    for (let b = a + 1; b < count; b++) {
      const cx = edges[b * 6 + 2], cy = edges[b * 6 + 3], dx = edges[b * 6 + 4], dy = edges[b * 6 + 5];
      if (Math.max(cx, dx) < minX || Math.min(cx, dx) > maxX || Math.max(cy, dy) < minY || Math.min(cy, dy) > maxY) continue;
      if (edges[b * 6] === ac) { const n = polys[ac].length / 2, bi = edges[b * 6 + 1]; if (Math.abs(bi - ai) <= 1 || Math.abs(bi - ai) === n - 1) continue; }
      if (segmentsCross(ax, ay, bx, by, cx, cy, dx, dy)) defects++;
    }
  }
  return defects;
}
/**
 * Largest bevel width (≤ requested) whose inset caps stay simple for every shape:
 * thin strokes would otherwise invert the caps. One value for the whole object keeps
 * the bevel consistent from letter to letter.
 */
export function mesh3dSafeBevelSize(shapes: readonly Mesh3dShape2[], requested: number, creaseDegrees = 38): number {
  if (!(requested > 1e-7)) return requested;
  const creaseCos = Math.cos(creaseDegrees * Math.PI / 180);
  let size = requested;
  for (const shape of shapes) {
    // Some instanced outlines already self-overlap; only defects the inset adds count.
    const frames = [shape.outer, ...shape.holes].map(c => contourFrame(c, creaseCos)), baseline = insetDefects(frames, 0);
    let tries = 0;
    while (size > requested * .05 && insetDefects(frames, size) > baseline && tries++ < 12) size *= .75;
    if (size <= requested * .05) return 0;
  }
  return size;
}

/**
 * Extrude shapes centred on z = 0 (caps at ±depth/2) into `out`. Each shape gets the
 * largest safe bevel up to the requested one (CJK glyphs are many overlapping stroke
 * solids; a thin hook must not cost every other stroke its bevel).
 */
export function mesh3dExtrudeShapes(shapes: readonly Mesh3dShape2[], requested: Mesh3dBevelOptions, out: Mesh3dMeshData): void {
  // Uniform where possible: no shape exceeds max(smallest safe bevel, half the request).
  const safes = shapes.map(shape => mesh3dSafeBevelSize([shape], requested.bevelSize, requested.creaseDegrees));
  const cap = Math.max(Math.min(...safes, requested.bevelSize), requested.bevelSize * .5);
  for (let i = 0; i < shapes.length; i++) {
    const shape = shapes[i], safe = Math.min(safes[i], cap);
    const o = safe === requested.bevelSize ? requested : { ...requested, bevelSize: safe, bevelThickness: safe > 0 ? requested.bevelThickness * Math.max(.35, safe / requested.bevelSize) : 0 };
    extrudeShape(shape, o, out);
  }
}
function extrudeShape(shape: Mesh3dShape2, o: Mesh3dBevelOptions, out: Mesh3dMeshData): void {
  const bands = profileBands(o), creaseCos = Math.cos(o.creaseDegrees * Math.PI / 180), half = o.depth / 2;
  const bevel = o.bevelSize > 1e-7 && o.bevelThickness > 1e-7, capInset = bevel ? o.bevelSize : 0;
  {
    const frames = [shape.outer, ...shape.holes].map(c => contourFrame(c, creaseCos));
    for (const f of frames) for (const [r0, r1] of bands) {
      // Per band: one vertex per smooth contour point, two at a crease.
      const inTop = new Int32Array(f.n), inBottom = new Int32Array(f.n), outTop = new Int32Array(f.n), outBottom = new Int32Array(f.n);
      for (let i = 0; i < f.n; i++) {
        const x0 = f.xs[i] - f.mx[i] * r0.inset, y0 = f.ys[i] - f.my[i] * r0.inset, x1 = f.xs[i] - f.mx[i] * r1.inset, y1 = f.ys[i] - f.my[i] * r1.inset;
        inTop[i] = vertex(out, x0, y0, r0.z, r0.normal(f.inX[i], f.inY[i]), o);
        inBottom[i] = vertex(out, x1, y1, r1.z, r1.normal(f.inX[i], f.inY[i]), o);
        if (f.smooth[i]) { outTop[i] = inTop[i]; outBottom[i] = inBottom[i]; }
        else { outTop[i] = vertex(out, x0, y0, r0.z, r0.normal(f.outX[i], f.outY[i]), o); outBottom[i] = vertex(out, x1, y1, r1.z, r1.normal(f.outX[i], f.outY[i]), o); }
      }
      for (let i = 0; i < f.n; i++) {
        const j = (i + 1) % f.n;
        pushTriangle(out, outTop[i], inTop[j], inBottom[j]);
        pushTriangle(out, outTop[i], inBottom[j], outBottom[i]);
      }
    }
    for (const side of [1, -1]) {
      const contour: Vector2[] = [], holes: Vector2[][] = [], z = side * half, normal = [0, 0, side];
      const inset = (f: ContourFrame) => { const points: Vector2[] = []; for (let i = 0; i < f.n; i++) points.push(new Vector2(f.xs[i] - f.mx[i] * capInset, f.ys[i] - f.my[i] * capInset)); return points; };
      contour.push(...inset(frames[0]));
      for (const f of frames.slice(1)) holes.push(inset(f));
      const all = [...contour, ...holes.flat()];
      let faces: number[][];
      try { faces = ShapeUtils.triangulateShape(contour, holes); } catch { continue; }
      const base = out.positions.length / 3;
      for (const p of all) vertex(out, p.x, p.y, z, normal, o);
      for (const [a, b, c] of faces) {
        const area = (all[b].x - all[a].x) * (all[c].y - all[a].y) - (all[c].x - all[a].x) * (all[b].y - all[a].y);
        if (Math.abs(area) < 1e-14) continue;
        if ((area > 0) === (side > 0)) out.indices.push(base + a, base + b, base + c); else out.indices.push(base + a, base + c, base + b);
      }
    }
  }
}

/** Glyph run of one line; x advances left to right, y-up, pen starts at 0 on the baseline. */
export interface Mesh3dGlyphRun { contours: Mesh3dPolyline[][]; width: number; ascender: number; descender: number; }
const UNSUPPORTED = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{M}]/u;
export function mesh3dGlyphRun(font: Font, text: string, size: number, tracking: number, tolerance: number, maxPerCurve: number, faceLabel: string): Mesh3dGlyphRun {
  const scale = size / font.unitsPerEm, contours: Mesh3dPolyline[][] = [];
  let pen = 0, previous: Glyph | undefined, index = 0;
  for (const character of text) {
    if (UNSUPPORTED.test(character) || character === "\n") throw new Error(`3D 文字不支援字元「${character}」（${faceLabel}）`);
    const glyph = font.charToGlyph(character), blank = /^\s$/u.test(character);
    if (!blank && (glyph.index === 0 || !glyph.path.commands.length)) throw new Error(`3D 字型 ${faceLabel} 缺少「${character}」；不接受替代方框`);
    if (index > 0) {
      pen += tracking * size;
      if (previous && glyph.index > 0) { try { const kerning = font.getKerningValue(previous, glyph); if (Number.isFinite(kerning)) pen += kerning * scale; } catch { /* no kerning table */ } }
    }
    if (!blank) contours.push(mesh3dFlattenCommands(glyph.path.commands as PathCommand[], scale, pen, 0, tolerance, maxPerCurve));
    pen += (Number.isFinite(glyph.advanceWidth) ? glyph.advanceWidth! : font.unitsPerEm) * scale;
    previous = glyph; index++;
  }
  return { contours, width: pen, ascender: font.ascender * scale, descender: font.descender * scale };
}

export function mesh3dPolylineBounds(polylines: readonly Mesh3dPolyline[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of polylines) for (let i = 0; i < p.length; i += 2) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]); }
  return [x0, y0, x1, y1];
}

/** Regular n-point star, clockwise (y-up), first point at the top. */
export function mesh3dStarPolyline(points: number, outer: number, inner: number): Mesh3dPolyline {
  const out: number[] = [];
  for (let i = 0; i < points * 2; i++) {
    const angle = Math.PI / 2 - i * Math.PI / points, r = i % 2 ? inner : outer;
    out.push(Math.cos(angle) * r, Math.sin(angle) * r);
  }
  return out;
}
/** Rounded rectangle centred on the origin, clockwise (y-up). */
export function mesh3dRoundedRectPolyline(width: number, height: number, radius: number, cornerSegments: number): Mesh3dPolyline {
  const hw = width / 2, hh = height / 2, r = Math.min(radius, hw, hh), out: number[] = [];
  const corners: [number, number, number][] = [[hw - r, hh - r, 0], [-hw + r, hh - r, 90], [-hw + r, -hh + r, 180], [hw - r, -hh + r, 270]];
  for (const [cx, cy, start] of corners) {
    if (r <= 1e-9) { out.push(cx, cy); continue; }
    for (let k = 0; k <= cornerSegments; k++) { const a = (start + 90 * k / cornerSegments) * Math.PI / 180; out.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r); }
  }
  return reversed(out);
}
