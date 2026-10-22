import type { EditProject } from "../domain/types";
import { projectDuration } from "../domain/editGraph";
import { estimateLongCompositeRamBytesV1 } from "./longRenderClassifierV1";
import { durationFrameCountV1, frameRateRationalV1, secondsToFrameV1 } from "./longRenderClockV1";
import { assertLongChunkClocksV1 } from "./longChunkClockAuditV1";
import { longChunkGraphIndexV1 } from "./longSubProjectV1";
import { isHdrOutput } from "./ffmpegComposite";
import { LongRenderRefusalV1, type LongRenderPolicyV1 } from "./longRenderContractsV1";

export interface LongCompositeChunkV1 { startFrame: number; frameCount: number; preRollFrames: number; ramEstimateBytes: number }
type Span = { start: number; end: number; weight: number; ids: string[] };

/** Sweep and greedy packing are O(items log items + chunks), never O(total frames × clips). */
export function planLongCompositeChunksV1(project: EditProject, policy: LongRenderPolicyV1, options: { maxChunkSeconds?: number; preRollFrames?: number } = {}) {
  assertLongChunkClocksV1(project);
  const rate = frameRateRationalV1(project.fps), duration = projectDuration(project), totalFrames = durationFrameCountV1(duration, rate);
  const maxSeconds = options.maxChunkSeconds ?? 60, preRoll = options.preRollFrames ?? 0;
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0 || maxSeconds > 60 || !Number.isSafeInteger(preRoll) || preRoll < 0
    || totalFrames < 1 || Math.abs(duration * rate.numerator / rate.denominator - totalFrames) > 1e-6) {
    throw new LongRenderRefusalV1("LONG_RENDER_CLOCK_RANGE", "chunk output requires a frame-aligned total duration, positive <=60s windows and integer pre-roll");
  }
  const maxFrames = Math.floor(maxSeconds * rate.numerator / rate.denominator + 1e-7);
  if (maxFrames < 1) throw new LongRenderRefusalV1("LONG_RENDER_CLOCK_RANGE", "chunk window is shorter than one frame");
  const frameBytes = project.width * project.height * (isHdrOutput(project) ? 3 : 1.5);
  if (frameBytes > policy.frameQueueBytes) throw new LongRenderRefusalV1("LONG_RENDER_POLICY_INVALID", "one output frame exceeds the byte queue budget");
  const depth = Math.min(policy.frameQueueFrames, Math.floor(policy.frameQueueBytes / frameBytes), 8);
  const reserved = depth * frameBytes + Math.min(60, duration) * 48000 * 16;
  const base = estimateLongCompositeRamBytesV1(project, []), spans: Span[] = [];
  const add = (start: number, length: number, id: string, weight = 0) => {
    if (!Number.isFinite(start) || !Number.isFinite(length) || start < 0 || length <= 0) throw new LongRenderRefusalV1("LONG_RENDER_CLOCK_RANGE", "invalid visual span", { id });
    spans.push({ start: secondsToFrameV1(start, rate, "floor"), end: secondsToFrameV1(start + length, rate, "ceil"), weight, ids: [id] });
  };
  const graph = longChunkGraphIndexV1(project), byId = graph.clips;
  for (const track of project.tracks.filter(track => track.kind === "video")) for (const clip of track.clips) {
    const asset = project.assets.find(item => item.id === clip.assetId);
    const dimensions = { width: asset?.width ?? project.width, height: asset?.height ?? project.height };
    const inputs = [dimensions, ...(clip.layer?.trackMatte ? [{ width: project.width, height: project.height }] : []),
      ...(clip.masks ?? []).filter(mask => mask.enabled).map(() => ({ width: project.width, height: project.height }))];
    add(clip.timelineStart, clip.duration, clip.id, track.hidden || clip.layer?.enabled === false ? 0 : estimateLongCompositeRamBytesV1(project, inputs) - base);
  }
  for (const caption of project.captions) add(caption.start, caption.duration, caption.id);
  for (const graphic of project.motionGraphics) add(graphic.timelineStart, graphic.duration, graphic.id);
  const connect = (from: { timelineStart: number; duration: number }, to: { timelineStart: number; duration: number }, id: string) => {
    const start = Math.min(from.timelineStart, to.timelineStart), end = Math.max(from.timelineStart + from.duration, to.timelineStart + to.duration);
    add(start, end - start, id);
  };
  for (const clip of byId.values()) for (const id of graph.dependencies(clip)) {
    const parent = byId.get(id); if (!parent) throw new LongRenderRefusalV1("LONG_RENDER_CHUNK_FIELD_UNSUPPORTED", "missing parent or matte source", { clipId: id });
    connect(clip, parent, `${clip.id}:${id}`);
  }
  for (const graphic of project.motionGraphics) for (const id of graph.graphicClips(graphic)) {
    const clip = byId.get(id); if (!clip) throw new LongRenderRefusalV1("LONG_RENDER_CHUNK_FIELD_UNSUPPORTED", "missing graphic tracking source", { clipId: id });
    connect(graphic, clip, `${graphic.id}:${id}`);
  }
  for (const scene of project.motionScenes ?? []) add(scene.startFrame * rate.denominator / rate.numerator, scene.durationFrames * rate.denominator / rate.numerator, scene.id);
  for (const pair of project.timelineTransitions ?? []) {
    const from = byId.get(pair.fromClipId), to = byId.get(pair.toClipId); if (!from || !to) throw new LongRenderRefusalV1("LONG_RENDER_CHUNK_FIELD_UNSUPPORTED", "transition has no source clip");
    connect(from, to, `${pair.id}:sources`);
    const cut = from.timelineStart + from.duration;
    add(cut - pair.beforeFrames * rate.denominator / rate.numerator, (pair.beforeFrames + pair.afterFrames) * rate.denominator / rate.numerator, pair.id);
  }
  const animated = (value: unknown): boolean => Boolean(value && typeof value === "object" && Object.entries(value).some(([key, item]) =>
    key === "keyframes" && Array.isArray(item) && item.length > 0 || item && typeof item === "object" && animated(item)));
  const globalAnimated = Boolean(project.particleSimulation?.enabled || animated(project.scene25d));
  if (globalAnimated) add(0, duration, "global-temporal-support");
  for (const segment of project.scene3d?.enabled ? project.scene3d.segments : []) add(segment.timelineStart, segment.duration, segment.id);
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const blocks: Span[] = [];
  for (const span of spans) {
    const previous = blocks.at(-1);
    if (previous && span.start < previous.end) { previous.end = Math.max(previous.end, span.end); previous.weight += span.weight; previous.ids.push(...span.ids); }
    else blocks.push({ ...span, ids: [...span.ids] });
  }
  const chunks: LongCompositeChunkV1[] = []; let cursor = 0, index = 0;
  while (cursor < totalFrames) {
    const limit = Math.min(cursor + maxFrames, totalFrames); let end = limit, weight = 0, next = index;
    while (next < blocks.length && blocks[next].start < limit) {
      const block = blocks[next];
      if (block.end > limit || base + reserved + weight + block.weight > policy.ramBudgetBytes) { end = block.start; break; }
      weight += block.weight; next++;
    }
    if (end <= cursor || base + reserved + weight > policy.ramBudgetBytes) {
      throw new LongRenderRefusalV1("LONG_RENDER_ROUTE_NOT_AVAILABLE", "no clean zero-support boundary fits the chunk length and RAM budget", {
        startFrame: cursor, maxFrames, ramBudgetBytes: policy.ramBudgetBytes, requiredBytes: base + reserved + (blocks[index]?.weight ?? 0), blockingIds: blocks[index]?.ids.slice(0, 16) });
    }
    chunks.push({ startFrame: cursor, frameCount: end - cursor, preRollFrames: Math.min(preRoll, cursor), ramEstimateBytes: base + reserved + weight });
    cursor = end; index = next;
    if (chunks.length > 1_000_000) throw new LongRenderRefusalV1("LONG_RENDER_POLICY_INVALID", "chunk metadata exceeds the bounded schedule budget");
  }
  return { schema: "editkin.long-composite-schedule/v1" as const, frameRate: rate, totalFrames, frameBytes, queueDepth: depth, chunks,
    audioWindowMaximumBytes: Math.min(60, duration) * 48000 * 16, temporalPreRollFrames: preRoll };
}
