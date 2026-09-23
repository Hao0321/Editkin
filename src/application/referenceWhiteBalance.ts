export interface ReferenceRoi { x: number; y: number; width: number; height: number }
export interface ReferenceWhiteBalanceFrame {
  sampleId: string; timeSeconds: number; width: number; height: number; pixels: Uint8Array;
  roi: ReferenceRoi; transfer: "bt709-oetf" | "srgb" | "linear"; reference: "caller-declared-neutral";
}
export interface ReferenceWhiteBalanceMeasurement {
  sampleId: string; timeSeconds: number; width: number; height: number; roi: ReferenceRoi;
  transfer: ReferenceWhiteBalanceFrame["transfer"]; reference: "caller-declared-neutral"; pixelCount: number;
  meanLinearRgb: [number, number, number]; varianceLinearRgb: [number, number, number]; meanLinearY: number; varianceLinearY: number;
  neutralErrorStops: number; endpointCount: number; endpointFraction: number;
}
export interface ReferenceWhiteBalanceCandidate { temperature: number; tint: number; frames: ReferenceWhiteBalanceMeasurement[] }
const fail = (): never => { throw Error("Invalid caller-declared neutral reference"); };
const unit = (v: number) => Number.isFinite(v) && v >= 0 && v <= 1;
const decode = (v: number, transfer: ReferenceWhiteBalanceFrame["transfer"]) => transfer === "linear" ? v
  : transfer === "srgb" ? v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4
    : v < .081 ? v / 4.5 : ((v + .099) / 1.099) ** (1 / .45);
