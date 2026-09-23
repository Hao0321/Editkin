import { describe, expect, it } from "vitest";
import { applyCommand } from "./commands";
import { createEmptyProject, validateProject } from "./editGraph";
import { createClipMask, resolveMaskPath } from "./masks";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type MotionTrack, type TimelineClip } from "./types";
import { compileClipAlphaPlan } from "./clipAlphaPlan";
import { createHistory, dispatchCommand, dispatchCommandSafely, redo, undo } from "./history";
import { motionTrackPoseAt } from "./motionTrackSampling";
import { createProductAutoRotoRouteReceipt } from "../application/autoRotoProductContract";
import { parseProject, readProjectFile, writeProjectFileAtomic } from "../application/projectFiles";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fixture() {
  const project = createEmptyProject("Clip slicing", { id: "slice-project", width: 1920, height: 1080, fps: 30 });
  project.assets.push({ id: "media", name: "Media", kind: "video", uri: "media.mp4", duration: 40 });
  project.tracks[0].clips.push({
    id: "clip", assetId: "media", trackId: project.tracks[0].id, timelineStart: 10, sourceStart: 20,
    duration: 10, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
    masks: [createClipMask("subject", "subject")],
  });
  return validateProject(project);
}

function maskOf(project: EditProject, index = 0) { return project.tracks[0].clips[index].masks![0]; }

function trackedFixture(fps = 30, bindMask = true) {
  const project = fixture();
  project.fps = fps;
  const track: MotionTrack = {
    id: "track", clipId: "clip", name: "Subject", engine: "template_match", analysisFps: 15,
    initialRect: { x: .1, y: .2, width: .2, height: .3 }, lostRatio: .25, createdAt: "2026-08-31T00:00:00Z",
    points: [
      { frame: 0, time: 0, status: "tracked" as const },
      { frame: 59, time: 59 / 15, status: "lost" as const },
      { frame: 62, time: 62 / 15, status: "tracked" as const },
      { frame: 150, time: 10, status: "manual" as const },
    ].map((sample, index) => ({
      ...sample, rect: { x: .1 + index * .1, y: .2, width: .2, height: .3 }, confidence: sample.status === "lost" ? .1 : .9,
      rotationDegrees: index * 5, scale: 1 + index * .1, activity: index * .2,
      quad: [{ x: .1 + index * .1, y: .2 }, { x: .3 + index * .1, y: .2 }, { x: .3 + index * .1, y: .5 }, { x: .1 + index * .1, y: .5 }],
    })),
  };
  project.motionTracks = [track];
  if (bindMask) maskOf(project).trackId = track.id;
  return validateProject(project);
}

function assertMaskFrameParity(before: EditProject, after: EditProject, offsets: number[]) {
  const source = before.tracks[0].clips[0];
  after.tracks[0].clips.forEach((clip, index) => {
    for (let frame = 0; frame <= Math.round(clip.duration * after.fps); frame++) {
      const localTime = frame / after.fps;
      expect(resolveMaskPath(after, clip, clip.masks![0], localTime), `clip=${clip.id}, frame=${frame}`)
        .toEqual(resolveMaskPath(before, source, source.masks![0], offsets[index] + localTime));
    }
  });
}

