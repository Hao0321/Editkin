import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_CHROMA_KEY } from "../domain/chromaKey";
import type { MediaAsset } from "../domain/types";
import KeyedPreviewMedia, { KeyedPreviewUnavailable, keyedPreviewFailureMessage, renderKeyedPreviewFrame } from "./KeyedPreviewMedia";

const imageAsset = { id: "green-screen", kind: "image", name: "綠幕測試" } as MediaAsset;

describe("KeyedPreviewMedia fail-closed preview", () => {
  it("keeps the unprocessed source hidden while the keyed canvas is preparing", () => {
    const html = renderToStaticMarkup(<KeyedPreviewMedia asset={imageAsset} source="https://media.example/green.png" settings={DEFAULT_CHROMA_KEY} muted testId="preview-image" />);
    expect(html).toContain('data-testid="preview-image-key-source"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("opacity:0");
    expect(html).toContain('data-keyed-preview-status="loading"');
    expect(html).not.toContain("keyed-preview-error");
  });

  it("renders an explicit alert without raw media when processing is unavailable", () => {
    const html = renderToStaticMarkup(<KeyedPreviewUnavailable assetName="綠幕測試" reason="素材來源限制阻擋像素讀取（CORS）" className="preview-layer" style={{ zIndex: 3, transform: "scale(1.2)", filter: "blur(20px)", maskImage: "url(secret-mask.png)" }} testId="preview-video" />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('data-testid="preview-video-key-error"');
    expect(html).toContain("為避免誤顯示未去背原片");
    expect(html).toContain("素材來源限制阻擋像素讀取（CORS）");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<video");
    expect(html).not.toContain("secret-mask");
    expect(html).not.toContain("blur(20px)");
  });

  it("classifies a tainted canvas as CORS and rejects a missing 2D context", () => {
    const securityError = Object.assign(new Error("The canvas has been tainted by cross-origin data"), { name: "SecurityError" });
    const taintedCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        clearRect: () => undefined,
        drawImage: () => undefined,
        getImageData: () => { throw securityError; },
      }),
    } as unknown as HTMLCanvasElement;
    let thrown: unknown;
    try { renderKeyedPreviewFrame(taintedCanvas, {} as CanvasImageSource, 1920, 1080, DEFAULT_CHROMA_KEY); }
    catch (error) { thrown = error; }
    expect(keyedPreviewFailureMessage(thrown)).toBe("素材來源限制阻擋像素讀取（CORS）");
    const canvas = { width: 0, height: 0, getContext: () => null } as unknown as HTMLCanvasElement;
    expect(() => renderKeyedPreviewFrame(canvas, {} as CanvasImageSource, 1920, 1080, DEFAULT_CHROMA_KEY)).toThrow("瀏覽器未提供 2D Alpha 預覽");
    expect(keyedPreviewFailureMessage(new Error("瀏覽器未提供 2D Alpha 預覽"))).toBe("此裝置不支援 2D Alpha Canvas 預覽");
  });

  it("surfaces a pixel-processing failure instead of treating it as a usable preview", () => {
    const processingCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        clearRect: () => undefined,
        drawImage: () => undefined,
        getImageData: () => ({ data: new Uint8ClampedArray([0, 255, 0, 255]) }),
        putImageData: () => { throw new Error("Canvas upload failed"); },
      }),
    } as unknown as HTMLCanvasElement;
    let thrown: unknown;
    try { renderKeyedPreviewFrame(processingCanvas, {} as CanvasImageSource, 1, 1, DEFAULT_CHROMA_KEY); }
    catch (error) { thrown = error; }
    expect(keyedPreviewFailureMessage(thrown)).toBe("去背像素處理失敗：Canvas upload failed");
  });
});
