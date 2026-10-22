import { describe, expect, it } from "vitest";
import type { MediaAsset } from "../domain/types";
import { DEFAULT_COLOR_MANAGEMENT } from "../domain/types";
import { aces16PrecompositionAssetV1, aces16PrecompositionEncoderArgsV1, aces16PrecompositionMetadataArgsV1, usesAces16PrecompositionV1 } from "./aces16PrecompositionV1";

describe("internal16-bit composition transport", () => {
  it("limits the new transport to the explicit new ACES policy", () => {
    expect(usesAces16PrecompositionV1(undefined)).toBe(false);
    expect(usesAces16PrecompositionV1({ ...DEFAULT_COLOR_MANAGEMENT, mode: "rec709", rec709DisplayPolicy: "phone-bt1886" })).toBe(false);
    expect(usesAces16PrecompositionV1({ ...DEFAULT_COLOR_MANAGEMENT, mode: "aces2", rec709DisplayPolicy: "legacy-grade-v2" })).toBe(false);
    expect(usesAces16PrecompositionV1({ ...DEFAULT_COLOR_MANAGEMENT, mode: "aces2", rec709DisplayPolicy: "phone-bt1886" })).toBe(true);
  });
  it("replaces stale source metadata only on the materialized clone", () => {
    const source: MediaAsset = { id: "composition", name: "Nested", kind: "video", duration: 1, uri: "composition:child", compositionId: "child", alphaMode: "premultiplied", color: { interpretation: "rec709", range: "tv", transfer: "bt709", primaries: "bt709" } };
    const before = structuredClone(source), working = aces16PrecompositionAssetV1(source, "owned-child.mkv");
    expect(source).toEqual(before);
    expect(working).toMatchObject({ id: source.id, uri: "owned-child.mkv", compositionId: undefined, alphaMode: "straight", color: { interpretation: "acescct", range: "pc" } });
    expect(working.color).not.toHaveProperty("transfer");
    expect(working.color).not.toHaveProperty("primaries");
    expect(aces16PrecompositionEncoderArgsV1()).toEqual(["-c:v", "ffv1", "-level", "3"]);
    expect(aces16PrecompositionMetadataArgsV1()).not.toContain("-color_trc");
  });
});
