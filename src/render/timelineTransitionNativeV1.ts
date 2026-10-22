import { compileTimelineTransitionHandlesV1 } from "../domain/timelineTransitionHandlesV1";
import type { GpuEngineVideoResourceEstimate } from "./gpuCompositorAdmission";
import type { EditProject, TimelineClip } from "../domain/types";
import type { EngineFrameRange, EngineGraphBuildOptions, EngineNode, EngineRenderGraph } from "./engineGraph";

export interface NativeTimelinePairEndpointV1 {
  branchNodeId: string;
  sourceNodeId: string;
  assetId: string;
  mediaKind: "video" | "image";
  nominal: EngineFrameRange;
  sourceStartSeconds: number;
  assetDurationSeconds: number;
}
export interface NativeTimelinePairSpecV1 {
  id: string;
  trackId: string;
  kernel: "dissolve" | "dip";
  startFrame: number;
  cutFrame: number;
  endFrame: number;
  from: NativeTimelinePairEndpointV1;
  to: NativeTimelinePairEndpointV1;
}

/** Stable reason the native resident and preview routes give for a matte (motion library) transition. The native host
 * binds exactly two textures (timeline_transition_v1.wgsl); the matte kernel needs a matte and an overlay texture, so
 * those segments are declined and the software path (FFmpeg composite) renders them. Nothing is dropped silently. */
export const TIMELINE_TRANSITION_NATIVE_MATTE_DECLINED = "TIMELINE_TRANSITION_NATIVE_MATTE_DECLINED" as const;

/** The native decline reason for this project, or undefined when every transition is a native kernel. */
export function timelineTransitionNativeDeclineV1(project: Pick<EditProject, "timelineTransitions" | "compositions">): typeof TIMELINE_TRANSITION_NATIVE_MATTE_DECLINED | undefined {
  const owners = [project, ...(project.compositions ?? [])];
  return owners.some(owner => owner.timelineTransitions?.some(transition => transition.kernel === "matte")) ? TIMELINE_TRANSITION_NATIVE_MATTE_DECLINED : undefined;
}

/** The source nodes retain authored ranges. A new typed composite owns the
 * separate physical handle declarations; old runtimes reject its unknown kind. */
