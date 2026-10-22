import type { PreparedGlyphPathCommand } from "../typography/preparedGlyphRun";

export interface HingeSurfacePoint { readonly x: number; readonly y: number }
export interface HingeSurfaceRect extends HingeSurfacePoint { readonly width: number; readonly height: number }
export interface HingeSurfaceLimits {
  readonly sourceCommands: number; readonly contours: number; readonly vertices: number;
  readonly prepareWork: number; readonly sampleWork: number; readonly subdivisionDepth: number;
}
export const HINGE_SURFACE_LIMITS: HingeSurfaceLimits = Object.freeze({ sourceCommands: 4096, contours: 128,
  vertices: 8192, prepareWork: 65536, sampleWork: 65536, subdivisionDepth: 20 });
export const HINGE_SURFACE_COORDINATE_LIMIT = 100_000;
export const HINGE_SURFACE_MAX_SCREEN_SCALE = 80;
const DECIMALS = 6, ROUNDING_DISTANCE = Math.SQRT2 * 1e-6;

/** Commands have the physical glyph command shape, but coordinates here are
 * already LOCAL PIXELS, y-down. This geometry factory is not font authority. */
export interface HingeSurfaceDefinition {
  readonly id: string;
  readonly commands: readonly PreparedGlyphPathCommand[];
  readonly clip: HingeSurfaceRect;
  readonly hinge: HingeSurfacePoint;
  readonly perspectivePixels: number;
  readonly maxScreenScale: number;
  readonly screenErrorPixels?: number;
  readonly limits?: Partial<HingeSurfaceLimits>;
}
export interface PreparedHingeSurface {
  readonly schema: "editkin.hinge-surface-prepared/v1";
  readonly id: string; readonly clip: HingeSurfaceRect; readonly hinge: HingeSurfacePoint;
  readonly perspectivePixels: number; readonly maxScreenScale: number; readonly screenErrorPixels: number;
  readonly contours: readonly (readonly HingeSurfacePoint[])[];
  readonly limits: HingeSurfaceLimits;
  readonly preparation: { readonly sourceCommands: number; readonly vertices: number; readonly work: number;
    readonly localErrorBound: number; readonly projectionLipschitzBound: number };
}
export interface HingeSurfaceSample {
  readonly schema: "editkin.hinge-surface-sample/v1"; readonly id: string;
  readonly angleDegrees: number; readonly screenScale: number;
  readonly visibility: "front" | "back-face" | "edge-on" | "clipped-empty";
  readonly contours: readonly (readonly HingeSurfacePoint[])[];
  readonly svg: string; readonly ass: string;
  readonly bounds: { readonly xMin: number; readonly yMin: number; readonly xMax: number; readonly yMax: number } | null;
  readonly errorBoundPixels: number; readonly vertices: number; readonly work: number;
}
const owned = new WeakSet<PreparedHingeSurface>();
function fail(message: string): never { throw new Error(`Hinge surface ${message}`); }
function keys(value: object, permitted: readonly string[]): void {
  if (Object.keys(value).some(key => !permitted.includes(key))) fail("contains an unknown field");
}
function record(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("requires an object");
}
function finite(value: number, low: number, high: number, name: string): number {
  if (!Number.isFinite(value) || value < low || value > high) fail(`${name} is non-finite or outside bounds`);
  return value === 0 ? 0 : value;
}
function point(x: number, y: number): HingeSurfacePoint {
  return { x: finite(x, -HINGE_SURFACE_COORDINATE_LIMIT, HINGE_SURFACE_COORDINATE_LIMIT, "x"),
    y: finite(y, -HINGE_SURFACE_COORDINATE_LIMIT, HINGE_SURFACE_COORDINATE_LIMIT, "y") };
}
function same(a: HingeSurfacePoint, b: HingeSurfacePoint): boolean { return a.x === b.x && a.y === b.y; }
function normalizedAngle(value: number): number {
  finite(value, -1_000_000, 1_000_000, "angle");
  const angle = ((value % 360) + 540) % 360 - 180;
  return angle === 0 ? 0 : angle;
}
function area(points: readonly HingeSurfacePoint[]): number {
  let twice = 0;
  for (let i = 0; i < points.length; i++) { const a = points[i], b = points[(i + 1) % points.length]; twice += a.x * b.y - b.x * a.y; }
  if (!Number.isFinite(twice)) fail("area is non-finite");
  return twice / 2;
}
function orientation(a: HingeSurfacePoint, b: HingeSurfacePoint, p: HingeSurfacePoint): number {
  const first = (b.x - a.x) * (p.y - a.y), second = (b.y - a.y) * (p.x - a.x), cross = first - second;
  const uncertainty = Number.EPSILON * 16 * (Math.abs(first) + Math.abs(second) + 1);
  return Math.abs(cross) <= uncertainty ? 0 : Math.sign(cross);
}
function onSegment(a: HingeSurfacePoint, b: HingeSurfacePoint, p: HingeSurfacePoint): boolean {
  const uncertainty = Number.EPSILON * 16 * Math.max(1, Math.abs(a.x), Math.abs(a.y), Math.abs(b.x), Math.abs(b.y), Math.abs(p.x), Math.abs(p.y));
  return p.x >= Math.min(a.x, b.x) - uncertainty && p.x <= Math.max(a.x, b.x) + uncertainty
    && p.y >= Math.min(a.y, b.y) - uncertainty && p.y <= Math.max(a.y, b.y) + uncertainty;
}
/** Source subpaths must be simple. Separate subpaths express holes and other
 * nonzero-winding regions. Clipping may create cancelling boundary bridges;
 * those are supported and intentionally are not checked as source topology.
 * Numerically uncertain contacts are rejected rather than silently admitted. */
