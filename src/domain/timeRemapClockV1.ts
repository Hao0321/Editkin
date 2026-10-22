import { timeRemapOutputFrameCountV1 } from "./timeRemapFrameCountV1";
/** W2-3/LV-01 shared clock candidate. Consumers are not enabled by this module. */
export interface RationalFrameRateV1 { numerator: number; denominator: number }
/** Seconds per decoded PTS tick. */
export interface RationalTimeBaseV1 { numerator: number; denominator: number }
export interface BezierSpeedPointV1 { time: number; speed: number }
export interface BezierSpeedSegmentV1 {
  from: BezierSpeedPointV1; control1: BezierSpeedPointV1;
  control2: BezierSpeedPointV1; to: BezierSpeedPointV1;
}
export interface TimeRemapClockRequestV1 {
  timelineDurationSeconds: number; sourceStartSeconds: number; sourceDurationSeconds: number;
  outputRate: RationalFrameRateV1; direction: "forward" | "reverse";
  /** Normalized clip time [0,1]; speed is source seconds per timeline second. */
  segments: readonly BezierSpeedSegmentV1[];
}
interface CompiledSegmentV1 {
  from: number; to: number; x: readonly number[]; y: readonly number[];
  primitive: readonly number[]; area: number; prefix: number; constantSpeed?: number;
}
export interface TimeRemapClockV1 {
  schema: "editkin.time-remap-clock/v1"; timelineDurationSeconds: number;
  sourceStartSeconds: number; sourceEndSeconds: number; sourceDurationSeconds: number;
  consumedSourceSeconds: number; outputRate: Readonly<RationalFrameRateV1>;
  totalOutputFrames: number; direction: "forward" | "reverse";
  interpolation: "frame_blending"; segments: readonly CompiledSegmentV1[];
}
const clocks = new WeakSet<object>();
const MAX_SECONDS = 1_000_000_000, MAX_SEGMENTS = 256, MAX_DESCRIPTOR_BYTES = 65_536;
function fail(reason: string): never { throw Error(`TIME_REMAP_CLOCK_${reason}`); }
function finite(value: number, low: number, high: number, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < low || value > high) fail(label);
}
function rate(value: RationalFrameRateV1): Readonly<RationalFrameRateV1> {
  if (!value || !Number.isSafeInteger(value.numerator) || !Number.isSafeInteger(value.denominator)
    || value.numerator < 1 || value.denominator < 1 || value.numerator > 1_000_000 || value.denominator > 1_000_000) fail("RATE_INVALID");
  let a = value.numerator, b = value.denominator;
  while (b) { const remainder = a % b; a = b; b = remainder; }
  return Object.freeze({ numerator: value.numerator / a, denominator: value.denominator / a });
}
function polynomial(values: readonly number[]): number[] {
  const [a, b, c, d] = values;
  return [a, 3 * (b - a), 3 * (c - 2 * b + a), d - 3 * c + 3 * b - a];
}
function evaluate(coefficients: readonly number[], u: number): number {
  let result = 0;
  for (let index = coefficients.length - 1; index >= 0; index--) result = result * u + coefficients[index];
  return result;
}
function bezier(points: readonly number[], u: number): number {
  const v = 1 - u;
  return v ** 3 * points[0] + 3 * v ** 2 * u * points[1] + 3 * v * u ** 2 * points[2] + u ** 3 * points[3];
}
function timeParameter(segment: CompiledSegmentV1, time: number): number {
  if (time <= segment.from) return 0;
  if (time >= segment.to) return 1;
  let low = 0, high = 1;
  for (let iteration = 0; iteration < 60; iteration++) {
    const middle = (low + high) / 2;
    if (bezier(segment.x, middle) < time) low = middle; else high = middle;
  }
  return (low + high) / 2;
}
function assertClock(clock: TimeRemapClockV1) { if (!clocks.has(clock)) fail("COMPILED_IDENTITY_REQUIRED"); }

