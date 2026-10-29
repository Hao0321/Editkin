import type { EditProject, MotionGraphic, MotionVectorShapeCommand, TimelineClip, Transform2D } from "../domain/types";
import { animatedClipState } from "../domain/editGraph";
import { composeClipTransforms } from "../domain/clipMirrors";
import { assertVectorTrackingProjectV1, assertVectorTrackingQuadV1, vectorTrackingPoseAtV1 } from "../domain/vectorTrackingV1";
import { motionVectorPaths, shapePaths, type MotionVectorPath } from "../motion/vectorGeometry";
import type { MotionGraphicV2FrameReceipt, MotionGraphicV2LayoutReceipt } from "../motion/compositionV2";
type Point = { x: number; y: number }; type Matrix = number[];
const identity: Matrix = [1,0,0,0,1,0,0,0,1];
function apply(m: Matrix, p: Point): Point {
  const d = m[6] * p.x + m[7] * p.y + m[8];
  if (!Number.isFinite(d) || Math.abs(d) < 1e-7) throw new Error("VECTOR_TRACKING_HORIZON");
  const result = { x: (m[0] * p.x + m[1] * p.y + m[2]) / d, y: (m[3] * p.x + m[4] * p.y + m[5]) / d };
  if (![result.x,result.y].every(n => Number.isFinite(n) && Math.abs(n) <= 32768)) throw new Error("VECTOR_TRACKING_POINT_BUDGET");
  return result;
}
function inverse(m: Matrix): Matrix {
  const [a,b,c,d,e,f,g,h,i] = m, cof = [e*i-f*h,c*h-b*i,b*f-c*e,f*g-d*i,a*i-c*g,c*d-a*f,d*h-e*g,b*g-a*h,a*e-b*d];
  const determinant = a * cof[0] + b * cof[3] + c * cof[6];
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-10) throw new Error("VECTOR_TRACKING_MATRIX_SINGULAR");
  return cof.map(n => n / determinant);
}
function transform(project: EditProject, clip: TimelineClip, playhead: number, seen = new Set<string>()): Transform2D {
  if (seen.has(clip.id) || seen.size > 32) throw new Error("VECTOR_TRACKING_PARENT_CYCLE_OR_BUDGET");
  seen.add(clip.id); const local = animatedClipState(clip, playhead - clip.timelineStart, project.fps).transform;
  if (!clip.layer?.parentClipId) return local;
  const parent = project.tracks.flatMap(t => t.clips).find(c => c.id === clip.layer?.parentClipId);
  if (!parent || parent.transform3d || parent.floatingFrame) throw new Error("VECTOR_TRACKING_PARENT_GEOMETRY_UNSUPPORTED");
  return composeClipTransforms(transform(project, parent, playhead, seen), local);
}
/** Source normalized point -> contain-padded canvas -> crop/viewport -> existing composed 2D transform. */
function clipMatrix(project: EditProject, clip: TimelineClip, playhead: number): Matrix {
  const asset = project.assets.find(a => a.id === clip.assetId)!, ratio = asset.displayAspectRatio ?? (asset.width! / asset.height!);
  if (!Number.isFinite(ratio) || ratio <= 0) throw new Error("VECTOR_TRACKING_SOURCE_DISPLAY_GEOMETRY_REQUIRED");
  const W = project.width, H = project.height, fitW = Math.min(W,H*ratio), fitH = fitW / ratio;
  const crop = clip.layout?.crop ?? { x:0,y:0,width:1,height:1 }, view = clip.layout?.viewport ?? { x:0,y:0,width:1,height:1 };
  const sx = fitW * view.width / crop.width, sy = fitH * view.height / crop.height;
  const bx = W*view.x + ((W-fitW)/2-W*crop.x)*view.width/crop.width, by = H*view.y + ((H-fitH)/2-H*crop.y)*view.height/crop.height;
  const t = transform(project,clip,playhead), radians = t.rotation*Math.PI/180, c = Math.cos(radians)*t.scale, s = Math.sin(radians)*t.scale;
  const fx = t.flipX ? -1 : 1, fy = t.flipY ? -1 : 1, cx = W*(view.x+view.width/2), cy = H*(view.y+view.height/2);
  const m = [c*fx*sx,-s*fy*sy,c*fx*(bx-cx)-s*fy*(by-cy)+cx+t.x,s*fx*sx,c*fy*sy,s*fx*(bx-cx)+c*fy*(by-cy)+cy+t.y,0,0,1];
  if (m.some(n=>!Number.isFinite(n)) || t.scale < .0001) throw new Error("VECTOR_TRACKING_CLIP_MATRIX_INVALID"); return m;
}
export function vectorTrackingHomographyV1(from: readonly Point[], to: readonly Point[]): Matrix {
  assertVectorTrackingQuadV1(from);assertVectorTrackingQuadV1(to); const rows:number[][]=[];
  for(let i=0;i<4;i++){const{x,y}=from[i],{x:u,y:v}=to[i];rows.push([x,y,1,0,0,0,-u*x,-u*y,u],[0,0,0,x,y,1,-v*x,-v*y,v]);}
  for(let col=0;col<8;col++){let pivot=col;for(let r=col+1;r<8;r++)if(Math.abs(rows[r][col])>Math.abs(rows[pivot][col]))pivot=r;
    if(Math.abs(rows[pivot][col])<1e-10)throw new Error("VECTOR_TRACKING_MATRIX_SINGULAR");[rows[col],rows[pivot]]=[rows[pivot],rows[col]];
    const d=rows[col][col];for(let j=col;j<=8;j++)rows[col][j]/=d;
    for(let r=0;r<8;r++)if(r!==col){const f=rows[r][col];for(let j=col;j<=8;j++)rows[r][j]-=f*rows[col][j];}}
  return [...rows.map(r=>r[8]),1];
}
function contours(text: string): Point[][] {
  const tokens = text.trim().split(/\s+/); if(tokens.length>65536)throw new Error("VECTOR_TRACKING_PATH_BUDGET");
  const result:Point[][]=[];let line:Point[]|undefined,op='';
  for(let i=0;i<tokens.length;){if(['m','l','b'].includes(tokens[i]))op=tokens[i++];const count=op==='b'?6:op==='m'||op==='l'?2:0;if(!count)throw new Error("VECTOR_TRACKING_PATH_GRAMMAR");
    const n=tokens.slice(i,i+count).map(Number);i+=count;if(n.length!==count||n.some(v=>!Number.isFinite(v)))throw new Error("VECTOR_TRACKING_PATH_GRAMMAR");
    if(op==='m'){line=[{x:n[0],y:n[1]}];result.push(line);op='l';}else if(!line)throw new Error("VECTOR_TRACKING_PATH_GRAMMAR");
    else if(op==='l')line.push({x:n[0],y:n[1]});else{const p=line.at(-1)!;for(let step=1;step<=48;step++){const t=step/48,u=1-t;line.push({x:u*u*u*p.x+3*u*u*t*n[0]+3*u*t*t*n[2]+t*t*t*n[4],y:u*u*u*p.y+3*u*u*t*n[1]+3*u*t*t*n[3]+t*t*t*n[5]});}}
  }return result;
}
/** Existing unbound path objects are returned unchanged. Only the explicit new binding projects shared filled contours. */
export function trackedMotionVectorPathsV1(project: EditProject, graphic: MotionGraphic, layout: MotionGraphicV2LayoutReceipt, frame: MotionGraphicV2FrameReceipt): MotionVectorPath[] {
  const original = motionVectorPaths(graphic,layout,frame); if(!graphic.vectorTrackingV1)return original;
  const binding=graphic.vectorTrackingV1,{track,clip}=assertVectorTrackingProjectV1(project,graphic,false)!,time=frame.timelineFrame/project.fps;
  if(!original.length)return original;
  const reference=vectorTrackingPoseAtV1(track,binding.referenceTime)!,current=vectorTrackingPoseAtV1(track,time-clip.timelineStart);if(!current)return [];
  const before=inverse(clipMatrix(project,clip,clip.timelineStart+binding.referenceTime)),after=clipMatrix(project,clip,time);
  let follow=identity;
  if(binding.mode==='surface'){if(!reference.quad||!current.quad)throw new Error("VECTOR_TRACKING_SURFACE_QUAD_REQUIRED");follow=vectorTrackingHomographyV1(reference.quad,current.quad);}
  else {
    const asset=project.assets.find(a=>a.id===clip.assetId)!,ratio=asset.displayAspectRatio??asset.width!/asset.height!,a=(current.rotationDegrees-reference.rotationDegrees)*Math.PI/180,scale=current.scale/reference.scale;
    const c=Math.cos(a)*scale,s=Math.sin(a)*scale,rx=reference.rect.x+reference.rect.width/2,ry=reference.rect.y+reference.rect.height/2,cx=current.rect.x+current.rect.width/2,cy=current.rect.y+current.rect.height/2;
    follow=[c,-s/ratio,cx-c*rx+s*ry/ratio,s*ratio,c,cy-s*ratio*rx-c*ry,0,0,1];
  }
  let vertices=0;
  return original.map(path=>{if(path.clip)throw new Error("VECTOR_TRACKING_PATH_CLIP_UNSUPPORTED");const commands:MotionVectorShapeCommand[]=[];
    for(const line of contours(path.ass)){for(let i=0;i<line.length;i++){if(++vertices>8192)throw new Error("VECTOR_TRACKING_VERTEX_BUDGET");
      const world={x:layout.box.x+line[i].x,y:layout.box.y+line[i].y},p=apply(after,apply(follow,apply(before,world)));
      commands.push({type:i===0?'M':'L',x:p.x-layout.box.x,y:p.y-layout.box.y});}commands.push({type:'Z'});}
    return{color:path.color,...shapePaths(commands)};});
}

// Existing numeric leaves shared with opt-in physical text tracking.
export { clipMatrix as vectorTrackingClipMatrixV1, inverse as vectorTrackingInverseV1, apply as vectorTrackingTransformPointV1 };
