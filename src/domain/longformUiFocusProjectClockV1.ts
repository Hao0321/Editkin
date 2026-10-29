/** This receipt proves the FFmpeg composite temporal route only. Native and
 * browser source presentation remain separate acceptance requirements. */
export interface LongformUiFocusProjectClockV1 {
  schema: "editkin.longform-ui-focus-project-clock/v1"; receiptSha256: string;
  state: "SOURCE_PROJECT_CLOCK_READY"; artifactId: string; holdReceiptSha256: string;
  sourceSha256: string; contextSha256: string;
  project: { id: string; revision: number; canonicalSha256: string; clipId: string; assetId: string;
    fps: number; timelineStart: number; sourceStart: number; duration: number };
  sourceTimeBase: { numerator: number; denominator: number };
  projectTimeBase: { numerator: number; denominator: number };
  sourceTimestampOffsetPts: number; timelineStartFrame: number; timelineEndFrame: number;
  frames: Array<{ projectFrame: number; sourceFrame: number; sourcePts: number; sourceTime: number;
    imageSha256: string; targetQuad: Array<{ x: number; y: number }> }>;
  provider: { route: "ffmpeg-composite-clock"; decodeRuntimeIdentitySha256: string; implementationSha256: string;
    processStdoutSha256: string; processStderrSha256: string; inputFramesObserved: number; outputFramesObserved: number;
    droppedSourceFrames: number; duplicatedSourceFrames: number };
  sourceProjectPixelsVerified: true; nativePresentationVerified: false; browserPresentationVerified: false;
  projectModified: false; focusHintsReady: false; artworkStatus: "ART_PENDING_CLAUDE"; selectableByDefault: false;
}
