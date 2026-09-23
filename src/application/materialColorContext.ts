import type { MaterialColorReceipt } from "./materialColorSamplingTypes";

export function materialColorReference(color?: MaterialColorReceipt) {
  if (!color) return { status: "unmeasured", reason: "legacy-material-without-colour-evidence" };
  if (color.status === "not_applicable") return { status: color.status };
  return { status: color.status, receiptSha256: color.receiptSha256, summaryOmitted: true };
}

/** Small window summary only. Full measurements remain in the local sealed receipt. */
export function materialColorSummary(color: MaterialColorReceipt | undefined, start: number, end: number) {
  if (!color || color.status === "not_applicable") return materialColorReference(color);
  if (color.status !== "measured") return { ...materialColorReference(color), reason: color.reason, summaryOmitted: false };
  const mappings = color.mapping.filter(frame => frame.decodedRelativeTime >= start && frame.decodedRelativeTime < end);
  const ids = new Set(mappings.map(frame => frame.id));
  const frames = color.measurements.frames.filter(frame => ids.has(frame.sampleId));
  const rounded = (n: number) => Number(n.toFixed(6));
  const span = (values: number[]) => values.length ? [rounded(Math.min(...values)), rounded(Math.max(...values))] : null;
  return {
    status: color.status, receiptSha256: color.receiptSha256, summaryOmitted: false,
    scope: "normalized-representative-samples-only",
    coverage: { samplesInWindow: frames.length, totalSamples: color.coverage.sampledCount, requestedSamples: color.coverage.requestedCount,
      detectedSceneCount: color.coverage.sceneCount, sceneCountVerified: color.coverage.sceneCountVerified,
      sceneAttributionVerified: color.coverage.sceneAttributionVerified,
      sampledScenes: [...new Set(mappings.map(frame => frame.sceneIndex))], omittedSceneCount: color.coverage.omittedSceneIndices.length },
    observations: { medianRelativeY: span(frames.map(frame => frame.linearRelativeY.p50)),
      nearWhiteFraction: span(frames.map(frame => frame.nearWhite.fraction)), nearBlackFraction: span(frames.map(frame => frame.nearBlack.fraction)),
      relativeChroma: span(frames.map(frame => frame.relativeLinearChroma.mean)) },
    automaticExposure: "unmeasured", automaticWhiteBalance: "unmeasured",
  };
}
