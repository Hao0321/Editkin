import { describe, expect, it } from "vitest";
import type { EditorCommand } from "../domain/commands";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type TimelineClip } from "../domain/types";
import type { ProofStillV1 } from "../domain/proofStillV1";
import { assertProofStillPlanEvidenceV1, proofStillClipsInCommandsV1, type ProofStillVerifiedEvidenceV1 } from "./proofStillEvidenceV1";

const M = "1".repeat(64), S = "2".repeat(64), SOURCE = "3".repeat(64);
const proofStill: ProofStillV1 = { schema: "editkin.proof-still/v1", sourceSha256: SOURCE, sourceWidth: 640, sourceHeight: 360, crop: { x: 0, y: 0, width: 640, height: 360 },
  redactions: [], hold: "static", confirmation: { by: "user", note: "Checked." } };
const clip = (id: string, proof: "target" | "plain" | "none" = "target"): TimelineClip => ({ id, assetId: "shot", trackId: "v", timelineStart: 0, sourceStart: 0, duration: 2, volume: 1,
  transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
  ...(proof === "none" ? {} : { proofStill: proof === "target" ? { ...proofStill, target: { rect: { x: 100, y: 100, width: 50, height: 40 } } } : proofStill }) });
const receipt = { materialId: M, sourceSha256: SOURCE, assetId: "shot", clipId: "source", semanticReceiptSha256: S };
const verified = new Map<string, ProofStillVerifiedEvidenceV1>([[`${M}:${S}`, {
  packet: { source: { kind: "image", sourceSha256: SOURCE }, keyframes: [{ id: "kf-1" }] },
  semantic: { segments: [{ evidenceFrameIds: ["kf-1"] }] },
} as unknown as ProofStillVerifiedEvidenceV1]]);
/** The target event as prepare_proof_still emits it: executed by the focus-bracket's anchor corner. */
const event = (id: string, refs = [`mi:${M}:${S}:frame:kf-1`], kind: "native_shape" | "context_card" = "native_shape") => ({ id, presetId: "reel_native_panel",
  range: { startFrame: 0, endFrame: 60 }, kind, purpose: "proof" as const, message: kind === "native_shape" ? "" : "設定頁", evidenceRefs: refs });

describe("proof-still plan evidence (design P5)", () => {
  it("finds proof stills added by add_clip, add_track and nested batches", () => {
    const commands: EditorCommand[] = [{ type: "batch", commands: [{ type: "add_clip", clip: clip("a") }, { type: "add_clip", clip: clip("plain", "none") }] },
      { type: "add_track", track: { id: "t", name: "t", kind: "video", locked: false, muted: false, clips: [clip("b")] } }];
    expect(proofStillClipsInCommandsV1(commands).map(row => row.id)).toEqual(["a", "b"]);
    expect(assertProofStillPlanEvidenceV1({ commands, graphics: [event("a.target"), event("b.target")], receipts: [receipt], verified })).toEqual({ proofStillCount: 2, commandsChecked: true });
  });

  it("refuses a target still without its own image receipt, target event or viewed frame; other refs keep their meaning", () => {
    const commands: EditorCommand[] = [{ type: "add_clip", clip: clip("a") }];
    expect(() => assertProofStillPlanEvidenceV1({ commands, graphics: [event("a.target")], receipts: [{ ...receipt, assetId: "other" }], verified })).toThrow(/^PROOF_STILL_EVIDENCE_MISSING/);
    const videoPacket = new Map([[`${M}:${S}`, { ...verified.get(`${M}:${S}`)!, packet: { source: { kind: "video", sourceSha256: SOURCE }, keyframes: [{ id: "kf-1" }] } } as unknown as ProofStillVerifiedEvidenceV1]]);
    expect(() => assertProofStillPlanEvidenceV1({ commands, graphics: [event("a.target", ["screen:settings"])], receipts: [receipt], verified: videoPacket })).toThrow(/^PROOF_STILL_EVIDENCE_MISSING/);
    // A frame ref into a video receipt is not a viewed still frame either.
    expect(() => assertProofStillPlanEvidenceV1({ commands, graphics: [event("a.target")], receipts: [receipt], verified: videoPacket })).toThrow(/^PROOF_STILL_EVENT_FRAME_UNCITED/);
    expect(() => assertProofStillPlanEvidenceV1({ commands, graphics: [], receipts: [receipt], verified })).toThrow(/^PROOF_STILL_EVENT_MISSING: a has a target and needs its target event a\.target/);
    // The clip id itself is not the target event id.
    expect(() => assertProofStillPlanEvidenceV1({ commands, graphics: [event("a")], receipts: [receipt], verified })).toThrow(/^PROOF_STILL_EVENT_MISSING/);
    expect(() => assertProofStillPlanEvidenceV1({ commands, graphics: [event("a.target", ["screen:settings"])], receipts: [receipt], verified })).toThrow(/^PROOF_STILL_EVENT_FRAME_UNCITED/);
    const uncited = new Map([[`${M}:${S}`, { ...verified.get(`${M}:${S}`)!, semantic: { segments: [{ evidenceFrameIds: [] }] } } as unknown as ProofStillVerifiedEvidenceV1]]);
    expect(() => assertProofStillPlanEvidenceV1({ commands, graphics: [event("a.target")], receipts: [receipt], verified: uncited })).toThrow(/^PROOF_STILL_EVENT_FRAME_UNCITED/);
    // Free-form refs on other events are not proof-still bindings and stay accepted.
    expect(assertProofStillPlanEvidenceV1({ commands: [], graphics: [event("x", ["transcript:intro"])], receipts: [receipt], verified })).toEqual({ proofStillCount: 0, commandsChecked: true });
    // Without the plan commands only the event references can be checked.
    expect(assertProofStillPlanEvidenceV1({ commands: undefined, graphics: [event("a.target")], receipts: [receipt], verified })).toEqual({ proofStillCount: 0, commandsChecked: false });
    expect(() => assertProofStillPlanEvidenceV1({ commands: undefined, graphics: [event("a.target", [`mi:${M}:${S}:frame:kf-3`])], receipts: [receipt], verified })).toThrow(/^PROOF_STILL_EVENT_FRAME_UNCITED/);
    // A ref into a receipt that this call does not carry (verified once elsewhere in a set) is left to that call.
    expect(assertProofStillPlanEvidenceV1({ commands: [], graphics: [event("a.target", [`mi:${"4".repeat(64)}:${S}:frame:kf-1`])], receipts: [receipt], verified }))
      .toEqual({ proofStillCount: 0, commandsChecked: true });
  });

  it("a still without a target carries no event but still needs its own image receipt; the frame grammar binds on any event kind", () => {
    const commands: EditorCommand[] = [{ type: "add_clip", clip: clip("p", "plain") }];
    expect(assertProofStillPlanEvidenceV1({ commands, graphics: [], receipts: [receipt], verified })).toEqual({ proofStillCount: 1, commandsChecked: true });
    expect(() => assertProofStillPlanEvidenceV1({ commands, graphics: [], receipts: [{ ...receipt, sourceSha256: "9".repeat(64) }], verified })).toThrow(/^PROOF_STILL_EVIDENCE_MISSING/);
    expect(() => assertProofStillPlanEvidenceV1({ commands, graphics: [event("card", [`mi:${M}:${S}:frame:kf-3`], "context_card")], receipts: [receipt], verified }))
      .toThrow(/^PROOF_STILL_EVENT_FRAME_UNCITED: card/);
  });
});
