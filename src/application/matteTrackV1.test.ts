import { describe, expect, it } from "vitest";
import { createHistory, dispatchCommand, redo, undo } from "../domain/history";
import { motionTrackPoseAt } from "../domain/motionTrackSampling";
import { assertVectorTrackingProjectV1 } from "../domain/vectorTrackingV1";
import { decodeProjectBytes, encodeProjectBytes } from "./projectCodec";
import { matteTrackFixtureV1 } from "./__fixtures__/matteTrackV1.fixture";
import { beginMatteTrackV1, matteTrackCommandV1, matteTrackSourceV1, measureMatteFrameV1, prepareMatteTrackV1 } from "./matteTrackV1";
import { trackedTextFixtureV1 } from "./__fixtures__/trackedTextV1.fixture";

describe("matte alpha geometry retains real bounds and independent weighted centroid", () => {
  it.each([8, 16] as const)("measures asymmetric %ibit weights at pixel centres with inclusive extents", bits => {
    const b = new Uint8Array(256 * bits / 8), put = (x: number, y: number, value: number) => {
      const i = (y * 16 + x) * bits / 8; b[i] = value & 255; if (bits === 16) b[i + 1] = value >>> 8;
    };
    const maximum = bits === 8 ? 255 : 65535;
    put(2, 3, maximum); put(3, 3, bits === 8 ? 128 : 32897); put(2, 4, bits === 8 ? 64 : 16448); put(15, 15, 1);
    const r = measureMatteFrameV1(b, 16, 16, bits, .1);
    expect(r.bbox).toEqual({ x: .125, y: .1875, width: .125, height: .125 }); expect(r.foregroundPixels).toBe(3);
    expect(r.alphaMass).toBeCloseTo(bits === 8 ? 447 / 255 : 114880 / 65535, 12);
    expect(r.centroid?.x).toBeCloseTo(bits === 8 ? 2491 / 14304 : 320097 / 1838080, 12);
    expect(r.centroid?.y).toBeCloseTo(bits === 8 ? 3257 / 14304 : 13079 / 57440, 12);
    expect(r.centroid?.x).not.toBe(.1875); expect(r.centroid?.y).not.toBe(.25);
  });
  it("honours an explicit threshold, includes one corner pixel, and reports empty without a fake rectangle", () => {
    const b = new Uint8Array(256); b[255] = 255; b[0] = 127;
    const r = measureMatteFrameV1(b, 16, 16, 8, .5);
    expect(r).toEqual({ foregroundPixels: 1, alphaMass: 1, bbox: { x: 15 / 16, y: 15 / 16, width: 1 / 16, height: 1 / 16 }, centroid: { x: 15.5 / 16, y: 15.5 / 16 } });
    expect(measureMatteFrameV1(new Uint8Array(512), 16, 16, 16, 1)).toEqual({ foregroundPixels: 0, alphaMass: 0 });
  });
  it.each(["length", "dimension", "pixels", "precision", "zero-threshold", "nan-threshold"])("refuses invalid %s before scanning", kind => {
    const width = kind === "dimension" ? 15 : kind === "pixels" ? 8192 : 16;
    expect(() => measureMatteFrameV1(new Uint8Array(kind === "length" ? 255 : 256), width, 16,
      (kind === "precision" ? 12 : 8) as 8, kind === "zero-threshold" ? 0 : kind === "nan-threshold" ? NaN : .1)).toThrow("CONTRACT");
  });
  it("preserves a cancellation/deadline reason during a frame scan", () => {
    const stop = new Error("stop-pixels"); expect(() => measureMatteFrameV1(new Uint8Array(256), 16, 16, 8, .1, () => { throw stop; })).toThrow(stop);
  });
});

