import { describe, expect, it } from "vitest";
import { parseRotoHoldoutKitV1, parseRotoHoldoutRequestV1, parseRotoHoldoutReviewV1, planRotoHoldoutClipV1,
  rotoHoldoutFramePathV1, rotoHoldoutReviewTemplateV1, type RotoHoldoutKitV1 } from "./rotoHoldoutLabelKitV1";
const request = () => ({ schema: "editkin.roto-holdout-label-request/v1", datasetId: "holdout", candidate: { engine: "instrument", artifacts: [{ id: "implementation", path: "D:/candidate.bin", sha256: "a".repeat(64) }] },
  clips: [{ id: "clip-a", sourcePath: "D:/source.mp4", sourceSha256: "b".repeat(64), sourceStart: 1, duration: 2, categories: ["hair-fur"] }] });
const probe = { duration: 4, width: 1920, height: 1080, hasVideo: true, hasAudio: false, sampleAspectRatio: 1, displayRotationDegrees: 0 };
function kit(): RotoHoldoutKitV1 {
  const r = parseRotoHoldoutRequestV1(request()), p = planRotoHoldoutClipV1(r, 0, probe), { selectedFrames, ...rest } = p;
  return { schema: "editkin.roto-holdout-label-kit/v1", datasetId: r.datasetId, frozenAt: "2026-10-16T00:00:00.000Z", status: "AWAITING_HUMAN_LABELS", sampleMode: r.sampleMode,
    candidate: { engine: r.candidate.engine, artifacts: r.candidate.artifacts.map(a => ({ ...a, bytes: 1 })), implementationSha256: "c".repeat(64) },
    samplingConvention: "ffmpeg-autorotate-fps-even-display-fit/v1", sampleTimeKind: "analysis-grid-not-decoder-pts",
    clips: [{ ...rest, source: { path: "D:/source.mp4", sha256: "b".repeat(64), bytes: 1 }, samples: selectedFrames.map(frame => ({ frame,
      timeSeconds: p.sourceStart + frame / p.analysisFps, framePath: rotoHoldoutFramePathV1(p.id, frame, "frames"), frameSha256: "d".repeat(64),
      maskPath: rotoHoldoutFramePathV1(p.id, frame, "labels"), blankMaskSha256: "e".repeat(64) })) }] };
}
const review = (k: RotoHoldoutKitV1) => ({ schema: "editkin.roto-holdout-human-review/v1", kitSha256: "f".repeat(64), reviewerIdHash: "9".repeat(64), reviewedAt: "2026-10-16T00:01:00.000Z",
  entries: k.clips.flatMap(c => c.samples.map(s => ({ clipId: c.id, frame: s.frame, approved: true, maskSha256: "e".repeat(64), allBackgroundConfirmed: false, tracking: null as unknown }))) });
