import type { LongformUiFocusFrameV1 } from "../domain/longformUiFocusV1";
import { WINDOWS_OCR_SCRIPT_V1 } from "./windowsOcrScriptV1";
import { colorBytesSha, colorDigest } from "./materialColorSamplingRuntime";
import { materialKeyframeFilters } from "./materialKeyframeExtraction";
import { sourceDisplayColorMetadata } from "./sourceDisplayMetadata";

/** Synthetic consistency controls only; not actual OCR/media evidence. */
export function uiFocusFixtureV1() {
  const hash = "a".repeat(64), image = Buffer.from([255, 216, 255, 217]);
  const stream = { width: 960, height: 640, color_primaries: "bt709", color_transfer: "bt709", color_space: "bt709",
    color_range: "tv", pix_fmt: "yuv420p", start_time: "0" };
  const source = { recordingId: "screen", sha256: hash, start: .05, duration: 1 };
  const frame: LongformUiFocusFrameV1 = { id: "focus-frame-1", display: {
    schema: "editkin.material-keyframe-display/v1", receiptSha256: "", runtimeIdentitySha256: hash,
    source: { sha256: hash, start: .05, duration: 1 }, requested: { id: "focus-frame-1", time: .1, sceneIndex: 0 },
    decoded: { pts: 2, timeBase: { numerator: 1, denominator: 10 }, sourceTime: .2, relativeTime: .15,
      width: 960, height: 640, timelineOrigin: 0, sceneIndex: 0, sceneAttributionVerified: false },
    probe: { sha256: hash, metadata: { stream, format: { start_time: "0" } } },
    normalization: { interpretation: "rec709", filters: materialKeyframeFilters("rec709", 960, 640, sourceDisplayColorMetadata(stream)),
      intermediateTransfer: "bt709", displayEotf: "bt1886-ideal", purpose: "neutral-display-proxy", transfer: "srgb", primaries: "bt709",
      range: "full", exposure: 0, creativeLook: false, maximumDimension: 1280 }, jpeg: { sha256: colorBytesSha(image), bytes: 4, mimeType: "image/jpeg" } },
    ocr: { schema: "editkin.windows-ocr-receipt/v1", receiptSha256: "", imageSha256: colorBytesSha(image),
      provider: { scriptSha256: colorBytesSha(Buffer.from(WINDOWS_OCR_SCRIPT_V1)), executableSha256: hash, engine: "Windows.Media.Ocr",
        resources: "existing-installed-os-language-components", modelBinarySha256Verified: false },
      result: { engine: "Windows.Media.Ocr", language: "zh-Hant-TW", width: 960, height: 640, textAngle: null,
        processing: { scale: 2, recognitionWidth: 1920, recognitionHeight: 1280, interpolation: "cubic", coordinates: "recognition-rectangles-divided-by-scale" },
        runtime: { powershellVersion: "5.1.0", osVersion: "Windows fixture", maximumImageDimension: 10000, languages: ["zh-Hant-TW"] },
        lines: [{ index: 0, text: "儲存 專案", words: [
          { index: 0, text: "儲存", x: 100, y: 100, width: 60, height: 30 }, { index: 1, text: "專案", x: 170, y: 100, width: 60, height: 30 },
        ] }] }, authority: "text-regions-in-this-image-only", calibratedConfidenceAvailable: false } };
  const reseal = () => { frame.display.receiptSha256 = colorDigest({ ...frame.display, receiptSha256: undefined });
    frame.ocr.receiptSha256 = colorDigest({ ...frame.ocr, receiptSha256: undefined }); }; reseal();
  return { source, frame, image, reseal };
}
