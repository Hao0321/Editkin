/**
 * tube_set geometry (2026-10-29): many polylines swept by a circle in one object — L-system branches and vines,
 * 3D routes, wires, line charts — with optional instanced tips (buds, blossoms, stars, leaves). Browser-safe (no
 * three.js, no fonts): the domain validation, the preview and the export share this file, so the triangle count the
 * budget checks is the count the renderer draws.
 *
 * Centerline: every polyline vertex where the direction turns is replaced by a circular fillet of radius equal to the
 * tube radius there (shortened to half the shorter neighbouring segment on tight corners), sampled every 30° or less,
 * so joints are round and the tube never pinches. Frames: the double-reflection rotation-minimising frame (Wang et
 * al. 2008) along the sampled centerline, so the tube does not twist on straight runs or through sharp bends.
 * Radius per vertex tapers linearly along each segment; normals include the taper slope. The sampled centerline and
 * its frames (the skeleton) are built once per shape and cached; reveal, growth and tips never rebuild them.
 *
 * Reveal: a polyline shows the arc-length window [start, start + (end − start) × share] of its centerline, where
 * [start, end] is its `reveal` (a number n means [0, n]; keyframed by revealKeyframes) and share is its part of the
 * object's `growth` (growthSpan [g0, g1], default [0, 1]). Each frame copies the skeleton rings inside the window and
 * closes it with rings interpolated exactly at both ends, capped like the polyline ends; the shown piece grows from
 * zero thickness over its first two radii. So drawing on is continuous (nothing pops in) and monotonic (each step
 * adds to the last), and the result depends only on the spec: the same on the calling thread and the worker pool.
 *
 * Tips: small meshes placed on a polyline at an arc-length fraction (or its end), +Y along the tangent, +X along the
 * frame normal, scaled by `scale`; optional `tilt` (degrees, +Y toward +X) and `spin` (degrees about the tangent). A tip
 * shows once its anchor is inside the polyline's shown window and the object's growth has passed `revealAt`; it then
 * grows in over 0.05 of growth (less if revealAt is within 0.05 of 1). One draw per colour role (tipColors).
 */
import type { Mesh3dTubeSetGeometryV1 } from "./mesh3dScene";

type Polyline = Mesh3dTubeSetGeometryV1["polylines"][number];
type Tip = NonNullable<Mesh3dTubeSetGeometryV1["tips"]>[number];
export const MESH3D_TUBE_SET_DEFAULT_RADIAL_SEGMENTS = 8;
/** Growth over which a tip scales in from nothing after its revealAt. */
export const MESH3D_TUBE_TIP_GROWTH_RAMP = .05;
/** Below this turn (radians) a vertex keeps one ring (bisector tangent) instead of a fillet. */
const STRAIGHT_RADIANS = 1e-6;

/** Sampled centerline of one polyline with its rotation-minimising frame. Arrays are xyz triples except r, s, slope. */
export interface Mesh3dTubeSkeletonV1 {
  count: number; length: number;
  c: Float64Array; t: Float64Array; n: Float64Array; r: Float64Array; s: Float64Array; slope: Float64Array;
}
export interface Mesh3dTubeSetMeshV1 { positions: Float32Array; normals: Float32Array; uvs: Float32Array; indices: Uint32Array }
type Counts = { triangles: number; vertices: number };
export interface Mesh3dTubeSetCountsV1 { triangles: number; tube: Counts; tips: Record<string, Counts> }

export function mesh3dTubeRadialSegmentsV1(spec: Pick<Mesh3dTubeSetGeometryV1, "radialSegments">): number { return spec.radialSegments ?? MESH3D_TUBE_SET_DEFAULT_RADIAL_SEGMENTS; }
/** Rings in each round cap (the base ring excluded, the pole included as the last). */
export function mesh3dTubeCapRingsV1(radial: number): number { return Math.max(2, Math.ceil(radial / 4)); }
const radiiOf = (p: Polyline): readonly number[] => typeof p.radius === "number" ? p.points.map(() => p.radius as number) : p.radius;
const clamp01 = (v: number) => v <= 0 ? 0 : v >= 1 ? 1 : v;

