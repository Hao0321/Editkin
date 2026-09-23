import type { ColorAdjustments } from "../domain/types";
import { analyzeShotColor, type ShotColorFrame } from "../color/shotColorAnalysis";
import { colorFileSha, getMaterialColorRuntimeIdentity } from "./materialColorSamplingRuntime";
import { verifyMaterialColorReceipt, type MaterialColorRuntime } from "./materialColorSampling";
import type { MaterialIntelligencePacket } from "./materialIntelligence";
import { autoColorGoalSchema, type AutoColorGoal } from "./autoColorDecision";
import { selectAutoColorCandidate, type AutoColorCandidate } from "./autoColorScoring";
import { readAutoColorCandidateFrame } from "./autoColorFrame";
export { autoColorCandidateFilters } from "./autoColorFrame";

export async function evaluateAutoColorExposure(packet: MaterialIntelligencePacket, originalColor: ColorAdjustments,
  inputGoal: AutoColorGoal, sourcePath: string, runtime: MaterialColorRuntime) {
  const goal = autoColorGoalSchema.parse(inputGoal), color = structuredClone(originalColor);
  if (Object.values(color).some(value => !Number.isFinite(value)) || Math.abs(color.exposure) > 3) throw Error("Invalid baseline primary colour");
  const measured = packet.analysis.color;
  if (!measured || measured.status !== "measured") throw Error("自動調色需要已驗證色彩量測");
  verifyMaterialColorReceipt(measured);
  if (!measured.coverage.sceneCountVerified || !measured.coverage.sceneAttributionVerified || measured.coverage.sceneCount !== 1) throw Error("請先依鏡頭切分素材再自動調色");
  if (measured.mapping.length < 2) throw Error("自動調色至少需要首尾兩個不同實測影格");
  const identity = await getMaterialColorRuntimeIdentity(runtime);
  if (identity.status !== "verified" || identity.identitySha256 !== measured.identity.identitySha256) throw Error("Colour runtime changed; reanalyse material");
  if (await colorFileSha(sourcePath) !== packet.source.sourceSha256) throw Error("Colour source changed; reanalyse material");
  const indices = [...new Set([0, Math.floor((measured.mapping.length - 1) / 2), measured.mapping.length - 1])];
  const limit = Math.floor(goal.maxExposureChange * 4);
  const offsets = Array.from({ length: limit * 2 + 1 }, (_, index) => (index - limit) / 4);
  const exposures = [...new Set(offsets.map(offset => Math.max(-3, Math.min(3, color.exposure + offset))))];
  const candidates: AutoColorCandidate[] = [], surfaces: Array<{ exposure: number; sampleId: string; decodedTime: number; rgbSha256: string; filters: string[] }> = [];
  const deadline = Date.now() + 120000;
  for (const exposure of exposures) {
    const frames: ShotColorFrame[] = [];
    for (const sampleIndex of indices) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw Error("Automatic colour candidate time budget exceeded");
      const decoded = await readAutoColorCandidateFrame(packet, sampleIndex, { ...color, exposure }, sourcePath, runtime, remaining);
      frames.push(decoded.frame); surfaces.push({ exposure, ...decoded.surface });
    }
    candidates.push({ exposure, measurements: analyzeShotColor(frames) });
  }
  if (await colorFileSha(sourcePath) !== packet.source.sourceSha256) throw Error("Colour source changed during candidate evaluation");
  if ((await getMaterialColorRuntimeIdentity(runtime)).identitySha256 !== identity.identitySha256) throw Error("Colour runtime changed during candidate evaluation");
  return { identitySha256: identity.identitySha256, goal, candidates, surfaces,
    selection: selectAutoColorCandidate(candidates, color.exposure, goal.medianLinearY) };
}