export function buildTimelineTransitionNativeGraphV1(project: EditProject, options: EngineGraphBuildOptions,
  base: (project: EditProject, options: EngineGraphBuildOptions) => EngineRenderGraph): EngineRenderGraph {
  const plans = compileTimelineTransitionHandlesV1(project);
  if (!plans.length) return base(project, options);
  if (plans.some(plan => plan.transition.kernel === "matte")) throw Error(TIMELINE_TRANSITION_NATIVE_MATTE_DECLINED);
  const graph = base({ ...project, timelineTransitions: undefined }, { ...options, nativeTimelineTransitionVersion: undefined });
  if (new Set(graph.nodes.map(node => node.id)).size !== graph.nodes.length) throw Error("TIMELINE_TRANSITION_NATIVE_NODE_ID_COLLISION");
  const clips = new Map(project.tracks.flatMap(track => track.clips).map(clip => [clip.id, clip]));
  const branchKinds = new Set(["transform2d", "transform3d", "color", "effect", "mask", "floating_video_frame_2d", "motion_blur"]);
  function endpoint(clipId: string): NativeTimelinePairEndpointV1 {
    const clip: TimelineClip | undefined = clips.get(clipId);
    const asset = clip && project.assets.find(candidate => candidate.id === clip.assetId);
    const sourceNodeId = `source:${clipId.replace(/[^a-zA-Z0-9_.:-]/g, "_")}`;
    const source = graph.nodes.find(node => node.id === sourceNodeId);
    if (!clip || !asset || !source || source.kind !== "source" || !source.enabled
      || source.assetId !== asset.id || (asset.kind !== "video" && asset.kind !== "image")) throw Error("TIMELINE_TRANSITION_NATIVE_SOURCE_INVALID");
    const nominal = source.timeline as EngineFrameRange | undefined;
    if (!nominal || ![nominal.timelineStartFrame, nominal.sourceStartFrame, nominal.durationFrames].every(Number.isSafeInteger)
      || nominal.durationFrames < 1) throw Error("TIMELINE_TRANSITION_NATIVE_SOURCE_INVALID");
    let branch: EngineNode = source;
    const seen = new Set<string>([source.id]);
    for (;;) {
      const next = graph.nodes.filter(node => node.inputs.length === 1 && node.inputs[0] === branch.id && branchKinds.has(node.kind));
      if (!next.length) break;
      if (next.length !== 1 || seen.has(next[0].id)) throw Error("TIMELINE_TRANSITION_NATIVE_BRANCH_INVALID");
      branch = next[0]; seen.add(branch.id);
      if (!branch.enabled) throw Error("TIMELINE_TRANSITION_VISIBLE_SOURCE_REQUIRED");
    }
    return { sourceNodeId, branchNodeId: branch.id, assetId: asset.id, mediaKind: asset.kind,
      nominal: { ...nominal }, sourceStartSeconds: clip.sourceStart, assetDurationSeconds: asset.kind === "video" ? asset.duration : 0 };
  }
  for (const plan of plans) {
    const kernel = plan.transition.kernel;
    if (kernel === "matte") throw Error(TIMELINE_TRANSITION_NATIVE_MATTE_DECLINED);
    const from = endpoint(plan.from.clipId), to = endpoint(plan.to.clipId);
    const candidates = graph.nodes.filter(node => ["composite", "timeline_transition_v1"].includes(node.kind)
      && node.inputs.length === 2 && node.inputs[1] === to.branchNodeId);
    let composite = candidates.at(0);
    if (candidates.length > 1) throw Error("TIMELINE_TRANSITION_NATIVE_COMPOSITE_MISSING");
    if (!composite) {
      // The existing graph has no composite for its first content layer.
      // Add a typed unary owner at that slot, preserving every authored branch.
      const consumers = graph.nodes.filter(node => node.inputs.includes(to.branchNodeId));
      if (!consumers.length || consumers.some(node => node.kind === "composite" && node.inputs[0] !== to.branchNodeId)) throw Error("TIMELINE_TRANSITION_NATIVE_COMPOSITE_MISSING");
      const id = `timeline-pair:first:${plan.transition.id.replace(/[^a-zA-Z0-9_.:-]/g, "_")}`;
      if (graph.nodes.some(node => node.id === id)) throw Error("TIMELINE_TRANSITION_NATIVE_NODE_ID_COLLISION");
      composite = { id, kind: "timeline_transition_v1", enabled: true, inputs: [to.branchNodeId], blendMode: "normal", opacity: 1 };
      for (const node of consumers) node.inputs = node.inputs.map(input => input === to.branchNodeId ? id : input);
      graph.nodes.push(composite);
    }
    const spec: NativeTimelinePairSpecV1 = { id: plan.transition.id, trackId: plan.transition.trackId,
      kernel, startFrame: plan.startFrame, cutFrame: plan.cutFrame, endFrame: plan.endFrame, from, to };
    composite.kind = "timeline_transition_v1";
    composite.plans = [...(composite.plans as NativeTimelinePairSpecV1[] | undefined ?? []), spec];
  }
  return graph;
}

/** Versioned resident pair handles always bind original media, including other
 * instances of the same asset; a nominal 15fps proxy cannot supply these reads. */
export function nativePairAssetIdsV1(project: EditProject): Set<string> {
  const clips = new Map(project.tracks.flatMap(track => track.clips).map(clip => [clip.id, clip]));
  return new Set(compileTimelineTransitionHandlesV1(project).flatMap(pair =>
    [clips.get(pair.from.clipId)!.assetId, clips.get(pair.to.clipId)!.assetId]));
}

export function reserveNativePairResourcesV1(resources: GpuEngineVideoResourceEstimate | undefined, pairCount: number, videoLayerCount: number): GpuEngineVideoResourceEstimate | undefined {
  if (!resources || pairCount === 0) return resources;
  if (!Number.isSafeInteger(pairCount) || pairCount < 0 || !Number.isSafeInteger(videoLayerCount) || videoLayerCount < 1) return undefined;
  const extra = resources.pixelCount * 32; // Two styled RGBA16F scenes and two RGBA16F composite targets.
  const requiredBytes = resources.requiredBytes + extra;
  const overhead = resources.requiredBytes - resources.bytesPerVideoLayer * videoLayerCount;
  const maxVideoLayers = Math.max(0, Math.floor((resources.budgetBytes - overhead - extra) / resources.bytesPerVideoLayer));
  if (![extra, requiredBytes, maxVideoLayers].every(Number.isSafeInteger) || requiredBytes > resources.budgetBytes) return undefined;
  return { ...resources, compositorWorkingBytes: resources.compositorWorkingBytes + extra,
    maximumFullFramePassesPerPresent: resources.maximumFullFramePassesPerPresent + pairCount * 3, requiredBytes, maxVideoLayers };
}
