import { describe, expect, it } from "vitest";
import { activeMediaLayers, previewSurfaceAsset } from "./previewMedia";
import { createDemoProject } from "../domain/demo";
import { parseProject } from "./projectFiles";
import { validateProject } from "../domain/editGraph";
import { buildGpuEngineVideoPreviewGraph } from "../render/gpuCompositor";
import type { MediaAsset } from "../domain/types";

function fixture() {
  const project = createDemoProject(), asset = project.assets[0];
  asset.uri = "D:/original-HLG.MOV";
  asset.color = { interpretation: "auto", primaries: "bt2020", transfer: "arib-std-b67", matrix: "bt2020nc", range: "tv" };
  asset.derivatives = { sourceSha256: "a".repeat(64), generatedAt: "2026-08-31T00:00:00Z", proxyUri: "D:/cache/proxy.mp4", proxyWidth: 960, proxyHeight: 540,
    proxyColorContract: "editkin.browser-display-proxy/v1", proxyColor: { interpretation: "rec709", primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" } };
  const urls = { [asset.id]: "asset://proxy", [`${asset.id}:proxy`]: "asset://proxy", [`${asset.id}:source`]: "asset://original" };
  return { project, asset, urls };
}

describe("display proxy colour is not source colour", () => {
  it("only projects explicitly bound proxy URLs, without mutating the project", () => {
    const { project, asset, urls } = fixture(), before = structuredClone(project);
    const layer = activeMediaLayers(project, .5, urls, "video")[0];
    expect(layer.displayProxy).toBe(true);
    expect(layer.asset.color?.interpretation).toBe("rec709");
    expect(layer.asset.uri).toBe(asset.uri);
    expect(project).toEqual(before);
    expect(buildGpuEngineVideoPreviewGraph(project, .5)).toBeUndefined();
  });
  it.each(["asset://original", "asset://native-effect", "asset://other-proxy"])("does not relabel another runtime surface %s", source => {
    const { asset, urls } = fixture();
    expect(previewSurfaceAsset(asset, source, urls)).toBe(asset);
  });
  it("does not infer a colour contract for an old proxy", () => {
    const { asset, urls } = fixture();
    delete asset.derivatives!.proxyColorContract;
    expect(previewSurfaceAsset(asset, urls[asset.id], urls)).toBe(asset);
  });
  it("serializes display metadata but preserves original camera tags/URI", () => {
    const { project, asset } = fixture();
    const reopened = parseProject(JSON.parse(JSON.stringify(project)));
    expect(reopened.assets[0].color).toEqual(asset.color);
    expect(reopened.assets[0].uri).toBe(asset.uri);
    expect(reopened.assets[0].derivatives).toEqual(asset.derivatives);
  });
  it.each([
    "not-an-editkin-preview-recipe",
    `editkin.browser-proxy-${"x".repeat(161)}`,
  ])("rejects malformed or unbounded preview recipe %s", previewRecipe => {
    const { project, asset } = fixture();
    asset.derivatives!.previewRecipe = previewRecipe;
    expect(() => parseProject(JSON.parse(JSON.stringify(project)))).toThrow();
  });
  it.each([
    (asset: MediaAsset) => { delete asset.derivatives!.proxyUri; },
    (asset: MediaAsset) => { delete asset.derivatives!.proxyColor; },
    (asset: MediaAsset) => { asset.derivatives!.proxyColor!.transfer = "arib-std-b67"; },
  ])("rejects incomplete or contradictory proxy colour claims", change => {
    const { project, asset } = fixture(); change(asset);
    expect(() => validateProject(project)).toThrow(/衍生檔/);
  });
});
