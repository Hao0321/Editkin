import { expect, it } from "vitest";
import { compactMaterialKeyframe, materialKeyframeReadiness } from "./materialIntelligenceTools";
import type { MaterialKeyframe } from "../application/materialIntelligence";

it("never exports full display probe paths/tags/filters into Agent metadata", () => {
  const frame = { id: "kf-1", time: .1, sceneIndex: 0, sha256: "a".repeat(64), bytes: 100, fileName: "private.jpg", mimeType: "image/jpeg",
    display: { receiptSha256: "b".repeat(64), requested: { time: .05 }, decoded: { relativeTime: .1, sceneAttributionVerified: true },
      probe: { metadata: { format: { filename: "D:/private/source.mov", tags: { secret: "private-camera-tag" } } } },
      normalization: { purpose: "neutral-display-proxy", transfer: "srgb", filters: ["private-filter-path"] } } } as unknown as MaterialKeyframe;
  const summary = compactMaterialKeyframe(frame);
  expect(summary.display).toEqual({ receiptSha256: "b".repeat(64), purpose: "neutral-display-proxy", transfer: "srgb", requestedTime: .05, actualTime: .1, sceneAttributionVerified: true });
  expect(JSON.stringify(summary)).not.toMatch(/private|probe|filters|filename|fileName/);
  expect(materialKeyframeReadiness([frame])).toEqual({ status: "GREEN", needsReprepare: false, unverifiedDisplayFrameIds: [] });
});

it("does not promote hash-valid legacy JPEGs to verified display normalization", () => {
  const legacy = { id: "kf-2", time: .1, sceneIndex: 0, sha256: "a".repeat(64), bytes: 100, fileName: "legacy.jpg", mimeType: "image/jpeg" } as MaterialKeyframe;
  expect(compactMaterialKeyframe(legacy).display).toBeUndefined();
  expect(materialKeyframeReadiness([legacy])).toEqual({ status: "PARTIAL", needsReprepare: true, unverifiedDisplayFrameIds: ["kf-2"] });
});
