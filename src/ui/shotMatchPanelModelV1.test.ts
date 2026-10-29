import { expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { shotGradeLocalRequestV1Schema } from "../application/shotGradeLocalContractV1";
import { regionFromShotMatchPixelsV1, replaceShotMatchMarkV1, shotMatchPanelRequestV1, shotMatchReferenceStripV1, validateShotMatchFramesV1,
  type ShotMatchDraftV1, type ShotMatchFramesV1, type ShotMatchHostV1 } from "./shotMatchPanelModelV1";

function fixture() {
  const project = createDemoProject(), clip = project.tracks[0].clips[0]; clip.timelineStart = 1; clip.duration = .6;
  project.tracks[0].clips.unshift({ ...structuredClone(clip), id: "previous", timelineStart: 0 });
  const host: ShotMatchHostV1 = { projectOwner: {}, contentOwner: {}, sessionId: 1, project, targetClipId: clip.id, editable: true,
    readFrames: async () => { throw Error("not used"); }, prepare: async () => { throw Error("not used"); } };
  const frames = (id = clip.id): ShotMatchFramesV1 => ({ clipId: id, assetId: clip.assetId, sourceSha256: "a".repeat(64), opaque: true,
    frames: [{ sampleId: "kf-1", timeSeconds: .1, width: 4, height: 2, format: "rgb8", workingSpace: "rec709_display", stage: "clip_working_post_v2", pixels: new Uint8Array(24).fill(100) }] });
  const draft: ShotMatchDraftV1 = { referenceClipId: "previous", targetRegions: [], referenceRegions: [], destination: { kind: "append", label: "對色" } };
  return { project, clip, host, frames, draft };
}
it("defaults to the previous same-track video and preserves authored names, allowing read-only references", () => {
  const f = fixture(); f.project.tracks[0].locked = false;
  expect(shotMatchReferenceStripV1(f.host).previousClipId).toBe("previous"); expect(shotMatchReferenceStripV1(f.host).clips[0].name).toBe(f.project.assets[0].name);
  f.host.targetClipId = "previous"; expect(shotMatchReferenceStripV1(f.host).previousClipId).toBeUndefined();
});
it("validates and clones bounded exact local post-grade frames without inventing regions", () => {
  const f = fixture(), input = f.frames(), output = validateShotMatchFramesV1(input, f.project, f.clip.id); expect(output).toEqual(input); expect(output.frames[0].pixels).not.toBe(input.frames[0].pixels);
  const request = shotMatchPanelRequestV1(f.host, f.draft, input, f.frames("previous"), "shot_match"); expect(shotGradeLocalRequestV1Schema.parse(request).target.regions).toEqual([]);
  expect(request).toMatchObject({ expectedRevision: f.project.revision, reference: { clipId: "previous" }, roiBasis: "local-layer-raster-normalized" });
});
it("auto balance has no invented reference and legacy omitted management uses the existing default", () => {
  const f = fixture(); delete f.project.colorManagement;
  const request = shotMatchPanelRequestV1(f.host, f.draft, f.frames(), undefined, "auto_balance"); expect("reference" in request).toBe(false); expect(shotGradeLocalRequestV1Schema.safeParse(request).success).toBe(true);
});
it.each(["clip", "asset", "sha", "alpha", "format", "space", "stage", "length", "duplicate", "time", "outside", "width"])("refuses mismatched %s frame data", kind => {
  const f = fixture(), input = f.frames();
  if (kind === "clip") input.clipId = "other"; if (kind === "asset") input.assetId = "other"; if (kind === "sha") input.sourceSha256 = "invalid";
  if (kind === "alpha") Object.assign(input, { opaque: false }); if (kind === "format") Object.assign(input.frames[0], { format: "rgb16" });
  if (kind === "space") input.frames[0].workingSpace = "acescct"; if (kind === "stage") input.frames[0].stage = "clip_working_pre_v2";
  if (kind === "length") input.frames[0].pixels = new Uint8Array(1); if (kind === "duplicate") input.frames.push(structuredClone(input.frames[0]));
  if (kind === "time") input.frames[0].timeSeconds = NaN; if (kind === "outside") input.frames[0].timeSeconds = f.clip.duration; if (kind === "width") input.frames[0].width = 257;
  expect(() => validateShotMatchFramesV1(input, f.project, f.clip.id)).toThrow(/FRAMES/);
});
it("maps inclusive point and drag bounds on the exact raster, including all right/bottom edges", () => {
  const frame = fixture().frames().frames[0]; expect(regionFromShotMatchPixelsV1(frame, "skin", { x: 3, y: 1 })).toEqual({ sampleId: "kf-1", role: "skin", x: .75, y: .5, width: .25, height: .5 });
  expect(regionFromShotMatchPixelsV1(frame, "neutral", { x: 3, y: 1 }, { x: 0, y: 0 })).toMatchObject({ x: 0, y: 0, width: 1, height: 1 });
  for (let width = 1; width <= 256; width++) for (let x = 0; x < width; x++) {
    const region = regionFromShotMatchPixelsV1({ ...frame, width, height: width }, "neutral", { x, y: x }, { x: width - 1, y: width - 1 });
    expect(region.x + region.width).toBeLessThanOrEqual(1); expect(region.y + region.height).toBeLessThanOrEqual(1);
  }
});
it.each([{ x: -1, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 2 }, { x: .5, y: 0 }, { x: NaN, y: 0 }])("rejects an out-of-raster coordinate $x,$y", point => {
  expect(() => regionFromShotMatchPixelsV1(fixture().frames().frames[0], "skin", point)).toThrow(/FRAMES/);
});
it("replaces only the declared role and sample mark without creating a semantic label", () => {
  const frame = fixture().frames().frames[0], first = regionFromShotMatchPixelsV1(frame, "neutral", { x: 0, y: 0 }), skin = regionFromShotMatchPixelsV1(frame, "skin", { x: 3, y: 1 });
  const regions = [first, skin], next = replaceShotMatchMarkV1(regions, { ...first, width: .5 }); expect(next).toEqual([skin, { ...first, width: .5 }]); expect(regions).toEqual([first, skin]);
});
it.each(["aces", "locked", "reference", "destination", "region-sample", "region-bounds"])("refuses an inapplicable %s request", kind => {
  const f = fixture(); if (kind === "aces") f.project.colorManagement!.mode = "aces2"; if (kind === "locked") f.project.tracks[0].locked = true;
  if (kind === "reference") f.draft.referenceClipId = f.clip.id; if (kind === "destination") f.draft.destination = { kind: "replace", nodeId: "missing", label: "對色" };
  if (kind.startsWith("region")) f.draft.targetRegions = [{ sampleId: kind === "region-sample" ? "unknown" : "kf-1", role: "skin", x: 0, y: 0, width: kind === "region-bounds" ? 1.1 : .5, height: 1 }];
  expect(() => shotMatchPanelRequestV1(f.host, f.draft, f.frames(), f.frames("previous"), "shot_match")).toThrow(/SHOT_MATCH_PANEL_/);
});
