import { describe, expect, it } from "vitest";
import { createEmptyProject, migrateProject, validateProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import { createHistory, dispatchCommand, dispatchCommandSafely, undo, redo } from "../domain/history";
import { editorCommandSchema } from "../domain/schema";
import { createClipMask } from "../domain/masks";
import { DEFAULT_TRANSFORM, DEFAULT_COLOR, type MotionTrackPoint } from "../domain/types";
import { createMotionGraphic } from "../motion/composition";
import { prepareStrokeAnnotationV1 } from "./strokeAnnotationV1";
import { motionTrackingSamplingV2 } from "./motionTrackingPolicyV2";
import type { MotionTrackAnalysisResult } from "./motionTracking";
import { beginMotionTrackRetrackV1, motionTrackRetrackSourceV1, prepareMotionTrackRetrackV1, motionTrackRetrackCommandV1,
  type MotionTrackRetrackJobV1 } from "./motionTrackRetrackV1";

const options = { trackId: "old", newTrackId: "new", correctedTime: 1, correctedRect: { x: .3, y: .25, width: .3, height: .4 },
  radiusSeconds: 2 / 12, createdAt: "2026-10-17T00:00:00Z" };
function fixture() {
  let p = createEmptyProject("Local retrack control", { id: "retrack-test", width: 128, height: 96, fps: 24 });
  p.assets = [{ id: "source", name: "owned original", kind: "video", uri: "D:/owned/source.mkv", duration: 2.25, width: 128, height: 96 }];
  p.tracks[0].clips = [{ id: "clip", assetId: "source", trackId: p.tracks[0].id, timelineStart: 3, sourceStart: .25, duration: 2,
    volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }];
  p.motionTracks = [{ id: "old", clipId: "clip", name: "keep original name", role: "host", engine: "hao-core-rust-motion-track-0.4-planar",
    initialRect: { x: .2, y: .2, width: .2, height: .2 }, analysisFps: 12, createdAt: options.createdAt, lostRatio: 0,
    points: Array.from({ length: 24 }, (_, frame) => ({ frame, time: frame / 12, status: "tracked", confidence: .8,
      rect: { x: .2, y: .2, width: .2, height: .2 }, rotationDegrees: 0, scale: 1,
      quad: [{ x: .2, y: .2 }, { x: .4, y: .2 }, { x: .4, y: .4 }, { x: .2, y: .4 }] })) }];
  p.motionGraphics = [createMotionGraphic("legacy", "tag", "authored", 3, 2, "old", { schema: "hao.motion-composition/v1" })];
  p.tracks[0].clips[0].masks = [{ ...createClipMask("subject", "subject"), trackId: "old", frozenRange: { fromFrame: 0, toFrame: 47 } }];
  const annotation = prepareStrokeAnnotationV1(p, { expectedRevision: p.revision, id: "stroke", name: "control", range: { startFrame: 72, endFrame: 120 },
    box: { x: 8, y: 8, width: 96, height: 56 }, geometry: { kind: "underline", start: { x: 8, y: 24 }, end: { x: 80, y: 24 } },
    inkColor: "#FFFFFF", widthPixels: 2, revealFrames: 1, purpose: "Numerical control, no art approval", evidenceRefs: ["synthetic:local-retrack"],
    tracking: { schema: "editkin.vector-tracking/v1", trackId: "old", mode: "surface", referenceTime: 0 } });
  p = applyCommand(p, annotation.command); validateProject(p); return p;
}
function native(project: ReturnType<typeof fixture>, job: MotionTrackRetrackJobV1): MotionTrackAnalysisResult {
  const { request } = motionTrackRetrackSourceV1(project, job), s = motionTrackingSamplingV2(request);
  const x = Math.round(request.initialRect.x * s.width) / s.width, y = Math.round(request.initialRect.y * s.height) / s.height;
  const width = Math.max(4, Math.round(request.initialRect.width * s.width)) / s.width;
  const height = Math.max(4, Math.round(request.initialRect.height * s.height)) / s.height;
  return { engine: "hao-core-rust-motion-track-0.4-planar", analysisFps: s.analysisFps, width: s.width, height: s.height,
    analyzedSeconds: request.duration, elapsedMs: 0, cacheHit: false, lostRatio: 0,
    points: Array.from({ length: s.maxFrames }, (_, frame) => ({ frame, time: frame / s.analysisFps, confidence: 1,
      status: frame === Math.round(request.initialTime * s.analysisFps) ? "manual" : "tracked", activity: 0,
      rect: { x, y, width, height }, rotationDegrees: 0, scale: 1,
      quad: [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }] })) };
}
function prepared() {
  const project = fixture(), job = beginMotionTrackRetrackV1(project, options), analysis = native(project, job);
  const plan = prepareMotionTrackRetrackV1(project, job, analysis);
  return { project, job, analysis, plan, command: motionTrackRetrackCommandV1(project, plan) };
}

