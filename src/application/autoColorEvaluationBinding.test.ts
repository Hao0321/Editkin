import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_COLOR } from "../domain/types";
import { analyzeShotColor } from "../color/shotColorAnalysis";
import { canonicalJson } from "../shared/canonicalJson";
import { measureReferenceWhiteBalanceFrame } from "./referenceWhiteBalance";
import { selectAutoWhiteBalanceCandidate } from "./autoWhiteBalance";
import { selectAutoColorCandidate } from "./autoColorScoring";
import { autoColorCandidateFilters,autoWhiteBalanceReferencePlan } from "./autoColorFrame";
import { assertAutoColorEvaluationBinding, type AutoColorEvaluationBindingInput } from "./autoColorEvaluationBinding";
import type { MaterialIntelligencePacket } from "./materialIntelligence";
import { nextLinearWhiteBalanceControl } from "./linearWhiteBalanceSelection";
import { measureLinearWhiteBalanceReference } from "./linearWhiteBalanceReference";
import type {AutoWhiteBalanceCandidate} from "./autoWhiteBalance";

const sha = (v: unknown) => createHash("sha256").update(canonicalJson(v)).digest("hex");
// Synthetic decoded RGB fixtures: not a real FFmpeg/render or attested material receipt.
function fixture(mode: "exposure" | "reference_white_balance", baseline = 0, step = .25) {
  const color = { ...DEFAULT_COLOR, ...(mode === "exposure" ? { exposure: baseline } : { whiteBalanceRed: baseline, whiteBalanceGreen: baseline,whiteBalanceBlue:baseline }) };
  const mapping = [0, 1, 2].map(i => ({ id: `kf-${i + 1}`, decodedRelativeTime: i, decodedSourceTime: i + 10 }));
  const packet = { source: { assetId: "asset", sourceSha256: "a".repeat(64), sourceStart: 10, duration: 3, kind: "video" },
    analysis: { color: { status: "measured", normalization: { interpretation: "rec709" }, probe: {}, mapping,
      coverage: { sceneCount: 1, sceneCountVerified: true, sceneAttributionVerified: true },
      identity: { identitySha256: "b".repeat(64) }, source: { sha256: "a".repeat(64), start: 10, duration: 3 } } } } as unknown as MaterialIntelligencePacket;
  const frames = mapping.map(m => ({ sampleId: m.id, timeSeconds: m.decodedRelativeTime, width: 16, height: 16,
    format: "rgb8" as const, transfer: "bt709-oetf" as const, primaries: "bt709" as const, range: "full" as const,
    pixels: Uint8Array.from({ length: 768 }, (_, i) => [137, 128, 119][i % 3]) }));
  const roi = { x: 0, y: 0, width: 1, height: 1 };
  const controls = mode === "exposure"
    ? [...new Set(Array.from({ length: Math.floor(step * 4) * 2 + 1 }, (_, i) => Math.max(-3, Math.min(3, baseline + (i - Math.floor(step * 4)) / 4))))].map(exposure => ({ exposure }))
    : [...new Set([-step, 0, step].map(n => Math.max(-1, Math.min(1, baseline + n))))].flatMap(temperature =>
      [...new Set([-step, 0, step].map(n => Math.max(-1, Math.min(1, baseline + n))))].map(tint => ({ temperature, tint })));
  const asset = { id: "asset", name: "fixture", uri: "fixture", kind: "video" as const, duration: 3, color: { interpretation: "rec709" as const } };
  const surfaces = controls.flatMap(control => mapping.map(m => ({ ...control, sampleId: m.id, decodedTime: m.decodedSourceTime,
    rgbSha256: sha(Array.from(frames[0].pixels)), filters: autoColorCandidateFilters(asset, { ...color, ...control }) })));
  if (mode === "exposure") {
    const candidates = controls.map(c => ({ exposure: "exposure" in c ? c.exposure : 0, measurements: analyzeShotColor(frames) }));
    return { packet, input: { mode, baselineSnapshot: { color }, evaluation: { identitySha256: "b".repeat(64),
      goal: { medianLinearY: .2, reason: "Explicit synthetic exposure target", maxExposureChange: step }, candidates, surfaces,
      selection: selectAutoColorCandidate(candidates, baseline, .2) } } as AutoColorEvaluationBindingInput };
  }
  const candidates: AutoWhiteBalanceCandidate[] = [];
  let termination;
  while (true) {
    const next = nextLinearWhiteBalanceControl(candidates, color, step);
    if (next.status === "stop") { termination = next; break; }
    const rgb=[.2968375069,.2614815069,.2285749618].map((v,i)=>v*2**([next.control.whiteBalanceRed,next.control.whiteBalanceGreen,next.control.whiteBalanceBlue][i]-baseline));
    candidates.push({ ...next.control, frames: frames.map(f => measureLinearWhiteBalanceReference({ ...f,pixels:Float32Array.from(Array.from({length:256},()=>[...rgb,1]).flat()),basis:"linear-rec709",inputConvention:"rec709-oetf",roi,reference:"caller-declared-neutral"})),
      outputReferences:frames.map(f=>measureReferenceWhiteBalanceFrame({...f,roi,reference:"caller-declared-neutral"})),globalMeasurements: analyzeShotColor(frames) });
  }
  const wbSurfaces = candidates.flatMap(({whiteBalanceRed,whiteBalanceGreen,whiteBalanceBlue}) => mapping.map(m => {
    const controls={whiteBalanceRed,whiteBalanceGreen,whiteBalanceBlue},plan=autoWhiteBalanceReferencePlan(asset,{...color,...controls});
    return {...controls,sampleId:m.id,decodedTime:m.decodedSourceTime,rgbSha256:sha(Array.from(frames[0].pixels)),filters:autoColorCandidateFilters(asset,{...color,...controls}),
      referenceSurface:{sampleId:m.id,decodedTime:m.decodedSourceTime,floatSha256:"c".repeat(64),format:"gbrapf32le",basis:plan.basis,inputConvention:plan.inputConvention,filters:plan.filters}};
  }));
  return { packet, input: { mode, baselineSnapshot: { color }, evaluation: {algorithm:"editkin.source-linear-reference-white-balance/v1", identitySha256: "b".repeat(64),
    goal: { reference: "caller-declared-neutral", reason: "Explicit synthetic neutral reference", maxGainStops: step,
      samples: mapping.map(m => ({ sampleId: m.id, roi })) }, candidates, surfaces:wbSurfaces, termination,
    selection: selectAutoWhiteBalanceCandidate(candidates, color) } } as AutoColorEvaluationBindingInput };
}

