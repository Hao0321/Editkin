import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { buildAces2DisplayVideoRenderRequest, type NativeAces2OutputTransform } from "./aces2SdrVideo";
import { buildRenderPlan } from "./planner";
import { planLongOutputIdentityV1 } from "./longRenderRouterV1";
import { resolveLongRenderPolicyV1 } from "./longRenderPolicyV1";
import { sceneLinearChunkPlanV1, sceneLinearMetadataBytesV1, assertSceneLinearChunkReceiptV1 } from "./sceneLinearChunkPlanV1";

function fixture(seconds: number, output: NativeAces2OutputTransform = "rec709_sdr") {
  const p = createEmptyProject("bounded float display", { width: 64, height: 36, fps: 30000 / 1001 });
  p.colorManagement = { ...p.colorManagement!, mode: "aces2", outputTransform: output };
  p.assets.push({ id: "src", name: "float.exr", kind: "image", uri: "C:/VFX/float.exr", duration: seconds, width: 64, height: 36,
    alphaMode: "straight", color: { interpretation: "linear_rec709" } });
  p.tracks[0].clips.push({ id: "v", trackId: p.tracks[0].id, assetId: "src", timelineStart: 0, sourceStart: 0, duration: seconds, volume: 1,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
  const request = buildAces2DisplayVideoRenderRequest(p, { longTimeline: true }), render = buildRenderPlan(p, uri => uri),
    identity = planLongOutputIdentityV1(p, render, output === "rec709_sdr" ? "libx264" : "libx265", { alphaDelivery: false, sceneLinear: true }),
    policy = resolveLongRenderPolicyV1({ stagingCapBytes: 1024 ** 2 });
  return { p, request, identity, policy, duration: render.duration, schedule: sceneLinearChunkPlanV1(p, render.duration, request, identity, policy) };
}
describe("bounded absolute scene-linear display batches", () => {
  it.each(["rec709_sdr", "rec2100_hlg_1000", "rec2100_pq_1000"] as const)("describes12h and24h%s without retaining every chunk", output => {
    for (const seconds of [43200, 86400]) {
      const b = fixture(seconds, output), s = b.schedule, last = s.chunk(s.chunkCount - 1);
      expect(s.frameCount).toBe(Math.round(seconds * 30000 / 1001)); expect(s.chunk(0).startFrame).toBe(0);
      expect(last.startFrame + last.frameCount).toBe(s.frameCount); expect(s.chunk(s.chunkCount - 2).startFrame + s.framesPerChunk).toBe(last.startFrame);
      expect(s.framesPerChunk * s.maximumPngFrameBytes).toBeLessThanOrEqual(s.batchBudgetBytes);
      expect(s.maximumRetainedPngBytes).toBe(s.maximumPngFrameBytes); expect(b.identity.audio.expectedSamples).toBe(seconds * 48000);
      expect(() => buildAces2DisplayVideoRenderRequest(b.p)).toThrow(/1,000,000/);
    }
  });
  it("preserves a fractional NTSC video endpoint and the full independent audio tail", () => {
    const b = fixture(2.01); expect(b.schedule.frameCount).toBe(60); expect(b.identity.audio.expectedSamples).toBe(96480);
    expect(Math.round(b.schedule.frameCount / b.p.fps * 48000)).not.toBe(96480);
    expect(() => b.schedule.chunk(-1)).toThrow(/LONG_RENDER_CLOCK_RANGE/); expect(() => b.schedule.chunk(b.schedule.chunkCount)).toThrow(/LONG_RENDER_CLOCK_RANGE/);
  });
  it.each(["timebase", "samples", "pixels", "frames"])("rejects a mismatched global%s identity", field => {
    const b = fixture(2.01); if (field === "timebase") b.request.graph.timebase.numerator++;
    if (field === "samples") b.identity.audio.expectedSamples--; if (field === "pixels") b.identity.pixelFormat = "yuv444p";
    if (field === "frames") b.request.frameCount++;
    expect(() => sceneLinearChunkPlanV1(b.p, b.duration, b.request, b.identity, b.policy)).toThrow(/LONG_RENDER_OUTPUT_QA/);
  });
  it("accounts UTF8 metadata before writing and refuses an overflow", () => {
    expect(sceneLinearMetadataBytesV1(["鏡頭🎥"], 10)).toBe(10);
    expect(() => sceneLinearMetadataBytesV1(["鏡頭🎥"], 9)).toThrow(/LONG_RENDER_STAGING_LIMIT/);
  });
  it("rejects a receipt for a different absolute frame range", () => {
    const b = fixture(2.01), chunk = b.schedule.chunk(1), r = { schema: "editkin.ocio-display-sequence/v1", status: "GREEN", colorProcessor: b.request.colorProcessor,
      ocioVersion: "2.5.2", acesVersion: "2.0", filePattern: "frame-%08d.png", artifactFormat: "rgba8", displayColorSpace: "rec709_sdr", deviceCreationCount: 1,
      audioIncluded: false, ...chunk, lastFrame: chunk.startFrame + chunk.frameCount - 1, width: 64, height: 36, graphId: b.request.graph.graphId,
      timebase: b.request.graph.timebase, configSha256: "a".repeat(64), lutSha256: "b".repeat(64), totalBytes: 100 };
    expect(() => assertSceneLinearChunkReceiptV1(r, b.request, chunk, "rgba8", 1024)).not.toThrow(); r.startFrame = 0;
    expect(() => assertSceneLinearChunkReceiptV1(r, b.request, chunk, "rgba8", 1024)).toThrow(/LONG_RENDER_OUTPUT_QA/);
  });
});
