import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { compileClipAlphaPlan } from "../domain/clipAlphaPlan";
import { createDemoProject } from "../domain/demo";
import { createClipMask } from "../domain/masks";
import type { MediaAsset } from "../domain/types";
import AlphaProcessedPreviewMedia, { AlphaPreviewUnavailable, alphaPreviewFailureMessage } from "./AlphaProcessedPreviewMedia";

const asset = { id: "source", kind: "image", name: "Alpha 測試" } as MediaAsset;

describe("AlphaProcessedPreviewMedia fail-closed surface", () => {
  it("keeps source and matte hidden and hides a stale canvas while the selected floor-sampled frame loads", () => {
    const project = createDemoProject();
    project.fps = 30;
    const clip = project.tracks[0].clips[0];
    const mask = createClipMask("roto", "subject");
    mask.matteSequence = {
      schema: "editkin.auto-roto-matte/v1", engine: "editkin-native-color-temporal-roto/v1",
      width: 4, height: 4, analysisFps: 12, frameCount: 2,
      sequenceUri: "matte.alpha8", manifestUri: "matte.json",
      framePreviewUris: ["preview-0.png", "preview-1.png"],
      meanBoundaryChatter: 0, frozen: true, qualityState: "diagnostic",
    };
    clip.masks = [mask];
    const html = renderToStaticMarkup(<AlphaProcessedPreviewMedia asset={asset} source="raw-source.png" plan={compileClipAlphaPlan(project, clip)} localProjectFrame={3} projectWidth={1920} projectHeight={1080} muted testId="preview-image" />);
    expect(html).toContain('src="raw-source.png"');
    expect(html).toContain('src="preview-1.png"');
    expect(html.match(/aria-hidden="true"/g)?.length).toBeGreaterThanOrEqual(3);
    expect(html).toContain("opacity:0");
    expect(html).toContain("visibility:hidden");
    expect(html).toContain('data-alpha-plan-schema="editkin.clip-alpha-plan/v1"');
    expect(html).toContain('data-alpha-preview-status="loading"');
  });

  it("sanitizes processing styles and never embeds raw media in an unavailable surface", () => {
    const html = renderToStaticMarkup(<AlphaPreviewUnavailable assetName="Alpha 測試" reason="Track Matte 不支援" className="preview-layer" style={{ filter: "blur(20px)", maskImage: "url(raw.png)", transform: "scale(1.2)" }} testId="preview-video" />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("為避免誤顯示未處理原片");
    expect(html).toContain("Track Matte 不支援");
    expect(html).toContain("scale(1.2)");
    expect(html).not.toContain("blur(20px)");
    expect(html).not.toContain("raw.png");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<video");
  });

  it("classifies tainted canvas failures without exposing implementation details", () => {
    const error = Object.assign(new Error("Canvas has been tainted by cross-origin data"), { name: "SecurityError" });
    expect(alphaPreviewFailureMessage(error)).toBe("素材來源限制阻擋像素讀取（CORS）");
    expect(alphaPreviewFailureMessage(new Error("瀏覽器未提供 2D Alpha 預覽"))).toBe("此裝置不支援 2D Alpha Canvas 預覽");
  });
});