describe("automatic colour evaluation closed binding", () => {
  it("preserves old scorer-only false-green control for self-rehashed goal mutations, then rejects them", () => {
    for (const change of ["roi", "maxGainStops", "maxExposureChange"] as const) {
      const { input, packet } = fixture(change === "maxExposureChange" ? "exposure" : "reference_white_balance");
      const before = sha(input);
      if (input.mode === "exposure") {
        input.evaluation.goal.maxExposureChange = .5;
        expect(selectAutoColorCandidate(input.evaluation.candidates, 0, input.evaluation.goal.medianLinearY)).toEqual(input.evaluation.selection);
      } else {
        if (change === "roi") input.evaluation.goal.samples[0].roi = { x: 0, y: 0, width: .5, height: 1 };
        else input.evaluation.goal.maxGainStops = .05;
        expect(selectAutoWhiteBalanceCandidate(input.evaluation.candidates, input.baselineSnapshot.color)).toEqual(input.evaluation.selection);
      }
      expect(sha(input)).not.toBe(before); // New self-hash alone is not a provenance check.
      expect(() => assertAutoColorEvaluationBinding(input, packet)).toThrow();
    }
  });
  it.each([0, .1, .8, 1])("accepts exact adaptive producer prefix including clamp/float baseline %s", baseline => {
    const { input, packet } = fixture("reference_white_balance", baseline, .5);
    expect(() => assertAutoColorEvaluationBinding(input, packet)).not.toThrow();
  });
  it.each([0, 2.9, -3])("accepts exposure boundary %s", baseline => {
    const { input, packet } = fixture("exposure", baseline, .75);
    expect(() => assertAutoColorEvaluationBinding(input, packet)).not.toThrow();
  });
  it("rejects missing/extra/reordered/duplicated surfaces and malformed hash/filter/time/control", () => {
    const mutations: Array<(i: AutoColorEvaluationBindingInput) => void> = [
      i => { i.evaluation.surfaces.pop(); }, i => { if (i.mode === "exposure") i.evaluation.surfaces.push(i.evaluation.surfaces[0]); else i.evaluation.surfaces.push(i.evaluation.surfaces[0]); },
      i => { i.evaluation.surfaces[1] = i.evaluation.surfaces[0]; }, i => { i.evaluation.surfaces.reverse(); },
      i => { i.evaluation.surfaces[0].rgbSha256 = "fake"; }, i => { i.evaluation.surfaces[0].filters.push("eq=brightness=1"); },
      i => { i.evaluation.surfaces[0].decodedTime += .001; }, i => { i.evaluation.candidates.reverse(); },
      i => { i.evaluation.identitySha256 = "c".repeat(64); },
    ];
    for (const mode of ["exposure", "reference_white_balance"] as const) for (const mutate of mutations) {
      const { input, packet } = fixture(mode); mutate(input);
      expect(() => assertAutoColorEvaluationBinding(input, packet)).toThrow();
    }
  });
  it("rejects changed frame mapping, transfer, reference metadata and surplus goal fields", () => {
    const { input, packet } = fixture("reference_white_balance");
    if (input.mode !== "reference_white_balance") throw Error("fixture mode");
    for (const mutate of [
      (i: typeof input) => { i.evaluation.candidates[0].frames[0].timeSeconds = .1; },
      (i: typeof input) => { i.evaluation.candidates[0].frames[0].inputConvention = "hlg-linear"; },
      (i: typeof input) => { Object.assign(i.evaluation.goal, { hidden: true }); },
      (i: typeof input) => { i.evaluation.goal.samples.reverse(); },
      (i: typeof input) => { i.evaluation.termination = { status: "stop", reason: "unchanged" }; },
      (i: typeof input) => { Object.assign(i.evaluation.candidates[0].frames[0],{basis:"post-tone-rgb8"}); },
      (i: typeof input) => { i.evaluation.surfaces[0].referenceSurface.floatSha256="not-a-hash"; },
      (i: typeof input) => { Object.assign(i.evaluation.surfaces[0].referenceSurface,{unexpected:true}); },
      (i: typeof input) => { i.evaluation.surfaces[0].referenceSurface.filters.push("format=rgb24"); },
      (i: typeof input) => { i.evaluation.candidates[1].whiteBalanceRed+=.01; },
      (i: typeof input) => { Object.assign(i.evaluation.candidates[0].frames[0],i.evaluation.candidates[0].outputReferences[0],{basis:undefined,inputConvention:undefined}); },
      (i: typeof input) => { Object.assign(i.evaluation.goal,{maxAdjustment:.5}); },
      (i: typeof input) => { Object.assign(i.evaluation,{algorithm:"legacy-temperature-search/v1"}); },
      (i: typeof input) => { i.baselineSnapshot.color.whiteBalanceBlue=.1; },
    ]) { const next = structuredClone(input); mutate(next); expect(() => assertAutoColorEvaluationBinding(next, packet)).toThrow(); }
  });
});
