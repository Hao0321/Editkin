import type { ColorAdjustments } from "../domain/types";
import { analyzeShotColor, type ShotColorAnalysis, type ShotColorFrame } from "../color/shotColorAnalysis";
import type { MaterialIntelligencePacket } from "./materialIntelligence";
import { verifyMaterialColorReceipt, type MaterialColorRuntime } from "./materialColorSampling";
import { colorFileSha, getMaterialColorRuntimeIdentity } from "./materialColorSamplingRuntime";
import { readAutoColorCandidateFrame, readAutoWhiteBalanceReferenceFrame } from "./autoColorFrame";
import { validateAutoColorMeasurements } from "./autoColorScoring";
import { referenceWhiteBalanceGoalSchema, type ReferenceWhiteBalanceGoal } from "./autoColorDecision";
import { measureReferenceWhiteBalanceFrame } from "./referenceWhiteBalance";
import { measureLinearWhiteBalanceReference } from "./linearWhiteBalanceReference";
import { nextLinearWhiteBalanceControl, selectLinearWhiteBalanceCandidate, type LinearWhiteBalanceCandidate } from "./linearWhiteBalanceSelection";
import type { LinearWhiteBalanceColor } from "../color/linearWhiteBalance";

export type AutoWhiteBalanceCandidate = LinearWhiteBalanceCandidate & { globalMeasurements: ShotColorAnalysis };

/** Reference neutrality is caller intent. Full-frame endpoint checks do not establish skin or artistic quality. */
export function selectAutoWhiteBalanceCandidate(candidates: AutoWhiteBalanceCandidate[], baseline: LinearWhiteBalanceColor) {
  const initial = selectLinearWhiteBalanceCandidate(candidates, baseline);
  const base = candidates[initial.baselineIndex];
  const rejected = candidates.map((candidate, candidateIndex) => {
    validateAutoColorMeasurements(candidate.globalMeasurements);
    const global = candidate.globalMeasurements, baseGlobal = base.globalMeasurements;
    if (global.frames.length !== candidate.frames.length || baseGlobal.frames.length !== global.frames.length
      || global.interpretation.transfer !== "bt709-oetf" || global.interpretation.format !== "rgb8") throw Error("White balance global sample mismatch");
    const reasons: string[] = [];
    global.frames.forEach((f, i) => {
      const b = baseGlobal.frames[i], ref = candidate.frames[i];
      if (f.sampleId !== ref.sampleId || f.timeSeconds !== ref.timeSeconds || f.pixelCount !== ref.width * ref.height
        || f.sampleId !== b.sampleId || f.timeSeconds !== b.timeSeconds || f.pixelCount !== b.pixelCount) throw Error("White balance global sample mismatch");
      if (f.encodedEndpoints.anyHigh.fraction - b.encodedEndpoints.anyHigh.fraction > .003 + 1e-12
        || f.nearWhite.fraction - b.nearWhite.fraction > .003 + 1e-12) reasons.push(`global-high-endpoint-increase:${f.sampleId}`);
      if (f.encodedEndpoints.anyLow.fraction - b.encodedEndpoints.anyLow.fraction > .005 + 1e-12
        || f.nearBlack.fraction - b.nearBlack.fraction > .005 + 1e-12) reasons.push(`global-low-endpoint-increase:${f.sampleId}`);
      for (let channel = 0; channel < 3; channel++) {
        if (f.encodedEndpoints.high[channel].fraction - b.encodedEndpoints.high[channel].fraction > .003 + 1e-12) reasons.push(`global-channel-high-increase:${channel}:${f.sampleId}`);
        if (f.encodedEndpoints.low[channel].fraction - b.encodedEndpoints.low[channel].fraction > .005 + 1e-12) reasons.push(`global-channel-low-increase:${channel}:${f.sampleId}`);
      }
    });
    return { candidateIndex, reasons };
  });
  return { ...selectLinearWhiteBalanceCandidate(candidates, baseline, rejected.map(item => item.reasons)),
    scope: "representative-source-linear-white-balance-before-tone-and-look" as const, skinProtection: "unmeasured" as const };
}

