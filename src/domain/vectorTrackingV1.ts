import * as z from "zod/v4";
import type { EditProject, MotionGraphic, MotionTrack, MotionTrackPoint, TimelineClip } from "./types";
import { motionTrackPoseAt } from "./motionTrackSampling";
import { assertTrackedTextBindingV1 } from "./trackedTextBindingV1";

export const vectorTrackingV1Schema = z.strictObject({
  schema: z.literal("editkin.vector-tracking/v1"), trackId: z.string().min(1).max(160),
  mode: z.enum(["anchor", "surface"]), referenceTime: z.number().finite().min(0).max(86_400),
});
export type VectorTrackingV1 = z.infer<typeof vectorTrackingV1Schema>;
export function assertVectorTrackingGraphicV1(graphic: MotionGraphic): void {
  if (graphic.vectorV2?.kind === "stroke" && graphic.vectorV2.schema === "editkin.motion-vector-tracked-stroke/v1" && !graphic.vectorTrackingV1) throw new Error("VECTOR_TRACKING_BINDING_REQUIRED");
  if (!graphic.vectorTrackingV1) return;
  vectorTrackingV1Schema.parse(graphic.vectorTrackingV1);
  if (graphic.schema === "hao.motion-composition/v2" && !graphic.vectorV2 && typeof graphic.text === "string" && graphic.text.trim()) {
    assertTrackedTextBindingV1(graphic); return;
  }
  if (graphic.schema !== "hao.motion-composition/v2" || graphic.vectorV2?.kind !== "stroke" || graphic.vectorV2.schema !== "editkin.motion-vector-tracked-stroke/v1" || graphic.vectorV2.commands.length > 64
    || graphic.text || graphic.trackId || graphic.trackingMode || graphic.paintV1 || graphic.clipRegion || graphic.holdBeatV3
    || graphic.compositeLayer === "background" || graphic.offsetX !== 0 || graphic.offsetY !== 0) throw new Error("VECTOR_TRACKING_GRAPHIC_CONTRACT");
  const motion = graphic.motionV2;
  if (!motion || motion.sequence.unit !== "all" || motion.sequence.staggerFrames || motion.sequence.exitStaggerFrames) throw new Error("VECTOR_TRACKING_PASSIVE_POSE_REQUIRED");
  for (const p of [motion.entrance, motion.exit]) if (p.durationFrames !== 1 || p.offsetXPixels !== 0 || p.offsetYPixels !== 0 || p.scale !== 1
    || p.opacity !== 1 || p.rotationDegrees || p.blurPixels || p.spreadPixels) throw new Error("VECTOR_TRACKING_PASSIVE_POSE_REQUIRED");
}

/** Binary-search only the two neighbours; preserve the existing lost/hold/interpolation semantics without a frame array. */
export function vectorTrackingPoseAtV1(track: MotionTrack, time: number) {
  if (!Number.isFinite(time) || !track.points.length) return undefined;
  let low = 0, high = track.points.length;
  while (low < high) { const mid = (low + high) >>> 1; if (track.points[mid].time < time) low = mid + 1; else high = mid; }
  const points: MotionTrackPoint[] = low === track.points.length ? [track.points.at(-1)!] : low === 0 ? [track.points[0]] : [track.points[low - 1], track.points[low]];
  return motionTrackPoseAt({ ...track, points }, time);
}
export function assertVectorTrackingQuadV1(points: readonly { x:number;y:number }[]): void {
  if(points.length!==4||points.some(p=>![p.x,p.y].every(n=>Number.isFinite(n)&&n>=0&&n<=1)))throw new Error("VECTOR_TRACKING_QUAD_INVALID");
  const cross=points.map((p,i)=>{const a=points[(i+1)%4],b=points[(i+2)%4];return(a.x-p.x)*(b.y-a.y)-(a.y-p.y)*(b.x-a.x);});
  if(cross.some(c=>Math.abs(c)<1e-6||Math.sign(c)!==Math.sign(cross[0])))throw new Error("VECTOR_TRACKING_QUAD_DEGENERATE");
}
export function assertVectorTrackingProjectV1(project: EditProject, graphic: MotionGraphic, deep = true): { track: MotionTrack; clip: TimelineClip } | undefined {
  if (!graphic.vectorTrackingV1) return undefined;
  assertVectorTrackingGraphicV1(graphic);
  const binding = graphic.vectorTrackingV1, matches = project.motionTracks.filter(t => t.id === binding.trackId);
  if (matches.length !== 1 || !matches[0].points.length) throw new Error("VECTOR_TRACKING_TRACK_MISSING_OR_AMBIGUOUS");
  const track = matches[0], clips = project.tracks.flatMap(t => t.clips).filter(c => c.id === track.clipId);
  if (clips.length !== 1) throw new Error("VECTOR_TRACKING_CLIP_MISSING_OR_AMBIGUOUS");
  const clip = clips[0], asset = project.assets.find(a => a.id === clip.assetId), frames = graphic.duration * project.fps;
  if (!asset || asset.kind !== "video" || asset.compositionId || project.scene25d?.enabled || clip.floatingFrame || clip.transform3d || clip.timeRemap || (clip.speed ?? 1) !== 1 || asset.clipRetime
    || graphic.timelineStart < clip.timelineStart - 1e-8 || graphic.timelineStart + graphic.duration > clip.timelineStart + clip.duration + 1e-8
    || binding.referenceTime > clip.duration || Math.abs(frames - Math.round(frames)) > 1e-6 || frames < 2 || frames > 1800) throw new Error("VECTOR_TRACKING_SOURCE_RANGE_OR_GEOMETRY_UNSUPPORTED");
  const reference=vectorTrackingPoseAtV1(track,binding.referenceTime);
  if (!reference) throw new Error("VECTOR_TRACKING_REFERENCE_LOST");
  if(binding.mode==='surface'){
    if(!reference.quad)throw new Error("VECTOR_TRACKING_SURFACE_QUAD_REQUIRED");assertVectorTrackingQuadV1(reference.quad);
    if(deep)for(const p of track.points)if(p.status!=='lost'){
      if(!p.quad)throw new Error("VECTOR_TRACKING_SURFACE_QUAD_REQUIRED");assertVectorTrackingQuadV1(p.quad);
    }
  }
  return { track, clip };
}
