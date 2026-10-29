/**
 * Design P5: a proof still is admitted into an autopilot plan only when it is
 * backed by a real image receipt. Called from verifyCurrentAutopilotMaterialEvidence
 * after every carried receipt has been re-verified against the current bytes.
 *
 * - Every proof-still clip the plan adds (add_clip / add_track, nested batches)
 *   needs a carried receipt for the same asset whose packet is kind "image" with
 *   an equal sourceSha256, and a confirmation (schema-required, re-parsed here).
 * - A proof still with a target is annotated by the focus-bracket. Its target
 *   event (graphics id `<clip id>.target`, executed by the bracket's anchor corner)
 *   must cite that material's viewed frame: `mi:<materialId>:<semantic>:frame:<kf-N>`,
 *   a keyframe of the packet that the semantic receipt lists as evidence. A still
 *   without a target has no visible annotation, so it carries no editorial event.
 * - Any graphics event reference in that frame grammar into a carried receipt must resolve the same way.
 * Proof stills already in the project were admitted when they were added.
 */
import type { EditorCommand } from "../domain/commands";
import { parseProofStillEvidenceReferenceV1, parseProofStillV1, proofStillTargetEventIdV1 } from "../domain/proofStillV1";
import type { TimelineClip } from "../domain/types";
import type { CurrentAutopilotPlan } from "./autopilotPlan";
import type { readMaterialIntelligence, verifyMaterialSemanticsReceipt } from "./materialIntelligence";

type Receipt = { materialId: string; sourceSha256: string; assetId: string; clipId: string; semanticReceiptSha256: string };
export interface ProofStillVerifiedEvidenceV1 {
  packet: Awaited<ReturnType<typeof readMaterialIntelligence>>;
  semantic: Awaited<ReturnType<typeof verifyMaterialSemanticsReceipt>>;
}

/** Proof-still clips introduced by plan commands, in command order. */
export function proofStillClipsInCommandsV1(commands: readonly EditorCommand[]): TimelineClip[] {
  return commands.flatMap((command): TimelineClip[] => command.type === "batch" ? proofStillClipsInCommandsV1(command.commands)
    : command.type === "add_clip" ? (command.clip.proofStill !== undefined ? [command.clip] : [])
    : command.type === "add_track" ? command.track.clips.filter(clip => clip.proofStill !== undefined) : []);
}

function viewedFrame(reference: string, receipts: readonly Receipt[], verified: ReadonlyMap<string, ProofStillVerifiedEvidenceV1>) {
  const parsed = parseProofStillEvidenceReferenceV1(reference);
  if (!parsed) return undefined;
  const receipt = receipts.find(row => row.materialId === parsed.materialId && row.semanticReceiptSha256 === parsed.semanticReceiptSha256);
  const evidence = verified.get(`${parsed.materialId}:${parsed.semanticReceiptSha256}`);
  if (!receipt || !evidence || evidence.packet.source.kind !== "image") return undefined;
  const decoded = evidence.packet.keyframes.some(frame => frame.id === parsed.frameId);
  const cited = evidence.semantic.segments.some(segment => segment.evidenceFrameIds.includes(parsed.frameId));
  return decoded && cited ? { receipt, evidence } : undefined;
}

export function assertProofStillPlanEvidenceV1(input: {
  commands: readonly EditorCommand[] | undefined;
  graphics: CurrentAutopilotPlan["editorial"]["graphics"];
  receipts: readonly Receipt[];
  verified: ReadonlyMap<string, ProofStillVerifiedEvidenceV1>;
}): { proofStillCount: number; commandsChecked: boolean } {
  for (const event of input.graphics) {
    for (const reference of event.evidenceRefs) {
      // Only the proof-still frame grammar is a binding; other free-form refs keep their meaning.
      // A ref into a receipt that is not in this verification call (a long-form set verifies each
      // receipt once) is left to that receipt's own call; a carried one must resolve here.
      const parsed = parseProofStillEvidenceReferenceV1(reference);
      const carried = parsed && input.receipts.some(row => row.materialId === parsed.materialId && row.semanticReceiptSha256 === parsed.semanticReceiptSha256);
      if (carried && !viewedFrame(reference, input.receipts, input.verified)) {
        throw new Error(`PROOF_STILL_EVENT_FRAME_UNCITED: ${event.id} cites a frame that is not a decoded, semantically cited frame of a carried image receipt`);
      }
    }
  }
  const clips = input.commands ? proofStillClipsInCommandsV1(input.commands) : [];
  for (const clip of clips) {
    const proof = parseProofStillV1(clip.proofStill);
    if (!proof.confirmation.note) throw new Error(`PROOF_STILL_CONFIRMATION_REQUIRED: ${clip.id}`);
    const matching = input.receipts.filter(receipt => receipt.assetId === clip.assetId && receipt.sourceSha256 === proof.sourceSha256
      && input.verified.get(`${receipt.materialId}:${receipt.semanticReceiptSha256}`)?.packet.source.kind === "image"
      && input.verified.get(`${receipt.materialId}:${receipt.semanticReceiptSha256}`)?.packet.source.sourceSha256 === proof.sourceSha256);
    if (!matching.length) throw new Error(`PROOF_STILL_EVIDENCE_MISSING: ${clip.id} has no carried image receipt for asset ${clip.assetId} with sourceSha256 ${proof.sourceSha256}`);
    if (!proof.target) continue;
    const eventId = proofStillTargetEventIdV1(clip.id);
    const event = input.graphics.find(candidate => candidate.id === eventId);
    if (!event) throw new Error(`PROOF_STILL_EVENT_MISSING: ${clip.id} has a target and needs its target event ${eventId}`);
    const cites = event.evidenceRefs.some(reference => {
      const resolved = viewedFrame(reference, input.receipts, input.verified);
      return resolved !== undefined && matching.includes(resolved.receipt);
    });
    if (!cites) throw new Error(`PROOF_STILL_EVENT_FRAME_UNCITED: ${clip.id} must cite a viewed frame of its own image receipt in ${eventId}`);
  }
  return { proofStillCount: clips.length, commandsChecked: input.commands !== undefined };
}