/** Centerline samples (centres, tangents, radii) of one polyline: ends, straight vertices and filleted corners. */
function sample(points: Polyline["points"], radii: readonly number[], radial: number) {
  const m = points.length, dir: number[] = [], len: number[] = [];
  for (let i = 0; i < m - 1; i++) {
    const dx = points[i + 1][0] - points[i][0], dy = points[i + 1][1] - points[i][1], dz = points[i + 1][2] - points[i][2], l = Math.hypot(dx, dy, dz);
    if (!(l > 0)) throw new Error("MESH_TUBE_SET_DUPLICATE_POINT");
    len.push(l); dir.push(dx / l, dy / l, dz / l);
  }
  const step = Math.min(Math.PI / 6, 2 * Math.PI / radial), c: number[] = [], t: number[] = [], r: number[] = [];
  const ring = (x: number, y: number, z: number, tx: number, ty: number, tz: number, radius: number) => { c.push(x, y, z); t.push(tx, ty, tz); r.push(radius); };
  ring(points[0][0], points[0][1], points[0][2], dir[0], dir[1], dir[2], radii[0]);
  for (let i = 1; i < m - 1; i++) {
    const ax = dir[i * 3 - 3], ay = dir[i * 3 - 2], az = dir[i * 3 - 1], bx = dir[i * 3], by = dir[i * 3 + 1], bz = dir[i * 3 + 2];
    const theta = Math.acos(Math.max(-1, Math.min(1, ax * bx + ay * by + az * bz))), [px, py, pz] = points[i];
    if (theta < STRAIGHT_RADIANS) {
      const hx = ax + bx, hy = ay + by, hz = az + bz, hl = Math.hypot(hx, hy, hz);
      ring(px, py, pz, hx / hl, hy / hl, hz / hl, radii[i]); continue;
    }
    // Bend axis k = a × b (any perpendicular for a full reversal); inward normal w = k × a.
    let kx = ay * bz - az * by, ky = az * bx - ax * bz, kz = ax * by - ay * bx, kl = Math.hypot(kx, ky, kz);
    if (kl < 1e-9) { const h = Math.abs(ay) < .9 ? [0, 1, 0] : [1, 0, 0]; kx = ay * h[2] - az * h[1]; ky = az * h[0] - ax * h[2]; kz = ax * h[1] - ay * h[0]; kl = Math.hypot(kx, ky, kz); }
    kx /= kl; ky /= kl; kz /= kl;
    const wx = ky * az - kz * ay, wy = kz * ax - kx * az, wz = kx * ay - ky * ax;
    const half = Math.tan(theta / 2), d = Math.min(radii[i] * half, .5 * Math.min(len[i - 1], len[i])), rho = d / half;
    const rA = radii[i] + (radii[i - 1] - radii[i]) * (d / len[i - 1]), rB = radii[i] + (radii[i + 1] - radii[i]) * (d / len[i]);
    const sx = px - ax * d, sy = py - ay * d, sz = pz - az * d, n = Math.max(1, Math.ceil(theta / step));
    for (let k = 0; k <= n; k++) {
      const phi = theta * k / n, sp = Math.sin(phi), cp = Math.cos(phi);
      ring(sx + rho * (sp * ax + (1 - cp) * wx), sy + rho * (sp * ay + (1 - cp) * wy), sz + rho * (sp * az + (1 - cp) * wz),
        cp * ax + sp * wx, cp * ay + sp * wy, cp * az + sp * wz, rA + (rB - rA) * k / n);
    }
  }
  const last = points[m - 1];
  ring(last[0], last[1], last[2], dir[m * 3 - 6], dir[m * 3 - 5], dir[m * 3 - 4], radii[m - 1]);
  return { c, t, r };
}

