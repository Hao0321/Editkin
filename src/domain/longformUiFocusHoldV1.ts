import * as z from "zod/v4";

export const LONGFORM_UI_FOCUS_HOLD_MAX_FRAMES_V1 = 256;
export const LONGFORM_UI_FOCUS_HOLD_MAX_RAW_BYTES_V1 = 256 * 1024 * 1024;
export const longformUiFocusHoldRequestV1Schema = z.strictObject({
  draftId: z.string().regex(/^[a-f0-9]{64}$/), candidateId: z.string().regex(/^uif-[a-f0-9]{64}$/),
  duration: z.number().finite().min(.8).max(4),
});
export type LongformUiFocusHoldRequestV1 = z.infer<typeof longformUiFocusHoldRequestV1Schema>;
const point = z.strictObject({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1) });
const rect = z.strictObject({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1),
  width: z.number().finite().positive().max(1), height: z.number().finite().positive().max(1) });
export const longformUiFocusHoldNativePlanV1Schema = z.strictObject({
  engine: z.enum(["hao-core-rust-motion-track-0.4-planar", "hao-core-rust-motion-track-0.4-region-fallback"]),
  width: z.number().int().min(16).max(1280), height: z.number().int().min(16).max(1280),
  analysisFps: z.number().finite().positive().max(120), lostRatio: z.number().finite().min(0).max(1),
  points: z.array(z.strictObject({ frame: z.number().int().nonnegative(), time: z.number().finite().nonnegative(), rect,
    confidence: z.number().finite().min(0).max(1), status: z.enum(["manual", "tracked", "held", "lost"]),
    activity: z.number().finite().min(0).max(1), rotationDegrees: z.number().finite().min(-180).max(180),
    scale: z.number().finite().min(0).max(10), quad: z.array(point).length(4),
    planarDiagnostics: z.strictObject({ matches: z.number().int().nonnegative(), inliers: z.number().int().nonnegative(),
      reprojectionErrorPx: z.number().finite().min(-1), appearanceCorrelation: z.number().finite().min(-1).max(1),
      globalSearch: z.boolean(), regionSupported: z.boolean() }).optional(),
  })).min(1).max(LONGFORM_UI_FOCUS_HOLD_MAX_FRAMES_V1),
});
export type LongformUiFocusHoldNativePlanV1 = z.infer<typeof longformUiFocusHoldNativePlanV1Schema>;
export interface LongformUiFocusHoldClockV1 {
  frame: number; pts: number; durationPts: number; sourceTime: number; duration: number; imageSha256: string;
  reportedDurationPts?: number; durationAuthority?: "decoder-duration" | "next-decoded-pts-with-millisecond-quantization";
}
export interface LongformUiFocusHoldSequenceV1 {
  schema: "editkin.longform-ui-focus-hold-sequence/v1";
  sourceSha256: string; width: number; height: number; origin: number;
  timeBase: { numerator: number; denominator: number }; nominalFps: number;
  frames: LongformUiFocusHoldClockV1[]; cuts: Array<{ frame: number; sourceTime: number; score: number }>;
  filters: string[]; rawSha256: string; rawBytes: number;
  followingFrame?: { pts: number; sourceTime: number; imageSha256: string };
}
export interface LongformUiFocusLocalObservationV1 {
  frame: number; state: "measured" | "missing" | "ambiguous" | "retired";
  targetQuad: Array<{ x: number; y: number }>; correlation: number; difference: number;
  searchRadiusPixels: number; testedOffsets: number; verifiedHypotheses: number;
}
export interface LongformUiFocusHoldReceiptV1 {
  schema: "editkin.longform-ui-focus-hold-evidence/v1"; receiptSha256: string;
  draftId: string; candidateId: string; state: "TRACKING_EVIDENCE_READY" | "BLOCKED";
  sourceSha256: string; sourceStart: number; sourceEnd: number; requestedDuration: number;
  sourceFrameCount: number; sourceTimeBase: LongformUiFocusHoldSequenceV1["timeBase"];
  sequenceSha256: string; rawSha256: string; nativeResultSha256: string;
  trackingContext: { x: number; y: number; width: number; height: number };
  contextAuthority: "tool-derived-padding-around-ocr-text-not-widget-edges";
  frames: Array<{ frame: number; pts: number; durationPts: number; sourceTime: number; endTime: number; imageSha256: string;
    targetQuad: Array<{ x: number; y: number }>; nativeStatus: string; nativeConfidence: number;
    templateCorrelation: number; templateMeanAbsoluteDifference: number; flags: string[];
    trackingProvider: "native-plan" | "independent-local-pixels"; nativeDiagnostics: string[] }>;
  flags: string[]; pixelTemplateContinuityVerified: boolean; semanticIdentityAcrossIntervalVerified: false;
  confidenceCalibrated: false; projectModified: false; focusHintsReady: false;
  artworkStatus: "ART_PENDING_CLAUDE"; selectableByDefault: false;
}
