import { beforeAll,expect,it,vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir,mkdtemp,readFile,writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sampleMaterialColor,getMaterialColorRuntimeIdentity,verifyMaterialColorReceipt,materialColorRequestSnapshot,type MaterialColorRequest } from "./materialColorSampling";
import * as io from "./materialColorSamplingRuntime";
const app=fileURLToPath(new URL("../../",import.meta.url)),ff=resolve(app,"vendor/ffmpeg/win32-x64/ffmpeg.exe"),fp=resolve(app,"vendor/ffmpeg/win32-x64/ffprobe.exe");
const runtime={ffmpegPath:ff,ffprobePath:fp};let dir:string;
const sources:Record<string,string>={};
function run(args:string[]) {const r=spawnSync(ff,args,{windowsHide:true,timeout:30000,maxBuffer:2*1024*1024});if(r.status!==0)throw Error(r.stderr.toString());return r.stdout;}
async function request(name="sdr",patch:Partial<MaterialColorRequest>={}):Promise<MaterialColorRequest> {return {sourcePath:sources[name],sourceSha256:await io.colorFileSha(sources[name]),sourceStart:.1,duration:1,kind:"video",sceneCount:3,sceneCountVerified:true,samples:[{id:"a",time:.01,sceneIndex:0},{id:"b",time:.41,sceneIndex:2}],...patch};}
beforeAll(async()=>{
  await mkdir(resolve(app,".rd/tmp"),{recursive:true});dir=await mkdtemp(resolve(app,".rd/tmp/material-color-sampling-"));
  for(const name of ["sdr","hlg","pq","unknown","offset","vfr"]) {
    const file=resolve(dir,`${name}.mkv`);sources[name]=file;
    const hdr=name==="hlg"||name==="pq";
    const vui=name==="unknown"?[]:["-x264-params",`colorprim=${hdr?"bt2020":"bt709"}:transfer=${name==="hlg"?"arib-std-b67":name==="pq"?"smpte2084":"bt709"}:colormatrix=${hdr?"bt2020nc":"bt709"}:range=tv`];
    run(["-v","error","-f","lavfi","-i","testsrc2=size=64x96:rate=10:duration=1.5",...(name==="offset"?["-vf","setpts=PTS+5/TB"]:name==="vfr"?["-vf","select='not(eq(n,2)+eq(n,3))'"]:[]),"-fps_mode","passthrough","-c:v","libx264","-qp","0","-pix_fmt",hdr?"yuv420p10le":"yuv420p",...vui,file]);
  }
  sources.alpha=resolve(dir,"alpha.mkv");
  run(["-v","error","-f","lavfi","-i","color=s=32x32:r=10:d=1,format=yuva444p,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709","-c:v","ffv1",sources.alpha]);
  sources.cut=resolve(dir,"known-cut.mkv");
  run(["-v","error","-f","lavfi","-i","color=red:s=64x64:r=10:d=0.1","-f","lavfi","-i","color=blue:s=64x64:r=10:d=1","-filter_complex","[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]","-map","[v]","-c:v","libx264","-qp","0","-x264-params","colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv",sources.cut]);
},30000);
it("measures portrait SDR with real non-requested PTS and exact literal RGB hash",async()=>{
  const q=await request(),identity=await getMaterialColorRuntimeIdentity(runtime);
  expect(identity.status).toBe("verified");
  const r=await sampleMaterialColor(q,runtime,identity);await writeFile(resolve(dir,"sdr-receipt.json"),JSON.stringify(r,null,2));
  expect(r.status,JSON.stringify(r)).toBe("measured");verifyMaterialColorReceipt(JSON.parse(JSON.stringify(r)));
  expect(r.mapping[0].decodedRelativeTime).not.toBe(q.samples[0].time);
  expect(r.mapping[0]).toMatchObject({width:64,height:96,decodedSourceTime:.2});
  expect(r.coverage).toMatchObject({sampledSceneIndices:[0,2],omittedSceneIndices:[1],sceneCountVerified:true});
  const bytes=run(["-v","error","-copyts","-ss","0.11","-i",sources.sdr,"-vf","select='gte(t,0.11)',scale=64:96:force_original_aspect_ratio=decrease,format=rgba,format=rgb24","-frames:v","1","-fps_mode","passthrough","-pix_fmt","rgb24","-f","rawvideo","-"]);
  expect(r.mapping[0].rawRgbSha256).toBe(io.colorBytesSha(bytes));
  expect(r.source.beforeSha256).toBe(q.sourceSha256);expect(r.source.afterSha256).toBe(q.sourceSha256);
},30000);
it.each(["hlg","pq"])("matches independent neutral %s normalization without grade",async name=>{
  const r=await sampleMaterialColor(await request(name),runtime);expect(r.status,JSON.stringify(r)).toBe("measured");
  const tone=name==="hlg"?"zscale=p=bt709,tonemap=tonemap=hable:desat=0":"tonemap=tonemap=hable:desat=0";
  const bytes=run(["-v","error","-copyts","-ss","0.11","-i",sources[name],"-vf",`select='gte(t,0.11)',zscale=t=linear:npl=100${name==="hlg"?":agamma=0":""},format=gbrpf32le,${tone},zscale=p=bt709:t=bt709:m=bt709:r=tv,format=rgba,scale=64:96:force_original_aspect_ratio=decrease,format=rgba,format=rgb24`,"-frames:v","1","-fps_mode","passthrough","-pix_fmt","rgb24","-f","rawvideo","-"]);
  expect(r.mapping[0].rawRgbSha256).toBe(io.colorBytesSha(bytes));
  expect(r.normalization).toMatchObject({exposure:0,creativeLook:false});
},30000);
it.each(["offset","vfr"])("observes actual %s timestamps, not seek labels",async name=>{
  const q=await request(name),r=await sampleMaterialColor(q,runtime);expect(r.status,JSON.stringify(r)).toBe("measured");
  expect(r.probe!.timelineOrigin).toBe(name==="offset"?5:0);
  expect(r.mapping[0].decodedSourceTime).toBeCloseTo(name==="offset"?.2:.4,8);
},30000);
it("marks duplicate decoded frames unmeasured and never fabricates unique IDs",async()=>{
  const q=await request("sdr",{samples:[{id:"a",time:.01,sceneIndex:0},{id:"b",time:.02,sceneIndex:0}]}),r=await sampleMaterialColor(q,runtime);
  expect(r).toMatchObject({status:"unmeasured",reason:"duplicate-decoded-frame"});expect(r.measurements).toBeUndefined();expect(r.mapping[0].decodedPts).toBe(r.mapping[1].decodedPts);
},30000);
it("rejects unknown/mismatched/Log/unsupported management and false source identity",async()=>{
  const requests=[await request("unknown"),await request("sdr",{color:{interpretation:"hlg"}}),await request("sdr",{color:{interpretation:"log_unresolved"}}),await request("sdr",{sourceSha256:"0".repeat(64)}),await request("sdr",{colorManagement:{mode:"aces2",workingSpace:"ACEScct",outputTransform:"rec709_sdr",configId:"studio-config-v4.0.0_aces-v2.0_ocio-v2.5"}})];
  for(const q of requests) {const r=await sampleMaterialColor(q,runtime);expect(r.status).toBe("unmeasured");expect(r.measurements).toBeUndefined();}
},60000);
it("keeps unknown scene coverage explicit and handles audio without imagery",async()=>{
  const r=await sampleMaterialColor(await request("sdr",{sceneCountVerified:undefined}),runtime);expect(r.status).toBe("measured");expect(r.coverage.sceneCountVerified).toBe(false);
  const audio=await sampleMaterialColor(await request("sdr",{kind:"audio",samples:[],sceneCount:0}),{ffmpegPath:"ffmpeg"});expect(audio.status).toBe("not_applicable");verifyMaterialColorReceipt(audio);
},30000);
it("fails malformed requests, bare tool paths and stale identities",async()=>{
  const q=await request();await expect(sampleMaterialColor({...q,samples:[]},runtime)).rejects.toThrow();
  expect((await sampleMaterialColor(q,{ffmpegPath:"ffmpeg"})).status).toBe("unmeasured");
  const identity=await getMaterialColorRuntimeIdentity(runtime);identity.tools[0].sha256="0".repeat(64);
  await expect(sampleMaterialColor(q,runtime,identity)).rejects.toThrow("runtime-identity-drift");
},30000);
it("rejects tampered and rehashed-inconsistent receipts",async()=>{
  const good=await sampleMaterialColor(await request(),runtime);expect(good.status).toBe("measured");
  for(const patch of [(r:any)=>r.mapping[0].rawRgbSha256="0".repeat(64),(r:any)=>r.coverage.sampledCount=9,(r:any)=>r.mapping[0].decodedPts+=1,(r:any)=>r.measurements.frames[0].nearBlack.fraction=.7]) {
    const bad=structuredClone(good);patch(bad);expect(()=>verifyMaterialColorReceipt(bad)).toThrow();
    if(bad.mapping[0].rawRgbSha256!=="0".repeat(64)) {bad.receiptSha256=io.colorDigest({...bad,receiptSha256:undefined});expect(()=>verifyMaterialColorReceipt(bad)).toThrow();}
  }
  expect(good.request).toEqual(materialColorRequestSnapshot(await request()));
  // The shared viewing transform is part of the closed runtime identity even
  // though measurement RGB itself intentionally does not use sRGB encoding.
  expect(good.identity.implementations.map(item=>item.name)).toContain("../color/displayTransfer.ts");
  const omittedDisplay=structuredClone(good);
  omittedDisplay.identity.implementations=omittedDisplay.identity.implementations.filter(item=>item.name!=="../color/displayTransfer.ts");
  omittedDisplay.identity.identitySha256=io.colorDigest({...omittedDisplay.identity,identitySha256:undefined});
  omittedDisplay.receiptSha256=io.colorDigest({...omittedDisplay,receiptSha256:undefined});
  expect(()=>verifyMaterialColorReceipt(omittedDisplay)).toThrow();
  expect(good.request).not.toHaveProperty("sourcePath");
  for(const patch of [(r:any)=>r.request.samples[0].time=.09,(r:any)=>r.request.samples[0].sceneIndex=1,(r:any)=>r.request.sceneCountVerified=false,(r:any)=>r.request.color={interpretation:"hlg"},(r:any)=>r.request.colorManagement.mode="aces2"]){
    const bad=structuredClone(good);patch(bad);bad.receiptSha256=io.colorDigest({...bad,receiptSha256:undefined});expect(()=>verifyMaterialColorReceipt(bad)).toThrow();
  }
  // Derived contract fixture here; genuine retained revision-3 readback is
  // separately replayed in .rd/.../historical-probe.ts without modifying it.
  const legacy=structuredClone(good);
  const names=["materialColorSampling.ts","materialColorSamplingTypes.ts","materialColorSamplingRuntime.ts","materialColorSamplingValidation.ts","../color/shotColorAnalysis.ts","../render/sourceColorFilters.ts","../color/primaryGrade.ts","../render/ffmpegExpressions.ts","../domain/types.ts","../shared/canonicalJson.ts","../shared/utf8ByteOrder.ts"];
  legacy.identity.implementations=names.map(name=>legacy.identity.implementations.find(item=>item.name===name)!);delete legacy.identity.code;
  const reseal=(r:typeof legacy)=>{r.identity.identitySha256=io.colorDigest({...r.identity,identitySha256:undefined});r.receiptSha256=io.colorDigest({...r,receiptSha256:undefined});};reseal(legacy);
  expect(()=>verifyMaterialColorReceipt(legacy)).toThrow();expect(()=>verifyMaterialColorReceipt(legacy,{historicalRuntime:"material-cache-revision-3"})).not.toThrow();
  legacy.identity.implementations.pop();reseal(legacy);expect(()=>verifyMaterialColorReceipt(legacy,{historicalRuntime:"material-cache-revision-3"})).toThrow();
},30000);
it("fails closed on truncated RGB, nonzero exit and source drift through real sampler",async()=>{
  const q=await request(),original=io.runColorProcess;
  for(const mode of ["truncated","exit","drift"] as const) {
    const copy=resolve(dir,`copy-${mode}.mkv`);await writeFile(copy,await readFile(q.sourcePath));
    const spy=vi.spyOn(io,"runColorProcess").mockImplementation(async(exe,args,max,timeout)=>{
      const r=await original(exe,args,max,timeout);
      if(args.includes("pipe:1")) {if(mode==="exit")throw Error("process-exit-1");if(mode==="truncated")return {...r,stdout:r.stdout.subarray(1)};if(mode==="drift")await writeFile(copy,Buffer.from("source-changed"));}
      return r;
    });
    try {const r=await sampleMaterialColor({...q,sourcePath:copy},runtime);expect(r.status).toBe("unmeasured");expect(r.measurements).toBeUndefined();if(mode!=="drift"&&r.status!=="measured")expect(r.reason).toBe(mode==="exit"?"process-exit-1":"truncated-or-invalid-rgb-surface");}
    finally {spy.mockRestore();}
  }
},60000);
it("rejects runtime identity drift even when sampling otherwise fails",async()=>{
  const q=await request("unknown"),identity=await getMaterialColorRuntimeIdentity(runtime);
  const changed=structuredClone(identity);changed.tools[0].sha256="0".repeat(64);changed.identitySha256=io.colorDigest({...changed,identitySha256:undefined});
  const spy=vi.spyOn(io,"getMaterialColorRuntimeIdentity").mockResolvedValueOnce(identity).mockResolvedValue(changed);
  try {await expect(sampleMaterialColor(q,runtime)).rejects.toThrow("runtime-identity-drift");}finally{spy.mockRestore();}
},30000);
it("keeps alpha and malformed probe results unmeasured without RGB measurements",async()=>{
  const q=await request(),original=io.runColorProcess;
  for(const mode of ["alpha","malformed"] as const){
    const spy=vi.spyOn(io,"runColorProcess").mockImplementation(async(exe,args,max,timeout)=>{
      const r=await original(exe,args,max,timeout);
      if(args.includes("-show_streams")){if(mode==="malformed")return {...r,stdout:Buffer.from("{")};const p=JSON.parse(r.stdout.toString());p.streams[0].pix_fmt="yuva420p";return {...r,stdout:Buffer.from(JSON.stringify(p))};}return r;
    });
    try{const r=await sampleMaterialColor(q,runtime);expect(r.status).toBe("unmeasured");expect(r.measurements).toBeUndefined();expect(r.mapping).toHaveLength(0);}finally{spy.mockRestore();}
  }
},30000);
it("rejects real tagged alpha and EXR/JSON containers (container routing only)",async()=>{
  const alpha=await sampleMaterialColor(await request("alpha"),runtime);
  expect(alpha.probe!.metadata.stream).toMatchObject({pix_fmt:"yuva444p",color_primaries:"bt709",color_transfer:"bt709"});
  expect(alpha).toMatchObject({status:"unmeasured",reason:"unsupported-or-alpha-pixel-format"});
  const q=await request();for(const suffix of ["exr","json"]){const file=resolve(dir,`routing-only.${suffix}`);await writeFile(file,await readFile(q.sourcePath));const r=await sampleMaterialColor({...q,sourcePath:file},runtime);expect(r).toMatchObject({status:"unmeasured",reason:"unsupported-source-container"});expect(r.probe).toBeUndefined();}
},30000);
it("reassigns a decoded frame crossing a known cut and preserves requested scene label",async()=>{
  const q=await request("cut",{sourceStart:0,duration:1.1,sceneCuts:[.1],sceneCount:2,samples:[{id:"cross",time:.05,sceneIndex:0},{id:"tail",time:.95,sceneIndex:1}]});
  const r=await sampleMaterialColor(q,runtime);expect(r.status,JSON.stringify(r)).toBe("measured");
  expect(r.mapping[0]).toMatchObject({requestedTime:.05,decodedRelativeTime:.1,requestedSceneIndex:0,sceneIndex:1});
  expect(r.mapping[1]).toMatchObject({decodedRelativeTime:1,requestedSceneIndex:1,sceneIndex:1});
  expect(r.coverage).toMatchObject({sceneAttributionVerified:true,sampledSceneIndices:[1],omittedSceneIndices:[0]});
  const bad=structuredClone(r);bad.mapping[0].sceneIndex=0;bad.coverage.sampledSceneIndices=[0,1];bad.coverage.omittedSceneIndices=[];bad.receiptSha256=io.colorDigest({...bad,receiptSha256:undefined});expect(()=>verifyMaterialColorReceipt(bad)).toThrow();
  for(const cuts of [[0],[.1,.1],[1.1]])await expect(sampleMaterialColor({...q,sceneCuts:cuts,sceneCount:cuts.length+1},runtime)).rejects.toThrow();
  await expect(sampleMaterialColor({...q,samples:[{id:"bad-label",time:.2,sceneIndex:0}]},runtime)).rejects.toThrow();
},30000);
it("bounds actual subprocess timeout and stdout",async()=>{
  await expect(io.runColorProcess(ff,["-re","-f","lavfi","-i","color=s=16x16:r=1:d=10","-f","null","-"],1024,10)).rejects.toThrow("process-timeout");
  await expect(io.runColorProcess(ff,["-v","error","-f","lavfi","-i","color=s=16x16:r=30:d=1","-f","rawvideo","-"],16,10000)).rejects.toThrow("stdout-budget-exceeded");
});
