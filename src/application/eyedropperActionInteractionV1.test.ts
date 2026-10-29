import { describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { DEFAULT_COLOR_MANAGEMENT, type ColorGradeV2 } from "../domain/types";
import { dispatchCommand, redo, undo } from "../domain/history";
import { createTransformMotionBlurInstance } from "../domain/transformMotionBlur";
import { filmLooksForGenre } from "../creative/filmLooksV2";
import { createProjectSession } from "./projectSession";
import { previewPickerValuesV1 } from "../color/previewPixelPickerV1";
import { parseCubeFile } from "../color/cubeLut";
import { applyColorGradeV2Rgb } from "../color/gradeV2";
import { compileSecondaryHslKeyV1, secondaryHslKeyWeightV1 } from "../color/secondaryHslV1";
import { createEyedropperActionInteractionV1, type EyedropperActionContextV1, type EyedropperActionStateV1 } from "./eyedropperActionInteractionV1";

const widths={hueHalfWidthDegrees:12,hueSoftnessDegrees:5,saturationRadius:.08,lightnessRadius:.08,bandSoftness:.02};
const ref={id:`lut:${"a".repeat(16)}`,sha256:"a".repeat(64),strength:1};
const cubeText="LUT_1D_SIZE 2\n0 0 0\n1 1 1\n";
const authored:ColorGradeV2={schema:"editkin.color-grade/v2",nodes:[{id:"prior",offset:{r:.04,g:-.01,b:.02}},{id:"selected",offset:{g:.08}}],look:{id:filmLooksForGenre("travel")[0].id,strength:.3},finishing:{grain:{amount:.2}}};
function fixture(grade:ColorGradeV2|undefined=authored){
  const project=createDemoProject();project.tracks[0].clips[0].gradeV2=structuredClone(grade);
  const session=createProjectSession(project,"owned.editkin.json"),snap=session.getSnapshot();
  const values=previewPickerValuesV1(new Uint8ClampedArray([96,124,144,255]));
  const context:EyedropperActionContextV1={projectOwner:{},contentOwner:snap.contentOwner,sessionId:snap.sessionId,revision:project.revision,projectId:project.id,projectPath:"owned.editkin.json",asset:project.assets[0],clip:project.tracks[0].clips[0],management:{...DEFAULT_COLOR_MANAGEMENT,mode:"rec709",outputTransform:"rec709_sdr"},localTime:0,sourceKey:"source-at-0",selectedNodeId:"selected",editable:true,locked:false,selectorWidths:{...widths},neutralNodeLabel:"Balance",contextKey:"picker",ready:true,sample:{...values,x:0,y:0,width:64,height:40,patchWidth:1,patchHeight:1,basis:"decoded-source-preview",contextKey:"picker"},onApply:()=>false};
  const apply=vi.fn((next:ColorGradeV2)=>{session.setHistory(h=>dispatchCommand(h,{type:"set_clip_grade_v2",clipId:context.clip.id,grade:next}));const s=session.getSnapshot();context.contentOwner=s.contentOwner;context.clip=s.history.present.tracks[0].clips[0];return true;});context.onApply=apply;
  const states:EyedropperActionStateV1[]=[],driver=createEyedropperActionInteractionV1(()=>context,s=>states.push(s));
  return{context,session,apply,driver,states};
}
function lutGate(f:ReturnType<typeof fixture>){
  f.context.clip.gradeV2={schema:"editkin.color-grade/v2",nodes:[{id:"prior",lut:ref},{id:"selected",offset:{g:.02}}]};
  let release!:()=>void;const gate=new Promise<void>(yes=>{release=yes;});
  const readCube=vi.fn(async()=>{await gate;return{text:cubeText,cube:parseCubeFile(cubeText)};});f.context.lutClient={readCube};return{readCube,release};
}

describe("eyedropper action interaction",()=>{
  it("appends one balance node through actual oneUndo/Redo and preserves authored look/finishing/source",async()=>{
    const f=fixture(),before=structuredClone(f.session.getSnapshot().history.present);
    expect(await f.driver.run("neutral")).toEqual({status:"applied"});expect(f.apply).toHaveBeenCalledTimes(1);
    const h=f.session.getSnapshot().history,next=h.present.tracks[0].clips[0].gradeV2!;
    expect(h.past).toHaveLength(1);expect(next.nodes).toHaveLength(3);expect(next.nodes!.slice(0,2)).toEqual(authored.nodes);
    expect(next.look).toEqual(authored.look);expect(next.finishing).toEqual(authored.finishing);expect(h.present.assets).toEqual(before.assets);
    expect(undo(h).present).toEqual(before);expect(redo(undo(h)).present.tracks[0].clips[0].gradeV2).toEqual(next);
    expect(JSON.parse(JSON.stringify(h.present)).tracks[0].clips[0].gradeV2).toEqual(next);
    const rgb:[number,number,number]=[96/255+.04,124/255-.01+.08,144/255+.02],t=.2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];
    const out=applyColorGradeV2Rgb({schema:"editkin.color-grade/v2",nodes:[next.nodes!.at(-1)!]},"rec709_display",rgb);
    out.forEach(v=>expect(v).toBeCloseTo(t,12));
  });
  it("seeds the selected INPUT rather than its output or the following Look",async()=>{
    const f=fixture(),old=structuredClone(f.context.clip.gradeV2!);expect((await f.driver.run("hsl")).status).toBe("applied");
    const next=f.context.clip.gradeV2!,s=next.nodes![1].secondaryHslV1!,key=compileSecondaryHslKeyV1(s.qualifier,s.cleanup,s.inverted);
    const input:[number,number,number]=[96/255+.04,124/255-.01,144/255+.02];expect(secondaryHslKeyWeightV1(input,key)).toBe(1);
    expect(secondaryHslKeyWeightV1([input[0],input[1]+.08,input[2]],key)).toBeLessThan(1);
    expect(next.nodes![0]).toEqual(old.nodes![0]);expect(next.nodes![1].offset).toEqual(old.nodes![1].offset);expect(next.look).toEqual(old.look);
    expect(f.session.getSnapshot().history.past).toHaveLength(1);
  });
  it("double click and pending-observer reentry send only one real command",async()=>{
    const f=fixture();let reentry=false;const c=createEyedropperActionInteractionV1(()=>f.context,s=>{if(s.status==="pending"&&!reentry){reentry=true;void c.run("neutral");}});
    await Promise.all([c.run("neutral"),c.run("neutral")]);expect(f.apply).toHaveBeenCalledTimes(1);expect(f.session.getSnapshot().history.past).toHaveLength(1);
  });
  it("consumes an applied sample across reopening a new action controller",async()=>{
    const f=fixture();await f.driver.run("neutral");f.driver.dispose();const c=createEyedropperActionInteractionV1(()=>f.context,()=>{});
    expect(await c.run("neutral")).toMatchObject({status:"held",code:"EYEDROPPER_STALE"});expect(f.apply).toHaveBeenCalledTimes(1);
  });
  it("returns no node/Undo for an already neutral patch even at the four-node limit",async()=>{
    const f=fixture({schema:"editkin.color-grade/v2",nodes:[{id:"a"},{id:"b"},{id:"c"},{id:"d"}]});f.context.sample!.rgb=[128,128,128];
    expect(await f.driver.run("neutral")).toEqual({status:"unchanged"});expect(f.apply).not.toHaveBeenCalled();expect(f.session.getSnapshot().history.past).toHaveLength(0);
  });
  it("refuses a fifth node instead of replacing or merging the user's existing nodes",async()=>{
    const f=fixture({schema:"editkin.color-grade/v2",nodes:[{id:"a"},{id:"b"},{id:"c"},{id:"d"}]});
    expect(await f.driver.run("neutral")).toMatchObject({status:"held",code:"EYEDROPPER_NODE_LIMIT"});expect(f.apply).not.toHaveBeenCalled();
  });
  const refusals:Array<[string,(c:EyedropperActionContextV1)=>void,string]>=[
    ["graded pixels",c=>{c.sample!.basis="graded-preview";},"EYEDROPPER_GRADED"],
    ["old frame",c=>{c.contextKey="other";},"EYEDROPPER_STALE"],
    ["not ready",c=>{c.ready=false;},"EYEDROPPER_STALE"],
    ["truthy ready",c=>{c.ready=Promise.resolve(true)as unknown as boolean;},"EYEDROPPER_STALE"],
    ["invalid RGB",c=>{c.sample!.rgb=[NaN,0,0];},"EYEDROPPER_SAMPLE"],
    ["invalid patch",c=>{c.sample!.patchWidth=10;},"EYEDROPPER_SAMPLE"],
    ["locked track",c=>{c.locked=true;},"EYEDROPPER_LOCKED"],
    ["read only",c=>{c.editable=false;},"EYEDROPPER_LOCKED"],
    ["nonneutral primary",c=>{c.clip.color.exposure=.1;},"EYEDROPPER_CALIBRATION"],
    ["linear WB",c=>{c.clip.color.whiteBalanceRed=.1;},"EYEDROPPER_CALIBRATION"],
    ["ACES",c=>{c.management.mode="aces2";},"EYEDROPPER_CALIBRATION"],
    ["wrong asset",c=>{c.clip.assetId="other";},"EYEDROPPER_SOURCE"],
    ["keyer",c=>{c.clip.chromaKey={enabled:true}as any;},"EYEDROPPER_SOURCE"],
    ["mask",c=>{c.clip.masks=[{enabled:true}as any];},"EYEDROPPER_SOURCE"],
    ["native effect",c=>{c.clip.creative={effectPresetIds:[],nativeEffectInstances:[{enabled:true}as any]};},"EYEDROPPER_SOURCE"],
    ["bad local time",c=>{c.localTime=NaN;},"EYEDROPPER_STALE"],
    ["missing source",c=>{c.sourceKey="";},"EYEDROPPER_UNAVAILABLE"],
    ["nonobject owner",c=>{c.projectOwner=1 as unknown as object;},"EYEDROPPER_UNAVAILABLE"],
  ];
  it.each(refusals)("holds %s with zero callbacks and zero Undo",async(_name,mutate,code)=>{
    const f=fixture(),reader=vi.fn();f.context.lutClient={readCube:reader};mutate(f.context);
    expect(await f.driver.run("neutral")).toMatchObject({status:"held",code});expect(f.apply).not.toHaveBeenCalled();expect(reader).not.toHaveBeenCalled();expect(f.session.getSnapshot().history.past).toHaveLength(0);
  });
  it("needs a selected node for HSL and refuses unavailable/unknown action contexts",async()=>{
    const f=fixture();f.context.selectedNodeId="missing";expect(await f.driver.run("hsl")).toMatchObject({status:"held",code:"EYEDROPPER_NODE"});
    expect(await f.driver.run("wrong"as any)).toMatchObject({status:"held",code:"EYEDROPPER_PARAMETERS"});
    expect(await createEyedropperActionInteractionV1(()=>undefined,()=>{}).run("neutral")).toMatchObject({status:"held",code:"EYEDROPPER_UNAVAILABLE"});expect(f.apply).not.toHaveBeenCalled();
  });
  it("refuses an actual enabled creative effect instance before dispatch",async()=>{
    const f=fixture();f.context.clip.creative={effectPresetIds:[],nativeEffectInstances:[createTransformMotionBlurInstance()]};
    expect(await f.driver.run("neutral")).toMatchObject({status:"held",code:"EYEDROPPER_SOURCE"});expect(f.apply).not.toHaveBeenCalled();
  });
  it("does not mistake a disabled creative effect for an active pre-grade operation",async()=>{
    const f=fixture(),blur=createTransformMotionBlurInstance();blur.enabled=false;f.context.clip.creative={effectPresetIds:[],nativeEffectInstances:[blur]};
    expect((await f.driver.run("neutral")).status).toBe("applied");expect(f.session.getSnapshot().history.past).toHaveLength(1);
  });
  const changes:Array<[string,(c:EyedropperActionContextV1)=>void]>=[
    ["mutable owner",c=>{c.projectOwner={};}],["content epoch",c=>{c.contentOwner={};}],["same-ID session",c=>{c.sessionId++;}],
    ["revision",c=>{c.revision++;}],["SaveAs",c=>{c.projectPath="other.editkin.json";}],["source",c=>{c.sourceKey="other";}],
    ["sample in-place",c=>{c.sample!.rgb[0]++;}],["new sample",c=>{c.sample=structuredClone(c.sample);}],["grade",c=>{c.clip.gradeV2!.nodes![1].mix=.5;}],
    ["selection",c=>{c.selectedNodeId="prior";}],["widths",c=>{c.selectorWidths.hueHalfWidthDegrees=30;}],["lock",c=>{c.locked=true;}],
    ["LUT provider",c=>{c.lutClient={readCube:c.lutClient!.readCube};}],["mutable LUT reader",c=>{c.lutClient!.readCube=vi.fn();}],
  ];
  it.each(changes)("rejects %s during LUT await even when the getter returns the same mutable object",async(_name,mutate)=>{
    const f=fixture(),g=lutGate(f),pending=f.driver.run("neutral");expect(g.readCube).toHaveBeenCalledTimes(1);mutate(f.context);g.release();
    expect(await pending).toMatchObject({status:"held",code:"EYEDROPPER_STALE"});expect(f.apply).not.toHaveBeenCalled();expect(f.session.getSnapshot().history.past).toHaveLength(0);
  });
  it("uses the checked existing LUT client interface once per required prefix ref",async()=>{
    const f=fixture(),g=lutGate(f),p=f.driver.run("neutral");g.release();expect((await p).status).toBe("applied");
    expect(g.readCube).toHaveBeenCalledTimes(1);expect(g.readCube).toHaveBeenCalledWith(ref,"rec709_display");
  });
  it("does not read the selected node's LUT when seeding its input",async()=>{
    const f=fixture({schema:"editkin.color-grade/v2",nodes:[{id:"selected",lut:ref}]});const readCube=vi.fn();f.context.lutClient={readCube};
    expect((await f.driver.run("hsl")).status).toBe("applied");expect(readCube).not.toHaveBeenCalled();
  });
  it("holds unavailable LUTs without degrading the prefix to an identity",async()=>{
    const f=fixture(),g=lutGate(f);f.context.lutClient={readCube:vi.fn(async()=>{throw Error("gone");})};g.release();
    expect(await f.driver.run("neutral")).toMatchObject({status:"held",code:"EYEDROPPER_LUT"});expect(f.apply).not.toHaveBeenCalled();
  });
  it.each(["cancel","dispose"]as const)("%s during a LUT read prevents any late apply",async action=>{
    const f=fixture(),g=lutGate(f),p=f.driver.run("neutral");f.driver[action]();expect(await p).toMatchObject({status:"cancelled"});g.release();await Promise.resolve();expect(f.apply).not.toHaveBeenCalled();
  });
  it("does not replay after a synchronous callback wrote and then threw",async()=>{
    const f=fixture(),real=f.context.onApply;f.context.onApply=g=>{real(g);throw Error("ack lost");};
    expect(await f.driver.run("neutral")).toMatchObject({status:"uncertain"});expect(f.session.getSnapshot().history.past).toHaveLength(1);
    const reopened=createEyedropperActionInteractionV1(()=>f.context,()=>{});expect(await reopened.run("neutral")).toMatchObject({status:"held",code:"EYEDROPPER_STALE"});expect(f.apply).toHaveBeenCalledTimes(1);
  });
  it("requires a fresh sample after a known synchronous false acknowledgement",async()=>{
    const f=fixture();f.context.onApply=vi.fn(()=>false);expect((await f.driver.run("neutral")).status).toBe("held");
    expect(await f.driver.run("neutral")).toMatchObject({status:"held",code:"EYEDROPPER_STALE"});expect(f.context.onApply).toHaveBeenCalledTimes(1);expect(f.session.getSnapshot().history.past).toHaveLength(0);
  });
  it("bounds the sum of actual parsed table byte lengths before evaluation",async()=>{
    const f=fixture(),other={...ref,id:`lut:${"b".repeat(16)}`,sha256:"b".repeat(64)};
    f.context.clip.gradeV2={schema:"editkin.color-grade/v2",nodes:[{id:"a",lut:ref},{id:"b",lut:other},{id:"selected"}]};
    const readCube=vi.fn(async()=>({text:"checked-host-test-double",cube:{kind:"3d"as const,size:129,domainMin:[0,0,0]as[number,number,number],domainMax:[1,1,1]as[number,number,number],values:new Float32Array(129**3*3)}}));f.context.lutClient={readCube};
    expect(await f.driver.run("neutral")).toMatchObject({status:"held",code:"EYEDROPPER_LUT"});expect(readCube).toHaveBeenCalledTimes(2);expect(f.apply).not.toHaveBeenCalled();
  });
  it("requires exact synchronous true, rejecting truthy or promise acknowledgements",async()=>{
    for(const reply of [1,Promise.resolve(true),Promise.reject(Error("late failure"))]){
      const f=fixture();f.context.onApply=(()=>reply)as any;expect(await f.driver.run("neutral")).toMatchObject({status:"uncertain"});expect(f.session.getSnapshot().history.past).toHaveLength(0);
    }
  });
});
