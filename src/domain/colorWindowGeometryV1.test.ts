import { describe, expect, it } from "vitest";
import { createClipMask } from "./masks";
import type { MotionTrack } from "./types";
import { colorWindowCoverageV1 } from "./colorWindowCoverageV1";
import { compileColorWindowGeometryV1 } from "./colorWindowGeometryV1";
import { colorWindowInverseMatrixV1, colorWindowMapPointV1, colorWindowQuadMatrixV1 } from "./colorWindowMathV1";
import type { ColorWindowMaskV1, ColorWindowPointV1 } from "./colorWindowV1";

const path=(x=.2,y=.2,w=.6,h=.6)=>[{id:"a",x,y},{id:"b",x:x+w,y},{id:"c",x:x+w,y:y+h},{id:"d",x,y:y+h}];
function mask(kind:ColorWindowMaskV1["kind"]="rectangle"):ColorWindowMaskV1 {
  return {...createClipMask("m","rectangle"),purpose:"color",kind,path:path(),feather:0,expansion:0,refine:{edgeShift:0,contrast:.5,chatterReduction:0}};
}
function track():MotionTrack {
  return {id:"t",clipId:"c",name:"test",engine:"fixture",analysisFps:1,initialRect:{x:.2,y:.2,width:.6,height:.6},lostRatio:0,createdAt:"fixture",points:[
    {frame:0,time:0,rect:{x:.2,y:.2,width:.6,height:.6},status:"tracked",confidence:1},
    {frame:1,time:1,rect:{x:.4,y:.3,width:.4,height:.4},status:"tracked",confidence:.8}]};
}
const compile=(m=mask(),tracks:MotionTrack[]=[],width=100,height=100)=>compileColorWindowGeometryV1({mask:m,clipId:"c",tracks,width,height});
describe("colour-window geometry and analytic coverage",()=>{
  it.each(["rectangle","ellipse","polygon"] as const)("selects the center and excludes the corners (%s)",kind=>{
    const g=compile(mask(kind)).at(0);
    expect(colorWindowCoverageV1(g,50,50)).toBe(1);expect(colorWindowCoverageV1(g,0,0)).toBe(0);
  });
  it("uses smoothstep signed-distance feather in plane pixels",()=>{
    const m=mask();m.feather=.1;const g=compile(m).at(0);
    expect(g.featherPx).toBe(10);
    expect(colorWindowCoverageV1(g,10,50)).toBe(0);
    expect(colorWindowCoverageV1(g,15,50)).toBeCloseTo(.15625,12);
    expect(colorWindowCoverageV1(g,20,50)).toBeCloseTo(.5,12);
    expect(colorWindowCoverageV1(g,25,50)).toBeCloseTo(.84375,12);
    expect(colorWindowCoverageV1(g,30,50)).toBe(1);
  });
  it("is exact on circular radial distances, including the ellipse center",()=>{
    const m=mask("ellipse");m.feather=.1;const g=compile(m).at(0);
    expect(colorWindowCoverageV1(g,50,50)).toBe(1);
    expect(colorWindowCoverageV1(g,80,50)).toBeCloseTo(.5,10);
    expect(colorWindowCoverageV1(g,85,50)).toBeCloseTo(.15625,10);
    const d=5/Math.sqrt(2);expect(colorWindowCoverageV1(g,50+(30+d)*Math.SQRT1_2,50+(30+d)*Math.SQRT1_2))
      .toBeCloseTo((.5-d/20)**2*(3-2*(.5-d/20)),10);
  });
  it("scales the feather by the shorter plane dimension",()=>{
    const m=mask();m.feather=.1;
    expect(compile(m,[],200,100).at(0).featherPx).toBe(10);
    expect(compile(m,[],100,200).at(0).featherPx).toBe(10);
  });
  it("applies expansion, edge shift, inversion and opacity in the stated order",()=>{
    const m=mask();m.expansion=.04;m.refine.edgeShift=.01;m.opacity=.4;
    let g=compile(m).at(0);expect(g.expansionPx).toBe(5);expect(colorWindowCoverageV1(g,16,50)).toBe(.4);
    m.inverted=true;g=compile(m).at(0);expect(colorWindowCoverageV1(g,16,50)).toBe(0);expect(colorWindowCoverageV1(g,0,0)).toBe(.4);
  });
  it("treats a gradient as an oriented finite-width half-plane",()=>{
    const m=mask("linear_gradient");m.path=[{id:"a",x:.2,y:.5},{id:"b",x:.8,y:.5}];const g=compile(m).at(0);
    expect(colorWindowCoverageV1(g,20,80)).toBe(0);expect(colorWindowCoverageV1(g,50,80)).toBe(.5);expect(colorWindowCoverageV1(g,80,0)).toBe(1);
    m.feather=.1;const soft=compile(m).at(0);expect(colorWindowCoverageV1(soft,20,0)).toBeGreaterThan(0);
    m.path.reverse();expect(colorWindowCoverageV1(compile(m).at(0),90,0)).toBe(0);
  });
  it("interpolates keyed paths at clip-local time instead of taking the nearest sample",()=>{
    const m=mask();m.path=path(.1,.1,.2,.2);m.keyframes=[{frame:0,time:0,points:m.path,confidence:1,status:"manual"},
      {frame:30,time:1,points:path(.5,.3,.2,.2),confidence:1,status:"manual"}];
    const g=compile(m).at(.25);expect(g.points[0]).toEqual({x:20,y:15});
    expect(g.points[0]).not.toEqual({x:10,y:10});
  });
  it("reuses the interpolated tracker while preserving the authored shape and offset",()=>{
    const m=mask();m.trackId="t";m.path=path(.35,.35,.3,.3);
    const g=compile(m,[track()]).at(.5);
    // Interpolated track: x=.3,y=.25,width=.5,height=.5. Authored path occupies the central half.
    expect(g.points[0].x).toBeCloseTo(42.5,10);expect(g.points[0].y).toBeCloseTo(37.5,10);
    expect(g.points[2].x).toBeCloseTo(67.5,10);expect(g.points[2].y).toBeCloseTo(62.5,10);
  });
  it("maps through a true planar homography rather than the quad bounding box",()=>{
    const forward=(p:ColorWindowPointV1)=>({x:(p.x+.1)/(1+.5*p.x),y:p.y/(1+.5*p.x)});
    const t=track();t.initialRect={x:0,y:0,width:1,height:1};t.points=[{...t.points[0],quad:path(0,0,1,1).map(forward) as NonNullable<MotionTrack["points"][0]["quad"]>}];
    const m=mask();m.trackId="t";const g=compile(m,[t]).at(0);
    m.path.forEach((p,i)=>{expect(g.points[i].x).toBeCloseTo(forward(p).x*100,10);expect(g.points[i].y).toBeCloseTo(forward(p).y*100,10);});
  });
  it("uses explicit scale and rotation in plane pixels when a quad is absent",()=>{
    const t=track();t.initialRect={x:.2,y:.2,width:.2,height:.2};t.points=[{...t.points[0],rect:{x:.6,y:.4,width:.2,height:.2},rotationDegrees:90,scale:2}];
    const m=mask();m.path=path(.2,.2,.2,.2);m.trackId="t";const g=compile(m,[t],200,100).at(0);
    for(const [i,p] of [{x:160,y:10},{x:160,y:90},{x:120,y:90},{x:120,y:10}].entries()) {
      expect(g.points[i].x).toBeCloseTo(p.x,10);expect(g.points[i].y).toBeCloseTo(p.y,10);
    }
  });
  it.each([false,true])("lost/missing/disabled paths stay outside-only even when inverted=%s",inverted=>{
    const m=mask();m.trackId="t";m.inverted=inverted;
    const t=track();t.points=[t.points[0],{...t.points[1],status:"lost"},{...t.points[1],frame:2,time:2}];
    const c=compile(m,[t]);expect(c.at(.5).status).toBe("held");
    for(const time of [1,1.5]){expect(c.at(time).reason).toBe("track_lost");expect(colorWindowCoverageV1(c.at(time),0,0)).toBe(0);}
    expect(c.at(2).status).toBe("tracked");
    expect(colorWindowCoverageV1(compile(m).at(0),50,50)).toBe(0);
    m.enabled=false;expect(colorWindowCoverageV1(compile(m,[t]).at(0),50,50)).toBe(0);
  });
  it("does not anticipate a keyed reacquisition",()=>{
    const m=mask();m.keyframes=[{frame:0,time:0,points:m.path,confidence:1,status:"manual"},{frame:1,time:1,points:m.path,confidence:0,status:"lost"},
      {frame:2,time:2,points:m.path,confidence:1,status:"manual"}];
    const c=compile(m);expect(c.at(.5).status).toBe("held");expect(c.at(1.9).status).toBe("lost");expect(c.at(2).status).toBe("manual");
  });
  it("flags an interpolated quad that collapses instead of filling the frame",()=>{
    const m=mask();m.trackId="t";m.inverted=true;const t=track();const q=path();
    t.points[0].quad=[q[0],q[1],q[2],q[3]];
    t.points[1].quad=[q[2],q[3],q[0],q[1]];
    const g=compile(m,[t]).at(.5);expect(g.reason).toBe("invalid_geometry");expect(colorWindowCoverageV1(g,50,50)).toBe(0);
  });
  it("captures immutable numeric input and does not mutate source masks/tracks",()=>{
    const m=mask();m.trackId="t";const t=track(),before=JSON.stringify([m,t]),c=compile(m,[t]);
    c.at(.5);expect(JSON.stringify([m,t])).toBe(before);const expected=c.at(.5);
    m.path[0].x=.99;t.points[0].rect.x=.9;expect(c.at(.5)).toEqual(expected);
  });
  it("rejects invalid time, ambiguous tracks, wrong clip bindings and unsorted observations",()=>{
    const m=mask();m.trackId="t";const t=track();
    expect(()=>compile(m,[t,{...t}])).toThrow("COLOR_WINDOW_TRACK");expect(()=>compile(m,[{...t,clipId:"foreign"}])).toThrow("COLOR_WINDOW_TRACK");
    expect(()=>compile(m,[{...t,points:[...t.points].reverse()}])).toThrow("COLOR_WINDOW_TRACK");
    expect(()=>compile(m,[t]).at(NaN)).toThrow("COLOR_WINDOW_PARAMETERS");expect(()=>compile(m,[t]).at(-1)).toThrow("COLOR_WINDOW_PARAMETERS");
  });
  it("preserves all independent unit-square corner correspondences and the inverse",()=>{
    const q=[{x:10,y:20},{x:90,y:15},{x:70,y:80},{x:20,y:95}],h=colorWindowQuadMatrixV1(q),inverse=colorWindowInverseMatrixV1(h);
    path(0,0,1,1).forEach((p,i)=>{const out=colorWindowMapPointV1(h,p);expect(out.x).toBeCloseTo(q[i].x,10);expect(out.y).toBeCloseTo(q[i].y,10);
      const back=colorWindowMapPointV1(inverse,out);expect(back.x).toBeCloseTo(p.x,10);expect(back.y).toBeCloseTo(p.y,10);});
  });
});
