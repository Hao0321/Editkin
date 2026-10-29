import { describe,expect,it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR,DEFAULT_TRANSFORM } from "../domain/types";
import { applyCommand } from "../domain/commands";
import { createHistory,dispatchCommand,undo } from "../domain/history";
import { compileAutoReframeV1,observeReframePixelsV1,reframeSceneChangeV1,type ReframeObservationV1 } from "./autoReframeV1";
import { autoReframeInputSchemaV1 } from "../mcp/autoReframeToolsV1";
function fixture() {
 const p=createEmptyProject("reframe",{id:"reframe-test",width:160,height:90,fps:30});
 p.assets=[{id:"source",name:"source",kind:"video",uri:"source.mp4",duration:2,width:160,height:90}];
 p.tracks[0].clips=[{id:"clip",assetId:"source",trackId:p.tracks[0].id,timelineStart:0,sourceStart:0,duration:1,volume:.7,transform:{...DEFAULT_TRANSFORM},color:{...DEFAULT_COLOR},keyframes:[]}];return p;
}
const observation=(frame:number,x=.4,sceneCut=!frame):ReframeObservationV1=>({frame,time:frame/30,sceneCut,pixelSha256:"a".repeat(64),subject:{rect:{x:x-.05,y:.4,width:.1,height:.2},confidence:1,origin:"matte"}});
const request=(observations=Array.from({length:30},(_,i)=>observation(i)))=>({clipId:"clip",sourceWidth:160,sourceHeight:90,outputWidth:90,outputHeight:160,observations});
function pixels(){const raw=new Uint8Array(64*36*4);for(let i=0;i<64*36;i++)raw.set([20,40,60,255],i*4);return raw;}
describe("automatic source reframe candidate",()=>{
 it("applies all camera and canvas changes as one Undo step",()=>{
  const p=fixture(),result=compileAutoReframeV1(p,request()),state=dispatchCommand(createHistory(p),{type:"batch",commands:result.commands});
  expect(state.past).toHaveLength(1);expect(state.present.tracks[0].clips[0].keyframes).toHaveLength(30);expect(undo(state).present).toEqual(p);
 });
 it("reads contrast pixels, treats flat frames as unknown, and prefers supplied matte geometry",()=>{
  const raw=pixels();expect(observeReframePixelsV1({rgba:raw,width:64,height:36}).subject).toBeUndefined();
  for(let y=12;y<24;y++)for(let x=32;x<40;x++)raw.set([250,30,20,255],(y*64+x)*4);
  const heuristic=observeReframePixelsV1({rgba:raw,width:64,height:36});expect(heuristic.subject?.origin).toBe("saliency");expect(heuristic.gridCells).toBeLessThanOrEqual(48*48);
  const alpha=new Uint8Array(64*36);for(let y=10;y<20;y++)for(let x=5;x<15;x++)alpha[y*64+x]=255;
  const masked=observeReframePixelsV1({rgba:raw,width:64,height:36,alpha,alphaWidth:64,alphaHeight:36});expect(masked.subject).toMatchObject({origin:"matte",rect:{x:5/64,y:10/36,width:10/64,height:10/36}});
  expect(()=>observeReframePixelsV1({rgba:raw.subarray(4),width:64,height:36})).toThrow("SHAPE");expect(()=>observeReframePixelsV1({rgba:raw,width:64,height:36,alpha:alpha.subarray(1),alphaWidth:64,alphaHeight:36})).toThrow("SHAPE");
 });
 it("prepares portrait cover geometry as existing keyframes, preserves source/audio and leaves input exact",()=>{
  const p=fixture(),before=JSON.stringify(p),result=compileAutoReframeV1(p,request());expect(JSON.stringify(p)).toBe(before);expect(result.commands).toHaveLength(31);
  expect(result.crop.width).toBeCloseTo((9/16)/(16/9));expect(result.metrics.measuredCentral60Ratio).toBe(1);expect(result.mutationPerformed).toBe(false);
  let current=structuredClone(p);for(const cmd of result.commands)current=applyCommand(current,cmd);expect(current.width).toBe(90);expect(current.height).toBe(160);
  expect(current.tracks[0].clips[0]).toMatchObject({assetId:"source",sourceStart:0,duration:1,volume:.7});expect(current.tracks[0].clips[0].keyframes[0].transform.scale).toBeCloseTo((16/9)/(9/16));
  expect(current.assets).toEqual(p.assets);
 });
 it("caps every non-cut pan and stays within source crop bounds even for an abrupt subject jump",()=>{
  const data=Array.from({length:30},(_,i)=>observation(i,i<3?.2:.8)),result=compileAutoReframeV1(fixture(),{...request(data),maximumPanSpeed:.1});
  for(let i=0;i<result.frames.length;i++){const f=result.frames[i];expect(f.centerX).toBeGreaterThanOrEqual(result.crop.width/2);expect(f.centerX).toBeLessThanOrEqual(1-result.crop.width/2);if(i)expect(Math.abs(f.centerX-result.frames[i-1].centerX)).toBeLessThanOrEqual(.1/30+1e-12);}
  expect(result.metrics.measuredCentral60Ratio).toBeLessThan(1);
 });
 it("dead-zone avoids jitter and unknown subjects hold the last camera without inventing a lock",()=>{
  const data=Array.from({length:30},(_,i)=>i>10?{...observation(i),subject:undefined}:observation(i,.4+(i%2?.001:0))),r=compileAutoReframeV1(fixture(),request(data));
  expect(r.frames.every(f=>f.centerX===r.frames[0].centerX)).toBe(true);expect(r.metrics.unknownFrames).toBe(19);
 });
 it("a scene reset may jump, with a hold keyframe before the cut and cleared spring velocity",()=>{
  const data=Array.from({length:30},(_,i)=>observation(i,i<15?.2:.8,i===0||i===15)),r=compileAutoReframeV1(fixture(),request(data));
  expect(r.frames[15].centerX).toBeCloseTo(.8);expect(r.frames[16].centerX).toBeCloseTo(.8);
  const before=r.commands.find(c=>c.type==="add_keyframe"&&c.keyframe.time===14/30);expect(before?.type==="add_keyframe"&&before.keyframe.easing).toBe("hold");
  const a=new Float64Array(48),b=new Float64Array(48);a[0]=1;b[15]=1;expect(reframeSceneChangeV1(a,b)).toBe(true);expect(reframeSceneChangeV1(a,a)).toBe(false);
 });
 it("rejects locked tracks, existing camera, foreign content resize, missing observations and bad provenance",()=>{
  const p=fixture();p.tracks[0].locked=true;expect(()=>compileAutoReframeV1(p,request())).toThrow("鎖定");p.tracks[0].locked=false;
  p.tracks[0].clips[0].transform.x=1;expect(()=>compileAutoReframeV1(p,request())).toThrow("MERGE");p.tracks[0].clips[0].transform.x=0;
  p.motionGraphics.push({}as never);expect(()=>compileAutoReframeV1(p,request())).toThrow("RECOMPOSITION");p.motionGraphics=[];
  expect(()=>compileAutoReframeV1(p,request([observation(0)]))).toThrow("BUDGET");const data=request();data.observations[3].pixelSha256="unknown";expect(()=>compileAutoReframeV1(p,data)).toThrow("OBSERVATION");
 });
 it("MCP input is strict and carries saved-project/source binding without force or model options",()=>{
  const value={projectPath:"project.json",clipId:"clip",expectedProjectSha256:"a".repeat(64),expectedSourceSha256:"b".repeat(64),outputWidth:90,outputHeight:160};
  expect(autoReframeInputSchemaV1.parse(value).maximumCommands).toBe(4096);expect(()=>autoReframeInputSchemaV1.parse({...value,force:true})).toThrow();expect(()=>autoReframeInputSchemaV1.parse({...value,model:"sam"})).toThrow();
 });
});