/** Integrates y(u)*x'(u) exactly; no output-duration-sized frame table. */
export function compileTimeRemapClockV1(request: TimeRemapClockRequestV1): TimeRemapClockV1 {
  if (!request || (request.direction !== "forward" && request.direction !== "reverse")) fail("REQUEST_INVALID");
  finite(request.timelineDurationSeconds, Number.MIN_VALUE, MAX_SECONDS, "DURATION_INVALID");
  finite(request.sourceDurationSeconds, Number.MIN_VALUE, MAX_SECONDS, "SOURCE_DURATION_INVALID");
  finite(request.sourceStartSeconds, 0, request.sourceDurationSeconds, "SOURCE_START_INVALID");
  if (request.sourceStartSeconds >= request.sourceDurationSeconds) fail("SOURCE_START_AT_EOF");
  const outputRate = rate(request.outputRate);
  const totalOutputFrames = timeRemapOutputFrameCountV1(request.timelineDurationSeconds, outputRate);
  if (!Number.isSafeInteger(totalOutputFrames) || totalOutputFrames < 1) fail("FRAME_COUNT_UNSAFE");
  if (!Array.isArray(request.segments) || !request.segments.length || request.segments.length > MAX_SEGMENTS) fail("SEGMENT_COUNT_INVALID");
  const segments: CompiledSegmentV1[] = [];
  let area = 0, correction = 0, previousTime = 0, previousSpeed: number | undefined;
  for (const input of request.segments) {
    if (!input || !input.from || !input.control1 || !input.control2 || !input.to) fail("SEGMENT_INVALID");
    const points = [input.from, input.control1, input.control2, input.to];
    for (const point of points) { finite(point.time, 0, 1, "TIME_INVALID"); finite(point.speed, 0, 64, "SPEED_INVALID"); }
    if (input.from.time !== previousTime || input.to.time <= input.from.time
      || (previousSpeed !== undefined && input.from.speed !== previousSpeed)) fail("SEGMENT_CONTINUITY_INVALID");
    if (input.control1.time < input.from.time || input.control2.time < input.control1.time || input.control2.time > input.to.time) fail("TIME_HANDLES_NON_MONOTONE");
    const x = points.map(p => p.time), y = points.map(p => p.speed), xp = polynomial(x), yp = polynomial(y);
    const derivative = [xp[1], 2 * xp[2], 3 * xp[3]], product = Array<number>(6).fill(0);
    for (let i = 0; i < yp.length; i++) for (let j = 0; j < derivative.length; j++) product[i + j] += yp[i] * derivative[j];
    const primitive = [0, ...product.map((value, i) => value / (i + 1))];
    const constantSpeed = y.every(value => value === y[0]) ? y[0] : undefined;
    const segmentArea = constantSpeed === undefined ? evaluate(primitive, 1) : constantSpeed * (input.to.time - input.from.time);
    if (!Number.isFinite(segmentArea) || segmentArea < -1e-12) fail("INTEGRATION_INVALID");
    const safeArea = Math.max(0, segmentArea);
    segments.push(Object.freeze({ from: input.from.time, to: input.to.time, x: Object.freeze(x), y: Object.freeze(y),
      primitive: Object.freeze(primitive), area: safeArea, prefix: area, ...(constantSpeed === undefined ? {} : { constantSpeed }) }));
    const adjusted = safeArea - correction, sum = area + adjusted;
    correction = (sum - area) - adjusted; area = sum;
    previousTime = input.to.time; previousSpeed = input.to.speed;
  }
  if (previousTime !== 1) fail("CURVE_END_REQUIRED");
  const consumedSourceSeconds = area * request.timelineDurationSeconds;
  if (!Number.isFinite(consumedSourceSeconds)) fail("SOURCE_SPAN_UNSAFE");
  if (area > 0 && consumedSourceSeconds === 0) fail("SOURCE_PRECISION_INSUFFICIENT");
  let sourceEndSeconds = request.sourceStartSeconds + consumedSourceSeconds;
  const tolerance = 16 * Number.EPSILON * Math.max(1, request.sourceDurationSeconds);
  if (sourceEndSeconds > request.sourceDurationSeconds + tolerance) fail("SOURCE_HANDLES_INSUFFICIENT");
  if (consumedSourceSeconds > 0 && sourceEndSeconds === request.sourceStartSeconds) fail("SOURCE_PRECISION_INSUFFICIENT");
  sourceEndSeconds = Math.min(sourceEndSeconds, request.sourceDurationSeconds);
  const clock: TimeRemapClockV1 = Object.freeze({ schema: "editkin.time-remap-clock/v1", timelineDurationSeconds: request.timelineDurationSeconds,
    sourceStartSeconds: request.sourceStartSeconds, sourceEndSeconds, sourceDurationSeconds: request.sourceDurationSeconds,
    consumedSourceSeconds, outputRate, totalOutputFrames, direction: request.direction, interpolation: "frame_blending", segments: Object.freeze(segments) });
  if (new TextEncoder().encode(JSON.stringify(clock)).byteLength > MAX_DESCRIPTOR_BYTES) fail("DESCRIPTOR_BYTES_EXCEEDED");
  clocks.add(clock); return clock;
}
function progress(clock: TimeRemapClockV1, timelineSeconds: number): number {
  if (timelineSeconds === 0) return 0;
  if (timelineSeconds === clock.timelineDurationSeconds) return clock.consumedSourceSeconds;
  const normalized = timelineSeconds / clock.timelineDurationSeconds;
  let low = 0, high = clock.segments.length - 1;
  while (low < high) { const middle = Math.floor((low + high) / 2); if (normalized >= clock.segments[middle].to) low = middle + 1; else high = middle; }
  const segment = clock.segments[low];
  if (segment.constantSpeed !== undefined) {
    return Math.min(clock.consumedSourceSeconds, Math.max(0, segment.prefix * clock.timelineDurationSeconds
      + segment.constantSpeed * (timelineSeconds - segment.from * clock.timelineDurationSeconds)));
  }
  const u = timeParameter(segment, normalized);
  const partial = u === 1 ? segment.area : Math.min(segment.area, Math.max(0, evaluate(segment.primitive, u)));
  return Math.min(clock.consumedSourceSeconds, Math.max(0, (segment.prefix + partial) * clock.timelineDurationSeconds));
}
/** A boundary can equal the exclusive source out; it is not a decoder sample. */
export function timeRemapSourceBoundaryV1(clock: TimeRemapClockV1, timelineSeconds: number): number {
  assertClock(clock); finite(timelineSeconds, 0, clock.timelineDurationSeconds, "TIMELINE_OUT_OF_RANGE");
  const distance = progress(clock, timelineSeconds);
  return clock.direction === "forward" ? Math.min(clock.sourceEndSeconds, clock.sourceStartSeconds + distance)
    : Math.max(clock.sourceStartSeconds, clock.sourceEndSeconds - distance);
}
export function timeRemapTimelineBoundaryV1(clock: TimeRemapClockV1, sourceSeconds: number, edge: "first" | "last"): number {
  assertClock(clock); finite(sourceSeconds, clock.sourceStartSeconds, clock.sourceEndSeconds, "SOURCE_OUT_OF_RANGE");
  if (edge !== "first" && edge !== "last") fail("INVERSE_EDGE_REQUIRED");
  const target = clock.direction === "forward" ? sourceSeconds - clock.sourceStartSeconds : clock.sourceEndSeconds - sourceSeconds;
  if (clock.consumedSourceSeconds === 0) return edge === "first" ? 0 : clock.timelineDurationSeconds;
  // Absolute source clocks round at addition: recognize exact zero-speed plateaus in that resolution.
  const sourceResolution = 8 * Number.EPSILON * Math.max(1, clock.sourceStartSeconds, clock.sourceEndSeconds);
  const plateaus = clock.segments.filter(segment => segment.constantSpeed === 0
    && Math.abs(segment.prefix * clock.timelineDurationSeconds - target) <= sourceResolution);
  if (plateaus.length) return (edge === "first" ? plateaus[0].from : plateaus[plateaus.length - 1].to) * clock.timelineDurationSeconds;
  if (target === 0 && edge === "first") return 0;
  if (target === clock.consumedSourceSeconds && edge === "last") return clock.timelineDurationSeconds;
  let low = 0, high = clock.timelineDurationSeconds;
  for (let iteration = 0; iteration < 64; iteration++) {
    const middle = (low + high) / 2, value = progress(clock, middle);
    if (edge === "first" ? value < target : value <= target) low = middle; else high = middle;
  }
  return edge === "first" ? high : low;
}
export function timeRemapFrameIntervalV1(clock: TimeRemapClockV1, frameIndex: number) {
  assertClock(clock);
  if (!Number.isSafeInteger(frameIndex) || frameIndex < 0 || frameIndex >= clock.totalOutputFrames) fail("FRAME_INDEX_INVALID");
  const timelineStart = frameIndex * clock.outputRate.denominator / clock.outputRate.numerator;
  const timelineEnd = Math.min(clock.timelineDurationSeconds, (frameIndex + 1) * clock.outputRate.denominator / clock.outputRate.numerator);
  if (timelineStart >= clock.timelineDurationSeconds || timelineEnd <= timelineStart) fail("FRAME_INTERVAL_PRECISION");
  const from = timeRemapSourceBoundaryV1(clock, timelineStart), to = timeRemapSourceBoundaryV1(clock, timelineEnd);
  return { frameIndex, timelineStart, timelineEnd, sourceLow: Math.min(from, to), sourceHigh: Math.max(from, to),
    direction: clock.direction, frozen: from === to };
}
/** CFR only. Reverse samples the lower boundary of its reversed half-open frame interval. */
export function timeRemapCfrBlendSampleV1(clock: TimeRemapClockV1, frameIndex: number,
  source: { timing: "cfr"; frameRate: RationalFrameRateV1; decodedFrameCount: number }) {
  assertClock(clock);
  if (!source || source.timing !== "cfr") fail("AUTHENTIC_CFR_CLOCK_REQUIRED");
  const sourceRate = rate(source.frameRate), count = source.decodedFrameCount;
  if (!Number.isSafeInteger(count) || count < 1) fail("SOURCE_FRAME_COUNT_INVALID");
  const actualEnd = count * sourceRate.denominator / sourceRate.numerator;
  if (clock.sourceEndSeconds > actualEnd + 16 * Number.EPSILON * Math.max(1, actualEnd)) fail("ACTUAL_VIDEO_EOF");
  const interval = timeRemapFrameIntervalV1(clock, frameIndex), rawPosition = interval.sourceLow * sourceRate.numerator / sourceRate.denominator;
  const nearestFrame = Math.round(rawPosition);
  const position = Math.abs(rawPosition - nearestFrame) <= 4 * Number.EPSILON * Math.max(1, Math.abs(rawPosition)) ? nearestFrame : rawPosition;
  const lowerFrame = Math.floor(position);
  if (!Number.isSafeInteger(lowerFrame) || lowerFrame < 0 || lowerFrame >= count) fail("SOURCE_SAMPLE_AT_EOF");
  const upperFrame = Math.min(lowerFrame + 1, count - 1);
  return { ...interval, lowerFrame, upperFrame, mix: upperFrame === lowerFrame ? 0 : position - lowerFrame,
    sourceTimeSeconds: interval.sourceLow, sourceTiming: "cfr" as const };
}

