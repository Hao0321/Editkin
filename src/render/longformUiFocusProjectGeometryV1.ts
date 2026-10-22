import type { EditProject, TimelineClip, Transform2D } from "../domain/types";
import type { LongformUiFocusGeometryWitnessV1, LongformUiFocusProjectedQuadV1, LongformUiFocusRasterSizeV1 } from "../domain/longformUiFocusProjectGeometryV1";
import { animatedClipState } from "../domain/editGraph";
import { composeClipTransforms } from "../domain/clipMirrors";
import { animatedGeometryCanvas } from "./animatedGeometryCanvas";
import { compositeFrameClock } from "./compositeFrameClock";
import { composedTransformExpressions } from "./ffmpegExpressions";
type Point = { x: number; y: number };
const fail = (code: string): never => { throw Error("UI_FOCUS_PROJECT_GEOMETRY_" + code); };
function size(value: LongformUiFocusRasterSizeV1) {
  if (!value || ![value.width,value.height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=16384) || value.width*value.height>64_000_000) fail("RASTER_BUDGET");
}
function sameSize(a: LongformUiFocusRasterSizeV1,b: LongformUiFocusRasterSizeV1) { return a.width===b.width&&a.height===b.height; }
function transformAt(project: EditProject,clip: TimelineClip,time: number,visiting=new Set<string>()): Transform2D {
  if(visiting.has(clip.id)) fail("PARENT_CYCLE");
  const local=animatedClipState(clip,time-clip.timelineStart,project.fps).transform;
  if(![local.x,local.y,local.scale,local.rotation,local.opacity].every(Number.isFinite)||local.scale<=0||local.opacity<0||local.opacity>1) fail("TRANSFORM");
  if(!clip.layer?.parentClipId)return local;
  const parent=project.tracks.flatMap(track=>track.clips).find(row=>row.id===clip.layer!.parentClipId);
  if(!parent) fail("PARENT_MISSING");
  const next=new Set(visiting);next.add(clip.id);
  return composeClipTransforms(transformAt(project,parent!,time,next),local);
}
function rect(value: {x:number;y:number;width:number;height:number}) {
  if(![value.x,value.y,value.width,value.height].every(Number.isFinite)||value.x<0||value.y<0||value.width<=0||value.height<=0
    ||value.x+value.width>1+1e-10||value.y+value.height>1+1e-10)fail("LAYOUT");
}
function quad(value: readonly Point[]) {
  if(value.length!==4||value.some(p=>![p.x,p.y].every(Number.isFinite)||p.x<0||p.x>1||p.y<0||p.y>1))fail("SOURCE_QUAD");
  const cross=value.map((a,i)=>{const b=value[(i+1)%4],c=value[(i+2)%4];return(b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x)});
  if(!cross.every(n=>n>1e-12)&&!cross.every(n=>n< -1e-12))fail("SOURCE_QUAD");
}
/** Project actual source-display edge coordinates through the existing FF
 * stages. Fit/affine dimensions and integer placement must be measured, not
 * guessed. Geometry and placement deliberately keep their separate clocks.
 * This pure internal primitive does not accept a source/OCR authority grant. */