describe("bounded local retrack through existing graph commands", () => {
  it("uses the selected original source offset and the same analysis grid, with a visible nearest-seed time", () => {
    const p = fixture(), job = beginMotionTrackRetrackV1(p, { ...options, correctedTime: 25 / 24 });
    const source = motionTrackRetrackSourceV1(p, job);
    expect(source.assetUri).toBe(p.assets[0].uri); expect(source.request.sourceStart).toBe(.25 + 10 / 12);
    expect(source.window).toMatchObject({ firstFrame: 10, lastFrame: 15, sampleCount: 6,
      requestedCorrectionSeconds: 25 / 24, effectiveCorrectionSeconds: 13 / 12 });
    expect(source.request.initialTime).toBe(3 / 12);
  });
  it("splices only the window, rebases native scale, preserves every binding and commits one Undo", () => {
    const { project, plan, command } = prepared(), before = structuredClone(project), old = before.motionTracks[0];
    const h = dispatchCommand(createHistory(project), editorCommandSchema.parse(command)), next = h.present.motionTracks[0];
    expect(h.past).toHaveLength(1); expect(h.journal).toHaveLength(1); expect(h.present.motionTracks.map(t => t.id)).toEqual(["new"]);
    expect(next.points.filter(p => p.frame < 10 || p.frame > 14)).toEqual(old.points.filter(p => p.frame < 10 || p.frame > 14));
    expect(next.initialRect).toEqual(old.initialRect); expect(next.name).toBe(old.name); expect(next.role).toBe("host");
    expect(next.points[12].scale).toBeCloseTo(Math.sqrt(38 * 38 / (26 * 19)), 12);
    expect(plan.localToOriginalScaleFactor).toBe(next.points[12].scale);
    expect(h.present.motionGraphics[0]).toEqual({ ...before.motionGraphics[0], trackId: "new" });
    expect(h.present.motionGraphics[1].vectorTrackingV1).toEqual({ ...before.motionGraphics[1].vectorTrackingV1!, trackId: "new" });
    expect(h.present.tracks[0].clips[0].masks![0]).toEqual({ ...before.tracks[0].clips[0].masks![0], trackId: "new", frozenRange: undefined, matteSequence: undefined });
    expect(undo(h).present).toEqual(before); expect(redo(undo(h)).present).toEqual(h.present);
    expect(migrateProject(JSON.parse(JSON.stringify(h.present)))).toEqual(h.present);
    expect(project).toEqual(before); expect(plan).toMatchObject({ realCornerQualityCertified: false, ordinaryEditorIntegrated: false, vaDefaultEligible: false });
  });
  it.each([0, 2, 2 - 1e-10])("clamps a tiny correction window at clip boundary %s without sampling outside", time => {
    const p = fixture(), job = beginMotionTrackRetrackV1(p, { ...options, correctedTime: time, radiusSeconds: 1e-10 });
    const source = motionTrackRetrackSourceV1(p, job);
    expect(source.window.firstFrame).toBeGreaterThanOrEqual(0); expect(source.window.lastFrame).toBeLessThan(24);
    expect(source.request.sourceStart + source.request.duration).toBeLessThanOrEqual(2.25 + 1e-12);
    expect(() => prepareMotionTrackRetrackV1(p, job, native(p, job))).not.toThrow();
  });
  it("preserves sparse and off-grid manual observations outside the window exactly", () => {
    const p = fixture(); p.motionTracks[0].points = p.motionTracks[0].points.filter(v => v.frame !== 2);
    const point = p.motionTracks[0].points.at(-1)!; point.time += .4 / 12; point.status = "manual";
    const job = beginMotionTrackRetrackV1(p, options), plan = prepareMotionTrackRetrackV1(p, job, native(p, job));
    const command = motionTrackRetrackCommandV1(p, plan), next = applyCommand(p, command).motionTracks[0];
    expect(next.points.filter(v => v.frame < 10 || v.frame > 14)).toEqual(p.motionTracks[0].points.filter(v => v.frame < 10 || v.frame > 14));
    expect(next.points.at(-1)).toEqual(point);
  });
  it("counts lost frames after splice and keeps absolute native rotation and quad", () => {
    const p = fixture(), job = beginMotionTrackRetrackV1(p, options), a = native(p, job);
    a.points[0].status = "lost"; a.lostRatio = 1 / a.points.length; a.points[1].rotationDegrees = 17; a.points[1].scale = 1.25;
    const plan = prepareMotionTrackRetrackV1(p, job, a), next = applyCommand(p, motionTrackRetrackCommandV1(p, plan)).motionTracks[0];
    expect(next.lostRatio).toBe(1 / 24); expect(next.points[11].rotationDegrees).toBe(17); expect(next.points[11].quad).toEqual(a.points[1].quad);
    expect(next.points[11].scale).toBe(plan.localToOriginalScaleFactor * 1.25);
  });
  it("uses the old width basis for the native region fallback", () => {
    const p = fixture(), job = beginMotionTrackRetrackV1(p, options), a = native(p, job); a.engine = "hao-core-rust-motion-track-0.4-region-fallback";
    const plan = prepareMotionTrackRetrackV1(p, job, a); expect(plan.localToOriginalScaleFactor).toBe(38 / 26);
  });
  it("allows an in-grid pixel-rounded seed with native floating point noise", () => {
    const p = fixture(), job = beginMotionTrackRetrackV1(p, options), a = native(p, job);
    a.points[2].scale = 1 + Number.EPSILON;
    expect(() => prepareMotionTrackRetrackV1(p, job, a)).not.toThrow();
  });
  it.each(["id", "radius", "rect", "time", "date", "retime", "lock", "clock", "offgrid", "range", "sourcekind"])("refuses invalid %s before analysis", kind => {
    const p = fixture(), o = structuredClone(options);
    if (kind === "id") o.newTrackId = "old";
    if (kind === "radius") o.radiusSeconds = Infinity;
    if (kind === "rect") o.correctedRect.width = .01;
    if (kind === "time") o.correctedTime = 3;
    if (kind === "date") o.createdAt = "invalid";
    if (kind === "retime") p.tracks[0].clips[0].speed = 2;
    if (kind === "lock") p.tracks[0].locked = true;
    if (kind === "clock") p.motionTracks[0].analysisFps = 30;
    if (kind === "offgrid") p.motionTracks[0].points[4].time += .1 / 12;
    if (kind === "range") p.assets[0].duration = 1;
    if (kind === "sourcekind") p.assets[0].kind = "image";
    expect(() => beginMotionTrackRetrackV1(p, o)).toThrow();
  });
  it.each(["partial", "clock", "engine", "seed", "seedrect", "seedscale", "quad", "duration"])("refuses a malformed %s result without graph mutation", kind => {
    const p = fixture(), before = structuredClone(p), job = beginMotionTrackRetrackV1(p, options), a = native(p, job);
    if (kind === "partial") a.points.pop();
    if (kind === "clock") a.points[0].time = .01;
    if (kind === "engine") a.engine = "invented";
    if (kind === "seed") a.points[2].status = "tracked";
    if (kind === "seedrect") a.points[2].rect.x += .01;
    if (kind === "seedscale") a.points[2].scale = 1.2;
    if (kind === "quad") a.points[0].quad![1] = { ...a.points[0].quad![0] };
    if (kind === "duration") a.analyzedSeconds += .1;
    expect(() => prepareMotionTrackRetrackV1(p, job, a)).toThrow(); expect(p).toEqual(before);
  });
  it.each(["source", "offset", "fps", "binding", "revision", "idcollision", "point"])("refuses a stale %s job/plan", kind => {
    const f = prepared(), p = f.project;
    if (kind === "source") p.assets[0].uri = "D:/different-original.mkv";
    if (kind === "offset") p.tracks[0].clips[0].sourceStart = .2;
    if (kind === "fps") p.fps = 30;
    if (kind === "binding") p.motionGraphics[0].offsetX += .01;
    if (kind === "revision") p.revision++;
    if (kind === "idcollision") p.motionTracks.push({ ...structuredClone(p.motionTracks[0]), id: "new" });
    if (kind === "point") p.motionTracks[0].points[0].confidence = .5;
    expect(() => motionTrackRetrackCommandV1(p, f.plan)).toThrow();
    expect(() => prepareMotionTrackRetrackV1(p, f.job, f.analysis)).toThrow();
  });
  it("rejects serialized handles, captures mutable input and isolates returned source/command copies", () => {
    const p = fixture(), input = structuredClone(options), job = beginMotionTrackRetrackV1(p, input); input.correctedRect.x = .8;
    const source = motionTrackRetrackSourceV1(p, job); source.request.initialRect.x = .9;
    expect(motionTrackRetrackSourceV1(p, job).request.initialRect.x).toBe(.3);
    expect(() => motionTrackRetrackSourceV1(p, { ...job })).toThrow("FOREIGN");
    const plan = prepareMotionTrackRetrackV1(p, job, native(p, job)), c = motionTrackRetrackCommandV1(p, plan);
    if (c.type !== "batch" || c.commands[0].type !== "add_motion_track") throw Error("wrong batch");
    c.commands[0].track.points[0].confidence = 0;
    expect(motionTrackRetrackCommandV1(p, plan)).not.toEqual(c);
    expect(() => motionTrackRetrackCommandV1(p, { ...plan })).toThrow("FOREIGN");
  });
  it("preserves cancellation through preparing and delayed command retrieval", () => {
    const p = fixture(), c = new AbortController(), job = beginMotionTrackRetrackV1(p, options, c.signal), a = native(p, job);
    const plan = prepareMotionTrackRetrackV1(p, job, a); c.abort(new Error("owned-stop"));
    expect(() => motionTrackRetrackCommandV1(p, plan)).toThrow("owned-stop");
    expect(() => beginMotionTrackRetrackV1(p, options, c.signal)).toThrow("owned-stop");
  });
  it("captures a runtime-only signal for the final canonical command check", () => {
    const p = fixture(), c = new AbortController(), job = beginMotionTrackRetrackV1(p, options);
    const plan = prepareMotionTrackRetrackV1(p, job, native(p, job), c.signal); c.abort(new Error("host-stop"));
    expect(() => motionTrackRetrackCommandV1(p, plan)).toThrow("host-stop");
  });
  it("leaves the whole history untouched if any final mask rebind becomes locked", () => {
    const { project, command } = prepared(); project.tracks[0].locked = true;
    const h = createHistory(project), failure = dispatchCommandSafely(h, command);
    expect(failure.state).toBe(h); expect(failure.error).toBeTruthy(); expect(h.present.motionTracks[0].id).toBe("old");
  });
  it("supports a short local range on a10hour source without sampling the whole source", () => {
    const p = fixture(); p.motionGraphics = []; delete p.tracks[0].clips[0].masks;
    p.tracks[0].clips[0].duration = 36_001; p.assets[0].duration = 36_001.25;
    p.motionTracks[0].points = [0, 12 * 36_000].map((frame, i) => ({ ...structuredClone(p.motionTracks[0].points[i]), frame, time: frame / 12 }));
    const job = beginMotionTrackRetrackV1(p, { ...options, correctedTime: 36_000 }), s = motionTrackRetrackSourceV1(p, job);
    expect(s.request.sourceStart).toBeCloseTo(36_000.25 - 2 / 12, 8); expect(s.window.sampleCount).toBe(5);
    expect(motionTrackingSamplingV2(s.request).rawBytes).toBe(5 * 128 * 96);
    const plan = prepareMotionTrackRetrackV1(p, job, native(p, job)); expect(plan.outsideSamplesRetained).toBe(1);
  });
});