function assertSimpleSourceContour(contour: readonly HingeSurfacePoint[], charge: (cost?: number) => void): void {
  for (let i = 0; i < contour.length; i++) {
    charge();
    const a = contour[(i + contour.length - 1) % contour.length], b = contour[i], c = contour[(i + 1) % contour.length];
    // Adjacent edges may continue along a line but must not retrace a ray.
    if (orientation(a, b, c) === 0) {
      const dot = (a.x - b.x) * (c.x - b.x) + (a.y - b.y) * (c.y - b.y);
      if (dot > 0) fail("source contour topology has retraced adjacent edges");
    }
    for (let j = i + 1; j < contour.length; j++) {
      if (j === i + 1 || i === 0 && j === contour.length - 1) continue;
      charge();
      const p = contour[i], q = contour[(i + 1) % contour.length], r = contour[j], s = contour[(j + 1) % contour.length];
      const pqR = orientation(p, q, r), pqS = orientation(p, q, s), rsP = orientation(r, s, p), rsQ = orientation(r, s, q);
      if (pqR * pqS < 0 && rsP * rsQ < 0 || pqR === 0 && onSegment(p, q, r) || pqS === 0 && onSegment(p, q, s)
        || rsP === 0 && onSegment(r, s, p) || rsQ === 0 && onSegment(r, s, q)) fail("source contour topology intersects or touches itself");
    }
  }
}
function frozenContours(contours: readonly (readonly HingeSurfacePoint[])[]): readonly (readonly HingeSurfacePoint[])[] {
  return Object.freeze(contours.map(contour => Object.freeze(contour.map(p => Object.freeze({ ...p })))));
}
function distanceToSegment(p: HingeSurfacePoint, a: HingeSurfacePoint, b: HingeSurfacePoint): number {
  const dx = b.x - a.x, dy = b.y - a.y, squared = dx * dx + dy * dy;
  const t = squared === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / squared));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
function splitCurve(points: readonly HingeSurfacePoint[]): [HingeSurfacePoint[], HingeSurfacePoint[]] {
  const left = [points[0]], right = [points[points.length - 1]];
  let row = [...points];
  while (row.length > 1) {
    row = row.slice(1).map((p, index) => point((row[index].x + p.x) / 2, (row[index].y + p.y) / 2));
    left.push(row[0]); right.unshift(row[row.length - 1]);
  }
  return [left, right];
}
function validatedLimits(raw?: Partial<HingeSurfaceLimits>): HingeSurfaceLimits {
  if (raw !== undefined) { record(raw); keys(raw, Object.keys(HINGE_SURFACE_LIMITS)); }
  const result = { ...HINGE_SURFACE_LIMITS, ...raw };
  for (const key of Object.keys(HINGE_SURFACE_LIMITS) as Array<keyof HingeSurfaceLimits>) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 1 || result[key] > HINGE_SURFACE_LIMITS[key]) fail(`${key} budget is invalid`);
  }
  return Object.freeze(result);
}