/** Double-reflection rotation-minimising frame and arc length along the samples. */
function skeleton(points: Polyline["points"], radii: readonly number[], radial: number): Mesh3dTubeSkeletonV1 {
  const sampled = sample(points, radii, radial), count = sampled.r.length;
  const c = Float64Array.from(sampled.c), t = Float64Array.from(sampled.t), r = Float64Array.from(sampled.r);
  const n = new Float64Array(count * 3), s = new Float64Array(count), slope = new Float64Array(count);
  {
    const tx = t[0], ty = t[1], tz = t[2], h = Math.abs(ty) < .99 ? [0, 1, 0] : [1, 0, 0];
    let bx = ty * h[2] - tz * h[1], by = tz * h[0] - tx * h[2], bz = tx * h[1] - ty * h[0]; const bl = Math.hypot(bx, by, bz); bx /= bl; by /= bl; bz /= bl;
    n[0] = by * tz - bz * ty; n[1] = bz * tx - bx * tz; n[2] = bx * ty - by * tx;
  }
  for (let k = 0; k < count - 1; k++) {
    const o = k * 3, q = o + 3;
    const v1x = c[q] - c[o], v1y = c[q + 1] - c[o + 1], v1z = c[q + 2] - c[o + 2], c1 = v1x * v1x + v1y * v1y + v1z * v1z;
    s[k + 1] = s[k] + Math.sqrt(c1);
    let rx = n[o], ry = n[o + 1], rz = n[o + 2], tx = t[o], ty = t[o + 1], tz = t[o + 2];
    if (c1 > 1e-24) {
      // Two reflections (a rotation): across the plane normal to the chord, then the one taking the tangent to the next.
      const fr = 2 / c1 * (v1x * rx + v1y * ry + v1z * rz), ft = 2 / c1 * (v1x * tx + v1y * ty + v1z * tz);
      rx -= fr * v1x; ry -= fr * v1y; rz -= fr * v1z; tx -= ft * v1x; ty -= ft * v1y; tz -= ft * v1z;
      const v2x = t[q] - tx, v2y = t[q + 1] - ty, v2z = t[q + 2] - tz, c2 = v2x * v2x + v2y * v2y + v2z * v2z;
      if (c2 > 1e-24) { const f = 2 / c2 * (v2x * rx + v2y * ry + v2z * rz); rx -= f * v2x; ry -= f * v2y; rz -= f * v2z; }
    } else {
      // Coincident samples (a zero-radius fillet): the minimal rotation of the tangent (one reflection would mirror the frame).
      let ax = ty * t[q + 2] - tz * t[q + 1], ay = tz * t[q] - tx * t[q + 2], az = tx * t[q + 1] - ty * t[q];
      const sin = Math.hypot(ax, ay, az), cos = tx * t[q] + ty * t[q + 1] + tz * t[q + 2];
      if (sin > 1e-12) {
        ax /= sin; ay /= sin; az /= sin;
        const dot = ax * rx + ay * ry + az * rz, cx = ay * rz - az * ry, cy = az * rx - ax * rz, cz = ax * ry - ay * rx;
        rx = rx * cos + cx * sin + ax * dot * (1 - cos); ry = ry * cos + cy * sin + ay * dot * (1 - cos); rz = rz * cos + cz * sin + az * dot * (1 - cos);
      }
    }
    // Keep it exactly perpendicular and unit (rounding only).
    const along = rx * t[q] + ry * t[q + 1] + rz * t[q + 2]; rx -= along * t[q]; ry -= along * t[q + 1]; rz -= along * t[q + 2];
    const rl = Math.hypot(rx, ry, rz) || 1; n[q] = rx / rl; n[q + 1] = ry / rl; n[q + 2] = rz / rl;
  }
  for (let k = 0; k < count; k++) {
    const a = Math.max(0, k - 1), b = Math.min(count - 1, k + 1), ds = s[b] - s[a];
    slope[k] = ds > 1e-12 ? (r[b] - r[a]) / ds : 0;
  }
  return { count, length: s[count - 1], c, t, n, r, s, slope };
}

const skeletons = new Map<string, Mesh3dTubeSkeletonV1[]>();
/** Skeletons of every polyline (shape only: points, radius, radialSegments), small LRU by content. */
export function mesh3dTubeSkeletonsV1(spec: Pick<Mesh3dTubeSetGeometryV1, "polylines" | "radialSegments">): Mesh3dTubeSkeletonV1[] {
  const radial = mesh3dTubeRadialSegmentsV1(spec), key = JSON.stringify([radial, spec.polylines.map(p => [p.points, p.radius])]), found = skeletons.get(key);
  if (found) { skeletons.delete(key); skeletons.set(key, found); return found; }
  const built = spec.polylines.map(p => skeleton(p.points, radiiOf(p), radial));
  if (skeletons.size >= 64) skeletons.delete(skeletons.keys().next().value!);
  skeletons.set(key, built);
  return built;
}

