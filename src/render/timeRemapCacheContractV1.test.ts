import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/timeRemapCacheReceiptV1.fixture.json";
import { parseTimeRemapCacheReceiptV1, timeRemapCacheKeyV1, timeRemapCacheDigestV1, admitTimeRemapCacheClipV1 } from "./timeRemapCacheContractV1";
import { createDemoProject } from "../domain/demo";
const receipt = () => parseTimeRemapCacheReceiptV1(structuredClone(fixture));
describe("strict source-clock cache identity", () => {
  it("admits a real 16-frame FFV1 receipt while retaining every diagnostic limit", () => {
    expect(receipt()).toMatchObject({ frames: 16, width: 64, height: 40, ordinaryEditorPreviewReady: false, wholePixelQualityCertified: false, audioQualityCertified: false });
  });
  it.each(["source", "window", "duration", "speed", "curve", "direction", "fps", "width", "height", "audio", "code", "ffmpeg", "ffprobe"])("invalidates the key on %s changes", kind => {
    const a = receipt().keyInputs, b = structuredClone(a);
    if (kind === "source") b.sourceSha256 = "1".repeat(64);
    if (kind === "window") b.sourceStart += .125;
    if (kind === "duration") b.duration += .125;
    if (kind === "speed") b.speed = 2;
    if (kind === "curve") b.timeRemap!.segments[0].control1.speed = .9;
    if (kind === "direction") b.timeRemap!.direction = "reverse";
    if (kind === "fps") b.fps.numerator += 1;
    if (kind === "width") b.width += 2;
    if (kind === "height") b.height += 2;
    if (kind === "audio") b.audio = "shared-phase-pcm";
    if (kind === "code") b.implementationSha256 = "2".repeat(64);
    if (kind === "ffmpeg") b.ffmpegSha256 = "3".repeat(64);
    if (kind === "ffprobe") b.ffprobeSha256 = "4".repeat(64);
    expect(timeRemapCacheKeyV1(b)).not.toBe(timeRemapCacheKeyV1(a));
  });
  it.each(["preview", "pixels", "audio", "frame-count", "byte-count", "pixel-sha", "geometry", "unknown", "digest", "key"])("refuses %s mutation, even with a recalculated outer digest", kind => {
    const r: any = structuredClone(fixture);
    if (kind === "preview") r.ordinaryEditorPreviewReady = true;
    if (kind === "pixels") r.wholePixelQualityCertified = true;
    if (kind === "audio") r.audioQualityCertified = true;
    if (kind === "frame-count") r.frames += 1;
    if (kind === "byte-count") r.pixels.bytes -= 4;
    if (kind === "pixel-sha") r.pixels.sha256 = "f".repeat(64);
    if (kind === "geometry") r.width += 2;
    if (kind === "unknown") r.approved = true;
    if (kind === "key") r.key = "f".repeat(64);
    const { digest: _old, ...body } = r; r.digest = kind === "digest" ? "0".repeat(64) : timeRemapCacheDigestV1(body);
    expect(() => parseTimeRemapCacheReceiptV1(r)).toThrow();
  });
  it("keeps equivalent key object order stable and rejects undeclared URI/model keys", () => {
    const a = receipt().keyInputs, b = Object.fromEntries(Object.entries(a).reverse());
    expect(timeRemapCacheKeyV1(b as typeof a)).toBe(timeRemapCacheKeyV1(a));
    expect(() => timeRemapCacheKeyV1({ ...a, model: "download" } as typeof a)).toThrow();
  });
  it.each(["aces", "hdr", "b4", "clock", "raster", "audio-asset", "linked"])("does not silently narrow unsupported %s", kind => {
    const p = createDemoProject(), c = p.tracks[0].clips[0], a = p.assets[0]; c.speed = 1;
    if (kind === "aces") p.colorManagement!.mode = "aces2";
    if (kind === "hdr") a.color = { interpretation: "hlg" };
    if (kind === "b4") a.clipRetime = {} as NonNullable<typeof a.clipRetime>;
    if (kind === "clock") c.duration = 12.01;
    if (kind === "raster") a.width = 32768;
    if (kind === "audio-asset") a.kind = "audio";
    if (kind === "linked") c.linkGroupId = "linked";
    expect(() => admitTimeRemapCacheClipV1(p, c, a)).toThrow();
  });
});
