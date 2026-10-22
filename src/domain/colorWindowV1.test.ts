import { describe, expect, it } from "vitest";
import { createClipMask } from "./masks";
import { createDemoProject } from "./demo";
import { projectSchema } from "./schema";
import { assertColorWindowMaskChangeV1, assertColorWindowMaskV1, assertColorWindowsForClipV1, assertColorWindowsV1,
  type ColorWindowClipV1, type ColorWindowMaskV1 } from "./colorWindowV1";

const mask=():ColorWindowMaskV1=>({...createClipMask("window","rectangle"),purpose:"color"});
function clip():ColorWindowClipV1 {
  return {...createDemoProject().tracks[0].clips[0],masks:[mask()],gradeV2:{schema:"editkin.color-grade/v2",nodes:[{id:"n",windowMaskId:"window"}]}};
}
describe("colour-window candidate admission (integrator H1-H4 still required)",()=>{
  it("leaves a legacy project and omitted/explicit alpha purposes alone",()=>{
    const project=createDemoProject(),before=JSON.stringify(project);
    assertColorWindowsV1(project);expect(JSON.stringify(project)).toBe(before);
    const c=clip();delete c.gradeV2;c.masks![0].purpose=undefined;assertColorWindowsForClipV1(c);
    c.masks![0].purpose="alpha";assertColorWindowsForClipV1(c);
  });
  it.each([undefined,"alpha"] as const)("refuses a gradient without colour purpose (%s)",purpose=>{
    const c=clip();c.masks![0]={...mask(),purpose,kind:"linear_gradient",path:[{id:"a",x:0,y:0},{id:"b",x:1,y:1}]};
    expect(()=>assertColorWindowsForClipV1(c)).toThrow("COLOR_WINDOW_PURPOSE");
  });
  it("accepts a colour gradient as two oriented endpoints",()=>{
    const m={...mask(),kind:"linear_gradient" as const,path:[{id:"a",x:.2,y:.3},{id:"b",x:.6,y:.8}]};
    expect(()=>assertColorWindowMaskV1(m)).not.toThrow();
    m.path[1]={...m.path[0],id:"b"};expect(()=>assertColorWindowMaskV1(m)).toThrow("COLOR_WINDOW_PATH");
  });
  it.each(["missing","alpha","disabled","ambiguous","empty"])("refuses %s same-clip reference, including bypass",reason=>{
    const c=clip();c.gradeV2!.nodes![0].enabled=false;
    if(reason==="missing")c.masks=[];
    if(reason==="alpha")delete c.masks![0].purpose;
    if(reason==="disabled")c.masks![0].enabled=false;
    if(reason==="ambiguous")c.masks!.push(mask());
    if(reason==="empty")c.gradeV2!.nodes![0].windowMaskId="";
    expect(()=>assertColorWindowsForClipV1(c)).toThrow("COLOR_WINDOW_REFERENCE");
  });
  it("limits spatial nodes to two, even if the third is bypassed",()=>{
    const c=clip();c.gradeV2!.nodes!.push({id:"b",windowMaskId:"window"});assertColorWindowsForClipV1(c);
    c.gradeV2!.nodes!.push({id:"c",windowMaskId:"window",enabled:false});expect(()=>assertColorWindowsForClipV1(c)).toThrow("COLOR_WINDOW_NODE_LIMIT");
  });
  it("refuses outside fields without their window",()=>{
    const c=clip();c.gradeV2!.nodes=[{id:"n",windowOutside:{offset:{master:.1}}}];
    expect(()=>assertColorWindowsForClipV1(c)).toThrow("COLOR_WINDOW_OUTSIDE_WITHOUT_WINDOW");
  });
  it("refuses deletion, disabling and alpha conversion of a referenced mask without mutating it",()=>{
    const c=clip(),before=JSON.stringify(c);
    for(const next of [null,{...mask(),enabled:false},{...mask(),purpose:"alpha" as const}]) expect(()=>assertColorWindowMaskChangeV1(c,"window",next)).toThrow("COLOR_WINDOW_REFERENCE");
    expect(JSON.stringify(c)).toBe(before);
    c.gradeV2!.nodes=[];assertColorWindowMaskChangeV1(c,"window",null);
  });
  it("rejects bow-ties, repeats, degenerate quads and more than sixteen polygon vertices",()=>{
    const m=mask();
    for(const path of [[m.path[0],m.path[2],m.path[1],m.path[3]],[m.path[0],m.path[0],m.path[2],m.path[3]],
      m.path.map(p=>({...p,y:0}))])expect(()=>assertColorWindowMaskV1({...m,path})).toThrow("COLOR_WINDOW_PATH");
    const path=Array.from({length:17},(_,i)=>({id:String(i),x:.5+.4*Math.cos(i*2*Math.PI/17),y:.5+.4*Math.sin(i*2*Math.PI/17)}));
    expect(()=>assertColorWindowMaskV1({...m,kind:"polygon",path})).toThrow("COLOR_WINDOW_PATH");
  });
  it("allows a simple concave polygon but rejects a concave rectangle",()=>{
    const m=mask();m.path[2]={...m.path[2],x:.4,y:.4};
    assertColorWindowMaskV1({...m,kind:"polygon"});expect(()=>assertColorWindowMaskV1(m)).toThrow("COLOR_WINDOW_PATH");
  });
  it("keeps pixel mattes, fixed windows and illegal values out of the new vector core",()=>{
    for(const patch of [{opacity:NaN},{feather:-1},{expansion:Infinity},{fixedWindowV3:{schema:"editkin.fixed-template-window/v3" as const}},
      {frozenRange:{fromFrame:0,toFrame:1}},{kind:"subject" as const}]) expect(()=>assertColorWindowMaskV1({...mask(),...patch})).toThrow(/COLOR_WINDOW_(PARAMETERS|SHAPE)/);
  });
  it("checks increasing keys, consistent point identities and key budget",()=>{
    const m=mask(),key={frame:0,time:0,points:m.path,confidence:1,status:"manual" as const};
    for(const keys of [[key,{...key,frame:1}], [{...key,points:[...m.path].reverse()}],Array(4097).fill(key)])
      expect(()=>assertColorWindowMaskV1({...m,keyframes:keys})).toThrow("COLOR_WINDOW_KEYFRAMES");
  });
  it("does not bypass the existing persisted schema before H1/H2 integration",()=>{
    const project=createDemoProject();Object.assign(project.tracks[0].clips[0],clip());
    expect(projectSchema.safeParse(project).success).toBe(false);
  });
});