/**
 * Arc-length window [start, end] (fractions) a polyline shows at an object growth: its reveal window (a number n is
 * [0, n]) drawn on from its start by its share of the growth (growthSpan). Undefined when nothing shows.
 */
export function mesh3dTubeWindowV1(polyline: Pick<Polyline, "reveal" | "growthSpan">, growth: number): [number, number] | undefined {
  const reveal = polyline.reveal ?? 1, [start, end] = typeof reveal === "number" ? [0, clamp01(reveal)] : [clamp01(reveal[0]), clamp01(reveal[1])];
  const share = polyline.growthSpan ? clamp01((growth - polyline.growthSpan[0]) / (polyline.growthSpan[1] - polyline.growthSpan[0])) : clamp01(growth);
  const shown = start + (end - start) * share;
  return shown > start ? [start, shown] : undefined;
}

/** A point of the skeleton at arc length `at` (interpolated between samples; the frame re-orthonormalised). */
function pointAt(sk: Mesh3dTubeSkeletonV1, at: number) {
  let k = 0;
  while (k + 2 < sk.count && sk.s[k + 1] < at) k++;
  const span = sk.s[k + 1] - sk.s[k], u = span > 0 ? Math.max(0, Math.min(1, (at - sk.s[k]) / span)) : 0, a = k * 3, b = a + 3;
  const mix = (p: number, q: number) => p + (q - p) * u;
  let tx = mix(sk.t[a], sk.t[b]), ty = mix(sk.t[a + 1], sk.t[b + 1]), tz = mix(sk.t[a + 2], sk.t[b + 2]); const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
  let nx = mix(sk.n[a], sk.n[b]), ny = mix(sk.n[a + 1], sk.n[b + 1]), nz = mix(sk.n[a + 2], sk.n[b + 2]); const along = nx * tx + ny * ty + nz * tz;
  nx -= along * tx; ny -= along * ty; nz -= along * tz; const nl = Math.hypot(nx, ny, nz) || 1;
  return { cx: mix(sk.c[a], sk.c[b]), cy: mix(sk.c[a + 1], sk.c[b + 1]), cz: mix(sk.c[a + 2], sk.c[b + 2]), tx, ty, tz, nx: nx / nl, ny: ny / nl, nz: nz / nl,
    r: mix(sk.r[k], sk.r[k + 1]), slope: mix(sk.slope[k], sk.slope[k + 1]) };
}

/** Rings shown for a window: an exact ring at each end (a skeleton ring when the window reaches the polyline's end) and every skeleton ring strictly inside. */
function windowRings(sk: Mesh3dTubeSkeletonV1, window: [number, number]) {
  const a = window[0] * sk.length, b = window[1] * sk.length;
  let first = 0;
  while (first < sk.count && !(sk.s[first] > a)) first++;
  let last = first;
  while (last < sk.count && sk.s[last] < b) last++;
  // Inner rings are [first, last); the start is ring 0 itself when a = 0, the end the last ring when b reaches the length.
  return { a, b, first, last, startExact: a <= 0, endExact: b >= sk.length, count: (last - first) + 2 };
}