function withMatte(): EditProject {
  const project = fixture();
  const mask = maskOf(project);
  const digest = "a".repeat(64);
  const root = `C:/Editkin/cache/auto-roto-product/${digest}`;
  const frameCount = 120;
  mask.frozenRange = { fromFrame: 30, toFrame: 240 };
  mask.matteSequence = {
    schema: "editkin.auto-roto-matte/v1", engine: "editkin-native-color-temporal-roto/v1",
    width: 16, height: 16, analysisFps: 12, frameCount, sequenceUri: `${root}/matte-sequence.alpha8`,
    sequenceSha256: digest, sequenceBytes: 16 * 16 * frameCount, manifestUri: `${root}/matte-manifest.json`,
    framePreviewUris: Array.from({ length: frameCount }, (_, index) => `asset://localhost/${digest}/${index}`),
    frameArtifactUris: Array.from({ length: frameCount }, (_, index) => `${root}/frame-${String(index).padStart(6, "0")}.png`),
    meanBoundaryChatter: .02, correctionStrokesApplied: 2, correctedFrames: [24, 60],
    regionMemoryRouting: { schema: "editkin.region-memory-routing/v1", requested: "fixed_baseline", executed: "fixed_baseline", candidateAttempted: false, deterministicFallback: false },
    alphaRefinement: {
      schema: "editkin.optical-alpha-refinement-aggregate/v1", engine: "editkin-self-authored-optical-alpha-refiner/v1",
      appliedFrames: frameCount, radius: 4, backgroundThreshold: .2, foregroundThreshold: .8, coarseWeight: .5,
      temporalStability: .5, temporalGate: .5, changedPixels: 10, fractionalPixels: 20, solvedPixels: 10, meanSolveConfidence: .8,
    },
    routeReceipt: createProductAutoRotoRouteReceipt(), frozen: true, qualityState: "diagnostic",
  };
  mask.rotoCorrections = [23, 24, 47, 48, 60, 84, 107, 108, 119].map((frame) => ({
    id: `stroke-${frame}`, frame, mode: "foreground", radius: .02, points: [{ x: .3, y: .4 }],
  }));
  return validateProject(project);
}

function split(project: EditProject, at = 14 + 1 / 30) {
  return applyCommand(project, { type: "split_clip", clipId: "clip", at, newClipId: "right" });
}

function rejectsWithoutMutation(project: EditProject, command: Parameters<typeof applyCommand>[1], message: RegExp) {
  const before = structuredClone(project);
  const history = createHistory(project);
  const result = dispatchCommandSafely(history, command);
  expect(result.error).toMatch(message);
  expect(result.state).toBe(history);
  expect(project).toEqual(before);
}

