import { selectReferenceWhiteBalanceCandidate, type ReferenceWhiteBalanceCandidate } from "./referenceWhiteBalance";
export interface ReferenceWhiteBalanceControl { temperature: number; tint: number }
export type ReferenceWhiteBalanceSearchNext = { status: "next"; control: ReferenceWhiteBalanceControl }
  | { status: "stop"; reason: "budget-exhausted" | "singular-jacobian" | "no-improvement" | "duplicate-control" | "target-reached" | "reference-unusable" };
const key = (c: ReferenceWhiteBalanceControl) => `${c.temperature}:${c.tint}`;
/** Bounded measured Jacobian search; it does not detect whether the declared reference is neutral. */
export function nextReferenceWhiteBalanceControl(evaluated: ReferenceWhiteBalanceCandidate[], baseline: ReferenceWhiteBalanceControl, maxAdjustment: number): ReferenceWhiteBalanceSearchNext {
  if (!baseline || ![baseline.temperature, baseline.tint].every(v => Number.isFinite(v) && Math.abs(v) <= 1)
    || !Number.isFinite(maxAdjustment) || maxAdjustment < .05 || maxAdjustment > 1 || !Array.isArray(evaluated) || evaluated.length > 9) throw Error("Invalid white balance search input");
  const bounded = (v: number, b: number) => Math.max(-1, b - maxAdjustment, Math.min(1, b + maxAdjustment, Math.round(v * 1e6) / 1e6));
  const control = (temperature: number, tint: number) => ({ temperature: bounded(temperature, baseline.temperature), tint: bounded(tint, baseline.tint) });
  const baseControl = { temperature: baseline.temperature, tint: baseline.tint };
  const seeds = [baseControl, control(baseline.temperature - maxAdjustment, baseline.tint), control(baseline.temperature + maxAdjustment, baseline.tint),
    control(baseline.temperature, baseline.tint - maxAdjustment), control(baseline.temperature, baseline.tint + maxAdjustment)]
    .filter((c, i, a) => a.findIndex(v => key(v) === key(c)) === i);
  if (!evaluated.length) return { status: "next", control: baseControl };
  const scores = selectReferenceWhiteBalanceCandidate(evaluated, baseline);
  if (key(evaluated[0]) !== key(baseline) || evaluated.some(c => Math.abs(c.temperature - baseline.temperature) > maxAdjustment + 1e-12 || Math.abs(c.tint - baseline.tint) > maxAdjustment + 1e-12)) throw Error("Invalid white balance search prefix");
  if (evaluated.slice(0, seeds.length).some((c, i) => key(c) !== key(seeds[i]))) throw Error("Invalid white balance seed order");
  if (scores.status === "reference_unusable") return { status: "stop", reason: "reference-unusable" };
  if (scores.candidates.some(c => c.accepted && c.worstErrorStops <= .08)) return { status: "stop", reason: "target-reached" };
  if (evaluated.length >= 9) return { status: "stop", reason: "budget-exhausted" };
  if (evaluated.length < seeds.length) return { status: "next", control: seeds[evaluated.length] };
  const residual = (c: ReferenceWhiteBalanceCandidate) => c.frames.reduce((v, f) => {
    if (f.meanLinearRgb.some(n => n <= 0)) throw Error("Undefined neutral channel ratio");
    return [v[0] + Math.log2(f.meanLinearRgb[0] / f.meanLinearRgb[1]) / c.frames.length,
      v[1] + Math.log2(f.meanLinearRgb[2] / f.meanLinearRgb[1]) / c.frames.length];
  }, [0, 0]);
  const axis = (name: "temperature" | "tint") => {
    const other = name === "temperature" ? "tint" : "temperature";
    const samples = evaluated.slice(0, seeds.length).filter(c => c[other] === baseline[other]).sort((a, b) => a[name] - b[name]);
    const a = samples[0], b = samples.at(-1)!;
    if (!a || b[name] - a[name] < 1e-8) return [0, 0];
    const ra = residual(a), rb = residual(b);
    return [(rb[0] - ra[0]) / (b[name] - a[name]), (rb[1] - ra[1]) / (b[name] - a[name])];
  };
  const t = axis("temperature"), g = axis("tint"), det = t[0] * g[1] - g[0] * t[1];
  const norm = Math.hypot(...t) * Math.hypot(...g);
  if (![...t, ...g, det].every(Number.isFinite) || norm < 1e-10 || Math.abs(det) / norm < 1e-4) return { status: "stop", reason: "singular-jacobian" };
  const error = (c: ReferenceWhiteBalanceCandidate) => Math.hypot(...residual(c));
  const best = evaluated.reduce((a, b) => error(b) < error(a) ? b : a);
  if (evaluated.length > seeds.length && error(evaluated.at(-1)!) >= Math.min(...evaluated.slice(0, -1).map(error)) - 1e-6) return { status: "stop", reason: "no-improvement" };
  const r = residual(best), next = control(best.temperature - (g[1] * r[0] - g[0] * r[1]) / det,
    best.tint - (-t[1] * r[0] + t[0] * r[1]) / det);
  if (evaluated.some(c => key(c) === key(next))) return { status: "stop", reason: "duplicate-control" };
  return { status: "next", control: next };
}
