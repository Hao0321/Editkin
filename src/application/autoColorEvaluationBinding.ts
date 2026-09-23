import type { ColorAdjustments, MediaAsset } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import { autoColorGoalSchema, referenceWhiteBalanceGoalSchema } from "./autoColorDecision";
import { autoColorCandidateFilters, autoColorSourceAsset, autoWhiteBalanceReferencePlan } from "./autoColorFrame";
import { validateAutoColorMeasurements } from "./autoColorScoring";
import { nextLinearWhiteBalanceControl } from "./linearWhiteBalanceSelection";
import { getLinearWhiteBalanceStops } from "../color/linearWhiteBalance";
import type { evaluateAutoColorExposure } from "./autoColorExposure";
import type { evaluateAutoWhiteBalance } from "./autoWhiteBalance";
import type { MaterialIntelligencePacket } from "./materialIntelligence";

export type AutoColorEvaluationBindingInput = { baselineSnapshot: { color: ColorAdjustments } } & (
  { mode: "exposure"; evaluation: Awaited<ReturnType<typeof evaluateAutoColorExposure>> }
  | { mode: "reference_white_balance"; evaluation: Awaited<ReturnType<typeof evaluateAutoWhiteBalance>> }
);
function reject(): never { throw Error("Automatic colour evaluation goal/sample/surface binding mismatch"); }
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
/** Consistency verification, not a signature or proof against wholesale fabricated pixel evidence. */
export function assertAutoColorEvaluationBinding(input: AutoColorEvaluationBindingInput, packet: MaterialIntelligencePacket): void {
  const measured = packet.analysis.color, color = input.baselineSnapshot.color;
  if (!measured || measured.status !== "measured" || !measured.normalization || !measured.probe
    || measured.mapping.length < 2 || measured.coverage.sceneCount !== 1 || !measured.coverage.sceneCountVerified || !measured.coverage.sceneAttributionVerified
    || measured.source.sha256 !== packet.source.sourceSha256 || measured.source.start !== packet.source.sourceStart || measured.source.duration !== packet.source.duration
    || input.evaluation.identitySha256 !== measured.identity.identitySha256 || Object.values(color).some(v => !Number.isFinite(v))) reject();
  const asset: MediaAsset = autoColorSourceAsset(packet, "bound-source");
  let indices: number[];
  let controls: Array<Partial<ColorAdjustments>>;
  if (input.mode === "exposure") {
    const goal = autoColorGoalSchema.parse(input.evaluation.goal);
    if (Math.abs(color.exposure) > 3) reject();
    indices = [...new Set([0, Math.floor((measured.mapping.length - 1) / 2), measured.mapping.length - 1])];
    const limit = Math.floor(goal.maxExposureChange * 4);
    controls = [...new Set(Array.from({ length: limit * 2 + 1 }, (_, i) => Math.max(-3, Math.min(3, color.exposure + (i - limit) / 4))))].map(exposure => ({ exposure }));
  } else {
    const goal = referenceWhiteBalanceGoalSchema.parse(input.evaluation.goal);
    getLinearWhiteBalanceStops(color);
    if (input.evaluation.algorithm !== "editkin.source-linear-reference-white-balance/v1") reject();
    indices = goal.samples.map(s => measured.mapping.findIndex(m => m.id === s.sampleId));
    if (indices.some((n, i) => n < 0 || (i > 0 && n <= indices[i - 1])) || indices[0] !== 0 || indices.at(-1) !== measured.mapping.length - 1) reject();
    if (!Array.isArray(input.evaluation.candidates) || !input.evaluation.candidates.length || input.evaluation.candidates.length > 9) reject();
    controls = input.evaluation.candidates.map((_, i) => {
      const next = nextLinearWhiteBalanceControl(input.evaluation.candidates.slice(0, i), color, goal.maxGainStops);
      if (next.status !== "next") reject();
      return next.control;
    });
    const stop = nextLinearWhiteBalanceControl(input.evaluation.candidates, color, goal.maxGainStops);
    if (stop.status !== "stop" || !equal(stop, input.evaluation.termination)) reject();
  }
  const evaluation = input.evaluation;
  if (!Array.isArray(evaluation.candidates) || evaluation.candidates.length !== controls.length
    || !Array.isArray(evaluation.surfaces) || evaluation.surfaces.length !== controls.length * indices.length) reject();
  for (const [ci, control] of controls.entries()) {
    const candidate = evaluation.candidates[ci];
    for (const key of Object.keys(control) as Array<keyof ColorAdjustments>) {
      if ((candidate as unknown as Record<string, unknown>)[key] !== control[key]) reject();
    }
    const frames = input.mode === "exposure" ? input.evaluation.candidates[ci].measurements.frames : input.evaluation.candidates[ci].frames;
    if (frames.length !== indices.length) reject();
    const global = input.mode === "exposure" ? input.evaluation.candidates[ci].measurements : input.evaluation.candidates[ci].globalMeasurements;
    const firstGlobal = input.mode === "exposure" ? input.evaluation.candidates[0].measurements : input.evaluation.candidates[0].globalMeasurements;
    validateAutoColorMeasurements(global);
    if (global.frames.length !== indices.length || !equal(global.interpretation, { primaries: "bt709", transfer: "bt709-oetf", range: "full", format: "rgb8" })) reject();
    const expectedFilters = autoColorCandidateFilters(asset, { ...color, ...control });
    for (const [si, index] of indices.entries()) {
      const mapping = measured.mapping[index], frame = frames[si], surface = evaluation.surfaces[ci * indices.length + si];
      const fullFrame = global.frames[si];
      if (fullFrame.sampleId !== mapping.id || fullFrame.timeSeconds !== mapping.decodedRelativeTime
        || fullFrame.pixelCount !== firstGlobal.frames[si].pixelCount || fullFrame.pixelCount > 256 * 256) reject();
      if (frame.sampleId !== mapping.id || frame.timeSeconds !== mapping.decodedRelativeTime || surface.sampleId !== mapping.id
        || !Number.isFinite(surface.decodedTime) || Math.abs(surface.decodedTime - mapping.decodedSourceTime) > 1e-7
        || typeof surface.rgbSha256 !== "string" || !/^[a-f0-9]{64}$/.test(surface.rgbSha256)
        || !equal(surface.filters, expectedFilters)) reject();
      if (!equal(Object.keys(surface).sort(), [...Object.keys(control), "sampleId", "decodedTime", "rgbSha256", "filters", ...(input.mode === "reference_white_balance" ? ["referenceSurface"] : [])].sort())) reject();
      for (const key of Object.keys(control)) if ((surface as unknown as Record<string, unknown>)[key] !== (control as Record<string, unknown>)[key]) reject();
      if (input.mode === "reference_white_balance") {
        const reference = input.evaluation.candidates[ci].frames[si], goal = input.evaluation.goal;
        const original = input.evaluation.candidates[0].frames[si];
        const referencePlan = autoWhiteBalanceReferencePlan(asset, { ...color, ...control });
        const referenceSurface = input.evaluation.surfaces[ci * indices.length + si].referenceSurface;
        if (!referenceSurface || !equal(Object.keys(referenceSurface).sort(), ["sampleId", "decodedTime", "floatSha256", "format", "basis", "inputConvention", "filters"].sort())
          || referenceSurface.sampleId !== mapping.id || referenceSurface.decodedTime !== surface.decodedTime
          || referenceSurface.format !== "gbrapf32le" || referenceSurface.basis !== referencePlan.basis || referenceSurface.inputConvention !== referencePlan.inputConvention
          || typeof referenceSurface.floatSha256 !== "string" || !/^[a-f0-9]{64}$/.test(referenceSurface.floatSha256)
          || !equal(referenceSurface.filters, referencePlan.filters)) reject();
        if (!equal(reference.roi, goal.samples[si].roi) || reference.reference !== goal.reference || reference.basis !== referencePlan.basis || reference.inputConvention !== referencePlan.inputConvention
          || reference.width !== original.width || reference.height !== original.height || reference.pixelCount !== original.pixelCount
          || reference.width * reference.height !== fullFrame.pixelCount) reject();
        const displayReference = input.evaluation.candidates[ci].outputReferences[si];
        if (!displayReference || displayReference.sampleId !== reference.sampleId || displayReference.timeSeconds !== reference.timeSeconds
          || displayReference.width !== reference.width || displayReference.height !== reference.height || displayReference.pixelCount !== reference.pixelCount
          || displayReference.transfer !== "bt709-oetf" || displayReference.reference !== goal.reference || !equal(displayReference.roi, reference.roi)) reject();
      } else {
        const interpretation = input.evaluation.candidates[ci].measurements.interpretation;
        if (interpretation.transfer !== "bt709-oetf" || interpretation.format !== "rgb8" || interpretation.primaries !== "bt709" || interpretation.range !== "full") reject();
      }
    }
  }
}
