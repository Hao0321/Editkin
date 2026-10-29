import { clipTimeRemapSchemaV1, type ClipTimeRemapV1 } from "../domain/clipTimeRemapV1";
import { compileTimeRemapClockV1, type BezierSpeedPointV1 } from "../domain/timeRemapClockV1";

export const SPEED_CURVE_VISIBLE_POINTS_V1 = 8;
/** The existing compiler is the authority for continuity and time handles; no permissive GUI parser. */
export function validateSpeedCurveEditorV1(value: unknown): ClipTimeRemapV1 {
  const curve = clipTimeRemapSchemaV1.parse(value);
  compileTimeRemapClockV1({ timelineDurationSeconds: 1, sourceStartSeconds: 0, sourceDurationSeconds: 65,
    outputRate: { numerator: 1, denominator: 1 }, direction: curve.direction, segments: curve.segments });
  return curve;
}
export function speedCurveAnchorsV1(value: ClipTimeRemapV1): BezierSpeedPointV1[] {
  const curve = validateSpeedCurveEditorV1(value);
  return [curve.segments[0].from, ...curve.segments.map(s => s.to)];
}
/** Paging is a view, never a simplification of the saved 256-segment curve. */
export function speedCurvePointWindowV1(value: ClipTimeRemapV1, offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw Error("SPEED_CURVE_POINT_WINDOW_INVALID");
  const points = speedCurveAnchorsV1(value), start = Math.min(offset, Math.max(0, points.length - SPEED_CURVE_VISIBLE_POINTS_V1));
  return { total: points.length, offset: start, points: points.slice(start, start + SPEED_CURVE_VISIBLE_POINTS_V1).map((point, i) => ({ index: start + i, ...point })) };
}
const bounded = (n: number, low: number, high: number) => Math.min(high, Math.max(low, n));
function finitePoint(point: BezierSpeedPointV1) {
  if (!point || !Number.isFinite(point.time) || !Number.isFinite(point.speed)) throw Error("SPEED_CURVE_POINT_INVALID");
}
function indexOfPoint(curve: ClipTimeRemapV1, index: number) {
  if (!Number.isSafeInteger(index) || index < 0 || index > curve.segments.length) throw Error("SPEED_CURVE_POINT_INDEX_INVALID");
}
const lerp = (a: BezierSpeedPointV1, b: BezierSpeedPointV1, t: number) => ({ time: a.time + (b.time - a.time) * t, speed: a.speed + (b.speed - a.speed) * t });
const cubic = (p: BezierSpeedPointV1[], t: number) => lerp(lerp(lerp(p[0], p[1], t), lerp(p[1], p[2], t), t), lerp(lerp(p[1], p[2], t), lerp(p[2], p[3], t), t), t);

/** De Casteljau split retains both handles. Enter on an existing anchor only selects it. */
export function insertSpeedCurvePointV1(value: ClipTimeRemapV1, normalizedTime: number) {
  const curve = validateSpeedCurveEditorV1(value), points = speedCurveAnchorsV1(curve);
  if (!Number.isFinite(normalizedTime) || normalizedTime < 0 || normalizedTime > 1) throw Error("SPEED_CURVE_POINT_TIME_INVALID");
  const existing = points.findIndex(p => p.time === normalizedTime);
  if (existing >= 0) return { curve, pointIndex: existing, changed: false };
  if (curve.segments.length === 256) throw Error("SPEED_CURVE_SEGMENT_LIMIT");
  const i = curve.segments.findIndex(s => normalizedTime > s.from.time && normalizedTime < s.to.time), s = curve.segments[i];
  if (!s) throw Error("SPEED_CURVE_SPLIT_INTERVAL_INVALID");
  const p = [s.from, s.control1, s.control2, s.to]; let lo = 0, hi = 1;
  for (let n = 0; n < 60; n++) { const mid = (lo + hi) / 2; if (cubic(p, mid).time < normalizedTime) lo = mid; else hi = mid; }
  const u = (lo + hi) / 2, a = lerp(p[0], p[1], u), b = lerp(p[1], p[2], u), c = lerp(p[2], p[3], u), d = lerp(a, b, u), e = lerp(b, c, u), middle = lerp(d, e, u);
  if (middle.time <= s.from.time || middle.time >= s.to.time) throw Error("SPEED_CURVE_SPLIT_PRECISION");
  curve.segments.splice(i, 1, { from: s.from, control1: a, control2: d, to: middle }, { from: middle, control1: e, control2: c, to: s.to });
  return { curve: validateSpeedCurveEditorV1(curve), pointIndex: i + 1, changed: true };
}

