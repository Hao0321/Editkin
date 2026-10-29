import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type MediaDerivatives } from "../domain/types";
import { buildGpuEngineVideoPreviewGraph } from "./gpuCompositor";
import { assertFormalOriginalBindingsV1, FORMAL_RENDER_PROXY_REFUSED, formalExportDerivativesV1, PREVIEW_PROXY_DERIVATIVE_FIELDS_V1 } from "./longRenderFormalOriginalsV1";

const proxied = (index: number): MediaDerivatives => ({
  sourceSha256: String(index).repeat(64).slice(0, 64), generatedAt: "2026-10-15T00:00:00.000Z", previewRecipe: "recipe-v8",
  proxyUri: `C:/cache/${index}/proxy.mp4`, proxyWidth: 320, proxyHeight: 180, proxyColorContract: "editkin.browser-display-proxy/v1",
  proxyColor: { interpretation: "rec709", primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" },
  overlayProxyUri: `C:/cache/${index}/overlay-proxy.mp4`, overlayProxyWidth: 384, overlayProxyHeight: 216,
  overlayProxyFrameRateNumerator: 15, overlayProxyFrameRateDenominator: 1, overlayProxyProfile: "editkin-small-overlay-performance/v1",
  thumbnailUri: `C:/cache/${index}/thumbnail.jpg`, waveformUri: `C:/cache/${index}/waveform.png`,
});

/** Formal export clone exactly as ffmpeg.ts builds it: same project, preview proxies removed. */
function formalClone(project: EditProject): EditProject {
  const clone = structuredClone(project);
  for (const asset of clone.assets) if (asset.kind === "video" && !asset.compositionId && asset.derivatives) asset.derivatives = formalExportDerivativesV1(asset.derivatives);
  return clone;
}

function singleLayer(): EditProject {
  const project = createDemoProject();
  project.width = 1920; project.height = 1080; project.captions = []; project.motionGraphics = [];
  project.colorManagement = { ...project.colorManagement!, mode: "aces2", outputTransform: "rec709_sdr" };
  Object.assign(project.assets[0], { uri: "C:/fixtures/source-1080.mp4", width: 1920, height: 1080,
    derivatives: { ...proxied(1), proxyUri: "C:/cache/proxy-540.mp4", proxyWidth: 960, proxyHeight: 540 } });
  return project;
}

/** Six layers of distinct sources: layers 2..6 are small (scale .25) and qualify for the 216p/15 fps overlay proxy in preview. */
function sixLayers(): EditProject {
  const project = createDemoProject();
  project.width = 640; project.height = 360; project.fps = 30; project.captions = []; project.motionGraphics = [];
  project.colorManagement = { ...project.colorManagement!, mode: "aces2", outputTransform: "rec709_sdr" };
  project.assets = []; project.tracks = project.tracks.filter(track => track.kind !== "video");
  for (let index = 0; index < 6; index += 1) {
    project.assets.push({ id: `layer-${index}`, name: `layer ${index}`, kind: "video", uri: `C:/fixtures/layer-${index}.mp4`, duration: 4, width: 640, height: 360, derivatives: proxied(index) });
    project.tracks.unshift({ id: `video-${index}`, name: `video ${index}`, kind: "video", locked: false, muted: false, clips: [{
      id: `clip-${index}`, assetId: `layer-${index}`, trackId: `video-${index}`, timelineStart: 0, sourceStart: 0, duration: 4, volume: 0,
      transform: { ...DEFAULT_TRANSFORM, scale: index === 0 ? 1 : .25, x: index === 0 ? 0 : (index - 3) * 100 }, color: { ...DEFAULT_COLOR }, keyframes: [] }] });
  }
  project.tracks.reverse();
  return project;
}

describe("LV-02 formal export derivative policy", () => {
  it("removes every preview decode field and keeps identity/thumbnail/waveform without mutating the saved derivatives", () => {
    const saved = proxied(7), before = structuredClone(saved);
    const formal = formalExportDerivativesV1(saved);
    for (const field of PREVIEW_PROXY_DERIVATIVE_FIELDS_V1) expect(field in formal).toBe(false);
    expect(formal).toEqual({ sourceSha256: saved.sourceSha256, generatedAt: saved.generatedAt, previewRecipe: saved.previewRecipe,
      thumbnailUri: saved.thumbnailUri, waveformUri: saved.waveformUri });
    expect(saved).toEqual(before);
  });

  it("keeps preview on the 540p proxy while the formal clone decodes the original", () => {
    const project = singleLayer();
    const preview = buildGpuEngineVideoPreviewGraph(project, 0)!;
    expect(preview.decoderDimensions["asset-demo"]).toEqual({ width: 960, height: 540, source: "proxy" });
    expect(() => assertFormalOriginalBindingsV1(project, preview)).toThrow(FORMAL_RENDER_PROXY_REFUSED);
    const clone = formalClone(project), formal = buildGpuEngineVideoPreviewGraph(clone, 0)!;
    expect(formal.assetBindings).toEqual({ "asset-demo": "C:/fixtures/source-1080.mp4" });
    expect(formal.decoderDimensions["asset-demo"]).toEqual({ width: 1920, height: 1080, source: "original" });
    expect(() => assertFormalOriginalBindingsV1(clone, formal)).not.toThrow();
    // Same admitted graph apart from the decoded file: stripping proxies never changes the route.
    expect(formal.graph).toEqual(preview.graph);
    expect(project.assets[0].derivatives?.proxyUri).toBe("C:/cache/proxy-540.mp4");
  });

  it("refuses the 216p/15 fps overlay proxy on formal output and binds all six originals", () => {
    const project = sixLayers();
    const preview = buildGpuEngineVideoPreviewGraph(project, 0)!;
    expect(preview).toBeTruthy();
    const sources = Object.values(preview.decoderDimensions).map(item => item.source);
    expect(sources.filter(source => source === "overlay-proxy")).toHaveLength(5);
    expect(() => assertFormalOriginalBindingsV1(project, preview)).toThrow(FORMAL_RENDER_PROXY_REFUSED);
    const clone = formalClone(project), formal = buildGpuEngineVideoPreviewGraph(clone, 0)!;
    expect(Object.values(formal.decoderDimensions)).toEqual(Array.from({ length: 6 }, () => ({ width: 640, height: 360, source: "original" })));
    expect(formal.assetBindings).toEqual(Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`layer-${index}`, `C:/fixtures/layer-${index}.mp4`])));
    expect(() => assertFormalOriginalBindingsV1(clone, formal)).not.toThrow();
  });

  it("refuses a graph whose decoder claims original but binds another file, or binds an undeclared source", () => {
    const clone = formalClone(singleLayer()), formal = buildGpuEngineVideoPreviewGraph(clone, 0)!;
    expect(() => assertFormalOriginalBindingsV1(clone, { ...formal, assetBindings: { "asset-demo": "C:/cache/proxy-540.mp4" } })).toThrow(/bound file is not the asset original/);
    expect(() => assertFormalOriginalBindingsV1(clone, { ...formal, decoderDimensions: { "asset-demo": { width: 960, height: 540, source: "original" } } })).toThrow(/differs from the original/);
    expect(() => assertFormalOriginalBindingsV1(clone, { ...formal, assetBindings: { ...formal.assetBindings, ghost: "C:/x.mp4" } })).toThrow(/without a declared decoder source/);
  });
});