/** Original bounded preparation. Curve-to-chord distance is bounded by the
 * Bezier control hull. A conservative Jacobian norm for every admitted hinge
 * angle converts that local bound to screen pixels at maxScreenScale. Every
 * flattened source subpath must be simple (no self-contact/crossing/retracing).
 * Separate closed subpaths can express holes. The quadratic source pair check
 * is charged to the same preparation budget. Clipping
 * is exact for the prepared polygon representation and preserves nonzero fill:
 * holes keep their winding; concave pieces may share cancelling boundary edges.
 * The approximation's possible fill difference stays in its curve-error band,
 * including at clip tangencies. It is not exact Bezier boolean topology. */
export function prepareHingeSurface(definition: HingeSurfaceDefinition): PreparedHingeSurface {
  record(definition); keys(definition, ["id", "commands", "clip", "hinge", "perspectivePixels", "maxScreenScale", "screenErrorPixels", "limits"]);
  if (typeof definition.id !== "string" || !/^[a-z0-9][a-z0-9:._-]{0,159}$/i.test(definition.id)) fail("requires a stable bounded id");
  record(definition.clip); keys(definition.clip, ["x", "y", "width", "height"]);
  record(definition.hinge); keys(definition.hinge, ["x", "y"]);
  const clip = { ...point(definition.clip.x, definition.clip.y),
    width: finite(definition.clip.width, 1e-6, 4096, "clip width"), height: finite(definition.clip.height, 1e-6, 4096, "clip height") };
  point(clip.x + clip.width, clip.y + clip.height);
  const hinge = point(definition.hinge.x, definition.hinge.y);
  const perspective = finite(definition.perspectivePixels, 1e-6, HINGE_SURFACE_COORDINATE_LIMIT, "perspective");
  const maxScreenScale = finite(definition.maxScreenScale, .01, HINGE_SURFACE_MAX_SCREEN_SCALE, "max screen scale");
  const screenError = finite(definition.screenErrorPixels ?? .25, .001, .25, "screen error");
  const limits = validatedLimits(definition.limits);
  let work = 0, vertices = 0;
  const charge = (cost = 1) => { work += cost; if (work > limits.prepareWork) fail("preparation work budget exceeded"); };
  if (!Array.isArray(definition.commands) || definition.commands.length > limits.sourceCommands) fail("source command budget exceeded");
  const commands: PreparedGlyphPathCommand[] = [];
  let maxU = Math.max(Math.abs(clip.x - hinge.x), Math.abs(clip.x + clip.width - hinge.x));
  let maxV = Math.max(Math.abs(clip.y - hinge.y), Math.abs(clip.y + clip.height - hinge.y));
  for (const command of definition.commands) {
    charge();
    record(command);
    const check = (x: unknown, y: unknown) => { charge(); const p = point(x as number, y as number); maxU = Math.max(maxU, Math.abs(p.x - hinge.x)); maxV = Math.max(maxV, Math.abs(p.y - hinge.y)); return p; };
    if (command.type === "M" || command.type === "L") {
      keys(command, ["type", "x", "y"]); const p = check(command.x, command.y); commands.push({ type: command.type, ...p });
    } else if (command.type === "Q") {
      keys(command, ["type", "x1", "y1", "x", "y"]); const c = check(command.x1, command.y1), p = check(command.x, command.y);
      commands.push({ type: "Q", x1: c.x, y1: c.y, ...p });
    } else if (command.type === "C") {
      keys(command, ["type", "x1", "y1", "x2", "y2", "x", "y"]); const c1 = check(command.x1, command.y1), c2 = check(command.x2, command.y2), p = check(command.x, command.y);
      commands.push({ type: "C", x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, ...p });
    } else if (command.type === "Z") { keys(command, ["type"]); commands.push({ type: "Z" }); }
    else fail("contains an unsupported path command");
  }
  // Source control hull and clip remain in front of the depth plane at every
  // angle, not just the first requested frame. No hidden denominator clamp.
  if (perspective < 4 * maxV) fail("perspective depth margin is insufficient");
  const minDepth = perspective - maxV;
  const lipschitz = Math.hypot(perspective / minDepth, maxU * perspective / (minDepth * minDepth), perspective * perspective / (minDepth * minDepth));
  // Reserve a few arithmetic ulps as well as path-coordinate rounding; do not
  // recombine an exactly exhausted screen budget into a value one ulp above it.
  const localError = (screenError * (1 - 16 * Number.EPSILON) - ROUNDING_DISTANCE * maxScreenScale) / (maxScreenScale * lipschitz);
  if (!Number.isFinite(localError) || localError <= 0) fail("derived screen error is invalid");
  const contours: HingeSurfacePoint[][] = [];
  let current: HingeSurfacePoint[] | undefined;
  const append = (p: HingeSurfacePoint) => {
    charge(); if (!current) fail("path must start with M");
    if (current.length && same(current[current.length - 1], p)) return;
    if (++vertices > limits.vertices) fail("vertex budget exceeded"); current.push(p);
  };
  const flatten = (points: readonly HingeSurfacePoint[], depth: number): void => {
    charge(points.length);
    const deviation = Math.max(...points.slice(1, -1).map(p => distanceToSegment(p, points[0], points[points.length - 1])));
    if (deviation <= localError) { append(points[points.length - 1]); return; }
    if (depth >= limits.subdivisionDepth) fail("subdivision depth budget exceeded");
    const [left, right] = splitCurve(points); flatten(left, depth + 1); flatten(right, depth + 1);
  };
  for (const command of commands) {
    charge();
    if (command.type === "M") {
      if (current) fail("contour must close before the next M");
      if (contours.length >= limits.contours) fail("contour budget exceeded");
      current = []; append(point(command.x, command.y));
    } else if (command.type === "Z") {
      if (!current || current.length < 3) fail("requires a nondegenerate closed contour");
      if (same(current[0], current[current.length - 1])) current.pop();
      charge(current.length);
      if (current.length < 3 || area(current) === 0) fail("requires a nondegenerate closed contour");
      assertSimpleSourceContour(current, charge);
      contours.push(current); current = undefined;
    } else {
      if (!current) fail("path must start with M");
      const a = current[current.length - 1], end = point(command.x, command.y);
      if (command.type === "L") append(end);
      else if (command.type === "Q") flatten([a, point(command.x1, command.y1), end], 0);
      else if (command.type === "C") flatten([a, point(command.x1, command.y1), point(command.x2, command.y2), end], 0);
      else fail("contains an unsupported contour command");
    }
  }
  if (current) fail("contour must end with Z");
  const clipped: HingeSurfacePoint[][] = [];
  let clippedVertices = 0;
  for (const contour of contours) {
    let polygon = contour;
    for (const boundary of [{ axis: "x", value: clip.x, minimum: true }, { axis: "x", value: clip.x + clip.width, minimum: false },
      { axis: "y", value: clip.y, minimum: true }, { axis: "y", value: clip.y + clip.height, minimum: false }] as const) {
      const output: HingeSurfacePoint[] = [];
      const push = (p: HingeSurfacePoint) => {
        charge(); if (!output.length || !same(output[output.length - 1], p)) output.push(p);
        if (output.length > limits.vertices) fail("clipped vertex budget exceeded");
      };
      const inside = (p: HingeSurfacePoint) => boundary.minimum ? p[boundary.axis] >= boundary.value : p[boundary.axis] <= boundary.value;
      for (let i = 0; i < polygon.length; i++) {
        charge(); const a = polygon[(i + polygon.length - 1) % polygon.length], b = polygon[i], aIn = inside(a), bIn = inside(b);
        if (aIn !== bIn) {
          const t = (boundary.value - a[boundary.axis]) / (b[boundary.axis] - a[boundary.axis]);
          finite(t, 0, 1, "clip intersection");
          push(boundary.axis === "x" ? point(boundary.value, a.y + t * (b.y - a.y)) : point(a.x + t * (b.x - a.x), boundary.value));
        }
        if (bIn) push(b);
      }
      if (output.length > 1 && same(output[0], output[output.length - 1])) output.pop();
      polygon = output;
    }
    charge(polygon.length * 2 + contour.length);
    if (polygon.length >= 3 && area(polygon) !== 0) {
      if (Math.sign(area(polygon)) !== Math.sign(area(contour))) fail("clipping changed contour winding");
      clippedVertices += polygon.length; if (clippedVertices > limits.vertices) fail("clipped vertex budget exceeded");
      clipped.push(polygon);
    }
  }
  const prepared: PreparedHingeSurface = Object.freeze({ schema: "editkin.hinge-surface-prepared/v1", id: definition.id,
    clip: Object.freeze(clip), hinge: Object.freeze(hinge), perspectivePixels: perspective, maxScreenScale, screenErrorPixels: screenError,
    contours: frozenContours(clipped), limits,
    preparation: Object.freeze({ sourceCommands: commands.length, vertices, work, localErrorBound: localError, projectionLipschitzBound: lipschitz }) });
  owned.add(prepared); return prepared;
}