export function projectLongformUiFocusQuadV1(projectInput: EditProject,clipId: string,sourceQuad: readonly Point[],
  witness: LongformUiFocusGeometryWitnessV1,bottomReserve: number): LongformUiFocusProjectedQuadV1 {
  const project=structuredClone(projectInput),track=project.tracks.find(row=>row.clips.some(clip=>clip.id===clipId)),clip=track?.clips.find(row=>row.id===clipId);
  if(!clip||track?.kind!=="video"||track.hidden||clip.layer?.enabled===false)fail("VISIBLE_CLIP");
  if(project.scene25d?.enabled||project.scene3d||clip!.transform3d||clip!.floatingFrame||clip!.masks?.some(row=>row.enabled)
    ||clip!.chromaKey?.enabled||clip!.layer?.trackMatte||["controller","adjustment"].includes(clip!.layer?.role??"content")
    ||clip!.creative?.transitionIn||clip!.creative?.transitionOut||clip!.creative?.effectPresetIds?.length
    ||clip!.creative?.nativeEffectInstances?.length)fail("UNVERIFIED_VISIBILITY_ROUTE");
  size(project);size(witness.fit);size(witness.layout);size(witness.affine.input);size(witness.affine.scaled);size(witness.affine.output);quad(sourceQuad);
  const clock=compositeFrameClock(project.fps,clip!.timelineStart),[denominator,numerator]=clock.rate.split("/").map(Number);
  if(witness.schema!=="editkin.longform-ui-focus-geometry-witness/v1"||witness.timeBase.numerator!==numerator||witness.timeBase.denominator!==denominator
    ||![witness.projectFrame,witness.geometryPts,witness.placement.x,witness.placement.y].every(Number.isSafeInteger)
    ||witness.projectFrame<clock.startFrame||witness.projectFrame>=clock.startFrame+Math.ceil(clip!.duration*project.fps)+1
    ||!Number.isFinite(bottomReserve)||bottomReserve<0||bottomReserve>=project.height)fail("CLOCK_OR_PLACEMENT");
  if(witness.fit.width>project.width||witness.fit.height>project.height)fail("FIT_RASTER");
  const layout=clip!.layout;if(layout){rect(layout.crop);rect(layout.viewport);}
  const crop=layout?{x:Math.max(0,Math.round(project.width*layout.crop.x)),y:Math.max(0,Math.round(project.height*layout.crop.y)),
    width:Math.max(2,Math.round(project.width*layout.crop.width)),height:Math.max(2,Math.round(project.height*layout.crop.height))}:
    {x:0,y:0,width:project.width,height:project.height};
  const base=layout?{width:Math.max(2,Math.round(project.width*layout.viewport.width)),height:Math.max(2,Math.round(project.height*layout.viewport.height))}:
    {width:project.width,height:project.height};
  if(crop.x+crop.width>project.width||crop.y+crop.height>project.height||!sameSize(base,witness.layout))fail("LAYOUT_RASTER");
  const geometryTime=witness.geometryPts*numerator/denominator,projectTime=witness.projectFrame*numerator/denominator;
  const geometry=transformAt(project,clip!,clip!.timelineStart+geometryTime),position=transformAt(project,clip!,projectTime);
  const fixed=animatedGeometryCanvas(project,clip!,project.width,project.height);
  if(fixed){
    if(witness.affine.mode!=="fixed-perspective"||!sameSize(fixed,witness.affine.input)||!sameSize(fixed,witness.affine.output)
      ||!sameSize(fixed,witness.affine.scaled))fail("AFFINE_RASTER");
  }else{
    const composed=composedTransformExpressions(project,clip!,"t",project.fps),scaled=composed.scale==="1"?base:
      {width:Math.max(1,Math.trunc(base.width*geometry.scale)),height:Math.max(1,Math.trunc(base.height*geometry.scale))};
    const angle=geometry.rotation*Math.PI/180,animated=/\b(?:t|T|n|N)\b/.test(composed.rotation),rotating=composed.rotation!=="0";
    const output=rotating?(animated?{width:Math.ceil(Math.hypot(scaled.width,scaled.height)/2)*2,height:Math.ceil(Math.hypot(scaled.width,scaled.height)/2)*2}:
      {width:Math.ceil((Math.abs(scaled.width*Math.cos(angle))+Math.abs(scaled.height*Math.sin(angle)))/2)*2,
        height:Math.ceil((Math.abs(scaled.width*Math.sin(angle))+Math.abs(scaled.height*Math.cos(angle)))/2)*2}):scaled;
    if(witness.affine.mode!=="scale-rotate"||!sameSize(base,witness.affine.input)||!sameSize(scaled,witness.affine.scaled)
      ||!sameSize(output,witness.affine.output))fail("AFFINE_RASTER");
  }
  // overlay may quantize coordinates to its current subsampling grid. Require
  // the observed integer placement to agree within at most one two-pixel cell.
  const cx=layout?project.width*(layout.viewport.x+layout.viewport.width/2):project.width/2;
  const cy=layout?project.height*(layout.viewport.y+layout.viewport.height/2):project.height/2;
  if(Math.abs(witness.placement.x-(cx-witness.affine.output.width/2+position.x))>2.01
    ||Math.abs(witness.placement.y-(cy-witness.affine.output.height/2+position.y))>2.01)fail("POSITION_BINDING");
  const pad={x:Math.floor((project.width-witness.fit.width)/2),y:Math.floor((project.height-witness.fit.height)/2)};
  const angle=geometry.rotation*Math.PI/180,cos=Math.cos(angle),sin=Math.sin(angle);
  const projectQuad=sourceQuad.map(point=>{
    const fitted={x:point.x*witness.fit.width+pad.x,y:point.y*witness.fit.height+pad.y};
    if(fitted.x<crop.x-1e-9||fitted.x>crop.x+crop.width+1e-9||fitted.y<crop.y-1e-9||fitted.y>crop.y+crop.height+1e-9)fail("CROPPED_TARGET");
    let x=(fitted.x-crop.x)*base.width/crop.width,y=(fitted.y-crop.y)*base.height/crop.height;
    if(geometry.flipX)x=base.width-x;if(geometry.flipY)y=base.height-y;
    if(fixed){x+=Math.floor((fixed.width-base.width)/2);y+=Math.floor((fixed.height-base.height)/2);
      x=(x-fixed.width/2)*geometry.scale;y=(y-fixed.height/2)*geometry.scale;
    }else{x=x*witness.affine.scaled.width/base.width-witness.affine.scaled.width/2;
      y=y*witness.affine.scaled.height/base.height-witness.affine.scaled.height/2;}
    const destination={x:witness.placement.x+witness.affine.output.width/2+x*cos-y*sin,
      y:witness.placement.y+witness.affine.output.height/2+x*sin+y*cos};
    if(![destination.x,destination.y].every(Number.isFinite)||destination.x< -1e-8||destination.x>project.width+1e-8
      ||destination.y< -1e-8||destination.y>project.height-bottomReserve+1e-8)fail("PROJECT_SAFE_AREA");
    return{x:destination.x/project.width,y:destination.y/project.height};
  });
  return{schema:"editkin.longform-ui-focus-projected-quad/v1",projectFrame:witness.projectFrame,geometryTime,projectTime,projectQuad,
    clipOpacity:geometry.opacity,coordinateSpace:"project-display",stageGeometryProjected:true,sourceTargetVerified:false,
    editableProjectGraphCompiled:false,nativePresentationVerified:false,browserPresentationVerified:false,
    projectModified:false,focusHintsReady:false,artworkStatus:"ART_PENDING_CLAUDE",selectableByDefault:false};
}