export interface IndexedPresentationClockV1 {
  timing: "vfr"; timeBase: RationalTimeBaseV1;
  /** Converts authentic PTS ticks into the canonical source-seconds coordinate. */
  clockOrigin: { pts: number; sourceSeconds: number };
  decodedFrameCount: number; lastFrameEndPts: number;
  /** Upstream-validated immutable presentation order, not packet/DTS order. */
  ptsAt: (frameIndex: number) => number;
}
/** Reads only a logarithmic bracket. Upstream owns global PTS-index integrity. */
export function timeRemapVfrBlendSampleV1(clock: TimeRemapClockV1, frameIndex: number, source: IndexedPresentationClockV1) {
  assertClock(clock);
  if (!source || source.timing !== "vfr" || typeof source.ptsAt !== "function" || !source.clockOrigin) fail("PRESENTATION_INDEX_REQUIRED");
  const timeBase = rate(source.timeBase), count = source.decodedFrameCount, origin = source.clockOrigin;
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(origin.pts)
    || !Number.isSafeInteger(source.lastFrameEndPts)) fail("PRESENTATION_INDEX_INVALID");
  finite(origin.sourceSeconds, 0, MAX_SECONDS, "SOURCE_ORIGIN_INVALID");
  const tickCache = new Map<number, number>();
  const read = (index: number) => {
    const cached = tickCache.get(index); if (cached !== undefined) return cached;
    const tick = source.ptsAt(index);
    if (!Number.isSafeInteger(tick) || !Number.isSafeInteger(tick - origin.pts)) fail("PRESENTATION_TICK_UNSAFE");
    tickCache.set(index, tick); return tick;
  };
  const firstTick = read(0), lastTick = read(count - 1);
  if (lastTick < firstTick || (count > 1 && lastTick === firstTick) || source.lastFrameEndPts <= lastTick
    || !Number.isSafeInteger(source.lastFrameEndPts - origin.pts)) fail("PRESENTATION_INDEX_INVALID");
  const actualEnd = origin.sourceSeconds + (source.lastFrameEndPts - origin.pts) * timeBase.numerator / timeBase.denominator;
  if (!Number.isFinite(actualEnd) || clock.sourceEndSeconds > actualEnd + 16 * Number.EPSILON * Math.max(1, actualEnd)) fail("ACTUAL_VIDEO_EOF");
  const interval = timeRemapFrameIntervalV1(clock, frameIndex);
  const rawTick = origin.pts + (interval.sourceLow - origin.sourceSeconds) * timeBase.denominator / timeBase.numerator;
  if (!Number.isFinite(rawTick) || Math.abs(rawTick) > Number.MAX_SAFE_INTEGER) fail("PRESENTATION_TICK_UNSAFE");
  const nearest = Math.round(rawTick), targetTick = Math.abs(rawTick - nearest) <= 4 * Number.EPSILON * Math.max(1, Math.abs(rawTick)) ? nearest : rawTick;
  if (targetTick < firstTick || targetTick >= source.lastFrameEndPts) fail("SOURCE_SAMPLE_OUTSIDE_PRESENTATION");
  let lowerFrame = 0, upperFrame = count - 1;
  if (targetTick >= lastTick) lowerFrame = upperFrame;
  else while (upperFrame - lowerFrame > 1) {
    const middle = Math.floor(lowerFrame + (upperFrame - lowerFrame) / 2), tick = read(middle);
    if (tick <= read(lowerFrame) || tick >= read(upperFrame)) fail("PRESENTATION_ORDER_INVALID");
    if (tick <= targetTick) lowerFrame = middle; else upperFrame = middle;
  }
  if (count === 1) upperFrame = lowerFrame;
  const lowerPts = read(lowerFrame), upperPts = read(upperFrame);
  if (upperFrame !== lowerFrame && upperPts <= lowerPts) fail("PRESENTATION_ORDER_INVALID");
  const mix = upperFrame === lowerFrame ? 0 : (targetTick - lowerPts) / (upperPts - lowerPts);
  if (mix < 0 || mix > 1 || !Number.isFinite(mix)) fail("PRESENTATION_BRACKET_INVALID");
  return { ...interval, lowerFrame, upperFrame, mix, lowerPts, upperPts, inspectedPoints: tickCache.size,
    sourceTimeSeconds: interval.sourceLow, sourceTiming: "vfr" as const };
}
