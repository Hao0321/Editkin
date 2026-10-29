import * as z from "zod/v4";
import type { MaterialKeyframeDisplay } from "../application/materialKeyframeTypes";
import type { WindowsOcrReceiptV1 } from "./windowsOcrV1";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const longformUiFocusRequestV1Schema = z.strictObject({
  schema: z.literal("editkin.longform-ui-focus-request/v1"), recordingId: z.string().min(1).max(160),
  sourcePath: z.string().min(1).max(4096), expectedSourceSha256: sha,
  sourceStart: z.number().finite().nonnegative(), duration: z.number().finite().positive().max(14400),
  language: z.string().min(2).max(64).regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/),
  frameTimes: z.array(z.number().finite().nonnegative()).min(1).max(12),
  targetTexts: z.array(z.string().trim().min(1).max(128)).max(16).default([]),
}).superRefine((value, ctx) => {
  if (!Number.isFinite(value.sourceStart + value.duration) || value.frameTimes.some((t, i) => t >= value.duration || (i > 0 && t <= value.frameTimes[i - 1])))
    ctx.addIssue({ code: "custom", message: "Frame times must increase within the source window" });
});
export const longformUiFocusConfirmationV1Schema = z.strictObject({
  draftId: sha, candidateIds: z.array(z.string().regex(/^uif-[a-f0-9]{64}$/)).min(1).max(64),
}).superRefine((value, ctx) => {
  if (new Set(value.candidateIds).size !== value.candidateIds.length) ctx.addIssue({ code: "custom", message: "Duplicate focus candidate" });
});
export interface LongformUiFocusFrameV1 { id: string; display: MaterialKeyframeDisplay; ocr: WindowsOcrReceiptV1 }
export interface LongformUiFocusCandidateV1 {
  candidateId: string; frameId: string; scope: "word" | "line" | "phrase"; lineIndex: number; wordIndexes: number[];
  text: string; normalizedText: string; sourceTime: number; relativeTime: number;
  quad: Array<{ x: number; y: number }>;
  bounds: { x: number; y: number; width: number; height: number };
  eligible: boolean; flags: string[];
  coordinateSpace: "normalized-upright-display-frame"; authority: "ocr-text-region";
  validity: "decoded-instant-only"; clickableControlVerified: false;
}
export interface LongformUiFocusDraftV1 {
  schema: "editkin.longform-ui-focus-draft/v1"; draftId: string; state: "REVIEW_REQUIRED";
  source: { recordingId: string; sha256: string; start: number; duration: number };
  frames: LongformUiFocusFrameV1[]; candidates: LongformUiFocusCandidateV1[];
  targetTexts: string[];
  omitted: Array<{ frameId: string; reason: string }>; projectModified: false;
  artworkStatus: "ART_PENDING_CLAUDE"; selectableByDefault: false;
}
