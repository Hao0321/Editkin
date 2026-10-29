import {expect,it} from "vitest";
import {createDemoProject} from "../domain/demo";
import {prepareLongformModuleScheduleV1} from "./longformModuleScheduleV1";
import {longformModuleScheduleRequestV1Schema,type LongformModuleScheduleRequestV1} from "../domain/longformModuleScheduleV1";
function fixture(fps=30){const project=createDemoProject();project.fps=fps;project.assets[0].duration=120;project.tracks[0].clips[0].duration=120;
  const module={id:"focus-1",kind:"ui_focus" as const,referenceId:"ug-owned-reference",startFrame:0,endFrame:Math.ceil(fps*.8),evidenceRefs:["source:current-target"]};
  const request:LongformModuleScheduleRequestV1={schema:"editkin.longform-module-schedule-request/v1",expectedRevision:project.revision,modules:[module]};return{project,request,module};}
it("admits64 focus,16 concept and3 recap modules with contiguous focus and no historical duty cap",()=>{
  const f=fixture(),before=structuredClone(f.project),modules:LongformModuleScheduleRequestV1["modules"]=[];
  for(const[kind,count]of [["ui_focus",64],["concept",16],["recap",3]]as const){for(let n=0;n<count;n++)modules.push({...f.module,id:kind+"-"+n,kind,
    startFrame:kind==="ui_focus"?n*24:1600+n*30,endFrame:kind==="ui_focus"?(n+1)*24:1624+n*30});}
  const result=prepareLongformModuleScheduleV1(f.project,{...f.request,modules:modules.reverse()});
  expect(result.counts).toEqual({ui_focus:64,concept:16,recap:3});expect(result.modules).toHaveLength(83);
  expect(result.focusFrames).toBe(1536);expect(result.focusFrames).toBeGreaterThan(result.totalFrames*.25);
  expect(result.focusMinimumGapFrames).toBe(0);expect(result.cleanHolds[0]).toEqual({startFrame:1536,endFrame:1600});
  expect(f.project).toEqual(before);expect(result).toMatchObject({projectModified:false,focusHintsReady:false,nativePresentationVerified:false,selectableByDefault:false});
});
it("rejects each independent quota and duplicate identities before producing a budget",()=>{
  const f=fixture();for(const[kind,count]of [["ui_focus",65],["concept",17],["recap",4]]as const){
    const modules=Array.from({length:count},(_,n)=>({...f.module,kind,id:kind+"-"+n,startFrame:n*24,endFrame:(n+1)*24}));
    expect(()=>prepareLongformModuleScheduleV1(f.project,{...f.request,modules})).toThrow("LONGFORM_MODULE_LIMIT_"+kind);}
  expect(()=>prepareLongformModuleScheduleV1(f.project,{...f.request,modules:[f.module,{...f.module,startFrame:24,endFrame:48}]})).toThrow("DUPLICATE_ID");
});
it("uses actual rational frame durations for the0.8second focus minimum at integer and NTSC rates",()=>{
  for(const[fps,minimum]of [[24,20],[25,20],[30,24],[60,48],[30000/1001,24],[24000/1001,20]]){
    const f=fixture(fps),result=prepareLongformModuleScheduleV1(f.project,{...f.request,modules:[{...f.module,endFrame:minimum}]});
    expect(result.focusMinimumFrames).toBe(minimum);
    expect(minimum*result.timeBase.numerator/result.timeBase.denominator).toBeGreaterThanOrEqual(.8);
    expect((minimum-1)*result.timeBase.numerator/result.timeBase.denominator).toBeLessThan(.8);
    expect(()=>prepareLongformModuleScheduleV1(f.project,{...f.request,modules:[{...f.module,endFrame:minimum-1}]})).toThrow("FOCUS_MINIMUM");
  }
});
it("uses half-open focus windows, rejects a one-frame overlap and refuses out-of-timeline windows",()=>{
  const f=fixture(),second={...f.module,id:"focus-2",startFrame:24,endFrame:48};
  expect(prepareLongformModuleScheduleV1(f.project,{...f.request,modules:[second,f.module]}).focusFrames).toBe(48);
  expect(()=>prepareLongformModuleScheduleV1(f.project,{...f.request,modules:[f.module,{...second,startFrame:23}]})).toThrow("FOCUS_OVERLAP");
  for(const row of [{...f.module,startFrame:24,endFrame:24},{...f.module,startFrame:3600,endFrame:3624}])
    expect(()=>prepareLongformModuleScheduleV1(f.project,{...f.request,modules:[row]})).toThrow("FRAME_RANGE");
});
it("retains declared references and bounded clean spans without asserting layering or target authority",()=>{
  const f=fixture(),result=prepareLongformModuleScheduleV1(f.project,{...f.request,modules:[{...f.module,startFrame:30,endFrame:54},
    {...f.module,id:"concept-1",kind:"concept",startFrame:40,endFrame:80}]});
  expect(result.cleanHolds).toEqual([{startFrame:0,endFrame:30},{startFrame:80,endFrame:3600}]);
  expect(result.referenceState).toContain("CALLER_DECLARED");expect(result.coordinatesVerified).toBe(false);expect(result.layoutOrLayeringVerified).toBe(false);
  result.modules[0].evidenceRefs[0]="changed";expect(f.module.evidenceRefs).toEqual(["source:current-target"]);
  Object.assign(result.limits,{ui_focus:1});expect(prepareLongformModuleScheduleV1(f.project,f.request).limits.ui_focus).toBe(64);
});
it("refuses stale revisions, non-landscape/empty timelines and pre-cancelled requests",()=>{
  const f=fixture();expect(()=>prepareLongformModuleScheduleV1(f.project,{...f.request,expectedRevision:f.project.revision+1})).toThrow("REVISION");
  expect(()=>prepareLongformModuleScheduleV1({...f.project,width:720,height:1280},f.request)).toThrow("LANDSCAPE");
  expect(()=>prepareLongformModuleScheduleV1({...f.project,tracks:f.project.tracks.map(t=>({...t,clips:[]}))},f.request)).toThrow("TIMELINE");
  const controller=new AbortController();controller.abort();expect(()=>prepareLongformModuleScheduleV1(f.project,f.request,controller.signal)).toThrow();
});
it("rejects manually supplied coordinates, style/old limits, fractional frames and excessive declarations",()=>{
  const f=fixture();for(const raw of [{...f.request,quietFrames:120},{...f.request,modules:[{...f.module,bounds:{x:0,y:0,width:1,height:1}}]},
    {...f.request,modules:[{...f.module,animation:"fade"}]},{...f.request,modules:[{...f.module,startFrame:.5}]},
    {...f.request,modules:Array.from({length:84},(_,n)=>({...f.module,id:"focus-"+n}))}])expect(()=>longformModuleScheduleRequestV1Schema.parse(raw)).toThrow();
});