describe("holdout planning and human review boundaries", () => {
  it("plans five distinct points on the declared grid without claiming decoder PTS", () => {
    const r = parseRotoHoldoutRequestV1(request()), p = planRotoHoldoutClipV1(r, 0, probe);
    expect(p).toMatchObject({ width: 480, height: 270, frameCount: 24, selectedFrames: [0, 6, 12, 17, 23] });
    expect(parseRotoHoldoutKitV1(kit()).sampleTimeKind).toBe("analysis-grid-not-decoder-pts");
  });
  it.each([90, 270, -90])("honours upright geometry at rotation %s", angle => {
    expect(planRotoHoldoutClipV1(parseRotoHoldoutRequestV1(request()), 0, { ...probe, displayRotationDegrees: angle })).toMatchObject({ width: 270, height: 480 });
  });
  it("accounts for non-square sample aspect", () => {
    expect(planRotoHoldoutClipV1(parseRotoHoldoutRequestV1(request()), 0, { ...probe, width: 720, height: 576, sampleAspectRatio: 16 / 15 })).toMatchObject({ width: 480, height: 360 });
  });
  it("offers complete contiguous samples separately", () => {
    const r = parseRotoHoldoutRequestV1({ ...request(), sampleMode: "contiguous" });
    expect(planRotoHoldoutClipV1(r, 0, probe).selectedFrames).toEqual(Array.from({ length: 24 }, (_, n) => n));
  });
  it.each(["../bad", "a/b", "A", "nul", "con", "com1", "lpt0", "", "x".repeat(65)])("refuses unsafe ID %s", id => {
    expect(() => parseRotoHoldoutRequestV1({ ...request(), datasetId: id })).toThrow();
  });
  it.each(["enabled", "humanApproved", "model", "sourceTrainingConsent"]) ("refuses unknown request field %s", key => {
    expect(() => parseRotoHoldoutRequestV1({ ...request(), [key]: true })).toThrow();
  });
  it("rejects duplicate clip identity and repeated original footage", () => {
    const r = request(); r.clips.push({ ...r.clips[0] }); expect(() => parseRotoHoldoutRequestV1(r)).toThrow();
    r.clips[1].id = "other"; expect(() => parseRotoHoldoutRequestV1(r)).toThrow(/Duplicate source/);
  });
  it.each([{ duration: .1 }, { sourceStart: 3 }, { analysisFps: 13 }])("rejects invalid sampling %o", change => {
    const input = request(), r = { ...input, clips: [{ ...input.clips[0], ...change }] };
    expect(() => planRotoHoldoutClipV1(parseRotoHoldoutRequestV1(r), 0, probe)).toThrow();
  });
  it.each([{ hasVideo: false }, { displayRotationDegrees: 12 }, { sampleAspectRatio: 0 }, { duration: Number.NaN }, { width: 0 }, { videoStreamIndex: -1 }])("rejects unsupported probe %o", change => {
    expect(() => planRotoHoldoutClipV1(parseRotoHoldoutRequestV1(request()), 0, { ...probe, ...change })).toThrow();
  });
  it.each(["framePath", "maskPath"]) ("rejects tampered %s", field => {
    const k = kit(); k.clips[0].samples[0][field as "framePath" | "maskPath"] = "../../escape.png"; expect(() => parseRotoHoldoutKitV1(k)).toThrow();
  });
  it("rejects clock, ordering and coverage tampering", () => {
    const a = kit(); a.clips[0].samples[0].timeSeconds += .1; expect(() => parseRotoHoldoutKitV1(a)).toThrow();
    const b = kit(); b.clips[0].samples.reverse(); expect(() => parseRotoHoldoutKitV1(b)).toThrow();
    const c = kit(); c.clips[0].samples.pop(); expect(() => parseRotoHoldoutKitV1(c)).toThrow();
  });
  it("never promotes its review template", () => {
    const k = kit(), template = rotoHoldoutReviewTemplateV1(k, "f".repeat(64));
    expect(template.entries.every(e => e.approved === false)).toBe(true);
    expect(() => parseRotoHoldoutReviewV1(template, k, "f".repeat(64), Date.parse("2026-10-16T00:02:00Z"))).toThrow();
  });
  it("accepts an explicit complete review and valid visible or lost corner labels", () => {
    const k = kit(), r = review(k);
    r.entries[0].tracking = { visibility: "visible", corners: [{ x: .1, y: .1 }, { x: .9, y: .1 }, { x: .9, y: .9 }, { x: .1, y: .9 }] };
    r.entries[1].tracking = { visibility: "lost", corners: null };
    expect(parseRotoHoldoutReviewV1(r, k, "f".repeat(64), Date.parse("2026-10-16T00:02:00Z"))).toEqual(r);
  });
  it.each(["stale", "missing", "duplicate", "future", "anonymous", "degenerate", "self-crossing"]) ("refuses %s review", kind => {
    const k = kit(), r = review(k);
    if (kind === "stale") r.kitSha256 = "0".repeat(64);
    if (kind === "missing") r.entries.pop();
    if (kind === "duplicate") r.entries[1] = r.entries[0];
    if (kind === "future") r.reviewedAt = "2026-10-17T00:00:00.000Z";
    if (kind === "anonymous") r.reviewerIdHash = "Hao";
    if (kind === "degenerate") r.entries[0].tracking = { visibility: "visible", corners: Array(4).fill({ x: .1, y: .1 }) };
    if (kind === "self-crossing") r.entries[0].tracking = { visibility: "visible", corners: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: 1, y: 0 }] };
    expect(() => parseRotoHoldoutReviewV1(r, k, "f".repeat(64), Date.parse("2026-10-16T00:02:00Z"))).toThrow();
  });
});
