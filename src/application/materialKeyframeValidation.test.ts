import { expect, it } from "vitest";
import { sourceDisplayFrame } from "./sourceDisplayFrame";
import { sourceDisplayColorMetadata, sourceDisplayInterpretation } from "./sourceDisplayMetadata";
import { verifyMaterialKeyframeDisplay } from "./materialKeyframeValidation";
import { colorDigest } from "./materialColorSamplingRuntime";
import { materialKeyframeFilters } from "./materialKeyframeExtraction";
import type { MaterialKeyframeAnalysis, MaterialKeyframeDisplay } from "./materialKeyframeTypes";

function fixture() {
  const hash = "a".repeat(64), stream = { width: 96, height: 64, color_primaries: "bt709", color_transfer: "bt709", color_space: "bt709", color_range: "tv", pix_fmt: "yuv420p", start_time: "0" };
  const analysis: MaterialKeyframeAnalysis = { schema: "editkin.material-keyframe-analysis/v1", policy: "neutral-srgb-display-v1", runtimeIdentitySha256: hash, state: "ready", requestedSamples: [{ id: "kf-1", time: .1, sceneIndex: 0 }], omitted: [] };
  const display: MaterialKeyframeDisplay = { schema: "editkin.material-keyframe-display/v1", receiptSha256: "", runtimeIdentitySha256: hash, source: { sha256: hash, start: .05, duration: 1 }, requested: analysis.requestedSamples[0],
    decoded: { pts: 2, timeBase: { numerator: 1, denominator: 10 }, sourceTime: .2, relativeTime: .15, width: 96, height: 64, timelineOrigin: 0, sceneIndex: 1, sceneAttributionVerified: true },
    probe: { sha256: hash, metadata: { stream, format: { start_time: "0" } } }, normalization: { interpretation: "rec709", filters: materialKeyframeFilters("rec709", 96, 64, sourceDisplayColorMetadata(stream)), intermediateTransfer: "bt709", displayEotf: "bt1886-ideal", purpose: "neutral-display-proxy", transfer: "srgb", primaries: "bt709", range: "full", exposure: 0, creativeLook: false, maximumDimension: 1280 }, jpeg: { sha256: hash, bytes: 100, mimeType: "image/jpeg" } };
  const frames = [{ id: "kf-1", time: .15, sceneIndex: 1, sha256: hash, bytes: 100, display }], source = { sourceSha256: hash, sourceStart: .05, duration: 1, kind: "video" };
  const reseal = () => { display.receiptSha256 = colorDigest({ ...display, receiptSha256: undefined }); }; reseal();
  return { analysis, display, frames, source, reseal, verify: () => verifyMaterialKeyframeDisplay(analysis, frames, source, hash, [.12]) };
}
it("validates explicit neutral display mapping (synthetic consistency fixture only)", () => fixture().verify());
it.each([
  ["source", (f: ReturnType<typeof fixture>) => { f.display.source.sha256 = "b".repeat(64); }],
  ["trim", (f: ReturnType<typeof fixture>) => { f.source.sourceStart = .1; }],
  ["requested time", (f: ReturnType<typeof fixture>) => { f.analysis.requestedSamples = [{ id: "kf-1", time: .11, sceneIndex: 0 }]; }],
  ["PTS", (f: ReturnType<typeof fixture>) => { f.display.decoded.pts = 3; }],
  ["fake requested clock", (f: ReturnType<typeof fixture>) => { f.frames[0].time = .1; }],
  ["range", (f: ReturnType<typeof fixture>) => { f.display.decoded.relativeTime = 2; }],
  ["wrong scene", (f: ReturnType<typeof fixture>) => { f.display.decoded.sceneIndex = 0; }],
  ["unknown", (f: ReturnType<typeof fixture>) => { delete f.display.probe.metadata.stream.color_transfer; }],
  ["look", (f: ReturnType<typeof fixture>) => { f.display.normalization.filters.push("eq=contrast=2"); }],
  ["sRGB label only", (f: ReturnType<typeof fixture>) => { f.display.normalization.filters = ["format=rgb24"]; }],
  ["JPEG hash", (f: ReturnType<typeof fixture>) => { f.frames[0].sha256 = "b".repeat(64); }],
  ["runtime", (f: ReturnType<typeof fixture>) => { f.display.runtimeIdentitySha256 = "b".repeat(64); }],
  ["missing receipt", (f: ReturnType<typeof fixture>) => { f.frames[0].display = undefined as never; }],
  ["duplicate coverage", (f: ReturnType<typeof fixture>) => { f.analysis.omitted.push({ id: "kf-1", reason: "duplicate-decoded-frame" }); }],
] as const)("rejects resealed %s inconsistency", (_name, change) => { const f = fixture(); change(f); f.reseal(); expect(f.verify).toThrow(); });
it("parses actual same-decode PTS across nonzero origins and rejects missing/stale/outside timestamps", () => {
  const stderr = "config in time_base: 1/1000\nn: 0 pts: 4200 pts_time:4.2 fmt:yuvj444p s:96x64";
  expect(sourceDisplayFrame(stderr, 4, .05, 1, .1, 1280)).toMatchObject({ pts: 4200, sourceTime: expect.closeTo(.2, 8), relativeTime: expect.closeTo(.15, 8) });
  expect(() => sourceDisplayFrame("no clock", 0, 0, 1, .1, 1280)).toThrow(/pts/);
  expect(() => sourceDisplayFrame(stderr, 4, .05, .12, .1, 1280)).toThrow(/window/);
  expect(() => sourceDisplayFrame(stderr, 4, .05, 1, .3, 1280)).toThrow(/window/);
});
it("shared metadata validator rejects unknown, alpha and contradictory Log rather than guessing", () => {
  const stream = { color_primaries: "bt709", color_transfer: "bt709", color_space: "bt709", color_range: "tv", pix_fmt: "yuv420p" };
  expect(sourceDisplayInterpretation(stream)).toBe("rec709");
  expect(() => sourceDisplayInterpretation({ ...stream, color_transfer: undefined })).toThrow(/unknown/);
  expect(() => sourceDisplayInterpretation({ ...stream, pix_fmt: "yuva444p" })).toThrow(/alpha/);
  expect(() => sourceDisplayInterpretation(stream, { interpretation: "log_unresolved" })).toThrow(/contradictory/);
});