/** Tip mesh templates (unit size; +Y along the tangent). Thin shapes carry both faces, the back one 0.002 behind. */
type TipTemplate = { positions: number[]; normals: number[]; indices: number[] };
const tipTemplates = new Map<Tip["mesh"], TipTemplate>();
function tipTemplate(kind: Tip["mesh"]): TipTemplate {
  const found = tipTemplates.get(kind);
  if (found) return found;
  const positions: number[] = [], normals: number[] = [], indices: number[] = [];
  const vertex = (p: number[], n: number[]) => { positions.push(...p); const l = Math.hypot(n[0], n[1], n[2]) || 1; normals.push(n[0] / l, n[1] / l, n[2] / l); return positions.length / 3 - 1; };
  /** A flat-shaded two-sided triangle (front counter-clockwise from its normal side). */
  const face = (p: number[], q: number[], r: number[]) => {
    const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2], vx = r[0] - p[0], vy = r[1] - p[1], vz = r[2] - p[2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx], l = Math.hypot(n[0], n[1], n[2]), back = n.map(v => -v / l * .002);
    if (!(l > 1e-12)) return; // a degenerate sliver (a pointed end) adds nothing
    indices.push(vertex(p, n), vertex(q, n), vertex(r, n));
    const m = n.map(v => -v), pb = p.map((v, i) => v + back[i]), qb = q.map((v, i) => v + back[i]), rb = r.map((v, i) => v + back[i]);
    indices.push(vertex(pb, m), vertex(rb, m), vertex(qb, m));
  };
  if (kind === "sphere") {
    const segments = 10, rings = 6;
    const top = vertex([0, 1, 0], [0, 1, 0]), first = positions.length / 3;
    for (let i = 1; i < rings; i++) for (let j = 0; j < segments; j++) {
      const a = Math.PI * i / rings, b = 2 * Math.PI * j / segments, p = [Math.sin(a) * Math.cos(b), Math.cos(a), -Math.sin(a) * Math.sin(b)];
      vertex(p, p);
    }
    const bottom = vertex([0, -1, 0], [0, -1, 0]), at = (i: number, j: number) => first + (i - 1) * segments + (j % segments);
    for (let j = 0; j < segments; j++) indices.push(top, at(1, j), at(1, j + 1));
    for (let i = 1; i < rings - 1; i++) for (let j = 0; j < segments; j++) indices.push(at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j), at(i + 1, j + 1), at(i, j + 1));
    for (let j = 0; j < segments; j++) indices.push(bottom, at(rings - 1, j + 1), at(rings - 1, j));
  } else if (kind === "petal") {
    // A five-petal blossom facing +Y, gently cupped: rim radius pinched between petals.
    const rim = 30, ring = Array.from({ length: rim }, (_, i) => {
      const a = 2 * Math.PI * i / rim, rr = .55 + .45 * Math.pow(Math.abs(Math.cos(a * 2.5)), .7);
      return [Math.cos(a) * rr, .22 * rr * rr, -Math.sin(a) * rr];
    });
    for (let i = 0; i < rim; i++) face([0, 0, 0], ring[i], ring[(i + 1) % rim]);
  } else if (kind === "star") {
    const rim = Array.from({ length: 10 }, (_, i) => { const a = Math.PI * i / 5, rr = i % 2 ? .42 : 1; return [Math.cos(a) * rr, 0, -Math.sin(a) * rr]; });
    for (let i = 0; i < 10; i++) face([0, .12, 0], rim[i], rim[(i + 1) % 10]);
  } else {
    // A leaf along +Y in the XY plane (front facing +Z), its halves folded up along the midrib, tip curling back.
    const rows = 7, at = (k: number, side: -1 | 0 | 1): number[] => {
      const y = k / (rows - 1), w = .42 * Math.pow(Math.sin(Math.PI * y), .8);
      return [side * w, y, Math.abs(side) * w * .35 - .12 * y * y];
    };
    for (let k = 0; k < rows - 1; k++) {
      face(at(k, -1), at(k, 0), at(k + 1, 0)); face(at(k, -1), at(k + 1, 0), at(k + 1, -1));
      face(at(k, 0), at(k, 1), at(k + 1, 1)); face(at(k, 0), at(k + 1, 1), at(k + 1, 0));
    }
  }
  const built = { positions, normals, indices };
  tipTemplates.set(kind, built);
  return built;
}
/** Triangles of one tip mesh. */
export function mesh3dTubeTipTrianglesV1(kind: Tip["mesh"]): number { return tipTemplate(kind).indices.length / 3; }

/** Size factor of a tip at a growth (0 while hidden): its anchor must be shown, then it grows in after revealAt. */
function tipSize(tip: Tip, sk: Mesh3dTubeSkeletonV1, window: [number, number] | undefined, growth: number): number {
  const at = tip.at === "end" ? 1 : tip.at;
  if (!window || at < window[0] || at > window[1]) return 0;
  const after = tip.revealAt ?? 0, ramp = Math.min(MESH3D_TUBE_TIP_GROWTH_RAMP, 1 - after);
  if (growth < after) return 0;
  const p = ramp > 0 ? Math.min(1, (growth - after) / ramp) : 1;
  return p * p * (3 - 2 * p);
}

