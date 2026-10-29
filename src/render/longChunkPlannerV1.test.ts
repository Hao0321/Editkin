import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { resolveLongRenderPolicyV1 } from "./longRenderPolicyV1";
import { planLongCompositeChunksV1 } from "./longChunkPlannerV1";
import { createLongSubProjectIndexV1 } from "./longSubProjectV1";
import { assertLongChunkClocksV1 } from "./longChunkClockAuditV1";

function movie(count = 3, seconds = 1): EditProject {
  const value = createEmptyProject("clean chunks", { width: 128, height: 72, fps: 30 });
  value.assets.push({ id: "source", name: "original", kind: "video", uri: "D:/never-opened-clock-fixture.mp4", width: 128, height: 72, duration: seconds });
  for (let i = 0; i < count; i++) value.tracks[0].clips.push({ id: `c${i}`, assetId: "source", trackId: value.tracks[0].id,
    timelineStart: i * seconds, sourceStart: 0, duration: seconds, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
  return value;
}
const policy = resolveLongRenderPolicyV1(undefined, 32 * 1024 ** 3);

describe("clean-boundary LONG schedule and audited sub-projects", () => {
  it("preserves all frames at abutting clean boundaries", () => {
    const plan = planLongCompositeChunksV1(movie(), policy, { maxChunkSeconds: 1 });
    expect(plan.chunks.map(chunk => [chunk.startFrame, chunk.frameCount])).toEqual([[0, 30], [30, 30], [60, 30]]);
    expect(plan.chunks.every(chunk => chunk.preRollFrames === 0 && chunk.ramEstimateBytes <= policy.ramBudgetBytes)).toBe(true);
  });

  it("keeps a crossing caption together and refuses a boundary inside it", () => {
    const value = movie(); value.captions.push({ id: "cap", text: "stay together", start: .8, duration: .5 });
    expect(() => planLongCompositeChunksV1(value, policy, { maxChunkSeconds: 1 })).toThrow("LONG_RENDER_ROUTE_NOT_AVAILABLE");
    expect(planLongCompositeChunksV1(value, policy, { maxChunkSeconds: 2 }).chunks.map(chunk => chunk.frameCount)).toEqual([60, 30]);
  });

  it("retains both transition sources even when beforeFrames is zero", () => {
    const value = movie(); value.timelineTransitions = [{ schema: "editkin.timeline-transition/v1", id: "pair", trackId: value.tracks[0].id,
      fromClipId: "c0", toClipId: "c1", beforeFrames: 0, afterFrames: 2, kernel: "dissolve" }];
    expect(() => planLongCompositeChunksV1(value, policy, { maxChunkSeconds: 1 })).toThrow("LONG_RENDER_ROUTE_NOT_AVAILABLE");
  });

  it("treats parent and matte references as temporal dependencies", () => {
    const value = movie(); value.tracks[0].clips[1].layer = { enabled: true, blendMode: "normal", parentClipId: "c0" };
    expect(() => planLongCompositeChunksV1(value, policy, { maxChunkSeconds: 1 })).toThrow("LONG_RENDER_ROUTE_NOT_AVAILABLE");
    const chunks = planLongCompositeChunksV1(value, policy, { maxChunkSeconds: 2 }).chunks;
    const part = createLongSubProjectIndexV1(value)(chunks[0]);
    expect(part.project.tracks[0].clips.map(clip => clip.id)).toEqual(["c0", "c1"]);
  });

  it("keeps clip-local keyframes, masks and volume clocks unchanged while rebasing timeline positions", () => {
    const value = movie(2), second = value.tracks[0].clips[1];
    second.keyframes = [{ id: "key", time: .25, transform: { ...DEFAULT_TRANSFORM, x: 10 }, color: { ...DEFAULT_COLOR }, easing: "linear" }];
    second.audioEnvelope = { schema: "editkin.clip-audio-envelope/v1", volume: { offset: .1, points: [{ id: "v", time: .2, db: -6 }] } };
    value.captions.push({ id: "cap", text: "later", start: 1.1, duration: .4 });
    const before = JSON.stringify(value), chunk = planLongCompositeChunksV1(value, policy, { maxChunkSeconds: 1 }).chunks[1];
    const part = createLongSubProjectIndexV1(value)(chunk), clip = part.project.tracks[0].clips[0];
    expect(clip.timelineStart).toBe(0); expect(clip.keyframes).toEqual(second.keyframes); expect(clip.audioEnvelope).toEqual(second.audioEnvelope);
    expect(part.project.captions[0].start).toBeCloseTo(.1); expect(part.assProject.captions[0].start).toBe(1.1);
    expect(part.startFrame).toBe(30); expect(JSON.stringify(value)).toBe(before);
  });

  it("can describe a wholly empty black gap without a synthetic media file", () => {
    const value = movie(1); value.tracks[0].clips[0].timelineStart = 90;
    const plan = planLongCompositeChunksV1(value, policy), part = createLongSubProjectIndexV1(value)(plan.chunks[0]);
    expect(plan.chunks.map(chunk => chunk.frameCount)).toEqual([1800, 930]);
    expect(part.durationSeconds).toBe(60); expect(part.project.assets).toEqual([]); expect(part.project.tracks.every(track => track.clips.length === 0)).toBe(true);
  });

  it.each([[12, 10800, 720], [24, 21600, 1440]])("plans %ih by intervals, with no frame array or integer overflow", (hours, clips, chunks) => {
    const plan = planLongCompositeChunksV1(movie(clips, 4), policy);
    expect(plan.totalFrames).toBe(hours * 3600 * 30); expect(plan.chunks).toHaveLength(chunks);
    expect(plan.chunks.reduce((sum, chunk) => sum + chunk.frameCount, 0)).toBe(plan.totalFrames);
    expect(plan.chunks.at(-1)!.startFrame + plan.chunks.at(-1)!.frameCount).toBe(plan.totalFrames);
  }, 30_000);

  it("rejects an unknown absolute time field instead of retaining a stale clock", () => {
    const value = movie(); Object.assign(value.tracks[0].clips[0].creative = { effectPresetIds: [] }, { futureTimelineStart: 2 });
    expect(() => assertLongChunkClocksV1(value)).toThrow("LONG_RENDER_CHUNK_FIELD_UNSUPPORTED");
    expect(() => assertLongChunkClocksV1(Object.assign(movie(), { futureClock: {} }))).toThrow("LONG_RENDER_CHUNK_FIELD_UNSUPPORTED");
  });

  it("rejects impossible RAM, oversized output frames and non-frame-aligned total durations", () => {
    expect(() => planLongCompositeChunksV1(movie(), { ...policy, ramBudgetBytes: 1 })).toThrow("LONG_RENDER_ROUTE_NOT_AVAILABLE");
    expect(() => planLongCompositeChunksV1(movie(), { ...policy, frameQueueBytes: 1 })).toThrow("LONG_RENDER_POLICY_INVALID");
    expect(() => planLongCompositeChunksV1(movie(1, 1.01), policy)).toThrow("LONG_RENDER_CLOCK_RANGE");
  });
});
