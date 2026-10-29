import type { MaskKeyframe, MaskPointStatus, MotionTrack } from "./types";
import { vectorTrackingPoseAtV1 } from "./vectorTrackingV1";
import type { MotionTrackPose } from "./motionTrackSampling";
import { assertColorWindowMaskV1, assertColorWindowPathV1, COLOR_WINDOW_LIMITS_V1, colorWindowRefuseV1,
  type ColorWindowMaskV1, type ColorWindowPointV1, type ColorWindowShapeV1 } from "./colorWindowV1";
import { colorWindowInverseMatrixV1, colorWindowMapPointV1, colorWindowQuadMatrixV1, type ColorWindowMatrixV1 } from "./colorWindowMathV1";

export interface ColorWindowGeometryV1 {
  maskId: string; kind: ColorWindowShapeV1; width: number; height: number;
  /** Plane-pixel coordinates. Coverage samples each pixel at (x+.5,y+.5). */
  points: readonly ColorWindowPointV1[];
  status: MaskPointStatus;
  reason: "manual" | "tracked" | "held" | "track_missing" | "track_lost" | "keyframe_lost" | "invalid_geometry" | "disabled";
  featherPx: number; expansionPx: number; inverted: boolean; opacity: number;
  ellipseInverse?: ColorWindowMatrixV1; ellipseCenterDepth?: number;
}
function animatedPath(mask: ColorWindowMaskV1, time: number): { points: ColorWindowPointV1[]; status: MaskPointStatus } {
  const keys=mask.keyframes;
  if (!keys.length) return {points:mask.path,status:"manual"};
  let low=0,high=keys.length;
  while(low<high) { const mid=Math.floor((low+high)/2); if(keys[mid].time<time) low=mid+1;else high=mid; }
  const single=(key: MaskKeyframe)=>({points:key.points,status:key.status});
  if (low===keys.length) return single(keys.at(-1)!);
  if (low===0 || Math.abs(keys[low].time-time)<=Number.EPSILON) return single(keys[low]);
  const before=keys[low-1],after=keys[low];
  if (before.status==="lost") return single(before);
  if (after.status==="lost") return {...single(before),status:"held"};
  const t=(time-before.time)/(after.time-before.time);
  return {points:before.points.map((p,i)=>({x:p.x+(after.points[i].x-p.x)*t,y:p.y+(after.points[i].y-p.y)*t})),
    status:before.status==="held"||after.status==="held"?"held":before.status==="manual"&&after.status==="manual"?"manual":"tracked"};
}
function snapshotTrack(source: MotionTrack, clipId: string, maskId: string): MotionTrack {
  const r=source.initialRect;
  if (source.clipId!==clipId || !Array.isArray(source.points) || source.points.length>COLOR_WINDOW_LIMITS_V1.trackPoints
    || !r || ![r.x,r.y,r.width,r.height].every(Number.isFinite) || r.width<=0 || r.height<=0) colorWindowRefuseV1("COLOR_WINDOW_TRACK",maskId);
  let time=-1;
  const hasQuad=source.points.some(p=>p.status!=="lost"&&p.quad);
  for (const p of source.points) {
    if (!Number.isFinite(p.time) || p.time<0 || p.time<=time || !Number.isSafeInteger(p.frame) || p.frame<0
      || !["manual","tracked","held","lost"].includes(p.status) || !Number.isFinite(p.confidence) || p.confidence<0 || p.confidence>1
      || !p.rect || ![p.rect.x,p.rect.y,p.rect.width,p.rect.height].every(Number.isFinite) || p.rect.width<=0 || p.rect.height<=0
      || !Number.isFinite(p.rotationDegrees??0) || Math.abs(p.rotationDegrees??0)>1e9 || !Number.isFinite(p.scale??1) || (p.scale??1)<=0 || (p.scale??1)>1e6) colorWindowRefuseV1("COLOR_WINDOW_TRACK",maskId);
    if (p.status!=="lost") {
      if (hasQuad && !p.quad) colorWindowRefuseV1("COLOR_WINDOW_TRACK",maskId);
      if (p.quad) assertColorWindowPathV1("rectangle",p.quad,maskId,true);
      else if (p.rotationDegrees && p.scale===undefined) colorWindowRefuseV1("COLOR_WINDOW_TRACK",maskId);
    }
    time=p.time;
  }
  return structuredClone(source);
}
function trackMap(track: MotionTrack, pose: MotionTrackPose, width: number, height: number, hasScale: boolean): ColorWindowMatrixV1 {
  let quad=pose.quad;
  if (!quad) {
    const cx=pose.rect.x+pose.rect.width/2,cy=pose.rect.y+pose.rect.height/2;
    const w=hasScale?track.initialRect.width*pose.scale:pose.rect.width;
    const h=hasScale?track.initialRect.height*pose.scale:pose.rect.height;
    const radians=pose.rotationDegrees*Math.PI/180,c=Math.cos(radians),s=Math.sin(radians);
    const corner=(x:number,y:number)=>({x:cx+c*x*w/2-s*y*h*height/width/2,y:cy+s*x*w*width/height/2+c*y*h/2});
    quad=[corner(-1,-1),corner(1,-1),corner(1,1),corner(-1,1)];
  }
  assertColorWindowPathV1("rectangle",quad!,undefined,true);
  return colorWindowQuadMatrixV1(quad!);
}

