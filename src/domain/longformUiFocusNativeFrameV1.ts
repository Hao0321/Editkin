import type { MotionGraphicV2Motion } from "./types";
/** Exact approved Long04 focus style. Historical positions/times are excluded. */
export const LONGFORM_UI_FOCUS_NATIVE_STYLE_V1 = {
  schema: "editkin.longform-ui-focus-native-style/v1" as const,
  approvedReferenceSha256: "24943c18c383d7d91a97e48828416fd0968f957b665d4d97ddd9bf66863abcd9",
  accentColor: "#5284FF", outlineWidthAt1080: 6, cornerRadiusAt1080: 12,
  subtitleReserveAt1080: 200, backgroundColor: "#00000000", shadowDepth: 0,
  motion: { sequence: { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0 },
    entrance: { durationFrames: 7, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 0, easing: { type: "ease_out" } },
    exit: { durationFrames: 4, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 0, easing: { type: "ease_in" } } } satisfies MotionGraphicV2Motion,
};
export interface PreparedLongformUiFocusNativeFramesV1 {
  readonly schema: "editkin.prepared-longform-ui-focus-native-frames/v1";
  readonly draftId: string; readonly frameCount: number;
}
export interface LongformUiFocusNativeFrameDraftV1 {
  schema: "editkin.longform-ui-focus-native-frame-draft/v1"; draftId: string;
  artifactId: string; holdReceiptSha256: string; clockReceiptSha256: string; candidateId: string;
  sourceSha256: string; projectCanonicalSha256: string;
  canvas: { width: number; height: number; coordinateSpace: "upright-source-display" };
  timelineStartFrame: number; timelineEndFrame: number; projectTimeBase: { numerator: number; denominator: number };
  style: typeof LONGFORM_UI_FOCUS_NATIVE_STYLE_V1;
  frames: Array<{ projectFrame: number; sourcePts: number; sourceTime: number; imageSha256: string;
    targetQuad: Array<{ x: number; y: number }>; opacity: number }>;
  projectGeometryProjected: false; editableProjectGraphCompiled: false;
  projectModified: false; focusHintsReady: false; artworkStatus: "ART_PENDING_CLAUDE"; selectableByDefault: false;
}