export function moveSpeedCurvePointV1(value: ClipTimeRemapV1, index: number, point: BezierSpeedPointV1): ClipTimeRemapV1 {
  const curve = validateSpeedCurveEditorV1(value); indexOfPoint(curve, index); finitePoint(point);
  const points = speedCurveAnchorsV1(curve), before = points[index], last = points.length - 1;
  if (index === 0 || index === last) { if (point.time !== before.time) throw Error("SPEED_CURVE_ENDPOINT_TIME_FIXED"); }
  else if (point.time <= points[index - 1].time || point.time >= points[index + 1].time) throw Error("SPEED_CURVE_POINTS_CROSS");
  if (point.speed < 0 || point.speed > 64) throw Error("SPEED_CURVE_SPEED_RANGE");
  const dt = point.time - before.time, ds = point.speed - before.speed;
  if (index > 0) {
    const left = curve.segments[index - 1]; left.to = { ...point };
    left.control1.time = bounded(left.control1.time, left.from.time, point.time);
    left.control2 = { time: bounded(left.control2.time + dt, left.control1.time, point.time), speed: bounded(left.control2.speed + ds, 0, 64) };
  }
  if (index < last) {
    const right = curve.segments[index]; right.from = { ...point };
    right.control2.time = bounded(right.control2.time, point.time, right.to.time);
    right.control1 = { time: bounded(right.control1.time + dt, point.time, right.control2.time), speed: bounded(right.control1.speed + ds, 0, 64) };
  }
  return validateSpeedCurveEditorV1(curve);
}
export function moveSpeedCurveHandleV1(value: ClipTimeRemapV1, segmentIndex: number, handle: "control1" | "control2", point: BezierSpeedPointV1) {
  const curve = validateSpeedCurveEditorV1(value); finitePoint(point);
  if (!Number.isSafeInteger(segmentIndex) || segmentIndex < 0 || segmentIndex >= curve.segments.length || !["control1", "control2"].includes(handle)) throw Error("SPEED_CURVE_HANDLE_INVALID");
  const s = curve.segments[segmentIndex];
  s[handle] = { time: bounded(point.time, handle === "control1" ? s.from.time : s.control1.time, handle === "control1" ? s.control2.time : s.to.time), speed: bounded(point.speed, 0, 64) };
  return validateSpeedCurveEditorV1(curve);
}
export function deleteSpeedCurvePointV1(value: ClipTimeRemapV1, index: number) {
  const curve = validateSpeedCurveEditorV1(value); indexOfPoint(curve, index);
  if (index === 0 || index === curve.segments.length) throw Error("SPEED_CURVE_ENDPOINT_REQUIRED");
  const left = curve.segments[index - 1], right = curve.segments[index];
  curve.segments.splice(index - 1, 2, { from: left.from, control1: left.control1, control2: right.control2, to: right.to });
  return validateSpeedCurveEditorV1(curve);
}
/** Caller handles Enter/Delete focus; these operations never write a project or history entry. */
export function nudgeSpeedCurvePointV1(value: ClipTimeRemapV1, index: number, key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown", duration: number, fps: number, shift = false) {
  const curve = validateSpeedCurveEditorV1(value); indexOfPoint(curve, index);
  if (!(Number.isFinite(duration) && duration > 0 && Number.isFinite(fps) && fps > 0 && fps <= 240) || typeof shift !== "boolean") throw Error("SPEED_CURVE_KEY_CLOCK_INVALID");
  const points = speedCurveAnchorsV1(curve), point = points[index], step = shift ? 10 : 1;
  if (key === "ArrowLeft" || key === "ArrowRight") {
    if (index === 0 || index === points.length - 1) return curve;
    const time = point.time + (key === "ArrowLeft" ? -1 : 1) * step / fps / duration;
    if (time <= points[index - 1].time || time >= points[index + 1].time) return curve;
    return moveSpeedCurvePointV1(curve, index, { ...point, time });
  }
  if (key !== "ArrowUp" && key !== "ArrowDown") throw Error("SPEED_CURVE_KEY_UNSUPPORTED");
  return moveSpeedCurvePointV1(curve, index, { ...point, speed: bounded(point.speed * 1.1 ** (key === "ArrowUp" ? step : -step), 0, 64) });
}
