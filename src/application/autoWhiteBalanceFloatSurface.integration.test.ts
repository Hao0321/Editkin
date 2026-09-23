import {afterAll,describe,expect,it} from "vitest";
import {spawnSync} from "node:child_process";
import {mkdirSync,writeFileSync,readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {autoWhiteBalanceReferencePlan,autoColorCandidateFilters} from "./autoColorFrame";
import {sourceLinearWhiteBalancePlan} from "../render/sourceLinearWhiteBalance";
import {DEFAULT_COLOR,type MediaAsset} from "../domain/types";
const app=fileURLToPath(new URL("../../",import.meta.url)),exe=resolve(app,"vendor/ffmpeg/win32-x64/ffmpeg.exe");
const evidence:unknown[]=[];
const count=512*64;
function source(kind:"rec709"|"hlg"|"pq"):MediaAsset{return {id:"float",name:"engineering raw",uri:"not-user-media",kind:"video",duration:1,alphaMode:"straight",color:{interpretation:kind,primaries:kind==="rec709"?"bt709":"bt2020",transfer:kind==="rec709"?"bt709":kind==="hlg"?"arib-std-b67":"smpte2084",matrix:kind==="rec709"?"gbr":"bt2020nc",range:kind==="rec709"?"full":"tv"}};}
function zeroPrecisionPlan(asset:MediaAsset){
 if(asset.color?.interpretation!=="pq")return autoWhiteBalanceReferencePlan(asset,DEFAULT_COLOR);
 // Preserve the old PQ zero-decode/resize pixel controls, but do not call this
 // engineering composition an available reference-WB or corrected-PQ feature.
 expect(()=>autoWhiteBalanceReferencePlan(asset,DEFAULT_COLOR)).toThrow(/PQ.*白平衡.*尚未/);
 const neutral=sourceLinearWhiteBalancePlan(asset,DEFAULT_COLOR);
 evidence.push({kind:"pq",scope:"zero-source-decode-plus-literal-resize-only",referenceWhiteBalance:"BLOCKED"});
 return {...neutral,filters:[...neutral.filters,"zscale=w='if(gte(iw,ih),256,-1)':h='if(gte(ih,iw),256,-1)'","format=gbrapf32le"]};
}
function pixels(kind:string){
 const palette=kind==="rec709"?[[-.1,.1,1.5,.1],[1.3,.8,.4,.3],[.3,.5,.7,.7],[1.5,1.5,1.5,1]]:[[1,.01,.01,.1],[.01,1,.01,.3],[.01,.01,1,.7],[1,1,1,1]];
 const bytes=Buffer.alloc(count*16);[1,2,0,3].forEach((channel,plane)=>{for(let y=0;y<64;y++)for(let x=0;x<512;x++)bytes.writeFloatLE(palette[Math.floor(x/128)][channel],(plane*count+y*512+x)*4);});return bytes;
}
function run(asset:MediaAsset,input:Buffer,filters:string[],size:number,label:string,dimensions="512x64"){
 const args=["-v","error","-nostdin","-f","rawvideo","-pixel_format","gbrapf32le","-video_size",dimensions,"-color_trc",asset.color!.transfer!,"-color_primaries",asset.color!.primaries!,"-colorspace","0","-color_range","pc","-i","pipe:0","-vf",filters.join(","),"-frames:v","1","-pix_fmt","gbrapf32le","-f","rawvideo","pipe:1"];
 const result=spawnSync(exe,args,{input,windowsHide:true,timeout:15000,maxBuffer:2*1024*1024});
 evidence.push({label,args,exit:result.status,error:result.error?.message,stderr:result.stderr.toString(),bytes:result.stdout.length});
 if(result.error||result.status!==0)throw Error(`Pinned FFmpeg ${label} exit ${result.status}: ${result.error??result.stderr.toString()}`);
 expect(result.stdout.length).toBe(size*16);return result.stdout;
}
const read=(b:Buffer,n:number,index:number)=>[2,0,1,3].map(plane=>b.readFloatLE((plane*n+index)*4));
afterAll(()=>{const dir=resolve(app,".rd/linear-white-balance-20260831");mkdirSync(dir,{recursive:true});writeFileSync(resolve(dir,`float-resize-evidence-${Date.now()}.json`),JSON.stringify({scope:"engineering-raw-float-resize-not-user-video",exe,exeSha256:createHash("sha256").update(readFileSync(exe)).digest("hex"),evidence},null,2));});
describe("actual source-linear WB 512x64 to 256x32 FLOAT surface",()=>{
 it.each(["rec709","hlg","pq"] as const)("preserves %s zero-source portrait precision (PQ reference remains blocked)",kind=>{
  const asset=source(kind),landscape=pixels(kind),portrait=Buffer.alloc(landscape.length);
  for(let plane=0;plane<4;plane++)for(let y=0;y<512;y++)for(let x=0;x<64;x++)
   portrait.writeFloatLE(landscape.readFloatLE((plane*count+x*512+y)*4),(plane*count+y*64+x)*4);
  const expr=(c:string)=>`if(lt(${c}(X,Y),0.081),${c}(X,Y)/4.5,pow((${c}(X,Y)+0.099)/1.099,1/0.45))`;
  const oracleFilters=kind==="rec709"?[`geq=r='${expr("r")}':g='${expr("g")}':b='${expr("b")}':a='alpha(X,Y)':i=nearest`]:[kind==="hlg"?"zscale=t=linear:npl=100:agamma=0":"zscale=t=linear:npl=100","zscale=p=bt709"];
  const oracle=run(asset,portrait,oracleFilters,count,`${kind}-portrait-independent`,"64x512");
  const actual=run(asset,portrait,zeroPrecisionPlan(asset).filters,32*256,`${kind}-portrait-zero-source`,"64x512");
  run(asset,portrait,autoColorCandidateFilters(asset,DEFAULT_COLOR),32*256,`${kind}-portrait-output-safety-shape`,"64x512");
  const values=Array.from({length:4},(_,patch)=>({patch,expected:read(oracle,count,(patch*128+64)*64+32),observed:read(actual,32*256,(patch*64+32)*32+16)}));
  evidence.push({kind,geometry:"portrait32x256",values});
  values.forEach(({expected,observed})=>observed.forEach((v,c)=>expect(Math.abs(v-expected[c])).toBeLessThan(c===3?1e-6:3e-5)));
  expect(values.some(v=>v.observed.slice(0,3).some(c=>c>1))).toBe(true);
  expect(values.some(v=>v.observed.slice(0,3).some(c=>c<0))).toBe(true);
  expect(new Set(values.map(v=>v.observed[3])).size).toBe(4);
 });
 it.each(["rec709","hlg","pq"] as const)("preserves %s zero-source signed/HDR/alpha resize (PQ reference remains blocked)",kind=>{
  const asset=source(kind),input=pixels(kind),plan=zeroPrecisionPlan(asset);
  const expr=(c:string)=>`if(lt(${c}(X,Y),0.081),${c}(X,Y)/4.5,pow((${c}(X,Y)+0.099)/1.099,1/0.45))`;
  // Literal independent non-resized decoder; never use production helper for oracle.
  const oracleFilters=kind==="rec709"?[`geq=r='${expr("r")}':g='${expr("g")}':b='${expr("b")}':a='alpha(X,Y)':i=nearest`]:[kind==="hlg"?"zscale=t=linear:npl=100:agamma=0":"zscale=t=linear:npl=100","zscale=p=bt709"];
  const oracle=run(asset,input,oracleFilters,count,`${kind}-independent-unscaled`);
  // Same decoder dimensions as the separately measured RGB8 safety surface;
  // final float transport here only checks shape, not RGB8 numerical fidelity.
  run(asset,input,autoColorCandidateFilters(asset,DEFAULT_COLOR),256*32,`${kind}-output-safety-shape`);
  const actual=run(asset,input,plan.filters,256*32,`${kind}-production-scaled`);
  const trial=run(asset,input,plan.filters.map(f=>f==="scale=256:256:force_original_aspect_ratio=decrease"?"zscale=w='if(gte(iw,ih),256,-1)':h='if(gte(ih,iw),256,-1)'":f),256*32,`${kind}-private-zscale-trial`);
  const values:Array<{patch:number;expected:number[];observed:number[]}>=[];for(let patch=0;patch<4;patch++){
   const expected=read(oracle,count,32*512+patch*128+64),observed=read(actual,256*32,16*256+patch*64+32);
   values.push({patch,expected,observed});
  }
  evidence.push({kind,values});
  const trialValues=values.map(({patch,expected})=>({patch,expected,observed:read(trial,256*32,16*256+patch*64+32)}));
  evidence.push({kind,trialValues});
  trialValues.forEach(({observed,expected})=>observed.forEach((v,c)=>expect(Math.abs(v-expected[c])).toBeLessThan(c===3?1e-6:3e-5)));
  const legacy=run(asset,input,[...oracleFilters,"scale=256:256:force_original_aspect_ratio=decrease","format=gbrapf32le"],256*32,`${kind}-legacy-swscale-mutant`);
  expect(values.some(({patch,expected})=>read(legacy,256*32,16*256+patch*64+32).slice(0,3).some((v,c)=>Math.abs(v-expected[c])>.01))).toBe(true);
  values.forEach(({observed,expected})=>observed.forEach((v,c)=>expect(Math.abs(v-expected[c])).toBeLessThan(c===3?1e-6:3e-5)));
  expect(values.some(v=>v.observed.slice(0,3).some(c=>c>1))).toBe(true);expect(values.some(v=>v.observed.slice(0,3).some(c=>c<0))).toBe(true);
  expect(new Set(values.map(v=>v.observed[3])).size).toBe(4);
  const broken=run(asset,input,[...oracleFilters,"format=gbrap16le","scale=256:32","format=gbrapf32le"],256*32,`${kind}-integer-clamp-negative`);
  const brokenValues=Array.from({length:4},(_,patch)=>read(broken,256*32,16*256+patch*64+32));
  expect(brokenValues.some((v,i)=>v.slice(0,3).some((c,j)=>Math.abs(c-values[i].expected[j])>.01))).toBe(true);
 });
});