export async function evaluateAutoWhiteBalance(packet: MaterialIntelligencePacket, originalColor: ColorAdjustments,
  inputGoal: ReferenceWhiteBalanceGoal, sourcePath: string, runtime: MaterialColorRuntime) {
  const goal = referenceWhiteBalanceGoalSchema.parse(inputGoal), color = structuredClone(originalColor), measured = packet.analysis.color;
  if (Object.values(color).some(v => !Number.isFinite(v))) throw Error("Invalid baseline primary colour");
  if (!measured || measured.status !== "measured") throw Error("白平衡需要目前來源的已驗證色彩量測");
  verifyMaterialColorReceipt(measured);
  if (!measured.coverage.sceneCountVerified || !measured.coverage.sceneAttributionVerified || measured.coverage.sceneCount !== 1) throw Error("請先依鏡頭切分素材再校正白平衡");
  const indices = goal.samples.map(sample => measured.mapping.findIndex(item => item.id === sample.sampleId));
  if (indices.some((index, i) => index < 0 || (i > 0 && index <= indices[i - 1]))
    || indices[0] !== 0 || indices.at(-1) !== measured.mapping.length - 1) throw Error("白平衡參考需包含量測首尾影格並按時間排序");
  const identity = await getMaterialColorRuntimeIdentity(runtime);
  if (identity.status !== "verified" || identity.identitySha256 !== measured.identity.identitySha256) throw Error("Colour runtime changed; reanalyse material");
  if (await colorFileSha(sourcePath) !== packet.source.sourceSha256) throw Error("Colour source changed; reanalyse material");
  const candidates: AutoWhiteBalanceCandidate[] = [];
  const surfaces: Array<{ whiteBalanceRed: number; whiteBalanceGreen: number; whiteBalanceBlue: number;
    sampleId: string; decodedTime: number; rgbSha256: string; filters: string[];
    referenceSurface: Awaited<ReturnType<typeof readAutoWhiteBalanceReferenceFrame>>["surface"] }> = [];
  const deadline = Date.now() + 120000;
  let termination: Extract<ReturnType<typeof nextLinearWhiteBalanceControl>, { status: "stop" }>;
  for (;;) {
    const next = nextLinearWhiteBalanceControl(candidates, color, goal.maxGainStops);
    if (next.status === "stop") { termination = next; break; }
    if (candidates.length >= 9) throw Error("White balance candidate budget exceeded");
    const controls = next.control;
    const frames: LinearWhiteBalanceCandidate["frames"] = [], outputReferences: LinearWhiteBalanceCandidate["outputReferences"] = [], globalFrames: ShotColorFrame[] = [];
    for (const [i, sampleIndex] of indices.entries()) {
      const corrected = { ...color, ...controls };
      const reference = await readAutoWhiteBalanceReferenceFrame(packet, sampleIndex, corrected, sourcePath, runtime, deadline - Date.now());
      const decoded = await readAutoColorCandidateFrame(packet, sampleIndex, corrected, sourcePath, runtime, deadline - Date.now());
      if (!(decoded.frame.pixels instanceof Uint8Array)) throw Error("White balance expected RGB8");
      frames.push(measureLinearWhiteBalanceReference({ ...reference.frame, reference: goal.reference, roi: goal.samples[i].roi }));
      outputReferences.push(measureReferenceWhiteBalanceFrame({ sampleId: decoded.frame.sampleId, timeSeconds: decoded.frame.timeSeconds,
        width: decoded.frame.width, height: decoded.frame.height, pixels: decoded.frame.pixels, transfer: "bt709-oetf",
        reference: goal.reference, roi: goal.samples[i].roi }));
      globalFrames.push(decoded.frame); surfaces.push({ ...controls, ...decoded.surface, referenceSurface: reference.surface });
    }
    candidates.push({ ...controls, frames, outputReferences, globalMeasurements: analyzeShotColor(globalFrames) });
  }
  if (await colorFileSha(sourcePath) !== packet.source.sourceSha256) throw Error("Colour source changed during white balance evaluation");
  if ((await getMaterialColorRuntimeIdentity(runtime)).identitySha256 !== identity.identitySha256) throw Error("Colour runtime changed during white balance evaluation");
  return { algorithm: "editkin.source-linear-reference-white-balance/v1" as const,
    identitySha256: identity.identitySha256, goal, candidates, surfaces, termination, selection: selectAutoWhiteBalanceCandidate(candidates, color) };
}
