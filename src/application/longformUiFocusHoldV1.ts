import { colorBytesSha, colorDigest } from "./materialColorSamplingRuntime";
import { verifyLongformUiFocusDraftV1 } from "./longformUiFocusV1";
import type { LongformUiFocusDraftV1 } from "../domain/longformUiFocusV1";
import { LONGFORM_UI_FOCUS_HOLD_MAX_FRAMES_V1, LONGFORM_UI_FOCUS_HOLD_MAX_RAW_BYTES_V1,
  longformUiFocusHoldRequestV1Schema, longformUiFocusHoldNativePlanV1Schema,
  type LongformUiFocusHoldSequenceV1, type LongformUiFocusHoldReceiptV1, type LongformUiFocusLocalObservationV1 } from "../domain/longformUiFocusHoldV1";

type Point = { x: number; y: number };
type Rect = { x: number; y: number; width: number; height: number };
const SHA = /^[a-f0-9]{64}$/;
const equal = (a: number, b: number) => Math.abs(a - b) <= 1e-7;
export function longformUiFocusHoldTargetV1(draft: LongformUiFocusDraftV1, raw: unknown) {
  verifyLongformUiFocusDraftV1(draft); const request = longformUiFocusHoldRequestV1Schema.parse(raw);
  if (draft.draftId !== request.draftId) throw Error("UI_FOCUS_HOLD_DRAFT_ID");
  const candidate = draft.candidates.find(row => row.candidateId === request.candidateId);
  if (!candidate?.eligible) throw Error("UI_FOCUS_HOLD_TARGET_UNAVAILABLE");
  const frame = draft.frames.find(row => row.id === candidate.frameId)!;
  const end = candidate.sourceTime + request.duration;
  if (end > draft.source.start + draft.source.duration + 1e-7) throw Error("UI_FOCUS_HOLD_OUTSIDE_CLIP");
  return { request, candidate, frame, start: candidate.sourceTime, end };
}
/** Padding is only tracker context. It is not an inferred button rectangle. */
export function longformUiFocusTrackingContextV1(target: Rect, width: number, height: number): Rect {
  const pad = 8, left = Math.max(0, Math.floor(target.x * width) - pad), top = Math.max(0, Math.floor(target.y * height) - pad);
  return { x: left / width, y: top / height, width: (Math.min(width, Math.ceil((target.x + target.width) * width) + pad) - left) / width,
    height: (Math.min(height, Math.ceil((target.y + target.height) * height) + pad) - top) / height };
}
function unitProjection(quad: readonly Point[]) {
  if (quad.length !== 4 || quad.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw Error("UI_FOCUS_HOLD_QUAD");
  const corners = [[0, 0], [1, 0], [1, 1], [0, 1]], matrix: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = corners[i], { x, y } = quad[i];
    matrix.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x], [0, 0, 0, u, v, 1, -u * y, -v * y, y]);
  }
  for (let column = 0; column < 8; column++) {
    let pivot = column; for (let row = column + 1; row < 8; row++) if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) pivot = row;
    if (Math.abs(matrix[pivot][column]) < 1e-10) throw Error("UI_FOCUS_HOLD_SINGULAR_QUAD");
    [matrix[pivot], matrix[column]] = [matrix[column], matrix[pivot]];
    const divisor = matrix[column][column]; for (let i = column; i < 9; i++) matrix[column][i] /= divisor;
    for (let row = 0; row < 8; row++) if (row !== column) {
      const multiplier = matrix[row][column]; for (let i = column; i < 9; i++) matrix[row][i] -= multiplier * matrix[column][i];
    }
  }
  const a = matrix.map(row => row[8]);
  return (u: number, v: number): Point => {
    const w = a[6] * u + a[7] * v + 1;
    if (!Number.isFinite(w) || Math.abs(w) < 1e-10) throw Error("UI_FOCUS_HOLD_SINGULAR_QUAD");
    return { x: (a[0] * u + a[1] * v + a[2]) / w, y: (a[3] * u + a[4] * v + a[5]) / w };
  };
}
export { unitProjection as longformUiFocusQuadProjectionV1 };
export function projectLongformUiFocusTrackedQuadV1(target: readonly Point[], context: Rect, trackedContext: readonly Point[]) {
  const project = unitProjection(trackedContext);
  return target.map(p => project((p.x - context.x) / context.width, (p.y - context.y) / context.height));
}
function validQuad(quad: readonly Point[]) {
  if (quad.length !== 4 || quad.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0 || p.x > 1 || p.y > 1)) return false;
  const crosses = quad.map((a, i) => { const b = quad[(i + 1) % 4], c = quad[(i + 2) % 4]; return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x); });
  return crosses.every(value => value > 1e-10);
}
function samplePixels(data: Uint8Array, width: number, height: number, quad: readonly Point[], columns: number, rows: number) {
  if (!validQuad(quad)) throw Error("UI_FOCUS_HOLD_TARGET_OUTSIDE_FRAME");
  const project = unitProjection(quad), values: number[] = [];
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const p = project((column + .5) / columns, (row + .5) / rows), x = p.x * width - .5, y = p.y * height - .5;
    if (x < 0 || y < 0 || x > width - 1 || y > height - 1) throw Error("UI_FOCUS_HOLD_TARGET_OUTSIDE_FRAME");
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
    values.push(data[y0 * width + x0] * (1 - x + x0) * (1 - y + y0) + data[y0 * width + x1] * (x - x0) * (1 - y + y0)
      + data[y1 * width + x0] * (1 - x + x0) * (y - y0) + data[y1 * width + x1] * (x - x0) * (y - y0));
  }
  return values;
}
function comparison(reference: number[], actual: number[]) {
  const n = reference.length, leftMean = reference.reduce((a, b) => a + b, 0) / n, rightMean = actual.reduce((a, b) => a + b, 0) / n;
  let left = 0, right = 0, covariance = 0, difference = 0;
  for (let i = 0; i < n; i++) { const a = reference[i] - leftMean, b = actual[i] - rightMean;
    left += a * a; right += b * b; covariance += a * b; difference += Math.abs(reference[i] - actual[i]); }
  return { correlation: Math.max(-1, Math.min(1, covariance / Math.max(1e-8, Math.sqrt(left * right)))),
    difference: difference / (n * 255), standardDeviation: Math.sqrt(left / n) };
}
export function verifyLongformUiFocusHoldSequenceV1(sequence: LongformUiFocusHoldSequenceV1, pixels: Uint8Array,
  draft: LongformUiFocusDraftV1, raw: unknown) {
  const target = longformUiFocusHoldTargetV1(draft, raw), { numerator, denominator } = sequence.timeBase, count = sequence.frames.length;
  if (sequence.schema !== "editkin.longform-ui-focus-hold-sequence/v1" || sequence.sourceSha256 !== draft.source.sha256
    || ![numerator, denominator, sequence.width, sequence.height].every(n => Number.isSafeInteger(n) && n > 0)
    || sequence.width !== target.frame.display.decoded.width || sequence.height !== target.frame.display.decoded.height
    || sequence.origin !== target.frame.display.decoded.timelineOrigin || !Number.isFinite(sequence.nominalFps) || sequence.nominalFps <= 0 || sequence.nominalFps > 120
    || !count || count > LONGFORM_UI_FOCUS_HOLD_MAX_FRAMES_V1 || pixels.length > LONGFORM_UI_FOCUS_HOLD_MAX_RAW_BYTES_V1
    || pixels.length !== count * sequence.width * sequence.height || sequence.rawBytes !== pixels.length || sequence.rawSha256 !== colorBytesSha(pixels)
    || colorDigest(sequence.filters) !== colorDigest([...target.frame.display.normalization.filters, "format=gray"]))
    throw Error("UI_FOCUS_HOLD_SEQUENCE_BINDING");
  const frameBytes = sequence.width * sequence.height;
  for (let i = 0; i < count; i++) {
    const frame = sequence.frames[i], time = frame.pts * numerator / denominator - sequence.origin, duration = frame.durationPts * numerator / denominator;
    if (frame.frame !== i || !Number.isSafeInteger(frame.pts) || !Number.isSafeInteger(frame.durationPts) || frame.durationPts <= 0
      || !equal(time, frame.sourceTime) || !equal(duration, frame.duration) || !SHA.test(frame.imageSha256)
      || frame.imageSha256 !== colorBytesSha(pixels.subarray(i * frameBytes, (i + 1) * frameBytes))
      || frame.sourceTime < target.start - 1e-7 || frame.sourceTime >= target.end - 1e-7
      || (i > 0 && !equal(frame.sourceTime, sequence.frames[i - 1].sourceTime + sequence.frames[i - 1].duration)))
      throw Error("UI_FOCUS_HOLD_CLOCK_OR_PIXEL_COVERAGE");
    if (frame.reportedDurationPts !== undefined && (!Number.isSafeInteger(frame.reportedDurationPts) || frame.reportedDurationPts <= 0
      || (frame.durationAuthority === "decoder-duration" && frame.reportedDurationPts !== frame.durationPts)
      || (frame.durationAuthority === "next-decoded-pts-with-millisecond-quantization"
        && (numerator / denominator > .001000001 || Math.abs(frame.reportedDurationPts - frame.durationPts) > 1))))
      throw Error("UI_FOCUS_HOLD_DURATION_AUTHORITY");
  }
  const last = sequence.frames.at(-1)!;
  if (sequence.followingFrame && (!Number.isSafeInteger(sequence.followingFrame.pts) || !SHA.test(sequence.followingFrame.imageSha256)
    || !equal(sequence.followingFrame.sourceTime, sequence.followingFrame.pts * numerator / denominator - sequence.origin)
    || !equal(sequence.followingFrame.sourceTime, last.sourceTime + last.duration) || sequence.followingFrame.sourceTime < target.end - 1e-7))
    throw Error("UI_FOCUS_HOLD_FOLLOWING_FRAME_BINDING");
  if (!equal(sequence.frames[0].sourceTime, target.start) || last.sourceTime + last.duration < target.end - 1e-7) throw Error("UI_FOCUS_HOLD_INCOMPLETE_WINDOW");
  for (const cut of sequence.cuts) if (!Number.isInteger(cut.frame) || cut.frame < 0 || cut.frame >= count || !equal(cut.sourceTime, sequence.frames[cut.frame].sourceTime)
    || !Number.isFinite(cut.score) || cut.score < 10 || cut.score > 100) throw Error("UI_FOCUS_HOLD_CUT_BINDING");
  return target;
}
/** Measured template continuity, not a semantic/control recognizer. Every source
 * presentation frame is checked; native ordinal/fps clocks are never published. */