/** Triangles and vertices of the tube and of each tip colour role at the spec's growth and reveal windows (exactly what the meshes contain). */
export function mesh3dTubeSetCountV1(spec: Mesh3dTubeSetGeometryV1): Mesh3dTubeSetCountsV1 {
  const growth = spec.growth ?? 1, radial = mesh3dTubeRadialSegmentsV1(spec), round = (spec.caps ?? "round") === "round", capRings = mesh3dTubeCapRingsV1(radial);
  const capTriangles = round ? (2 * capRings - 1) * radial : radial, capVertices = round ? capRings * (radial + 1) + 1 : radial + 2;
  const skeletons = mesh3dTubeSkeletonsV1(spec), windows = spec.polylines.map(p => mesh3dTubeWindowV1(p, growth));
  const tube = { triangles: 0, vertices: 0 }, tips: Record<string, Counts> = {};
  skeletons.forEach((sk, i) => {
    const window = windows[i];
    if (!window) return;
    const rings = windowRings(sk, window).count;
    tube.triangles += (rings - 1) * 2 * radial + 2 * capTriangles; tube.vertices += rings * (radial + 1) + 2 * capVertices;
  });
  for (const tip of spec.tips ?? []) {
    if (!(tipSize(tip, skeletons[tip.polylineIndex], windows[tip.polylineIndex], growth) > 0)) continue;
    const template = tipTemplate(tip.mesh), role = tips[tip.colorRole] ??= { triangles: 0, vertices: 0 };
    role.triangles += template.indices.length / 3; role.vertices += template.positions.length / 3;
  }
  return { triangles: tube.triangles + Object.values(tips).reduce((n, c) => n + c.triangles, 0), tube, tips };
}

