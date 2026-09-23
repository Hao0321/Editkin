import { DEFAULT_SHOT_COLOR_THRESHOLDS, SHOT_COLOR_LIMITS, type ShotColorAnalysis } from "../color/shotColorAnalysis";

export type AutoColorCandidate = { exposure: number; measurements: ShotColorAnalysis };
type Score = { exposure: number; medianErrorStops: number; worstErrorStops: number; accepted: boolean; reasons: string[] };
export interface AutoColorSelection {
  selectedIndex: number; baselineIndex: number; status: "candidate" | "unchanged" | "target_unreachable";
  candidates: Score[]; whiteBalance: "unmeasured"; aestheticQuality: "unmeasured";
}
const fail = (): never => { throw new Error("Invalid automatic exposure candidate measurements"); };
const unit = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const median = (v: number[]) => { const a = [...v].sort((x, y) => x - y); const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const floorY = 1 / (SHOT_COLOR_LIMITS.histogramBins - 1);
export function validateAutoColorMeasurements(m: ShotColorAnalysis) {
  if (!m || m.status !== "measured" || m.scope !== "provided-representative-rgb-surfaces-only"
    || m.interpretation?.primaries !== "bt709" || m.interpretation.range !== "full"
    || !["linear", "srgb", "bt709-oetf"].includes(m.interpretation.transfer)
    || !["rgb8", "rgb32f"].includes(m.interpretation.format)
    || m.quantiles?.bins !== SHOT_COLOR_LIMITS.histogramBins || m.quantiles.maximumAbsoluteBinError !== floorY
    || m.quantiles.method !== "nearest-rank-histogram-lower-edge"
    || !Array.isArray(m.frames) || m.frames.length < 1 || m.frames.length > 3) fail();
  for (const [key, expected] of Object.entries(DEFAULT_SHOT_COLOR_THRESHOLDS)) {
    if (m.thresholds?.[key as keyof typeof m.thresholds] !== expected) fail();
  }
  const ids = new Set<string>();
  for (const [index, f] of m.frames.entries()) {
    if (!f || typeof f.sampleId !== "string" || !f.sampleId.trim() || f.sampleId.length > 128 || ids.has(f.sampleId)
      || !Number.isFinite(f.timeSeconds) || f.timeSeconds < 0 || (index > 0 && f.timeSeconds <= m.frames[index - 1].timeSeconds)
      || !Number.isSafeInteger(f.pixelCount) || f.pixelCount <= 0 || f.pixelCount > SHOT_COLOR_LIMITS.pixelsPerFrame) fail();
    ids.add(f.sampleId);
    for (const d of [f.linearRelativeY, f.relativeLinearChroma]) {
      if (!d || ![d.minimum, d.maximum, d.mean, d.p01, d.p05, d.p50, d.p95, d.p99].every(unit)
        || d.minimum > d.maximum || d.mean < d.minimum - 1e-7 || d.mean > d.maximum + 1e-7
        || d.p01 > d.p05 || d.p05 > d.p50 || d.p50 > d.p95 || d.p95 > d.p99
        || d.p01 < d.minimum - floorY - 1e-7 || d.p99 > d.maximum + 1e-7) fail();
    }
    const e = f.encodedEndpoints;
    if (!e || !Array.isArray(e.low) || !Array.isArray(e.high) || e.low.length !== 3 || e.high.length !== 3) fail();
    for (const r of [f.nearWhite, f.nearBlack, f.neutralCandidates, e.anyHigh, e.anyLow, ...e.low, ...e.high]) {
      if (!r || !Number.isSafeInteger(r.count) || r.count < 0 || r.count > f.pixelCount || !unit(r.fraction)
        || Math.abs(r.fraction - r.count / f.pixelCount) > 1e-12) fail();
    }
    if (f.nearWhite.count + f.nearBlack.count > f.pixelCount || f.neutralCandidates.trustedWhitePoint !== false) fail();
  }
}

/** Explicit editorial target only. Technical proxy; never infers exposure intent or a white point. */
export function selectAutoColorCandidate(candidates: AutoColorCandidate[], baselineExposure: number, targetMedianLinearY: number): AutoColorSelection {
  if (!Array.isArray(candidates) || !candidates.length || candidates.length > 9 || !Number.isFinite(baselineExposure)
    || !unit(targetMedianLinearY) || targetMedianLinearY <= 0) fail();
  const exposures = new Set<number>();
  for (const c of candidates) {
    if (!c || !Number.isFinite(c.exposure) || Math.abs(c.exposure - baselineExposure) > 1 || exposures.has(c.exposure)) fail();
    exposures.add(c.exposure); validateAutoColorMeasurements(c.measurements);
  }
  const baselineIndex = candidates.findIndex(c => c.exposure === baselineExposure);
  if (baselineIndex < 0) fail();
  const baseline = candidates[baselineIndex].measurements;
  for (const c of candidates) {
    if (c.measurements.frames.length !== baseline.frames.length
      || (["primaries", "range", "transfer", "format"] as const).some(key => c.measurements.interpretation[key] !== baseline.interpretation[key])) fail();
    c.measurements.frames.forEach((f, i) => {
      const b = baseline.frames[i];
      if (f.sampleId !== b.sampleId || f.timeSeconds !== b.timeSeconds || f.pixelCount !== b.pixelCount) fail();
    });
  }
  const stops = (m: ShotColorAnalysis) => m.frames.map(f => Math.log2(Math.max(floorY, f.linearRelativeY.p50)));
  const spread = (m: ShotColorAnalysis) => { const s = stops(m); return Math.max(...s) - Math.min(...s); };
  const extreme = baseline.frames.some(f => f.nearWhite.fraction > .5 || f.nearBlack.fraction > .5);
  const lowContrast = baseline.frames.some(f => f.linearRelativeY.p95 - f.linearRelativeY.p05 <= 2 * floorY);
  const scores = candidates.map(c => {
    const errors = stops(c.measurements).map(y => Math.abs(y - Math.log2(targetMedianLinearY)));
    const reasons: string[] = [];
    c.measurements.frames.forEach((f, i) => {
      const b = baseline.frames[i];
      if (f.nearWhite.fraction - b.nearWhite.fraction > .003 + 1e-12) reasons.push(`near-white-increase:${f.sampleId}`);
      if (f.nearBlack.fraction - b.nearBlack.fraction > .005 + 1e-12) reasons.push(`near-black-increase:${f.sampleId}`);
      if (f.encodedEndpoints.anyHigh.fraction - b.encodedEndpoints.anyHigh.fraction > .003 + 1e-12) reasons.push(`high-endpoint-increase:${f.sampleId}`);
      if (f.encodedEndpoints.anyLow.fraction - b.encodedEndpoints.anyLow.fraction > .005 + 1e-12) reasons.push(`low-endpoint-increase:${f.sampleId}`);
      for (let channel = 0; channel < 3; channel++) {
        if (f.encodedEndpoints.high[channel].fraction - b.encodedEndpoints.high[channel].fraction > .003 + 1e-12) reasons.push(`channel-high-increase:${channel}:${f.sampleId}`);
        if (f.encodedEndpoints.low[channel].fraction - b.encodedEndpoints.low[channel].fraction > .005 + 1e-12) reasons.push(`channel-low-increase:${channel}:${f.sampleId}`);
      }
    });
    if (spread(c.measurements) - spread(baseline) > .15 + 1e-12) reasons.push("representative-temporal-spread-increase");
    if (extreme) reasons.push("baseline-extreme-occupancy-target-unverified");
    if (lowContrast) reasons.push("baseline-insufficient-measured-contrast");
    return { exposure: c.exposure, medianErrorStops: median(errors), worstErrorStops: Math.max(...errors), accepted: reasons.length === 0, reasons };
  });
  const base = scores[baselineIndex];
  const improved = scores.map((s, i) => ({ s, i })).filter(({ s, i }) => i !== baselineIndex && s.accepted
    && base.medianErrorStops - s.medianErrorStops >= .05 - 1e-12 && s.worstErrorStops <= base.worstErrorStops + 1e-12);
  const bestError = Math.min(...improved.map(({ s }) => s.medianErrorStops));
  improved.sort((a, b) => {
    const nearA = a.s.medianErrorStops <= bestError + .05; const nearB = b.s.medianErrorStops <= bestError + .05;
    return Number(nearB) - Number(nearA) || (nearA && nearB ? Math.abs(a.s.exposure - baselineExposure) - Math.abs(b.s.exposure - baselineExposure) : 0)
      || a.s.medianErrorStops - b.s.medianErrorStops || a.i - b.i;
  });
  const selectedIndex = improved[0]?.i ?? baselineIndex;
  const unreachable = extreme || lowContrast || scores[selectedIndex].worstErrorStops > .25;
  if (unreachable) scores[selectedIndex].reasons.push("target-unreachable-selected-for-review-only");
  return { selectedIndex, baselineIndex, status: unreachable ? "target_unreachable" : selectedIndex === baselineIndex ? "unchanged" : "candidate",
    candidates: scores, whiteBalance: "unmeasured", aestheticQuality: "unmeasured" };
}
