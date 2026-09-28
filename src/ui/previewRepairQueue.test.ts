import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { nextAutomaticPreviewRepair } from "./previewRepairQueue";

describe("automatic video preview repair admission", () => {
  it("selects three failed MOV assets one at a time and never submits a source twice", () => {
    const project = createDemoProject();
    const first = project.assets[0]!;
    const clip = project.tracks[0]!.clips[0]!;
    const assets = [first, { ...first, id: "mov-2", uri: "second.mov" }, { ...first, id: "mov-3", uri: "third.mov" }];
    for (const asset of assets) delete asset.derivatives;
    const layers = assets.map((asset, index) => ({ clip: { ...clip, id: `clip-${index}`, assetId: asset.id }, asset, source: `${index}.mov` }));
    layers.push({ clip: { ...clip, id: "clip-again", assetId: assets[0]!.id }, asset: assets[0]!, source: "0.mov" });
    const failures = new Set(layers.map(layer => JSON.stringify([layer.clip.id, layer.source])));
    const attempted = new Set<string>();
    const selected: string[] = [];
    for (let index = 0; index < 4; index++) {
      const next = nextAutomaticPreviewRepair(project.id, layers, failures, attempted);
      if (!next) break;
      selected.push(next.assetId);
      attempted.add(next.attemptKey);
    }
    expect(selected).toEqual(assets.map(asset => asset.id));
    expect(nextAutomaticPreviewRepair(project.id, layers, failures, attempted)).toBeUndefined();
  });

  it("ignores playable frames and assets that already own a proxy", () => {
    const project = createDemoProject();
    const asset = { ...project.assets[0]! };
    asset.derivatives = { sourceSha256: "a".repeat(64), proxyUri: "prepared.mp4", thumbnailUri: "thumbnail.jpg", generatedAt: "2026-09-28T00:00:00Z" };
    const clip = project.tracks[0]!.clips[0]!;
    const layers = [{ clip, asset, source: "prepared.mp4" }];
    expect(nextAutomaticPreviewRepair(project.id, layers, new Set(), new Set())).toBeUndefined();
    expect(nextAutomaticPreviewRepair(project.id, layers, new Set([JSON.stringify([clip.id, "prepared.mp4"])]), new Set())).toBeUndefined();
  });
});