/** The tube mesh of the spec (sample animated fields first: mesh3dGeometryAtV1). `maxTriangles` is checked on the exact count before anything is allocated. Winding is counter-clockwise from outside, like three.js. */
export function mesh3dTubeSetMeshV1(spec: Mesh3dTubeSetGeometryV1, maxTriangles: number): Mesh3dTubeSetMeshV1 {
  const growth = spec.growth ?? 1, counts = mesh3dTubeSetCountV1(spec), count = counts.tube;
  if (counts.triangles > maxTriangles) throw new Error(`MESH_TUBE_SET_TRIANGLE_BUDGET: ${counts.triangles}/${maxTriangles}`);
  const radial = mesh3dTubeRadialSegmentsV1(spec), round = (spec.caps ?? "round") === "round", capRings = mesh3dTubeCapRingsV1(radial);
  const positions = new Float32Array(count.vertices * 3), normals = new Float32Array(count.vertices * 3), uvs = new Float32Array(count.vertices * 2), indices = new Uint32Array(count.triangles * 3);
  let vertex = 0, index = 0;
  const cosines = Array.from({ length: radial + 1 }, (_, j) => Math.cos(2 * Math.PI * j / radial)), sines = Array.from({ length: radial + 1 }, (_, j) => j === radial ? 0 : Math.sin(2 * Math.PI * j / radial));
  const push = (x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number) => {
    const nl = Math.hypot(nx, ny, nz) || 1, o = vertex * 3;
    positions[o] = x; positions[o + 1] = y; positions[o + 2] = z; normals[o] = nx / nl; normals[o + 1] = ny / nl; normals[o + 2] = nz / nl;
    uvs[vertex * 2] = u; uvs[vertex * 2 + 1] = v; return vertex++;
  };
  const band = (a: number, b: number) => { for (let j = 0; j < radial; j++) { indices.set([a + j, a + j + 1, b + j, a + j + 1, b + j + 1, b + j], index); index += 6; } };
  type Ring = ReturnType<typeof pointAt> & { u: number };
  /** A ring's vertices: radius × (cos φ n + sin φ b), b = t × n; `along` scales the radial part of the normal, `normalSlope` tilts it along −t. */
  const ring = (g: Ring, radius: number, offset: number, along: number, u: number, normalSlope: number) => {
    const bx = g.ty * g.nz - g.tz * g.ny, by = g.tz * g.nx - g.tx * g.nz, bz = g.tx * g.ny - g.ty * g.nx, first = vertex;
    for (let j = 0; j <= radial; j++) {
      const dx = cosines[j] * g.nx + sines[j] * bx, dy = cosines[j] * g.ny + sines[j] * by, dz = cosines[j] * g.nz + sines[j] * bz;
      push(g.cx + g.tx * offset + dx * radius, g.cy + g.ty * offset + dy * radius, g.cz + g.tz * offset + dz * radius,
        dx * along - g.tx * normalSlope, dy * along - g.ty * normalSlope, dz * along - g.tz * normalSlope, u, j / radial);
    }
    return first;
  };
  const cap = (g: Ring, sign: 1 | -1, radius: number) => {
    if (!round) {
      const centre = push(g.cx, g.cy, g.cz, g.tx * sign, g.ty * sign, g.tz * sign, g.u, .5), base = ring(g, radius, 0, 0, g.u, -sign);
      for (let j = 0; j < radial; j++) { indices.set(sign > 0 ? [centre, base + j, base + j + 1] : [centre, base + j + 1, base + j], index); index += 3; }
      return;
    }
    // Hemisphere; start caps (sign −1) are emitted pole first so every band runs along +t with the side's winding.
    const angle = (q: number) => Math.PI / 2 * q / capRings;
    const capRing = (q: number) => ring(g, radius * Math.cos(angle(q)), Math.sin(angle(q)) * radius * sign, Math.cos(angle(q)), g.u, -sign * Math.sin(angle(q)));
    if (sign > 0) {
      let previous = ring(g, radius, 0, 1, g.u, 0);
      for (let q = 1; q < capRings; q++) { const next = capRing(q); band(previous, next); previous = next; }
      const pole = push(g.cx + g.tx * radius, g.cy + g.ty * radius, g.cz + g.tz * radius, g.tx, g.ty, g.tz, g.u, .5);
      for (let j = 0; j < radial; j++) { indices.set([previous + j, previous + j + 1, pole], index); index += 3; }
    } else {
      const pole = push(g.cx - g.tx * radius, g.cy - g.ty * radius, g.cz - g.tz * radius, -g.tx, -g.ty, -g.tz, g.u, .5);
      let previous = -1;
      for (let q = capRings - 1; q >= 1; q--) {
        const next = capRing(q);
        if (previous < 0) for (let j = 0; j < radial; j++) { indices.set([pole, next + j + 1, next + j], index); index += 3; } else band(previous, next);
        previous = next;
      }
      band(previous, ring(g, radius, 0, 1, g.u, 0));
    }
  };
  mesh3dTubeSkeletonsV1(spec).forEach((sk, i) => {
    const window = mesh3dTubeWindowV1(spec.polylines[i], growth);
    if (!window) return;
    const w = windowRings(sk, window), shown = w.b - w.a;
    // The shown piece grows from zero thickness over its first two start radii (or the whole polyline, if shorter).
    const startRadius = w.startExact ? sk.r[0] : pointAt(sk, w.a).r, ramp = startRadius > 0 ? Math.min(1, shown / Math.min(sk.length, 2 * startRadius)) : 1;
    const scaled = (g: ReturnType<typeof pointAt>, s: number): Ring => ({ ...g, r: g.r * ramp, slope: g.slope * ramp, u: s / sk.length });
    const atRing = (k: number) => scaled({ cx: sk.c[k * 3], cy: sk.c[k * 3 + 1], cz: sk.c[k * 3 + 2], tx: sk.t[k * 3], ty: sk.t[k * 3 + 1], tz: sk.t[k * 3 + 2],
      nx: sk.n[k * 3], ny: sk.n[k * 3 + 1], nz: sk.n[k * 3 + 2], r: sk.r[k], slope: sk.slope[k] }, sk.s[k]);
    const rings: Ring[] = [w.startExact ? atRing(0) : scaled(pointAt(sk, w.a), w.a)];
    for (let k = w.first; k < w.last; k++) rings.push(atRing(k));
    rings.push(w.endExact ? atRing(sk.count - 1) : scaled(pointAt(sk, w.b), w.b));
    cap(rings[0], -1, rings[0].r);
    let previous = -1;
    for (const g of rings) { const next = ring(g, g.r, 0, 1, g.u, g.slope); if (previous >= 0) band(previous, next); previous = next; }
    cap(rings[rings.length - 1], 1, rings[rings.length - 1].r);
  });
  if (vertex !== count.vertices || index !== indices.length) throw new Error("MESH_TUBE_SET_COUNT_MISMATCH");
  return { positions, normals, uvs, indices };
}

