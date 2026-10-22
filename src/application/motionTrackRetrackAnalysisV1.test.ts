import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_TRANSFORM, DEFAULT_COLOR } from "../domain/types";
import { analyzeMotionTrack } from "./motionTracking";
import { analyzeMotionTrackRetrackV1 } from "./motionTrackRetrackAnalysisV1";
import { beginMotionTrackRetrackV1, motionTrackRetrackCommandV1 } from "./motionTrackRetrackV1";
vi.mock("./motionTracking", () => ({ analyzeMotionTrack: vi.fn() }));
const runtime = { ffmpegPath: "owned-ffmpeg", nativeCorePath: "owned-core" };
function fixture() {
  const p = createEmptyProject("host", { id: "host", width: 128, height: 96, fps: 24 });
  p.assets = [{ id: "source", name: "original", kind: "video", uri: "original.mkv", duration: 2.5, width: 128, height: 96,
    derivatives: { sourceSha256: "a".repeat(64), generatedAt: "2026-10-17T00:00:00Z" } }];
  p.tracks[0].clips = [{ id: "c", assetId: "source", trackId: p.tracks[0].id, timelineStart: 0, sourceStart: .5, duration: 2,
    volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }];
  p.motionTracks = [{ id: "old", clipId: "c", name: "old", engine: "manual:test", analysisFps: 12,
    initialRect: { x: .25, y: .25, width: .25, height: .25 }, points: [{ frame: 0, time: 0, rect: { x: .25, y: .25, width: .25, height: .25 }, status: "manual", confidence: 1 }],
    lostRatio: 0, createdAt: "2026-10-17T00:00:00Z" }];
  const o = { trackId: "old", newTrackId: "new", correctedTime: 1, correctedRect: { x: .25, y: .25, width: .25, height: .25 },
    radiusSeconds: 1 / 12, createdAt: "2026-10-17T00:00:00Z" };
  return { p, o };
}
beforeEach(() => {
  vi.mocked(analyzeMotionTrack).mockReset().mockImplementation(async request => ({
    engine: "hao-core-rust-motion-track-0.4-planar", analysisFps: 12, width: 128, height: 96,
    lostRatio: 0, analyzedSeconds: request.duration, elapsedMs: 0, cacheHit: false,
    points: Array.from({ length: 3 }, (_, frame) => ({ frame, time: frame / 12, rect: { ...request.initialRect },
      confidence: 1, status: frame === 1 ? "manual" : "tracked", activity: 0, rotationDegrees: 0, scale: 1,
      quad: [{ x: .25, y: .25 }, { x: .5, y: .25 }, { x: .5, y: .5 }, { x: .25, y: .5 }] })),
  }));
});
describe("local retrack Node host uses existing analyzer", () => {
  it("resolves the captured original, carries its actual asserted SHA and samples only the local window", async () => {
    const { p, o } = fixture(), before = structuredClone(p), job = beginMotionTrackRetrackV1(p, o);
    const r = await analyzeMotionTrackRetrackV1(p, job, { assetBase: "D:\\owned" }, runtime);
    expect(analyzeMotionTrack).toHaveBeenCalledOnce(); expect(vi.mocked(analyzeMotionTrack).mock.calls[0][0]).toMatchObject({
      sourcePath: "D:\\owned\\original.mkv", sourceStart: .5 + 11 / 12, duration: .25,
      initialTime: 1 / 12, sourceSha256: "a".repeat(64), fps: 12,
    });
    expect(r.plan.samplesReplaced).toBe(3); expect(p).toEqual(before);
  });
  it("refuses a relative asset root before native work", async () => {
    const { p, o } = fixture(); await expect(analyzeMotionTrackRetrackV1(p, beginMotionTrackRetrackV1(p, o), { assetBase: "." }, runtime)).rejects.toThrow("ABSOLUTE");
    expect(analyzeMotionTrack).not.toHaveBeenCalled();
  });
  it("refuses mismatched cancellation owners before work", async () => {
    const { p, o } = fixture(), a = new AbortController(), b = new AbortController();
    await expect(analyzeMotionTrackRetrackV1(p, beginMotionTrackRetrackV1(p, o, a.signal), { assetBase: "D:\\owned" }, { ...runtime, signal: b.signal })).rejects.toThrow("SINGLE_OWNER");
    expect(analyzeMotionTrack).not.toHaveBeenCalled();
  });
  it("checks a project edited while analysis was running and never returns a stale plan", async () => {
    const { p, o } = fixture(), implementation = vi.mocked(analyzeMotionTrack).getMockImplementation()!;
    vi.mocked(analyzeMotionTrack).mockImplementation(async (request, r) => { const v = await implementation(request, r); p.assets[0].uri = "different.mkv"; return v; });
    await expect(analyzeMotionTrackRetrackV1(p, beginMotionTrackRetrackV1(p, o), { assetBase: "D:\\owned" }, runtime)).rejects.toThrow("STALE");
  });
  it("keeps the runtime cancellation live until command retrieval", async () => {
    const { p, o } = fixture(), c = new AbortController();
    const r = await analyzeMotionTrackRetrackV1(p, beginMotionTrackRetrackV1(p, o), { assetBase: "D:\\owned" }, { ...runtime, signal: c.signal });
    c.abort(new Error("host-cancelled")); expect(() => motionTrackRetrackCommandV1(p, r.plan)).toThrow("host-cancelled");
  });
});