/** True one-axis projective point calculation, not a uniform scale substitute.
 * This standalone numeric helper does not confer preparation/font authority. */
export function projectHingeSurfacePoint(p: HingeSurfacePoint, hinge: HingeSurfacePoint, perspectivePixels: number, angleDegrees: number): HingeSurfacePoint {
  point(p.x, p.y); point(hinge.x, hinge.y);
  const perspective = finite(perspectivePixels, 1e-6, HINGE_SURFACE_COORDINATE_LIMIT, "perspective");
  const angle = normalizedAngle(angleDegrees);
  const radians = angle * Math.PI / 180;
  const sin = angle === 0 || Math.abs(angle) === 180 ? 0 : Math.sin(radians);
  const cos = Math.abs(angle) === 90 ? 0 : Math.cos(radians);
  const u = p.x - hinge.x, v = p.y - hinge.y, depth = perspective - v * sin;
  if (!Number.isFinite(depth) || depth < perspective * .25) fail("perspective depth is singular or outside margin");
  const k = perspective / depth;
  return point(hinge.x + u * k, hinge.y + v * cos * k);
}
function rounded(value: number): number { const r = Number(value.toFixed(DECIMALS)); return r === 0 ? 0 : r; }

/** Caller supplies the angle for its requested frame/time. No last frame,
 * clock, RNG, mutable cache or rendering API participates in sampling. Paths
 * remain local: the later shared object/camera consumer applies screenScale. */
