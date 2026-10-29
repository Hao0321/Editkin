import type { MaterialIntelligencePacket } from "./materialIntelligenceProtocol";
import { materialColorReference, materialColorSummary } from "./materialColorContext";
import { AGENT_CONTEXT_MAX_TOKENS, MATERIAL_CONTEXT_DEFAULT_TOKENS, estimateAgentContextTokens } from "./agentContextBudget";

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export interface MaterialContextOptions {
  afterCueIndex?: number;
  maxTokens?: number;
  maxCuts?: number;
}

export function compactMaterialContext(
  packet: MaterialIntelligencePacket,
  start: number,
  end: number,
  maxCues: number,
  options: MaterialContextOptions = {},
) {
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(end) || end <= start || end > packet.source.duration + 1e-6) throw new Error("素材 context 時間窗不合法");
  const afterCueIndex = Math.max(-1, Math.floor(options.afterCueIndex ?? -1));
  const maxTokenBudget = clamp(Math.floor(options.maxTokens ?? MATERIAL_CONTEXT_DEFAULT_TOKENS), 200, AGENT_CONTEXT_MAX_TOKENS);
  const maximumCues = clamp(Math.floor(maxCues), 1, 200);
  const maximumCuts = clamp(Math.floor(options.maxCuts ?? 20), 1, 100);
  const cueCandidates = packet.analysis.transcript.cues
    .map((cue, index) => ({ ...cue, index }))
    .filter((cue) => cue.start < end && cue.end > start)
    .filter((cue) => cue.index > afterCueIndex);
  const allCuts = packet.analysis.scene.cuts.filter((cut) => cut.time >= start && cut.time <= end);
  const allKeyframes = packet.keyframes.filter((frame) => frame.time >= start && frame.time <= end)
    .map(({ fileName: _privateFileName, display, ...frame }) => ({ ...frame, ...(display ? { display: { receiptSha256: display.receiptSha256, transfer: display.normalization.transfer, requestedTime: display.requested.time, actualTime: display.decoded.relativeTime } } : {}) }));
  const cuts = allCuts.slice(0, maximumCuts);
  const keyframes = [...allKeyframes];
  const cues: typeof cueCandidates = [];
  const minimumColor = materialColorReference(packet.analysis.color);
  let color: ReturnType<typeof materialColorSummary> = minimumColor;

  const build = () => ({
    materialId: packet.materialId,
    sourceSha256: packet.source.sourceSha256,
    window: { start, end },
    transcript: {
      state: packet.analysis.transcript.state,
      recognition: packet.analysis.transcript.recognition,
      reason: packet.analysis.transcript.reason,
      rawTranscriptSha256: packet.analysis.transcript.rawTranscript?.sha256,
      cues,
      returnedCues: cues.length,
      remainingWindowCues: Math.max(0, cueCandidates.length - cues.length),
      hasMore: cueCandidates.length > cues.length,
      nextCueIndex: cueCandidates.length > cues.length ? (cues.at(-1)?.index ?? afterCueIndex) : undefined,
    },
    cuts,
    cutsHasMore: allCuts.length > cuts.length,
    keyframes,
    keyframesHasMore: allKeyframes.length > keyframes.length,
    color,
    budget: { maxTokens: maxTokenBudget, estimatedTokens: 0 },
  });
  const selectionBudget = Math.max(1, maxTokenBudget - 12);
  const metadataBudget = Math.max(160, Math.floor(selectionBudget * 0.45));
  const fits = (limit = selectionBudget) => estimateAgentContextTokens(JSON.stringify(build())) <= limit;
  // The separate keyframe tool owns visual detail. Keep this packet's metadata
  // small enough that transcript evidence still receives most of the budget.
  while (!fits(metadataBudget) && cuts.length) cuts.pop();
  while (!fits(metadataBudget) && keyframes.length) keyframes.pop();
  for (const cue of cueCandidates.slice(0, maximumCues)) {
    cues.push(cue);
    if (fits()) continue;
    cues.pop();
    break;
  }
  if (cueCandidates.length && !cues.length) throw new Error("素材 context 的單一逐字稿 cue 無法放入 Token 預算；請提高 maxTokens，不可跳過此 cue");
  // Rich colour detail only uses remaining space: never pop transcript evidence
  // or advance its cursor just to fit an observation summary.
  color = materialColorSummary(packet.analysis.color, start, end);
  if (!fits()) color = minimumColor;
  const response = build();
  response.budget.estimatedTokens = estimateAgentContextTokens(JSON.stringify(response));
  if (response.budget.estimatedTokens > maxTokenBudget) throw new Error("素材 context 基礎 metadata 超過 Token 預算，請縮小時間窗");
  return response;
}

