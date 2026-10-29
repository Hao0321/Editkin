import { describe,expect,it } from "vitest";
import { createEmptyProject,migrateProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import { DEFAULT_COLOR,DEFAULT_TRANSFORM,DEFAULT_CLIP_LAYER,DEFAULT_SCENE_25D,type EditProject } from "../domain/types";
import { motionGraphicV2LayoutReceipt,motionGraphicV2FrameReceipt } from "../motion/compositionV2";
import { motionVectorPaths } from "../motion/vectorGeometry";
import { motionTrackPoseAt } from "../domain/motionTrackSampling";
import { vectorTrackingPoseAtV1 } from "../domain/vectorTrackingV1";
import { motionGraphicSchema } from "../domain/schema";
import { prepareStrokeAnnotationV1 } from "./strokeAnnotationV1";
import { trackedMotionVectorPathsV1,vectorTrackingHomographyV1 } from "./trackedVectorPathsV1";
import { writeAssContent } from "../render/captionAss";
function fixture(){
  const project=createEmptyProject("Synthetic stroke executor",{id:"stroke-project",width:320,height:240,fps:30});
  project.assets=[{id:"source",name:"Synthetic source",kind:"video",uri:"D:/synthetic/stroke.mp4",duration:2,width:320,height:240,displayAspectRatio:4/3}];
  project.tracks[0].clips=[{id:"source-clip",assetId:"source",trackId:project.tracks[0].id,timelineStart:0,sourceStart:0,duration:2,volume:0,transform:{...DEFAULT_TRANSFORM},color:{...DEFAULT_COLOR},keyframes:[]}];
  const q=(x:number)=>[{x,y:.2},{x:x+.2,y:.2},{x:x+.2,y:.4},{x,y:.4}] as [any,any,any,any];
  project.motionTracks=[{id:"track",clipId:"source-clip",name:"Synthetic manual points",engine:"manual:synthetic",analysisFps:30,initialRect:{x:.2,y:.2,width:.2,height:.2},lostRatio:0,createdAt:"2026-10-15T00:00:00Z",
    points:[0,1,2].map((time,i)=>({time,frame:time*30,status:"manual" as const,confidence:1,rect:{x:.2+i*.1,y:.2,width:.2,height:.2},quad:q(.2+i*.1)}))}];
  const request={expectedRevision:0,id:"underline",name:"Owned numeric geometry control",range:{startFrame:0,endFrame:60},box:{x:50,y:40,width:100,height:60},
    geometry:{kind:"underline",start:{x:10,y:30},end:{x:90,y:30}},inkColor:"#FFFFFF",widthPixels:4,revealFrames:1,purpose:"Synthetic executor control, no art certification",evidenceRefs:["synthetic:stroke-control"]};
  return{project,request};
}
function paths(project:EditProject,frame:number){const g=project.motionGraphics[0],layout=motionGraphicV2LayoutReceipt(project,g),receipt=motionGraphicV2FrameReceipt(project,g,frame,layout);return trackedMotionVectorPathsV1(project,g,layout,receipt);}
const coordinates=(text:string)=>text.trim().split(/\s+/).filter(t=>!['m','l','b'].includes(t)).map(Number);
describe("original stroke authoring and shared lazy tracking",()=>{
  it("authors arrow/circle/underline with actual stroke reveal, save/reopen and zero old project mutation",()=>{
    const f=fixture(),before=JSON.stringify(f.project);
    for(const geometry of [f.request.geometry,{kind:"arrow",start:{x:10,y:30},end:{x:90,y:30},headLength:15,headAngleDegrees:30},{kind:"circle",center:{x:50,y:30},radiusX:35,radiusY:20}]){
      const plan=prepareStrokeAnnotationV1(f.project,{...f.request,geometry,revealFrames:8}),edited=applyCommand(f.project,plan.command),reopened=migrateProject(JSON.parse(JSON.stringify(edited)));
      expect(paths(reopened,0)).toEqual([]);expect(paths(reopened,8).length).toBeGreaterThan(0);expect(paths(reopened,59)).toEqual(paths(reopened,8));expect(paths(reopened,60)).toEqual([]);
      expect(plan).toMatchObject({defaultEnabled:false,qualityState:"ART_PENDING_CLAUDE",directApplyAllowed:false});expect(motionGraphicSchema.safeParse(plan.command.graphic).success).toBe(true);
    }expect(JSON.stringify(f.project)).toBe(before);
  });
  it("unbound graphics keep the existing exact SVG/ASS path objects and draw only their authored contours",()=>{
    const f=fixture(),p=applyCommand(f.project,prepareStrokeAnnotationV1(f.project,f.request).command),g=p.motionGraphics[0],l=motionGraphicV2LayoutReceipt(p,g);
    for(const frame of [0,1,20,59])expect(trackedMotionVectorPathsV1(p,g,l,motionGraphicV2FrameReceipt(p,g,frame,l))).toEqual(motionVectorPaths(g,l,motionGraphicV2FrameReceipt(p,g,frame,l)));
    expect(writeAssContent(p,p.captionStyle)).toContain("\\p1");
  });
  it("anchor interpolation follows source rect translation in exact canvas pixels and round-trips its explicit version",()=>{
    const f=fixture(),plan=prepareStrokeAnnotationV1(f.project,{...f.request,tracking:{schema:"editkin.vector-tracking/v1",trackId:"track",mode:"anchor",referenceTime:0}}),p=applyCommand(f.project,plan.command);
    expect(p.motionGraphics[0].vectorV2?.schema).toBe("editkin.motion-vector-tracked-stroke/v1");
    const a=coordinates(paths(p,0)[0].ass),b=coordinates(paths(p,15)[0].ass);expect(b.length).toBe(a.length);
    for(let i=0;i<a.length;i+=2){expect(b[i]-a[i]).toBeCloseTo(16,2);expect(b[i+1]-a[i+1]).toBeCloseTo(0,2);}
    expect(migrateProject(JSON.parse(JSON.stringify(p))).motionGraphics[0].vectorTrackingV1).toEqual(plan.command.graphic.vectorTrackingV1);
  });
  it("surface homography maps all four independently stated correspondences, including real perspective",()=>{
    const from=[{x:.1,y:.1},{x:.8,y:.1},{x:.8,y:.8},{x:.1,y:.8}],to=[{x:.2,y:.2},{x:.7,y:.1},{x:.9,y:.9},{x:.1,y:.7}],h=vectorTrackingHomographyV1(from,to);
    for(let i=0;i<4;i++){const p=from[i],d=h[6]*p.x+h[7]*p.y+1;expect((h[0]*p.x+h[1]*p.y+h[2])/d).toBeCloseTo(to[i].x,9);expect((h[3]*p.x+h[4]*p.y+h[5])/d).toBeCloseTo(to[i].y,9);}
    const f=fixture(),p=applyCommand(f.project,prepareStrokeAnnotationV1(f.project,{...f.request,tracking:{schema:"editkin.vector-tracking/v1",trackId:"track",mode:"surface",referenceTime:0}}).command);
    expect(paths(p,30)[0].ass).not.toBe(paths(p,0)[0].ass);
  });
  it("anchor rotation/scale are evaluated in source pixel aspect rather than distorting normalized axes",()=>{
    const f=fixture();f.project.motionTracks[0].points[1].rotationDegrees=90;f.project.motionTracks[0].points[1].scale=2;
    const p=applyCommand(f.project,prepareStrokeAnnotationV1(f.project,{...f.request,tracking:{schema:"editkin.vector-tracking/v1",trackId:"track",mode:"anchor",referenceTime:0}}).command);
    const a=coordinates(paths(p,0)[0].ass),b=coordinates(paths(p,30)[0].ass);
    for(let i=0;i<a.length;i+=2){expect(b[i]).toBeCloseTo(128-2*(40+a[i+1]-72)-50,2);expect(b[i+1]).toBeCloseTo(72+2*(50+a[i]-96)-40,2);}
  });
  it("clip crop/viewport and animated translation are composed, including mirrors",()=>{
    const f=fixture();f.project.tracks[0].clips[0].layout={crop:{x:0,y:0,width:1,height:1},viewport:{x:.2,y:.2,width:.5,height:.5}};
    f.project.tracks[0].clips[0].keyframes=[{id:"start",time:0,transform:{...DEFAULT_TRANSFORM,x:0},color:{...DEFAULT_COLOR},easing:"linear"},{id:"end",time:1,transform:{...DEFAULT_TRANSFORM,x:20},color:{...DEFAULT_COLOR},easing:"linear"}];
    const p=applyCommand(f.project,prepareStrokeAnnotationV1(f.project,{...f.request,tracking:{schema:"editkin.vector-tracking/v1",trackId:"track",mode:"anchor",referenceTime:0}}).command);
    const a=coordinates(paths(p,0)[0].ass),b=coordinates(paths(p,30)[0].ass);expect(b[0]-a[0]).toBeCloseTo(36,2);
    const mirrored=structuredClone(p);mirrored.tracks[0].clips[0].transform.flipX=true;expect(paths(mirrored,30)[0].ass).not.toBe(paths(p,30)[0].ass);
  });
  it("hides explicit lost spans and resumes only at reacquisition, using unchanged legacy sampling semantics",()=>{
    const f=fixture(),t=f.project.motionTracks[0];t.points.splice(1,0,{...structuredClone(t.points[0]),time:.5,frame:15,status:"lost",confidence:0});
    for(const time of [-.01,0,.25,.5,.75,1,1.5,2,3])expect(vectorTrackingPoseAtV1(t,time)).toEqual(motionTrackPoseAt(t,time));
    const p=applyCommand(f.project,prepareStrokeAnnotationV1(f.project,{...f.request,tracking:{schema:"editkin.vector-tracking/v1",trackId:"track",mode:"anchor",referenceTime:0}}).command);
    expect(paths(p,15)).toEqual([]);expect(paths(p,20)).toEqual([]);expect(paths(p,30).length).toBeGreaterThan(0);
  });
  it("composes an animated parent with the tracked source and rejects cyclic parent evaluation",()=>{
    const f=fixture(),child=f.project.tracks[0].clips[0],parent=structuredClone(child);parent.id='parent';parent.keyframes=[{id:'p0',time:0,transform:{...DEFAULT_TRANSFORM},color:{...DEFAULT_COLOR},easing:"linear"},{id:'p1',time:1,transform:{...DEFAULT_TRANSFORM,x:10},color:{...DEFAULT_COLOR},easing:"linear"}];
    child.layer={...DEFAULT_CLIP_LAYER,parentClipId:'parent'};parent.trackId='parent-video';f.project.tracks.push({...f.project.tracks[0],id:'parent-video',name:'Synthetic parent layer',clips:[parent]});
    const p=applyCommand(f.project,prepareStrokeAnnotationV1(f.project,{...f.request,tracking:{schema:'editkin.vector-tracking/v1',trackId:'track',mode:'anchor',referenceTime:0}}).command);
    const a=coordinates(paths(p,0)[0].ass),b=coordinates(paths(p,30)[0].ass);expect(b[0]-a[0]).toBeCloseTo(42,2);
    p.tracks.find(t=>t.id==='parent-video')!.clips[0].layer={...DEFAULT_CLIP_LAYER,parentClipId:child.id};expect(()=>paths(p,30)).toThrow('PARENT_CYCLE');
  });
  it("does not flatten a 2.5D camera into an invented 2D tracking result",()=>{
    const f=fixture();f.project.scene25d=structuredClone(DEFAULT_SCENE_25D);
    expect(()=>prepareStrokeAnnotationV1(f.project,{...f.request,tracking:{schema:'editkin.vector-tracking/v1',trackId:'track',mode:'anchor',referenceTime:0}})).toThrow('GEOMETRY_UNSUPPORTED');
  });
  it("rejects invalid ids, ranges, geometry and unsupported source bindings without editing",()=>{
    const f=fixture();for(const patch of [{expectedRevision:1},{range:{startFrame:0,endFrame:1}},{geometry:{kind:"underline",start:{x:1,y:1},end:{x:1,y:1}}},{box:{x:300,y:0,width:100,height:60}}])expect(()=>prepareStrokeAnnotationV1(f.project,{...f.request,...patch})).toThrow();
    expect(()=>prepareStrokeAnnotationV1(f.project,{...f.request,tracking:{schema:"editkin.vector-tracking/v1",trackId:"missing",mode:"anchor",referenceTime:0}})).toThrow("TRACK_MISSING");
    f.project.tracks[0].clips[0].speed=2;expect(()=>prepareStrokeAnnotationV1(f.project,{...f.request,tracking:{schema:"editkin.vector-tracking/v1",trackId:"track",mode:"anchor",referenceTime:0}})).toThrow("GEOMETRY_UNSUPPORTED");expect(f.project.motionGraphics).toHaveLength(0);
  });
  it("binding/version mismatches, active outer motion and degenerate surface quads fail closed",()=>{
    const f=fixture(),plan=prepareStrokeAnnotationV1(f.project,{...f.request,tracking:{schema:"editkin.vector-tracking/v1",trackId:"track",mode:"surface",referenceTime:0}});
    const missing=structuredClone(plan.command.graphic);delete missing.vectorTrackingV1;expect(motionGraphicSchema.safeParse(missing).success).toBe(false);
    const wrong=structuredClone(plan.command.graphic);wrong.vectorV2!.schema="editkin.motion-vector-stroke/v1";expect(motionGraphicSchema.safeParse(wrong).success).toBe(false);
    const active=structuredClone(plan.command.graphic);active.motionV2!.entrance.offsetXPixels=10;expect(motionGraphicSchema.safeParse(active).success).toBe(false);
    const p=applyCommand(f.project,plan.command);p.motionTracks[0].points[1].quad=[{x:.2,y:.2},{x:.2,y:.2},{x:.2,y:.2},{x:.2,y:.2}];expect(()=>paths(p,30)).toThrow("QUAD_DEGENERATE");
  });
});
