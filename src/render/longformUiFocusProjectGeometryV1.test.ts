import {describe,it,expect} from "vitest";
import {createDemoProject} from "../domain/demo";
import {DEFAULT_TRANSFORM} from "../domain/types";
import type {LongformUiFocusGeometryWitnessV1} from "../domain/longformUiFocusProjectGeometryV1";
import {projectLongformUiFocusQuadV1} from "./longformUiFocusProjectGeometryV1";
const q=[{x:.25,y:.25},{x:.5,y:.25},{x:.5,y:.4},{x:.25,y:.4}];
function fixture(){const project=createDemoProject();project.width=640;project.height=360;const clip=project.tracks[0].clips[0];
  clip.timelineStart=0;clip.transform={...DEFAULT_TRANSFORM};clip.keyframes=[];delete clip.creative;delete clip.layout;
  const raster={width:640,height:360};const witness:LongformUiFocusGeometryWitnessV1={schema:"editkin.longform-ui-focus-geometry-witness/v1",projectFrame:10,geometryPts:10,
    timeBase:{numerator:1,denominator:30},fit:{...raster},layout:{...raster},affine:{mode:"scale-rotate",input:{...raster},scaled:{...raster},output:{...raster}},placement:{x:0,y:0}};
  return{project,clip,witness};}
describe("actual-stage source to project geometry",()=>{
  it("maps actual contain padding and integer crop/viewport dimensions without inventing a target",()=>{
    const f=fixture();f.witness.fit={width:640,height:320};
    let result=projectLongformUiFocusQuadV1(f.project,f.clip.id,q,f.witness,60);
    expect(result.projectQuad[0]).toEqual({x:.25,y:100/360});expect(result.sourceTargetVerified).toBe(false);expect(result.focusHintsReady).toBe(false);
    f.clip.layout={crop:{x:.125,y:.1,width:.5,height:.6},viewport:{x:.1,y:.1,width:.5,height:.6}};
    f.witness.layout={width:320,height:216};f.witness.affine={mode:"scale-rotate",input:{width:320,height:216},scaled:{width:320,height:216},output:{width:320,height:216}};
    f.witness.placement={x:64,y:36};result=projectLongformUiFocusQuadV1(f.project,f.clip.id,q,f.witness,60);
    expect(result.projectQuad[0]).toEqual({x:144/640,y:100/360});
  });
  it("uses measured scaling extents, pixel placement and reflected winding",()=>{
    const f=fixture();f.clip.transform={...DEFAULT_TRANSFORM,scale:.5,flipX:true,x:20,y:-10};
    f.witness.affine.scaled=f.witness.affine.output={width:320,height:180};f.witness.placement={x:180,y:80};
    const result=projectLongformUiFocusQuadV1(f.project,f.clip.id,q,f.witness,60);
    expect(result.projectQuad[0]).toEqual({x:420/640,y:125/360});expect(result.projectQuad[1]).toEqual({x:340/640,y:125/360});
  });
  it("keeps observed geometry time separate from rebased placement time across a Hold boundary",()=>{
    const f=fixture();f.clip.timelineStart=.2;f.clip.keyframes=[{id:"zero",time:0,easing:"hold",transform:{...DEFAULT_TRANSFORM,x:10},color:f.clip.color},
      {id:"next",time:.4,easing:"hold",transform:{...DEFAULT_TRANSFORM,x:40,rotation:180},color:f.clip.color}];
    f.witness.projectFrame=18;f.witness.geometryPts=11;f.witness.placement.x=40;
    f.witness.affine.output={width:736,height:736};f.witness.placement={x:-8,y:-188};
    const result=projectLongformUiFocusQuadV1(f.project,f.clip.id,q,f.witness,0);
    expect(result.geometryTime).toBe(11/30);expect(result.projectTime).toBe(.6);
    expect(result.projectQuad[0].x).toBeCloseTo(200/640,10);expect(result.projectQuad[0].y).toBeCloseTo(.25,10);
  });
  it("composes reflected parents through the existing shared transform sampler",()=>{
    const f=fixture(),parent=structuredClone(f.clip);parent.id="parent";parent.transform={...DEFAULT_TRANSFORM,flipX:true,x:40,scale:.5};
    parent.layer={enabled:true,role:"controller",blendMode:"normal"};f.project.tracks[0].clips.push(parent);
    f.clip.layer={enabled:true,role:"content",blendMode:"normal",parentClipId:"parent"};f.clip.transform.x=20;
    f.witness.affine.scaled=f.witness.affine.output={width:320,height:180};f.witness.placement={x:190,y:90};
    const result=projectLongformUiFocusQuadV1(f.project,f.clip.id,q,f.witness,0);
    expect(result.projectQuad[0]).toEqual({x:430/640,y:135/360});
  });
  it("projects fixed animated geometry on its measured invariant canvas",()=>{
    const f=fixture();f.clip.duration=1;f.clip.keyframes=[{id:"end",time:1,easing:"linear",transform:{...DEFAULT_TRANSFORM,scale:2},color:f.clip.color}];
    f.witness.geometryPts=0;f.witness.projectFrame=0;f.witness.affine={mode:"fixed-perspective",input:{width:1282,height:722},scaled:{width:1282,height:722},output:{width:1282,height:722}};
    f.witness.placement={x:-321,y:-181};const result=projectLongformUiFocusQuadV1(f.project,f.clip.id,q,f.witness,60);
    expect(result.projectQuad).toEqual(q);
  });
  it("rejects cropped/offscreen targets, malformed witnesses and invisible/unproved geometry without mutations",()=>{
    const f=fixture(),before=JSON.stringify(f.project);f.witness.fit.width=641;
    expect(()=>projectLongformUiFocusQuadV1(f.project,f.clip.id,q,f.witness,60)).toThrow("FIT_RASTER");f.witness.fit.width=640;
    f.witness.placement.x=3;expect(()=>projectLongformUiFocusQuadV1(f.project,f.clip.id,q,f.witness,60)).toThrow("POSITION_BINDING");f.witness.placement.x=0;
    f.witness.timeBase.denominator=24;expect(()=>projectLongformUiFocusQuadV1(f.project,f.clip.id,q,f.witness,60)).toThrow("CLOCK_OR_PLACEMENT");f.witness.timeBase.denominator=30;
    expect(()=>projectLongformUiFocusQuadV1(f.project,f.clip.id,q,f.witness,240)).toThrow("PROJECT_SAFE_AREA");expect(JSON.stringify(f.project)).toBe(before);
    f.clip.layout={crop:{x:.3,y:0,width:.5,height:1},viewport:{x:0,y:0,width:.5,height:1}};f.witness.layout={width:320,height:360};
    f.witness.affine.input=f.witness.affine.scaled=f.witness.affine.output={width:320,height:360};
    expect(()=>projectLongformUiFocusQuadV1(f.project,f.clip.id,q,f.witness,0)).toThrow("CROPPED_TARGET");
    f.project.tracks[0].hidden=true;expect(()=>projectLongformUiFocusQuadV1(f.project,f.clip.id,q,f.witness,0)).toThrow("VISIBLE_CLIP");
  });
});