describe("source-bound matte bbox track uses the existing single Undo command", () => {
  it("preserves original graph, exact bbox/centroid receipt, loss, scale, Undo/Redo and project serialization", () => {
    const { project: p, options: o, measurement: m } = matteTrackFixtureV1(), before = structuredClone(p);
    const plan = prepareMatteTrackV1(p, beginMatteTrackV1(p, o), m), command = matteTrackCommandV1(p, plan);
    expect(p).toEqual(before); expect(command.type).toBe("add_motion_track"); expect(plan.trackAnchor).toBe("bbox-center"); expect(plan.centroidUse).toBe("measurement-only");
    const h = dispatchCommand(createHistory(p), command);
    expect(h.past).toHaveLength(1); expect(h.present.tracks).toEqual(p.tracks); expect(h.present.assets).toEqual(p.assets);
    const t = h.present.motionTracks.at(-1)!;
    expect(t.engine).toBe("editkin-matte-bbox-track/v1"); expect(t.points[1].rect).toEqual(m.frames[1].bbox);
    expect(t.points[2]).toMatchObject({ status: "lost", confidence: 0 }); expect(t.points[3].scale).toBeCloseTo(Math.sqrt(1.25), 12);
    expect(t.points[4].scale).toBe(.0625); expect(t.points.every(p => p.quad === undefined && p.rotationDegrees === 0)).toBe(true);
    expect(t.lostRatio).toBe(.2); expect(motionTrackPoseAt(t, .5)).toBeUndefined(); expect(motionTrackPoseAt(t, .75)?.rect).toEqual(m.frames[3].bbox);
    expect(undo(h).present).toEqual(before); expect(redo(undo(h)).present).toEqual(h.present);
    expect(decodeProjectBytes(encodeProjectBytes(h.present)).motionTracks).toEqual(h.present.motionTracks);
    expect(plan.measurement.frames).toEqual(m.frames); expect(plan.benchmarkAccepted).toBe(false);
  });
  it("keeps leading empty frames hidden and uses the explicit nonempty reference", () => {
    const { project: p, options: o, measurement: m } = matteTrackFixtureV1(); o.referenceFrame = 1;
    m.frames[0] = { frame: 0, time: 0, confidence: 0, foregroundPixels: 0, alphaMass: 0 };
    const t = prepareMatteTrackV1(p, beginMatteTrackV1(p, o), m).track;
    expect(t.initialRect).toEqual(m.frames[1].bbox); expect(motionTrackPoseAt(t, 0)).toBeUndefined(); expect(motionTrackPoseAt(t, .25)).toBeDefined();
  });
  it("does not let mutable preview/option copies rewrite the retained command", () => {
    const { project: p, options: o, measurement: m } = matteTrackFixtureV1(); const job = beginMatteTrackV1(p, o);
    o.newTrackId = "changed"; matteTrackSourceV1(p, job).options.newTrackId = "another";
    const plan = prepareMatteTrackV1(p, job, m); plan.track.id = "forged-preview"; plan.track.points[0].rect.x = .9;
    const c = matteTrackCommandV1(p, plan); expect(c.type === "add_motion_track" && c.track.id).toBe("matte-track");
    expect(c.type === "add_motion_track" && c.track.points[0].rect.x).toBe(8 / 64);
  });
  it.each(["revision", "source", "window", "locked", "collision"])("rejects stale %s immediately before apply", kind => {
    const { project: p, options: o, measurement: m } = matteTrackFixtureV1(); const plan = prepareMatteTrackV1(p, beginMatteTrackV1(p, o), m);
    if (kind === "revision") p.revision++; if (kind === "source") p.assets[0].uri = "other.mkv";
    if (kind === "window") p.tracks[0].clips[0].sourceStart = 0; if (kind === "locked") p.tracks[0].locked = true;
    if (kind === "collision") p.motionTracks.push(structuredClone(plan.track));
    expect(() => matteTrackCommandV1(p, plan)).toThrow();
  });
  it.each(["zero-threshold", "bad-date", "reference", "empty-name", "speed", "retime", "asset-retime", "locked"])("refuses unsupported %s before file work", kind => {
    const { project: p, options: o } = matteTrackFixtureV1();
    if (kind === "zero-threshold") o.minimumAlpha = 0; if (kind === "bad-date") o.createdAt = "invalid";
    if (kind === "reference") o.referenceFrame = 1440; if (kind === "empty-name") o.name = " ";
    if (kind === "speed") p.tracks[0].clips[0].speed = 2;
    if (kind === "retime") p.tracks[0].clips[0].timeRemap = {} as never;
    if (kind === "asset-retime") p.assets[0].clipRetime = {} as never; if (kind === "locked") p.tracks[0].locked = true;
    expect(() => beginMatteTrackV1(p, o)).toThrow();
  });
  it.each(["digest", "start", "fps", "count", "time", "index", "threshold", "empty-reference", "fake-empty", "centroid", "grid", "mass", "pixels", "extra-field"])("refuses inconsistent measurement %s", kind => {
    const { project: p, options: o, measurement: m } = matteTrackFixtureV1(), job = beginMatteTrackV1(p, o);
    if (kind === "digest") m.sourceSha256 = "0".repeat(64); if (kind === "start") m.sourceStart = 0;
    if (kind === "fps") m.fps = 5; if (kind === "count") m.frameCount = 4;
    if (kind === "time") m.frames[1].time += .01; if (kind === "index") m.frames[1].frame = 2;
    if (kind === "threshold") m.minimumAlpha = .2;
    if (kind === "empty-reference") m.frames[0] = { frame: 0, time: 0, confidence: 0, foregroundPixels: 0, alphaMass: 0 };
    if (kind === "fake-empty") m.frames[2].bbox = { x: 0, y: 0, width: .1, height: .1 };
    if (kind === "centroid") m.frames[0].centroid!.x = .99; if (kind === "grid") m.frames[0].bbox!.width += .001;
    if (kind === "mass") m.frames[0].alphaMass = 1000; if (kind === "pixels") m.frames[0].foregroundPixels = 1000;
    if (kind === "extra-field") Object.assign(m, { benchmarkAccepted: true });
    expect(() => prepareMatteTrackV1(p, job, m)).toThrow();
  });
  it("keeps inherited and runtime cancellation live until command retrieval and rejects foreign plans/jobs", () => {
    const { project: p, options: o, measurement: m } = matteTrackFixtureV1(), a = new AbortController();
    const job = beginMatteTrackV1(p, o, a.signal), plan = prepareMatteTrackV1(p, job, m);
    a.abort(new Error("owner-stop")); expect(() => matteTrackCommandV1(p, plan)).toThrow("owner-stop");
    expect(() => prepareMatteTrackV1(p, { schema: "editkin.matte-track-job/v1", clipId: o.clipId }, m)).toThrow("FOREIGN");
    expect(() => matteTrackCommandV1(p, { ...plan })).toThrow("FOREIGN");
    const b = new AbortController(), other = prepareMatteTrackV1(p, beginMatteTrackV1(p, o), m, b.signal);
    b.abort(new Error("runtime-stop")); expect(() => matteTrackCommandV1(p, other)).toThrow("runtime-stop");
  });
  it("never presents an axis-aligned matte as a planar surface quad", async () => {
    const { project: p, options: o, measurement: m } = matteTrackFixtureV1(); const plan = prepareMatteTrackV1(p, beginMatteTrackV1(p, o), m);
    p.motionTracks.push(plan.track); const source = await trackedTextFixtureV1(); const g = source.g;
    g.timelineStart = 2; g.duration = 1; g.vectorTrackingV1 = { schema: "editkin.vector-tracking/v1", trackId: o.newTrackId, mode: "surface", referenceTime: 0 };
    expect(() => assertVectorTrackingProjectV1(p, g)).toThrow("QUAD_REQUIRED");
  });
});