/** Compile once per immutable source revision; sampling never builds a duration-sized frame array.
 * Authored paths bind in initialRect coordinates, so changing a tracker does not erase a user's shape/offset.
 * Tracked quads include perspective; rect-only observations use their size, or explicit scale+rotation.
 */
export function compileColorWindowGeometryV1(input: {mask:ColorWindowMaskV1;clipId:string;width:number;height:number;tracks?:readonly MotionTrack[]}) {
  assertColorWindowMaskV1(input.mask);
  const {width,height}=input;
  if (![width,height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=32768)) colorWindowRefuseV1("COLOR_WINDOW_RASTER_BUDGET",input.mask.id);
  const mask=structuredClone(input.mask),matches=(input.tracks??[]).filter(track=>track.id===mask.trackId);
  if (mask.trackId && matches.length>1) colorWindowRefuseV1("COLOR_WINDOW_TRACK",mask.id);
  const track=mask.trackId&&matches.length?snapshotTrack(matches[0],input.clipId,mask.id):undefined;
  const explicitScale=track?.points.some(p=>p.scale!==undefined)??false;
  const scale=Math.min(width,height);
  const base={maskId:mask.id,kind:mask.kind as ColorWindowShapeV1,width,height,featherPx:mask.feather*scale,
    expansionPx:(mask.expansion+mask.refine.edgeShift)*scale,inverted:mask.inverted,opacity:mask.opacity};
  const hidden=(reason:ColorWindowGeometryV1["reason"]):ColorWindowGeometryV1=>({...base,points:[],status:"lost",reason});
  return Object.freeze({maskId:mask.id,width,height,trackPointCount:track?.points.length??0,
    at(localSeconds:number):ColorWindowGeometryV1 {
      if (!Number.isFinite(localSeconds)||localSeconds<0) colorWindowRefuseV1("COLOR_WINDOW_PARAMETERS",mask.id);
      if (!mask.enabled) return hidden("disabled");
      if (mask.trackId&&!track?.points.length) return hidden("track_missing");
      const authored=animatedPath(mask,localSeconds);
      if (authored.status==="lost") return hidden("keyframe_lost");
      let points=authored.points,status=authored.status;
      if (track) {
        const pose=vectorTrackingPoseAtV1(track,localSeconds);
        if (!pose || pose.status==="lost") return hidden("track_lost");
        try {
          const matrix=trackMap(track,pose,width,height,explicitScale);
          const r=track.initialRect;
          points=points.map(p=>colorWindowMapPointV1(matrix,{x:(p.x-r.x)/r.width,y:(p.y-r.y)/r.height}));
          assertColorWindowPathV1(mask.kind,points,mask.id,true);
        } catch { return hidden("invalid_geometry"); }
        status=pose.status;
      } else assertColorWindowPathV1(mask.kind,points,mask.id);
      const pixels=points.map(p=>({x:p.x*width,y:p.y*height}));
      const result:ColorWindowGeometryV1={...base,points:pixels,status,reason:status==="manual"?"manual":status==="held"?"held":"tracked"};
      if (mask.kind==="ellipse") {
        const matrix=colorWindowQuadMatrixV1(pixels),center=colorWindowMapPointV1(matrix,{x:.5,y:.5});
        result.ellipseInverse=colorWindowInverseMatrixV1(matrix);
        result.ellipseCenterDepth=Math.min(...[{x:0,y:.5},{x:1,y:.5},{x:.5,y:0},{x:.5,y:1}]
          .map(p=>{const edge=colorWindowMapPointV1(matrix,p);return Math.hypot(edge.x-center.x,edge.y-center.y);}));
      }
      return result;
    }});
}