/** The tips of one colour role, placed and scaled at the spec's growth (no triangles when none shows). */
export function mesh3dTubeTipsMeshV1(spec: Mesh3dTubeSetGeometryV1, role: string, maxTriangles: number): Mesh3dTubeSetMeshV1 {
  const growth = spec.growth ?? 1, counts = mesh3dTubeSetCountV1(spec), count = counts.tips[role] ?? { triangles: 0, vertices: 0 };
  if (counts.triangles > maxTriangles) throw new Error(`MESH_TUBE_SET_TRIANGLE_BUDGET: ${counts.triangles}/${maxTriangles}`);
  const positions = new Float32Array(count.vertices * 3), normals = new Float32Array(count.vertices * 3), uvs = new Float32Array(count.vertices * 2), indices = new Uint32Array(count.triangles * 3);
  const skeletons = mesh3dTubeSkeletonsV1(spec);
  let vertex = 0, index = 0;
  for (const tip of spec.tips ?? []) {
    if (tip.colorRole !== role) continue;
    const sk = skeletons[tip.polylineIndex], size = tipSize(tip, sk, mesh3dTubeWindowV1(spec.polylines[tip.polylineIndex], growth), growth);
    if (!(size > 0)) continue;
    const g = pointAt(sk, (tip.at === "end" ? 1 : tip.at) * sk.length), scale = tip.scale * size, template = tipTemplate(tip.mesh);
    // Local axes: X = frame normal, Y = tangent, Z = X × Y; tilt turns Y toward X, then spin turns both about the tangent.
    const tilt = (tip.tilt ?? 0) * Math.PI / 180, spin = (tip.spin ?? 0) * Math.PI / 180, ct = Math.cos(tilt), st = Math.sin(tilt), cs = Math.cos(spin), ss = Math.sin(spin);
    const zx = g.ty * g.nz - g.tz * g.ny, zy = g.tz * g.nx - g.tx * g.nz, zz = g.tx * g.ny - g.ty * g.nx;
    const ax = [g.nx * ct - g.tx * st, g.ny * ct - g.ty * st, g.nz * ct - g.tz * st], ay = [g.tx * ct + g.nx * st, g.ty * ct + g.ny * st, g.tz * ct + g.nz * st], az = [-zx, -zy, -zz];
    // Spin about the tangent t: v' = v cos + (t × v) sin + t (t·v)(1 − cos).
    const turn = (v: number[]) => { const d = g.tx * v[0] + g.ty * v[1] + g.tz * v[2], c = [g.ty * v[2] - g.tz * v[1], g.tz * v[0] - g.tx * v[2], g.tx * v[1] - g.ty * v[0]];
      return [0, 1, 2].map(i => v[i] * cs + c[i] * ss + [g.tx, g.ty, g.tz][i] * d * (1 - cs)); };
    const X = turn(ax), Y = turn(ay), Z = turn(az), first = vertex;
    for (let v = 0; v < template.positions.length / 3; v++) {
      const px = template.positions[v * 3], py = template.positions[v * 3 + 1], pz = template.positions[v * 3 + 2];
      const qx = template.normals[v * 3], qy = template.normals[v * 3 + 1], qz = template.normals[v * 3 + 2], o = vertex * 3;
      positions[o] = g.cx + scale * (px * X[0] + py * Y[0] + pz * Z[0]); positions[o + 1] = g.cy + scale * (px * X[1] + py * Y[1] + pz * Z[1]); positions[o + 2] = g.cz + scale * (px * X[2] + py * Y[2] + pz * Z[2]);
      normals[o] = qx * X[0] + qy * Y[0] + qz * Z[0]; normals[o + 1] = qx * X[1] + qy * Y[1] + qz * Z[1]; normals[o + 2] = qx * X[2] + qy * Y[2] + qz * Z[2];
      vertex++;
    }
    for (const i of template.indices) indices[index++] = first + i;
  }
  if (vertex !== count.vertices || index !== indices.length) throw new Error("MESH_TUBE_SET_COUNT_MISMATCH");
  return { positions, normals, uvs, indices };
}