function geometry(f: Omit<ReferenceWhiteBalanceFrame, "pixels">) {
  if (!f || f.reference !== "caller-declared-neutral" || !["linear", "srgb", "bt709-oetf"].includes(f.transfer)
    || typeof f.sampleId !== "string" || !f.sampleId.trim() || f.sampleId.length > 128 || !Number.isFinite(f.timeSeconds) || f.timeSeconds < 0
    || !Number.isInteger(f.width) || !Number.isInteger(f.height) || f.width < 1 || f.height < 1 || f.width > 256 || f.height > 256
    || !f.roi || ![f.roi.x, f.roi.y, f.roi.width, f.roi.height].every(unit) || f.roi.width <= 0 || f.roi.height <= 0
    || f.roi.x + f.roi.width > 1 || f.roi.y + f.roi.height > 1) fail();
  const x0 = Math.floor(f.roi.x * f.width), y0 = Math.floor(f.roi.y * f.height);
  const x1 = Math.min(f.width, Math.ceil((f.roi.x + f.roi.width) * f.width)), y1 = Math.min(f.height, Math.ceil((f.roi.y + f.roi.height) * f.height));
  if ((x1 - x0) * (y1 - y0) < 32) fail();
  return { x0, y0, x1, y1, count: (x1 - x0) * (y1 - y0) };
}
const errorStops = (rgb: number[]) => Math.log2(Math.max(1e-8, Math.max(...rgb)) / Math.max(1e-8, Math.min(...rgb)));
export function measureReferenceWhiteBalanceFrame(input: ReferenceWhiteBalanceFrame): ReferenceWhiteBalanceMeasurement {
  const g = geometry(input);
  if (!(input.pixels instanceof Uint8Array) || input.pixels.length !== input.width * input.height * 3
    || (typeof SharedArrayBuffer !== "undefined" && input.pixels.buffer instanceof SharedArrayBuffer)) fail();
  const sum = [0, 0, 0], sum2 = [0, 0, 0]; let ySum = 0, y2Sum = 0, endpoints = 0;
  for (let y = g.y0; y < g.y1; y++) for (let x = g.x0; x < g.x1; x++) {
    const offset = (y * input.width + x) * 3;
    const values = [input.pixels[offset], input.pixels[offset + 1], input.pixels[offset + 2]];
    if (values.some(v => v === 0 || v === 255)) endpoints++;
    const rgb = values.map(v => decode(v / 255, input.transfer));
    rgb.forEach((v, i) => { sum[i] += v; sum2[i] += v * v; });
    const luminance = rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
    ySum += luminance; y2Sum += luminance * luminance;
  }
  const meanLinearRgb = sum.map(v => v / g.count) as [number, number, number], meanLinearY = ySum / g.count;
  return { sampleId: input.sampleId, timeSeconds: input.timeSeconds, width: input.width, height: input.height, roi: { ...input.roi },
    reference: input.reference, transfer: input.transfer, pixelCount: g.count, meanLinearRgb,
    varianceLinearRgb: sum2.map((v, i) => Math.max(0, v / g.count - meanLinearRgb[i] ** 2)) as [number, number, number], meanLinearY,
    varianceLinearY: Math.max(0, y2Sum / g.count - meanLinearY ** 2), neutralErrorStops: errorStops(meanLinearRgb),
    endpointCount: endpoints, endpointFraction: endpoints / g.count };
}
export function validateReferenceWhiteBalanceMeasurement(f: ReferenceWhiteBalanceMeasurement) {
  const g = geometry(f);
  if (f.pixelCount !== g.count || !Array.isArray(f.meanLinearRgb) || f.meanLinearRgb.length !== 3 || !f.meanLinearRgb.every(unit)
    || !Array.isArray(f.varianceLinearRgb) || f.varianceLinearRgb.length !== 3 || !f.varianceLinearRgb.every(unit)
    || f.varianceLinearRgb.some((v, i) => v > f.meanLinearRgb[i] * (1 - f.meanLinearRgb[i]) + 1e-10)
    || !unit(f.meanLinearY) || !unit(f.varianceLinearY) || !Number.isFinite(f.neutralErrorStops)
    || Math.abs(f.neutralErrorStops - errorStops(f.meanLinearRgb)) > 1e-10
    || Math.abs(f.meanLinearY - (f.meanLinearRgb[0] * .2126 + f.meanLinearRgb[1] * .7152 + f.meanLinearRgb[2] * .0722)) > 1e-10
    || f.varianceLinearY > f.meanLinearY * (1 - f.meanLinearY) + 1e-10
    || !Number.isInteger(f.endpointCount) || f.endpointCount < 0 || f.endpointCount > f.pixelCount
    || !unit(f.endpointFraction) || Math.abs(f.endpointFraction - f.endpointCount / f.pixelCount) > 1e-12) fail();
}
function unusable(f: ReferenceWhiteBalanceMeasurement) {
  return f.meanLinearY < .02 || f.meanLinearY > .95 || f.endpointFraction > .02
    || f.varianceLinearRgb.some((v, i) => Math.sqrt(v) / Math.max(1e-8, f.meanLinearRgb[i]) > .25)
    || Math.sqrt(f.varianceLinearY) / Math.max(1e-8, f.meanLinearY) > .25;
}
export function selectReferenceWhiteBalanceCandidate(candidates: ReferenceWhiteBalanceCandidate[], baseline: { temperature: number; tint: number }) {
  const validControl = (v: number) => Number.isFinite(v) && Math.abs(v) <= 1;
  if (!baseline || !validControl(baseline.temperature) || !validControl(baseline.tint) || !Array.isArray(candidates) || !candidates.length || candidates.length > 9) fail();
  const keys = new Set<string>();
  candidates.forEach(c => {
    if (!c || !validControl(c.temperature) || !validControl(c.tint) || Math.abs(c.temperature - baseline.temperature) > 1 + 1e-12 || Math.abs(c.tint - baseline.tint) > 1 + 1e-12
      || keys.has(`${c.temperature}:${c.tint}`) || !Array.isArray(c.frames) || !c.frames.length || c.frames.length > 3) fail();
    keys.add(`${c.temperature}:${c.tint}`); c.frames.forEach(validateReferenceWhiteBalanceMeasurement);
    if (new Set(c.frames.map(f => f.sampleId)).size !== c.frames.length || c.frames.some((f, i) => i > 0 && f.timeSeconds <= c.frames[i - 1].timeSeconds)) fail();
  });
  const baselineIndex = candidates.findIndex(c => c.temperature === baseline.temperature && c.tint === baseline.tint);
  if (baselineIndex < 0) fail();
  const base = candidates[baselineIndex];
  const invalidReference = base.frames.some(unusable);
  const scores = candidates.map(c => {
    if (c.frames.length !== base.frames.length) fail();
    const reasons: string[] = [];
    c.frames.forEach((f, i) => {
      const b = base.frames[i];
      for (const key of ["sampleId", "timeSeconds", "width", "height", "transfer", "pixelCount", "reference"] as const) if (f[key] !== b[key]) fail();
      for (const key of ["x", "y", "width", "height"] as const) if (f.roi[key] !== b.roi[key]) fail();
      if (unusable(f)) reasons.push(`reference-unusable:${f.sampleId}`);
      if (Math.abs(Math.log2(Math.max(1e-8, f.meanLinearY) / Math.max(1e-8, b.meanLinearY))) > .1 + 1e-12) reasons.push(`luminance-drift:${f.sampleId}`);
      if (f.endpointFraction - b.endpointFraction > .003 + 1e-12) reasons.push(`endpoint-increase:${f.sampleId}`);
    });
    return { temperature: c.temperature, tint: c.tint, neutralErrorStops: c.frames.reduce((n, f) => n + f.neutralErrorStops, 0) / c.frames.length,
      worstErrorStops: Math.max(...c.frames.map(f => f.neutralErrorStops)), accepted: !invalidReference && reasons.length === 0, reasons };
  });
  const eligible = scores.map((s, i) => ({ s, i })).filter(({ s, i }) => i !== baselineIndex && s.accepted
    && scores[baselineIndex].neutralErrorStops - s.neutralErrorStops >= .02 - 1e-12 && s.worstErrorStops <= scores[baselineIndex].worstErrorStops + 1e-12);
  const best = Math.min(...eligible.map(v => v.s.neutralErrorStops));
  const movement = (s: typeof scores[number]) => Math.hypot(s.temperature - baseline.temperature, s.tint - baseline.tint);
  eligible.sort((a, b) => Number(b.s.neutralErrorStops <= best + .02) - Number(a.s.neutralErrorStops <= best + .02)
    || movement(a.s) - movement(b.s) || a.s.neutralErrorStops - b.s.neutralErrorStops || a.i - b.i);
  const selectedIndex = eligible[0]?.i ?? baselineIndex;
  const status: "reference_unusable" | "target_unreachable" | "unchanged" | "candidate" = invalidReference ? "reference_unusable"
    : scores[selectedIndex].worstErrorStops > .08 ? "target_unreachable" : selectedIndex === baselineIndex ? "unchanged" : "candidate";
  return { selectedIndex, baselineIndex, status, candidates: scores, referenceAuthority: "caller-declared-not-detected" as const,
    whitePointVerification: "unmeasured" as const, aestheticQuality: "unmeasured" as const };
}
