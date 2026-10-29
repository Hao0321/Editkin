import {describe,expect,it} from "vitest";
import {createEmptyProject} from "../domain/editGraph";
import {DEFAULT_COLOR,DEFAULT_TRANSFORM} from "../domain/types";
import {compileAutoReframeV1,type ReframeObservationV1} from "./autoReframeV1";
import {createAutoReframeSparseV2,assertAutoReframeSparseSinkV2} from "./autoReframeSparseV2";
import type {EditorCommand} from "../domain/commandTypes";
function fixture(count=300,fps=30){const p=createEmptyProject("sparse reframe",{id:"sparse-test",width:160,height:90,fps});p.assets=[{id:"source",name:"source",kind:"video",uri:"source.mp4",duration:count/fps,width:160,height:90}];p.tracks[0].clips=[{id:"clip",assetId:"source",trackId:p.tracks[0].id,timelineStart:0,sourceStart:0,duration:count/fps,volume:.7,transform:{...DEFAULT_TRANSFORM},color:{...DEFAULT_COLOR},keyframes:[]}];return p;}
const input={clipId:"clip",outputWidth:90,outputHeight:160};
const obs=(frame:number,x=.5,fps=30,cut=!frame):ReframeObservationV1=>({frame,time:frame/fps,sceneCut:cut,pixelSha256:"a".repeat(64),subject:{rect:{x:x-.025,y:.4,width:.05,height:.2},confidence:1,origin:"matte"}});
function pose(commands:EditorCommand[],frame:number,fps=30){const points=commands.filter((c):c is Extract<EditorCommand,{type:"add_keyframe"}>=>c.type==="add_keyframe").map(c=>c.keyframe),time=frame/fps;let a=points[0];for(let i=1;i<points.length;i++){const b=points[i];if(time<b.time-1e-9){const mix=a.easing==="hold"?0:(time-a.time)/(b.time-a.time);return{x:a.transform.x+(b.transform.x-a.transform.x)*mix,y:a.transform.y+(b.transform.y-a.transform.y)*mix};}a=b;}return{x:a.transform.x,y:a.transform.y};}
describe("streaming sparse automatic reframe",()=>{
 it("keeps every sampled camera position within the fixed pixel corridor and pan limit",()=>{
  const p=fixture(),data=Array.from({length:300},(_,i)=>obs(i,.5+.25*Math.sin(i/30*.8))),dense=compileAutoReframeV1(p,{...input,sourceWidth:160,sourceHeight:90,observations:data}),sink=createAutoReframeSparseV2(p,input),before=JSON.stringify(p);sink.initialize(160,90);for(const row of data)sink.consume(row);const sparse=sink.finish();
  expect(sparse.commands.length).toBeLessThan(dense.commands.length/2);const renderedWidth=input.outputWidth/dense.crop.width;
  for(let i=0;i<data.length;i++){const current=pose(sparse.commands,i),reference=pose(dense.commands,i);expect(Math.abs(current.x-reference.x)).toBeLessThanOrEqual(.25+1e-8);expect(Math.abs(current.y-reference.y)).toBeLessThanOrEqual(.25+1e-8);if(i)expect(Math.abs(current.x-pose(sparse.commands,i-1).x)).toBeLessThanOrEqual(.6*renderedWidth/30+1e-8);}
  expect(sparse.compression.storedWholeObservationRows).toBe(0);expect(sparse.observations.length).toBeLessThanOrEqual(8);expect(sparse.compression.maximumDiagnosticRows).toBeLessThanOrEqual(8);expect(JSON.stringify(p)).toBe(before);
 });
 it("preserves both sides of a cut as hold/reset points without interpolating across the scene jump",()=>{
  const p=fixture(90),data=Array.from({length:90},(_,i)=>obs(i,i<30?.3:i<60?.75:.4,30,i===0||i===30||i===60)),dense=compileAutoReframeV1(p,{...input,sourceWidth:160,sourceHeight:90,observations:data}),s=createAutoReframeSparseV2(p,input);s.initialize(160,90);for(const row of data)s.consume(row);const sparse=s.finish();
  for(let i=0;i<90;i++)expect(Math.abs(pose(sparse.commands,i).x-pose(dense.commands,i).x)).toBeLessThanOrEqual(.25+1e-8);
  for(const f of[29,59]){const c=sparse.commands.find(c=>c.type==="add_keyframe"&&Math.abs(c.keyframe.time-f/30)<1e-9);expect(c?.type==="add_keyframe"&&c.keyframe.easing).toBe("hold");}
 });
 it("processes a modeled twelve-hour low-rate camera clock without storing the full trace or hitting the old dense cap",()=>{
  const p=fixture(43200,1);expect(()=>compileAutoReframeV1(p,{...input,sourceWidth:160,sourceHeight:90,observations:[]})).toThrow("BUDGET");const s=createAutoReframeSparseV2(p,input);s.initialize(160,90);for(let i=0;i<43200;i++)s.consume(obs(i,.4,1));const result=s.finish();
  expect(result.metrics.observations).toBe(43200);expect(result.commands).toHaveLength(3);expect(result.compression.outputKeyframes).toBe(2);expect(result.frames.length).toBe(8);expect(result.observations.length).toBe(8);expect(result.compression.storedWholeObservationRows).toBe(0);expect(result.subjectQualityCertified).toBe(false);
 });
 it("refuses complex output budget exhaustion rather than dropping source frames or raising the error threshold",()=>{
  const p=fixture(10),s=createAutoReframeSparseV2(p,{...input,maximumCommands:3});s.initialize(160,90);s.consume(obs(0,.3));s.consume(obs(1,.7,30,true));expect(()=>s.consume(obs(2,.4,30,true))).toThrow("COMMAND_BUDGET_EXHAUSTED");expect(()=>s.finish()).toThrow("STATE");
  expect(()=>createAutoReframeSparseV2(p,{...input,maximumPositionErrorPixels:1})).toThrow("BUDGET");
 });
 it("authenticates the original project/request and rejects fake, mutated or reused source sinks",()=>{
  const p=fixture(3),s=createAutoReframeSparseV2(p,input);expect(()=>assertAutoReframeSparseSinkV2(s,p,input)).not.toThrow();expect(()=>assertAutoReframeSparseSinkV2({...s},p,input)).toThrow("OWNER");expect(()=>assertAutoReframeSparseSinkV2(s,p,{...input,outputWidth:91})).toThrow("OWNER");const changed=structuredClone(p);changed.revision++;expect(()=>assertAutoReframeSparseSinkV2(s,changed,input)).toThrow("OWNER");
  s.initialize(160,90);expect(()=>s.initialize(160,90)).toThrow("INITIALIZATION");expect(()=>s.finish()).toThrow("INCOMPLETE");s.consume(obs(0));s.consume(obs(1));s.consume(obs(2));s.finish();expect(()=>s.finish()).toThrow("STATE");expect(()=>s.consume(obs(3))).toThrow("STATE");
 });
 it("holds the camera immediately through an unknown subject span and does not invent motion from the old velocity",()=>{
  const p=fixture(30),s=createAutoReframeSparseV2(p,input);s.initialize(160,90);for(let i=0;i<30;i++)s.consume(i<10?obs(i,.3+i*.03):{...obs(i),subject:undefined});const r=s.finish(),at10=pose(r.commands,10);for(let i=11;i<30;i++)expect(Math.abs(pose(r.commands,i).x-at10.x)).toBeLessThanOrEqual(.25+1e-8);expect(r.metrics.unknownFrames).toBe(20);
 });
 it("requires ordered, finite, complete source observations and honest hashes",()=>{
  for(const row of[{...obs(0),frame:1},{...obs(0),pixelSha256:"missing"},{...obs(0),subject:{...obs(0).subject!,confidence:NaN}}]){const s=createAutoReframeSparseV2(fixture(2),input);s.initialize(160,90);expect(()=>s.consume(row)).toThrow("OBSERVATION");expect(()=>s.finish()).toThrow("STATE");}
 });
});