describe("mask-safe clip slicing", () => {
  it("splits a legal subject mask into independent globally unique masks", () => {
    const original = fixture();
    const result = applyCommand(original, { type: "split_clip", clipId: "clip", at: 14, newClipId: "right" });
    const [left, right] = result.tracks[0].clips;
    expect([left.duration, right.duration, right.sourceStart, right.timelineStart]).toEqual([4, 6, 24, 14]);
    expect(left.masks![0].id).not.toBe(right.masks![0].id);
    expect(left.masks![0]).not.toBe(right.masks![0]);
    expect(right.masks![0].path).toEqual(original.tracks[0].clips[0].masks![0].path);
    expect(() => validateProject(result)).not.toThrow();
  });

  it("smart-cuts legal subject masks with nonzero source and keep-range starts", () => {
    const result = applyCommand(fixture(), {
      type: "smart_cut_clip", clipId: "clip", keepRanges: [{ start: 2, end: 4 }, { start: 7, end: 9 }], segmentIds: ["clip", "right"],
    });
    expect(result.tracks[0].clips.map((clip) => [clip.timelineStart, clip.sourceStart, clip.duration])).toEqual([[10, 22, 2], [12, 27, 2]]);
    expect(new Set(result.tracks[0].clips.map((clip) => clip.masks![0].id)).size).toBe(2);
    expect(() => validateProject(result)).not.toThrow();
  });

  it("preserves animated nearest mask observations on every project frame across a non-aligned split", () => {
    const original = fixture();
    const mask = maskOf(original);
    mask.keyframes = [0, 3, 5, 10].map((time, index) => ({
      time, frame: time * original.fps, confidence: .5 + index * .1, status: index === 1 ? "lost" : "manual",
      points: mask.path.map((point) => ({ ...point, x: point.x * (.6 + index * .1) })),
    }));
    const result = split(original);
    assertMaskFrameParity(original, result, [0, 121 / 30]);
    result.tracks[0].clips.forEach((clip) => {
      expect(clip.masks![0].keyframes.every((keyframe) => keyframe.frame === Math.round(keyframe.time * result.fps))).toBe(true);
    });
  });

  it.each([30, 60, 120])("preserves nearest tracked mask paths, lost/reacquired spans, quad and binding at %i FPS", (fps) => {
    const original = trackedFixture(fps);
    const offset = Math.round((4 + 1 / 30) * fps) / fps;
    const result = split(original, 10 + offset);
    assertMaskFrameParity(original, result, [0, offset]);
    expect(new Set(result.motionTracks.map((track) => track.id)).size).toBe(2);
    result.tracks[0].clips.forEach((clip) => {
      const track = result.motionTracks.find((item) => item.id === clip.masks![0].trackId)!;
      expect(track.clipId).toBe(clip.id);
      expect(track.analysisFps).toBe(fps);
      expect(track.points.every((point) => point.frame === Math.round(point.time * fps))).toBe(true);
      expect(track.points.every((point) => point.quad?.length === 4 && point.rotationDegrees !== undefined && point.scale !== undefined)).toBe(true);
    });
  });

  it("keeps nearest boundary observations when a retained interval contains no original samples", () => {
    const original = trackedFixture();
    const result = applyCommand(original, { type: "smart_cut_clip", clipId: "clip", keepRanges: [{ start: 7, end: 8 }], segmentIds: ["clip"] });
    assertMaskFrameParity(original, result, [7]);
    expect(result.motionTracks[0].points.length).toBeGreaterThan(0);
  });

  it("retains actual frame-weighted lost coverage instead of counting compressed hold endpoints", () => {
    const original = trackedFixture();
    const tracked = original.motionTracks[0].points[0];
    original.motionTracks[0].points = [
      { ...structuredClone(tracked), frame: 0, time: 0, status: "lost" },
      { ...structuredClone(tracked), frame: 135, time: 9, status: "lost" },
      { ...structuredClone(tracked), frame: 150, time: 10, status: "tracked" },
    ];
    const result = applyCommand(original, { type: "trim_clip_start", clipId: "clip", seconds: 1 });
    const count = Math.round(result.tracks[0].clips[0].duration * result.fps) + 1;
    const lost = Array.from({ length: count }, (_, frame) => resolveMaskPath(original, original.tracks[0].clips[0], maskOf(original), 1 + frame / result.fps))
      .filter((sample) => sample.status === "lost").length;
    expect(result.motionTracks[0].points.length).toBe(count);
    expect(result.motionTracks[0].lostRatio).toBe(lost / count);
    expect(result.motionTracks[0].lostRatio).toBeGreaterThan(.9);
  });

  it("retains empty tracks and their lost mask bindings instead of dropping the mask", () => {
    const original = trackedFixture();
    original.motionTracks[0].points = [];
    const result = split(original, 14);
    assertMaskFrameParity(original, result, [0, 4]);
    expect(result.motionTracks).toHaveLength(2);
    expect(result.motionTracks.every((track) => track.points.length === 0)).toBe(true);
  });

  it("preserves the linear/held tracking consumer at project frames for tracks not bound to masks", () => {
    const original = trackedFixture(30, false);
    const result = split(original);
    result.tracks[0].clips.forEach((clip, index) => {
      const track = result.motionTracks.find((item) => item.clipId === clip.id)!;
      for (let frame = 0; frame <= Math.round(clip.duration * result.fps); frame++) {
        const time = frame / result.fps;
        const expected = motionTrackPoseAt(original.motionTracks[0], (index ? 121 / 30 : 0) + time);
        const actual = motionTrackPoseAt(track, time);
        if (!expected) expect(actual).toBeUndefined();
        else {
          expect(actual?.status).toBe(expected.status);
          expect(actual?.confidence).toBeCloseTo(expected.confidence, 10);
          expect(actual?.rotationDegrees).toBeCloseTo(expected.rotationDegrees, 10);
          expect(actual?.scale).toBeCloseTo(expected.scale, 10);
          for (const axis of ["x", "y", "width", "height"] as const) expect(actual?.rect[axis]).toBeCloseTo(expected.rect[axis], 10);
        }
      }
    });
  });

  it("smart-cut tracks retain source moments after multiple removed intervals", () => {
    const original = trackedFixture();
    const result = applyCommand(original, { type: "smart_cut_clip", clipId: "clip", keepRanges: [{ start: 2, end: 4 }, { start: 7, end: 9 }], segmentIds: ["clip", "right"] });
    assertMaskFrameParity(original, result, [2, 7]);
  });

  it.each(["trim_clip_start", "trim_clip_end"] as const)("%s uses the same mask/track time mapping", (type) => {
    const original = trackedFixture();
    const result = applyCommand(original, { type, clipId: "clip", seconds: 2 + 1 / 30 });
    assertMaskFrameParity(original, result, [type === "trim_clip_start" ? 61 / 30 : 0]);
    expect(() => parseProject(result)).not.toThrow();
  });

  it("preserves full native matte receipt/inventory, crops authored correction time, and fails closed", () => {
    const original = withMatte();
    expect(() => compileClipAlphaPlan(original, original.tracks[0].clips[0], "formal")).not.toThrow();
    const result = applyCommand(original, { type: "smart_cut_clip", clipId: "clip", keepRanges: [{ start: 2, end: 4 }, { start: 7, end: 9 }], segmentIds: ["clip", "right"] });
    expect(maskOf(result).frozenRange).toEqual({ fromFrame: 0, toFrame: 60 });
    expect(maskOf(result, 1).frozenRange).toEqual({ fromFrame: 0, toFrame: 30 });
    expect(maskOf(result).rotoCorrections?.map((stroke) => [stroke.id, stroke.frame])).toEqual([["stroke-24", 0], ["stroke-47", 23]]);
    expect(maskOf(result, 1).rotoCorrections?.map((stroke) => [stroke.id, stroke.frame])).toEqual([["stroke-84", 0], ["stroke-107", 23]]);
    result.tracks[0].clips.forEach((clip) => {
      expect(clip.masks![0].matteSequence).toEqual({ ...maskOf(original).matteSequence, stale: true, staleReason: "clip-time-range-changed" });
      expect(clip.masks![0].enabled).toBe(true);
      expect(clip.masks![0].path).toEqual(maskOf(original).path);
      for (const purpose of ["preview", "formal"] as const) expect(() => compileClipAlphaPlan(result, clip, purpose)).toThrow(/過期/);
    });
    expect(() => parseProject(JSON.parse(JSON.stringify(result)))).not.toThrow();
  });

  it("maps non-analysis-aligned correction frames without an exclusive frameCount endpoint", () => {
    const original = withMatte();
    const result = split(original);
    result.tracks[0].clips.forEach((clip) => {
      expect(clip.masks![0].rotoCorrections!.every((stroke) => stroke.frame >= 0 && stroke.frame < Math.ceil(clip.duration * 12))).toBe(true);
    });
    expect(maskOf(result).rotoCorrections?.find((stroke) => stroke.id === "stroke-48")?.frame).toBe(48);
    expect(maskOf(result, 1).rotoCorrections?.find((stroke) => stroke.id === "stroke-60")?.frame).toBe(12);
  });

  it("uses min(12, projectFPS) for editable corrections without a matte", () => {
    const original = fixture();
    original.fps = 6;
    maskOf(original).rotoCorrections = [{ id: "stroke", frame: 18, mode: "background", radius: .1, points: [{ x: .2, y: .3 }] }];
    const result = applyCommand(original, { type: "trim_clip_start", clipId: "clip", seconds: 2 });
    expect(maskOf(result).rotoCorrections![0].frame).toBe(6);
  });

  it("keeps a frozen invalidation anchor even when the kept interval misses the original frozen range", () => {
    const original = withMatte();
    maskOf(original).frozenRange = { fromFrame: 0, toFrame: 30 };
    const result = applyCommand(original, { type: "trim_clip_start", clipId: "clip", seconds: 7 });
    expect(maskOf(result).frozenRange).toEqual({ fromFrame: 0, toFrame: 0 });
    expect(maskOf(result).matteSequence?.stale).toBe(true);
    expect(() => compileClipAlphaPlan(result, result.tracks[0].clips[0])).toThrow(/過期/);
  });

  it("does not invalidate full-range no-op cuts or clear a preexisting stale reason", () => {
    const original = withMatte();
    const full = applyCommand(original, { type: "smart_cut_clip", clipId: "clip", keepRanges: [{ start: 0, end: 10 }], segmentIds: ["clip"] });
    expect(maskOf(full).matteSequence).toEqual(maskOf(original).matteSequence);
    const sliced = split(original);
    const again = applyCommand(sliced, { type: "trim_clip_end", clipId: "right", seconds: 1 });
    expect(maskOf(again, 1).matteSequence?.staleReason).toBe("clip-time-range-changed");
    expect(maskOf(again, 1).matteSequence?.sequenceSha256).toBe(maskOf(original).matteSequence?.sequenceSha256);
  });

  it("resolves preexisting generated-ID collisions and repeated splits without aliasing mask/track state", () => {
    const original = trackedFixture();
    const unrelated: TimelineClip = { ...structuredClone(original.tracks[0].clips[0]), id: "other", timelineStart: 30, masks: [createClipMask("subject-right", "subject")] };
    original.tracks[0].clips.push(unrelated);
    original.motionTracks.push({ ...structuredClone(original.motionTracks[0]), id: "track-right", clipId: "other" });
    const once = split(original, 14);
    const result = applyCommand(once, { type: "split_clip", clipId: "right", at: 16, newClipId: "third" });
    const masks = result.tracks[0].clips.flatMap((clip) => clip.masks!);
    expect(new Set(masks.map((mask) => mask.id)).size).toBe(4);
    expect(new Set(result.motionTracks.map((track) => track.id)).size).toBe(4);
    expect(result.tracks[0].clips[1].masks![0].id).toBe("subject-right-2");
    result.tracks[0].clips[1].masks![0].path[0].x = .987;
    expect(result.tracks[0].clips[0].masks![0].path[0].x).not.toBe(.987);
    expect(original.tracks[0].clips[0].masks![0].path[0].x).not.toBe(.987);
  });

  it("rejects unsafe linked-graphic slicing without any project/history mutation but allows a full-range no-op", () => {
    const original = trackedFixture();
    original.motionGraphics.push({
      schema: "hao.motion-composition/v1", id: "label", name: "Tracked label", kind: "tag", text: "Tracked label",
      timelineStart: 10, duration: 10, x: .5, y: .5, width: .2, fontSize: 42, textColor: "#ffffff",
      backgroundColor: "#000000", accentColor: "#00ff00", animation: "fade", offsetX: 0, offsetY: 0, trackId: "track",
    });
    expect(() => parseProject(original)).not.toThrow();
    rejectsWithoutMutation(original, { type: "split_clip", clipId: "clip", at: 14, newClipId: "right" }, /動畫時鐘.*先完成剪輯再追蹤/);
    const unchanged = applyCommand(original, { type: "smart_cut_clip", clipId: "clip", keepRanges: [{ start: 0, end: 10 }], segmentIds: ["clip"] });
    expect(unchanged.motionTracks).toEqual(original.motionTracks);
    expect(unchanged.motionGraphics).toEqual(original.motionGraphics);
  });

  it("rejects >120FPS tracked slices atomically, but not static masks", () => {
    const original = trackedFixture(240);
    rejectsWithoutMutation(original, { type: "split_clip", clipId: "clip", at: 14, newClipId: "right" }, /120 FPS/);
    const unchanged = applyCommand(original, { type: "smart_cut_clip", clipId: "clip", keepRanges: [{ start: 0, end: 10 }], segmentIds: ["clip"] });
    expect(unchanged.motionTracks).toEqual(original.motionTracks);
    original.motionTracks = [];
    delete maskOf(original).trackId;
    expect(() => split(original, 14)).not.toThrow();
  });

  it("rejects oversized sampling plans before changing any state", () => {
    const original = trackedFixture(120);
    original.assets[0].duration = 2020;
    original.tracks[0].clips[0].duration = 2000;
    rejectsWithoutMutation(original, { type: "split_clip", clipId: "clip", at: 14, newClipId: "right" }, /100,000.*安全上限/);
  });

  it("rejects non-monotonic authored keyframe times instead of silently sampling the wrong geometry", () => {
    const original = fixture();
    maskOf(original).keyframes = [2, 1].map((time, frame) => ({ frame, time, confidence: 1, status: "manual", points: structuredClone(maskOf(original).path) }));
    rejectsWithoutMutation(original, { type: "split_clip", clipId: "clip", at: 14, newClipId: "right" }, /關鍵幀時間未遞增/);
  });

  it("applies a masked Smart Cut inside one real batch with one Undo and no partial command loss", () => {
    const original = trackedFixture();
    const history = dispatchCommand(createHistory(original), { type: "batch", commands: [
      { type: "smart_cut_clip", clipId: "clip", keepRanges: [{ start: 2, end: 4 }, { start: 7, end: 9 }], segmentIds: ["clip", "right"] },
      { type: "add_caption", caption: { id: "caption", text: "New subtitle", start: 10, duration: 1 } },
    ] });
    expect(history.past).toHaveLength(1);
    expect(history.present.captions[0].text).toBe("New subtitle");
    assertMaskFrameParity(original, history.present, [2, 7]);
    expect(undo(history).present).toEqual(original);
  });

  it.each(["split_clip", "trim_clip_start", "trim_clip_end"] as const)("rejects invalid %s boundaries without mutation", (type) => {
    const original = trackedFixture();
    const command = type === "split_clip" ? { type, clipId: "clip", at: 10, newClipId: "right" } : { type, clipId: "clip", seconds: 10 };
    rejectsWithoutMutation(original, command, /內部|小於片段時長/);
  });

  it("retains no-mask split/trim control behavior", () => {
    const original = fixture();
    delete original.tracks[0].clips[0].masks;
    const result = split(original, 14);
    expect(result.tracks[0].clips.every((clip) => clip.masks === undefined)).toBe(true);
    expect(result.motionTracks).toEqual([]);
    expect(result.tracks[0].clips.map((clip) => clip.duration)).toEqual([4, 6]);
  });

  it("Undo restores complete original masks/tracks/receipts; Redo and disk reopen keep the sliced graph", async () => {
    const original = withMatte();
    original.motionTracks = trackedFixture().motionTracks;
    maskOf(original).trackId = "track";
    const history = dispatchCommand(createHistory(original), { type: "split_clip", clipId: "clip", at: 14, newClipId: "right" });
    expect(undo(history).present).toEqual(original);
    const reapplied = redo(undo(history));
    expect(reapplied.present).toEqual(history.present);
    const directory = await mkdtemp(join(tmpdir(), "editkin-clip-slice-test-"));
    try {
      const path = join(directory, "project.editkin");
      await writeProjectFileAtomic(path, reapplied.present);
      const reopened = await readProjectFile(path);
      expect(reopened.motionTracks).toEqual(history.present.motionTracks);
      expect(reopened.tracks[0].clips.map((clip) => clip.masks?.[0].id)).toEqual(history.present.tracks[0].clips.map((clip) => clip.masks?.[0].id));
      reopened.tracks[0].clips.forEach((clip) => {
        expect(clip.masks![0].matteSequence?.staleReason).toBe("clip-time-range-changed");
        expect(clip.masks![0].matteSequence?.routeReceipt).toEqual(maskOf(original).matteSequence?.routeReceipt);
        expect(() => compileClipAlphaPlan(reopened, clip, "formal")).toThrow(/過期/);
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
