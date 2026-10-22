import { uiFocusFixtureV1 } from "./longformUiFocusV1.fixture";
import { materialKeyframeFilters } from "./materialKeyframeExtraction";
import { sourceDisplayColorMetadata } from "./sourceDisplayMetadata";
import { assembleLongformUiFocusDraftV1 } from "./longformUiFocusV1";
import { longformUiFocusTrackingContextV1 } from "./longformUiFocusHoldV1";
import { colorBytesSha } from "./materialColorSamplingRuntime";
import type { LongformUiFocusHoldSequenceV1, LongformUiFocusHoldNativePlanV1 } from "../domain/longformUiFocusHoldV1";

/** Synthetic consistency/geometry controls only; not native/OCR evidence. */
export function uiFocusHoldFixtureV1(options: { translation?: boolean; sourceSha?: string } = {}) {
  const f = uiFocusFixtureV1(), width = 160, height = 100, frameCount = 24, rate = 30;
  f.source.sha256 = options.sourceSha ?? f.source.sha256; f.frame.display.source.sha256 = f.source.sha256;
  const stream = { ...f.frame.display.probe.metadata.stream, width, height, avg_frame_rate: "30/1" };
  f.frame.display.probe.metadata.stream = stream; f.frame.display.decoded.width = width; f.frame.display.decoded.height = height;
  f.frame.display.normalization.filters = materialKeyframeFilters("rec709", width, height, sourceDisplayColorMetadata(stream));
  f.frame.ocr.result.width = width; f.frame.ocr.result.height = height;
  f.frame.ocr.result.processing.recognitionWidth = width * 2; f.frame.ocr.result.processing.recognitionHeight = height * 2;
  f.frame.ocr.result.lines[0].words.forEach((word, index) => Object.assign(word, { x: 20 + index * 20, y: 15, width: 15, height: 10 }));
  f.reseal(); const draft = assembleLongformUiFocusDraftV1(f.source, [f.frame], [], ["儲存專案"]);
  const candidate = draft.candidates[0], request = { draftId: draft.draftId, candidateId: candidate.candidateId, duration: .8 };
  const pixels = new Uint8Array(width * height * frameCount);
  const template = new Uint8Array(width * height); let random = 0x19d06c7;
  for (let i = 0; i < template.length; i++) { random ^= random << 13; random ^= random >>> 17; random ^= random << 5; template[i] = 40 + (random >>> 0) % 180; }
  for (let frame = 0; frame < frameCount; frame++) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const originalX = x - (options.translation ? frame : 0);
    pixels[frame * width * height + y * width + x] = originalX < 0 ? 240 : template[y * width + originalX];
  }
  const sequence: LongformUiFocusHoldSequenceV1 = { schema: "editkin.longform-ui-focus-hold-sequence/v1", sourceSha256: f.source.sha256,
    width, height, origin: 0, timeBase: { numerator: 1, denominator: rate }, nominalFps: rate, frames: [], cuts: [],
    filters: [...f.frame.display.normalization.filters, "format=gray"], rawSha256: "", rawBytes: pixels.length };
  const reseal = () => {
    sequence.rawSha256 = colorBytesSha(pixels); sequence.frames = Array.from({ length: frameCount }, (_, frame) => ({ frame, pts: 6 + frame,
      durationPts: 1, reportedDurationPts: 1, durationAuthority: "decoder-duration", sourceTime: (6 + frame) / rate, duration: 1 / rate,
      imageSha256: colorBytesSha(pixels.subarray(frame * width * height, (frame + 1) * width * height)) }));
  }; reseal();
  const context = longformUiFocusTrackingContextV1(candidate.bounds, width, height);
  const plan: LongformUiFocusHoldNativePlanV1 = { engine: "hao-core-rust-motion-track-0.4-planar", width, height, analysisFps: rate, lostRatio: 0,
    points: Array.from({ length: frameCount }, (_, frame) => {
      const rect = { ...context, x: context.x + (options.translation ? frame / width : 0) };
      return { frame, time: frame / rate, rect, confidence: 1, status: frame ? "tracked" : "manual", activity: 0, rotationDegrees: 0, scale: 1,
        quad: [{ x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y }, { x: rect.x + rect.width, y: rect.y + rect.height }, { x: rect.x, y: rect.y + rect.height }],
        planarDiagnostics: { matches: 10, inliers: 10, reprojectionErrorPx: 0, appearanceCorrelation: 1, globalSearch: false, regionSupported: true } };
    }) };
  const log = "[Parsed_showinfo_9 @ 000001] config in time_base: 1/30, frame_rate: 30/1\n" +
    sequence.frames.map(frame => "[Parsed_showinfo_9 @ 000001] n: " + frame.frame + " pts: " + frame.pts + " pts_time:" + frame.sourceTime +
      " duration: 1 duration_time:0.0333333 fmt:gray cl:unspecified sar:1/1 s:160x100 i:P checksum:00000000\n").join("");
  return { ...f, draft, candidate, request, pixels, sequence, plan, context, log, resealPixels: reseal };
}
