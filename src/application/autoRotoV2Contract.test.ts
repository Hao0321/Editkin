import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/autoRotoNativeV2.fixture.json";
import { nativeAutoRotoV2Schema, parseNativeAutoRotoV2, parseRotoV2Request, ROTO_V2_DEFAULT_SETTINGS } from "./autoRotoV2Contract";
import { planRotoV2Media } from "./rotoV2Media";

const request = () => ({ sourcePath: "D:/control/source.mkv", sourceStart: 0, duration: 1.25, fps: 4, initialTime: .5,
  initialRect: { x: .25, y: .25, width: .5, height: .55 }, sourceColor: "rec709-rgb8", maxDimension: 64, edgeSettings: { ...ROTO_V2_DEFAULT_SETTINGS } });
const probe = () => ({ format: { duration: "1.25" }, streams: [{ codec_type: "audio", index: 0 },
  { codec_type: "video", index: 1, width: 32, height: 24, sample_aspect_ratio: "1:1", color_transfer: "bt709", pix_fmt: "bgr0" }] });
describe("explicit diagnostic v2 native contract", () => {
  it("admits the actual compiled native CLI fixture with an independently specified grid/hash", () => {
    const n = fixture.native;
    expect(parseNativeAutoRotoV2(n, { width: 32, height: 24, frameCount: 5, fps: 4, initialFrame: 2, rawSha256: n.sourceRawSha256 })).toEqual(n);
  });
  it.each(["schema", "engine", "quality", "model", "counter", "frame", "time", "path", "bytes", "raw", "format", "fallback", "settings", "precision", "coverage", "count"])("rejects changed native %s", kind => {
    const v = structuredClone(fixture.native) as unknown as Record<string, any>;
    if (kind === "schema") v.schema = "editkin.auto-roto-matte/v1";
    if (kind === "engine") v.engine = "sam";
    if (kind === "quality") v.qualityState = "passed";
    if (kind === "model") v.onnxPack = {};
    if (kind === "counter") v.frames[0].manualPixelsRestored = 769;
    if (kind === "frame") v.frames[0].frame = 1;
    if (kind === "time") v.frames[1].time += .1;
    if (kind === "path") v.frames[0].alphaPath = "../outside.png";
    if (kind === "bytes") v.alphaBytes--;
    if (kind === "raw") v.straightRgbBytes += 3;
    if (kind === "format") v.alphaFormat = "gray";
    if (kind === "fallback") v.coarseRouting.deterministicFallback = true;
    if (kind === "settings") v.frames[0].edgeRefinement.settings.bandRadius++;
    if (kind === "precision") v.frames[0].edgeRefinement.alphaPrecision = "float-solve-to-unorm8";
    if (kind === "coverage") v.frames[0].edgeRefinement.solvedPixels++;
    if (kind === "count") v.frames.pop();
    expect(() => nativeAutoRotoV2Schema.parse(v)).toThrow();
  });
  it("refuses a different expected raster/source even if the receipt is internally consistent", () => {
    const n = fixture.native;
    expect(() => parseNativeAutoRotoV2(n, { width: 32, height: 24, frameCount: 5, fps: 4, initialFrame: 2, rawSha256: "0".repeat(64) })).toThrow("EXPECTED");
  });
  it.each(["sam", "rect", "future", "frames", "brush", "radius"])("refuses request %s before child work", kind => {
    const v = request() as Record<string, any>;
    if (kind === "sam") v.model = "sam";
    if (kind === "rect") v.initialRect.x = .8;
    if (kind === "future") v.initialTime = 10;
    if (kind === "frames") v.fps = 60, v.duration = 120;
    if (kind === "brush") v.corrections = [{ id: "big", frame: 0, mode: "foreground", radius: .1, points: new Array(4097) }];
    if (kind === "radius") v.edgeSettings.localRadius = 1;
    expect(() => parseRotoV2Request(v)).toThrow();
  });
});
describe("actual stream/display raster and declared sample grid", () => {
  it("skips audio and cover art, preserving source stream index and exact frame count", () => {
    const p = probe(); p.streams.unshift({ codec_type: "video", index: 7, width: 320, height: 320, disposition: { attached_pic: 1 } } as any);
    const result = planRotoV2Media(p, parseRotoV2Request(request()));
    expect(result).toMatchObject({ width: 32, height: 24, frameCount: 5, rawBytes: 11520, videoStreamIndex: 1, hasAudio: true, initialFrame: 2 });
  });
  it("normalizes quarter-turns and SAR onto the same bilinear even raster as the label kit", () => {
    const p = probe(); Object.assign(p.streams[1], { sample_aspect_ratio: "2:1", tags: { rotate: "90" } });
    expect(planRotoV2Media(p, parseRotoV2Request(request()))).toMatchObject({ width: 24, height: 64, sourceDisplayWidth: 24, sourceDisplayHeight: 64 });
  });
  it.each(["hdr", "srgb", "alpha", "float", "range", "rotation", "memory", "audio"])("refuses media %s", kind => {
    const p = probe(), r = request();
    if (kind === "hdr") p.streams[1].color_transfer = "arib-std-b67";
    if (kind === "srgb") p.streams[1].color_transfer = "iec61966-2-1";
    if (kind === "alpha") p.streams[1].pix_fmt = "gbrap16le";
    if (kind === "float") p.streams[1].pix_fmt = "gbrpf32le";
    if (kind === "range") r.duration = 2;
    if (kind === "rotation") Object.assign(p.streams[1], { tags: { rotate: "45" } });
    if (kind === "memory") Object.assign(p, { format: { duration: "120" } }), Object.assign(p.streams[1], { width: 1920, height: 1080 }), Object.assign(r, { maxDimension: 1920, fps: 30, duration: 20 });
    if (kind === "audio") p.streams.pop();
    expect(() => planRotoV2Media(p, parseRotoV2Request(r))).toThrow();
  });
});
