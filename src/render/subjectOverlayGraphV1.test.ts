import { describe, expect, it } from "vitest";
import { rotoProjectFixture } from "../application/__fixtures__/rotoCutoutProject.fixture";
import { subjectOverlaySourceStageV1 } from "../application/subjectOverlayProjectV1";
import { compileClipAlphaPlan } from "../domain/clipAlphaPlan";
import { DEFAULT_CHROMA_KEY, chromaKeyFfmpegFilter } from "../domain/chromaKey";
import { compositorVideoFilters } from "./ffmpegComposite";
import { aces16AlphaPlaneJoinV1 } from "./aces16AlphaPlanesV1";
import { buildSubjectOverlayGraphV1 } from "./subjectOverlayGraphV1";
import { buildSubjectStickerFiltersV1, type SubjectStickerStyleV1 } from "./subjectStickerV1";
const style: SubjectStickerStyleV1 = { schema: "editkin.subject-sticker-style/v1", borderPixels: 3, shadowSigma: 2, shadowOpacity: .4, shadowOffsetX: 4, shadowOffsetY: 3,
  popStartFrame: 0, popFrames: 12, popStartScale: .8, popOvershoot: .1, anchorX: .5, anchorY: .5 };
function fixture() { const p = rotoProjectFixture(); p.width = 320; p.height = 200; p.fps = 24; return subjectOverlaySourceStageV1(p, "selected", "sticker"); }
const probe = { duration: 4, width: 64, height: 40, encodedWidth: 64, encodedHeight: 40, hasVideo: true, hasAudio: true, sampleAspectRatio: 1 };
const native = { width: 64, height: 40, fps: 4, frameCount: 5, bits: 16 as const };
describe("existing complete-mask owner followed by native gate and frozen kernels", () => {
  it("preserves the complete original compositor and sticker graph arrays exactly", () => {
    const stage = fixture(), graph = buildSubjectOverlayGraphV1(stage, probe, native, { kind: "sticker", style });
    const original = compositorVideoFilters({ clip: stage.clip, alphaPlan: compileClipAlphaPlan(stage.project, stage.clip, "formal"), asset: stage.asset, assetPath: stage.asset.uri, inputIndex: 0, probe }, "ovBase", stage.plan, stage.project, undefined, true);
    expect(graph.originalCompositorFilters).toEqual(original); expect(graph.filters.slice(0, original.length)).toEqual(graph.bakeCompositorFilters);
    const differences = original.map((f, i) => f === graph.bakeCompositorFilters[i] ? -1 : i).filter(i => i >= 0);
    expect(differences).toHaveLength(2); expect(graph.bakeCompositorFilters).toContain(aces16AlphaPlaneJoinV1("ovBasesourcergb", "ovBasecombinedalpha", "ovBasemerged"));
    const old = buildSubjectStickerFiltersV1({ sourceRgbLabel: "ovStickerRgb", effectiveAlphaLabel: "ovStickerAlpha", outputLabel: "ovEffect", width: 320, height: 200, frameOffset: 0, style });
    expect(graph.filters.slice(-old.filters.length - 1, -1)).toEqual(old.filters); expect(graph.pixelFormat).toBe("bgra"); expect(graph.defaultEnabled).toBe(false);
    expect(graph.filters.join(";")).toContain("round=up:start_time=0:eof_action=pass"); expect(graph.existingAuthoredAlphaPlan.operations).toHaveLength(1);
  });
  it("leaves an unmasked source graph exact without introducing a second mask owner", () => {
    const stage = fixture(); stage.clip.masks = [];
    const graph = buildSubjectOverlayGraphV1(stage, probe, native, { kind: "sticker", style });
    expect(graph.bakeCompositorFilters).toEqual(graph.originalCompositorFilters); expect(graph.existingAuthoredAlphaPlan.operations).toEqual([]);
  });
  it("retains full keyer and mask execution before gating rather than replacing either", () => {
    const stage = fixture(); stage.clip.chromaKey = { ...DEFAULT_CHROMA_KEY };
    const graph = buildSubjectOverlayGraphV1(stage, probe, native, { kind: "sticker", style });
    expect(graph.existingAuthoredAlphaPlan.keyer?.enabled).toBe(true); const source = graph.originalCompositorFilters.join(";");
    expect(source).toContain(chromaKeyFfmpegFilter(DEFAULT_CHROMA_KEY, "high16")); expect(graph.filters.indexOf("[ovAuthoredAlpha][ovNativeCanvas]blend=all_expr='A*B/65535':shortest=1[ovEffectiveAlpha]")).toBeGreaterThan(graph.originalCompositorFilters.length);
  });
  it("uses a short sweep at clip-local offset and transparent integer padding without resetting pose time", () => {
    const stage = fixture(), graph = buildSubjectOverlayGraphV1(stage, probe, native, { kind: "sheen", style: { schema: "editkin.subject-sheen-style/v1", angleDegrees: 35, bandWidthRatio: .28, intensity: .7 }, range: { startFrame: 55, endFrame: 73 } });
    expect(graph.activeFrames).toBe(18); expect(graph.frames).toBe(30); expect(graph.pixelFormat).toBe("gbrap16le");
    expect(graph.filters.join(";")).toContain("trim=start_frame=7:end_frame=25"); expect(graph.filters.join(";")).toContain("tpad=start=7:stop=5");
  });
  it.each([[47, 60], [50, 80], [50, 52]])("refuses uncovered sweep %j..%j", (startFrame, endFrame) => {
    expect(() => buildSubjectOverlayGraphV1(fixture(), probe, native, { kind: "sheen", style: { schema: "editkin.subject-sheen-style/v1", angleDegrees: 35, bandWidthRatio: .28, intensity: .7 }, range: { startFrame, endFrame } })).toThrow("INTERVAL");
  });
  it("refuses an unneutralized or excessive private raster instead of baking pose twice", () => {
    const stage = fixture(); stage.clip.transform.opacity = .8; expect(() => buildSubjectOverlayGraphV1(stage, probe, native, { kind: "sticker", style })).toThrow("PRIVATE_STAGE");
    stage.clip.transform.opacity = 1; stage.plan.width = 8193; expect(() => buildSubjectOverlayGraphV1(stage, probe, native, { kind: "sticker", style })).toThrow("RASTER");
  });
  it.each(["x", "rotation", "scale", "mirror"])("refuses private %s pose before it could be baked twice", channel => {
    const stage = fixture(); if (channel === "x") stage.clip.transform.x = 5; if (channel === "rotation") stage.clip.transform.rotation = 7;
    if (channel === "scale") stage.clip.transform.scale = .9; if (channel === "mirror") stage.clip.transform.flipX = true;
    expect(() => buildSubjectOverlayGraphV1(stage, probe, native, { kind: "sticker", style })).toThrow("PRIVATE_STAGE");
  });
});
