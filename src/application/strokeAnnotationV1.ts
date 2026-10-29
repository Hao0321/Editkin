import * as z from "zod/v4";
import type { EditProject, MotionGraphic, MotionVectorShapeCommand } from "../domain/types";
import { vectorTrackingV1Schema, assertVectorTrackingProjectV1 } from "../domain/vectorTrackingV1";
import { applyCommand } from "../domain/commands";
import { motionGraphicV2LayoutReceipt } from "../motion/compositionV2";
const number = z.number().finite().min(0).max(4096), point = z.strictObject({ x:number,y:number });
export const strokeAnnotationRequestV1Schema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(), id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), name: z.string().trim().min(1).max(120),
  range: z.strictObject({ startFrame:z.number().int().nonnegative(),endFrame:z.number().int().positive() }),
  box: z.strictObject({ x:number,y:number,width:z.number().finite().min(16).max(4096),height:z.number().finite().min(1).max(4096) }),
  geometry: z.discriminatedUnion("kind",[
    z.strictObject({kind:z.literal("underline"),start:point,end:point}),
    z.strictObject({kind:z.literal("arrow"),start:point,end:point,headLength:z.number().finite().min(1).max(256),headAngleDegrees:z.number().finite().min(15).max(80)}),
    z.strictObject({kind:z.literal("circle"),center:point,radiusX:z.number().finite().min(1).max(2048),radiusY:z.number().finite().min(1).max(2048)}),
  ]),
  inkColor:z.string().regex(/^#[a-f0-9]{6}(?:[a-f0-9]{2})?$/i),widthPixels:z.number().finite().min(.5).max(64),
  revealFrames:z.number().int().min(1).max(600), tracking:vectorTrackingV1Schema.optional(),
  purpose:z.string().trim().min(1).max(500),evidenceRefs:z.array(z.string().trim().min(1).max(160)).min(1).max(8),
});
export function prepareStrokeAnnotationV1(project: EditProject, payload: unknown) {
  const request=strokeAnnotationRequestV1Schema.parse(payload),{box,geometry,range}=request,duration=range.endFrame-range.startFrame;
  if(request.expectedRevision!==project.revision)throw new Error("STROKE_ANNOTATION_PROJECT_REVISION_CHANGED");
  if(!Number.isFinite(project.fps)||project.fps<1||project.fps>240||range.endFrame/project.fps>86400||duration<2||duration>1800||request.revealFrames>duration)throw new Error("STROKE_ANNOTATION_CLOCK_BUDGET");
  if(project.motionGraphics.some(g=>g.id===request.id)||box.x+box.width>project.width||box.y+box.height>project.height)throw new Error("STROKE_ANNOTATION_ID_OR_BOX");
  const commands:MotionVectorShapeCommand[]=[];
  if(geometry.kind==='circle'){
    const{x:cx,y:cy}=geometry.center,rx=geometry.radiusX,ry=geometry.radiusY,k=.5522847498307936;
    if(cx-rx<0||cy-ry<0||cx+rx>box.width||cy+ry>box.height)throw new Error("STROKE_ANNOTATION_GEOMETRY_OUTSIDE_BOX");
    commands.push({type:'M',x:cx+rx,y:cy},{type:'C',x1:cx+rx,y1:cy+k*ry,x2:cx+k*rx,y2:cy+ry,x:cx,y:cy+ry},
      {type:'C',x1:cx-k*rx,y1:cy+ry,x2:cx-rx,y2:cy+k*ry,x:cx-rx,y:cy},
      {type:'C',x1:cx-rx,y1:cy-k*ry,x2:cx-k*rx,y2:cy-ry,x:cx,y:cy-ry},
      {type:'C',x1:cx+k*rx,y1:cy-ry,x2:cx+rx,y2:cy-k*ry,x:cx+rx,y:cy},{type:'Z'});
  }else{
    const dx=geometry.end.x-geometry.start.x,dy=geometry.end.y-geometry.start.y,length=Math.hypot(dx,dy);
    if(length<1)throw new Error("STROKE_ANNOTATION_DEGENERATE_LINE");
    commands.push({type:'M',...geometry.start},{type:'L',...geometry.end});
    if(geometry.kind==='arrow'){
      if(geometry.headLength>length)throw new Error("STROKE_ANNOTATION_HEAD_TOO_LONG");
      const base=Math.atan2(dy,dx)+Math.PI,a=geometry.headAngleDegrees*Math.PI/180;
      for(const angle of [base-a,base+a])commands.push({type:'M',...geometry.end},{type:'L',x:geometry.end.x+Math.cos(angle)*geometry.headLength,y:geometry.end.y+Math.sin(angle)*geometry.headLength});
    }
    if(commands.some(c=>c.type!=='Z'&&(c.x<0||c.y<0||c.x>box.width||c.y>box.height)))throw new Error("STROKE_ANNOTATION_GEOMETRY_OUTSIDE_BOX");
  }
  const phase={durationFrames:1,offsetXPixels:0,offsetYPixels:0,scale:1,opacity:1,easing:{type:'linear' as const}};
  const graphic:MotionGraphic={id:request.id,kind:'card',text:'',timelineStart:range.startFrame/project.fps,duration:duration/project.fps,
    schema:'hao.motion-composition/v2',name:request.name,x:box.x/project.width,y:box.y/project.height,width:box.width/project.width,
    fontSize:8,backgroundColor:request.inkColor,textColor:'#FFFFFF',accentColor:request.inkColor,outlineWidth:0,shadowDepth:0,cornerRadius:0,
    animation:'fade',offsetX:0,offsetY:0,compositeLayer:'foreground',
    motionV2:{sequence:{unit:'all',order:'forward',exitOrder:'forward',staggerFrames:0,exitStaggerFrames:0},entrance:{...phase},exit:{...phase}},
    layoutV2:{safeArea:{top:0,right:0,bottom:0,left:0},maxLines:1,minFontSize:8,lineGap:0,align:'left'},
    vectorV2:{schema:'editkin.motion-vector-stroke/v1',kind:'stroke',heightPixels:box.height,revealFrames:request.revealFrames,commands,widthPixels:request.widthPixels,cap:'round',tipRadiusPixels:0,stack:'over_text'},
  };
  if(request.tracking){graphic.vectorTrackingV1=structuredClone(request.tracking);graphic.vectorV2!.schema='editkin.motion-vector-tracked-stroke/v1';}
  assertVectorTrackingProjectV1(project,graphic);
  const command={type:'add_motion_graphic' as const,graphic},applied=applyCommand(project,command),layout=motionGraphicV2LayoutReceipt(applied,applied.motionGraphics.find(g=>g.id===graphic.id)!);
  if(Math.abs(layout.box.x-box.x)>1e-6||Math.abs(layout.box.y-box.y)>1e-6||Math.abs(layout.box.width-box.width)>1e-6)throw new Error("STROKE_ANNOTATION_LAYOUT_CHANGED_AUTHORED_BOX");
  return{schema:'editkin.stroke-annotation-plan/v1' as const,command,projectId:project.id,projectRevision:project.revision,purpose:request.purpose,evidenceRefs:request.evidenceRefs,
    renderer:'existing stroke/v1 shared SVG and ASS; explicit vector-tracking/v1 when present' as const,qualityState:'ART_PENDING_CLAUDE' as const,defaultEnabled:false as const,directApplyAllowed:false as const};
}