export function sampleHingeSurface(surface: PreparedHingeSurface, angleDegrees: number, screenScale = 1): HingeSurfaceSample {
  if (!surface || !owned.has(surface)) fail("requires a current factory-owned prepared receipt");
  const angle = normalizedAngle(angleDegrees), scale = finite(screenScale, .01, surface.maxScreenScale, "screen scale");
  const edge = Math.abs(angle) === 90, back = Math.abs(angle) > 90;
  let work = 0;
  const charge = () => { if (++work > surface.limits.sampleWork) fail("sampling work budget exceeded"); };
  const contours = edge || back ? [] : surface.contours.map(contour => contour.map(p => {
    charge(); const projected = projectHingeSurfacePoint(p, surface.hinge, surface.perspectivePixels, angle);
    return { x: rounded(projected.x), y: rounded(projected.y) };
  }));
  const vertices = contours.reduce((count, contour) => count + contour.length, 0);
  if (vertices > surface.limits.vertices) fail("sample vertex budget exceeded");
  let svg = "", ass = "";
  let bounds: HingeSurfaceSample["bounds"] = null;
  for (const contour of contours) {
    const tokens = contour.map(p => {
      charge();
      bounds = bounds === null ? { xMin: p.x, yMin: p.y, xMax: p.x, yMax: p.y }
        : { xMin: Math.min(bounds.xMin, p.x), yMin: Math.min(bounds.yMin, p.y), xMax: Math.max(bounds.xMax, p.x), yMax: Math.max(bounds.yMax, p.y) };
      return `${p.x} ${p.y}`;
    });
    svg += `${svg ? " " : ""}M ${tokens[0]} L ${tokens.slice(1).join(" ")} Z`;
    ass += `${ass ? " " : ""}m ${tokens[0]} l ${tokens.slice(1).join(" ")} ${tokens[0]}`;
  }
  return Object.freeze({ schema: "editkin.hinge-surface-sample/v1", id: surface.id, angleDegrees: angle, screenScale: scale,
    visibility: edge ? "edge-on" : back ? "back-face" : vertices === 0 ? "clipped-empty" : "front",
    contours: frozenContours(contours), svg, ass, bounds: bounds ? Object.freeze(bounds) : null,
    errorBoundPixels: (surface.preparation.localErrorBound * surface.preparation.projectionLipschitzBound + ROUNDING_DISTANCE) * scale,
    vertices, work });
}