export function assembleLongformUiFocusHoldEvidenceV1(draft: LongformUiFocusDraftV1, raw: unknown,
  sequence: LongformUiFocusHoldSequenceV1, pixels: Uint8Array, nativeValue: unknown,
  localObservations?: readonly LongformUiFocusLocalObservationV1[]): LongformUiFocusHoldReceiptV1 {
  const target = verifyLongformUiFocusHoldSequenceV1(sequence, pixels, draft, raw), plan = longformUiFocusHoldNativePlanV1Schema.parse(nativeValue);
  const count = sequence.frames.length, frameBytes = sequence.width * sequence.height;
  if (plan.width !== sequence.width || plan.height !== sequence.height || plan.analysisFps !== sequence.nominalFps || plan.points.length !== count
    || plan.points.some((p, i) => p.frame !== i || !equal(p.time, i / plan.analysisFps))
    || !equal(plan.lostRatio, plan.points.filter(p => p.status === "lost").length / count)) throw Error("UI_FOCUS_HOLD_NATIVE_BINDING");
  if (localObservations && (localObservations.length !== count || localObservations.some((row, i) => row.frame !== i)))
    throw Error("UI_FOCUS_HOLD_LOCAL_FRAME_BINDING");
  const context = longformUiFocusTrackingContextV1(target.candidate.bounds, sequence.width, sequence.height);
  const columns = Math.max(8, Math.min(64, Math.ceil(target.candidate.bounds.width * sequence.width)));
  const rows = Math.max(8, Math.min(64, Math.ceil(target.candidate.bounds.height * sequence.height)));
  const reference = samplePixels(pixels.subarray(0, frameBytes), sequence.width, sequence.height, target.candidate.quad, columns, rows);
  const flags: string[] = [], frames: LongformUiFocusHoldReceiptV1["frames"] = []; let previous = target.candidate.quad;
  if (comparison(reference, reference).standardDeviation < 4) flags.push("TARGET_TEXTURE_TOO_WEAK");
  for (let i = 0; i < count; i++) {
    const p = plan.points[i], clock = sequence.frames[i], local: string[] = [], diagnostics: string[] = [], observation = localObservations?.[i];
    const independent = observation?.state === "measured";
    let quad: Point[] = [], correlation = -1, difference = 1;
    if ((i === 0 && p.status !== "manual") || (i > 0 && p.status !== "tracked")) diagnostics.push("TRACK_NOT_CONTINUOUS");
    if (i > 0 && p.confidence < .6) diagnostics.push("LOW_UNCALIBRATED_TRACK_SCORE");
    if (p.planarDiagnostics?.globalSearch) diagnostics.push("REACQUISITION_REQUIRES_NEW_CONFIRMATION");
    if (!independent) local.push(...diagnostics);
    if (observation && observation.state !== "measured") local.push("LOCAL_TARGET_" + observation.state.toUpperCase());
    if (sequence.cuts.some(cut => cut.frame === i && i > 0)) local.push("SCENE_CHANGE_REQUIRES_NEW_CONFIRMATION");
    try {
      if (independent) {
        if (!validQuad(observation.targetQuad) || !Number.isFinite(observation.correlation) || observation.correlation < .92 || observation.difference > .08)
          throw Error("LOCAL_PIXEL_OBSERVATION_INVALID");
        quad = structuredClone(observation.targetQuad);
      } else {
        if (!validQuad(p.quad)) throw Error("QUAD_OUTSIDE_OR_FOLDED");
        quad = projectLongformUiFocusTrackedQuadV1(target.candidate.quad, context, p.quad);
      }
      const measured = comparison(reference, samplePixels(pixels.subarray(i * frameBytes, (i + 1) * frameBytes), sequence.width, sequence.height, quad, columns, rows));
      correlation = measured.correlation; difference = measured.difference;
      if (correlation < .8 || difference > .12) local.push("TARGET_APPEARANCE_CHANGED");
      if (i === 0 && quad.some((q, n) => Math.hypot((q.x - target.candidate.quad[n].x) * sequence.width, (q.y - target.candidate.quad[n].y) * sequence.height) > 2))
        local.push("INITIAL_TARGET_NOT_ANCHORED");
      if (i > 0 && quad.some((q, n) => Math.hypot((q.x - previous[n].x) * sequence.width, (q.y - previous[n].y) * sequence.height) > Math.min(sequence.width, sequence.height) * .15))
        local.push("ABRUPT_TARGET_JUMP");
      previous = quad;
    } catch { local.push("TARGET_OUTSIDE_OR_INVALID_GEOMETRY"); }
    frames.push({ frame: i, pts: clock.pts, durationPts: clock.durationPts, sourceTime: clock.sourceTime,
      endTime: Math.min(target.end, clock.sourceTime + clock.duration), imageSha256: clock.imageSha256, targetQuad: quad,
      nativeStatus: p.status, nativeConfidence: p.confidence, templateCorrelation: correlation, templateMeanAbsoluteDifference: difference, flags: local,
      trackingProvider: independent ? "independent-local-pixels" : "native-plan", nativeDiagnostics: diagnostics });
  }
  flags.push(...new Set(frames.flatMap(frame => frame.flags)));
  const body: Omit<LongformUiFocusHoldReceiptV1, "receiptSha256"> = {
    schema: "editkin.longform-ui-focus-hold-evidence/v1", draftId: draft.draftId, candidateId: target.candidate.candidateId,
    state: flags.length ? "BLOCKED" : "TRACKING_EVIDENCE_READY", sourceSha256: draft.source.sha256,
    sourceStart: target.start, sourceEnd: target.end, requestedDuration: target.request.duration, sourceFrameCount: count,
    sourceTimeBase: sequence.timeBase, sequenceSha256: colorDigest(sequence), rawSha256: sequence.rawSha256, nativeResultSha256: colorDigest(plan),
    trackingContext: context, contextAuthority: "tool-derived-padding-around-ocr-text-not-widget-edges", frames, flags,
    pixelTemplateContinuityVerified: !flags.length, semanticIdentityAcrossIntervalVerified: false, confidenceCalibrated: false,
    projectModified: false, focusHintsReady: false, artworkStatus: "ART_PENDING_CLAUDE", selectableByDefault: false,
  };
  return { ...body, receiptSha256: colorDigest(body) };
}
