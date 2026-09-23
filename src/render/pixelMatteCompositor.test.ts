import { expect,it,vi } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir,mkdtemp,readFile,writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDemoProject } from "../domain/demo";
import { createClipMask } from "../domain/masks";
import { floorFrameRateSampleIndex,rationalRate } from "../domain/clipAlphaPlan";
import { createProductAutoRotoRouteReceipt } from "../application/autoRotoProductContract";
import type { RotoMatteSequence } from "../domain/types";
import { renderComposite } from "./ffmpegComposite";
import { buildRenderPlan } from "./planner";
import * as sampling from "./pixelMatteSampling";

const app=fileURLToPath(new URL("../../",import.meta.url));
const ff=resolve(app,"vendor/ffmpeg/win32-x64/ffmpeg.exe"),fp=resolve(app,"vendor/ffmpeg/win32-x64/ffprobe.exe");
const sha=(b:Uint8Array)=>createHash("sha256").update(b).digest("hex");
function run(args:string[],input?:Buffer) {
  const r=spawnSync(ff,args,{input,windowsHide:true,timeout:30000,maxBuffer:8*1024*1024});
  if(r.status!==0)throw Error(r.stderr.toString());return r.stdout;
}
/** Synthetic, byte-verified contract fixture, NOT an executed tracker/model receipt. */
async function fixture(cacheRoot:string) {
  const root=resolve(cacheRoot,"auto-roto-product","e".repeat(64));await mkdir(root,{recursive:true});
  const count=11,width=16,height=16,analysisFps=12;
  const sequence=Buffer.alloc(count*width*height);
  for(let i=0;i<count;i++)sequence.fill(20*(i+1),i*width*height,(i+1)*width*height);
  const sequencePath=resolve(root,"matte-sequence.alpha8"),manifestPath=resolve(root,"matte-manifest.json");
  await writeFile(sequencePath,sequence);
  run(["-v","error","-f","rawvideo","-pixel_format","gray","-video_size","16x16","-framerate","12","-i","pipe:0","-start_number","0",resolve(root,"frame-%06d.png")],sequence);
  const framePaths=Array.from({length:count},(_,i)=>resolve(root,`frame-${String(i).padStart(6,"0")}.png`));
  const routeReceipt=createProductAutoRotoRouteReceipt();
  const regionMemoryRouting={schema:"editkin.region-memory-routing/v1" as const,requested:"fixed_baseline" as const,executed:"fixed_baseline" as const,candidateAttempted:false as const,deterministicFallback:false as const};
  const alphaRefinement={schema:"editkin.optical-alpha-refinement-aggregate/v1" as const,engine:"editkin-self-authored-optical-alpha-refiner/v1" as const,appliedFrames:count,radius:4,backgroundThreshold:.2,foregroundThreshold:.8,coarseWeight:.5,temporalStability:.5,temporalGate:.5,changedPixels:0,fractionalPixels:count*width*height,solvedPixels:0,meanSolveConfidence:.8};
  const matte:RotoMatteSequence={schema:"editkin.auto-roto-matte/v1",engine:"editkin-native-color-temporal-roto/v1",width,height,analysisFps,frameCount:count,sequenceUri:sequencePath,sequenceSha256:sha(sequence),sequenceBytes:sequence.length,manifestUri:manifestPath,framePreviewUris:framePaths,frameArtifactUris:framePaths,meanBoundaryChatter:0,correctionStrokesApplied:0,correctedFrames:[],regionMemoryRouting,alphaRefinement,routeReceipt,frozen:true,qualityState:"diagnostic"};
  const frames=await Promise.all(framePaths.map(async(alphaPath,i)=>({frame:i,time:i/analysisFps,alphaPath,confidence:.9,foregroundRatio:.4,boundaryChatter:0,previewSha256:sha(await readFile(alphaPath)),alphaFrameSha256:sha(sequence.subarray(i*width*height,(i+1)*width*height))})));
  await writeFile(manifestPath,JSON.stringify({schema:matte.schema,engine:matte.engine,width,height,analysisFps,initialFrame:4,sequencePath,frames,sequenceSha256:matte.sequenceSha256,sequenceBytes:sequence.length,meanBoundaryChatter:0,correctionStrokesApplied:0,correctedFrames:[],regionMemoryRouting,alphaRefinement,frozen:true,qualityState:"diagnostic",routeReceipt}));
  return matte;
}

it.each([...([24,25,30,60,24000/1001,30000/1001].map(fps=>({fps,mutant:false}))),{fps:30,mutant:true}])("public verified-artifact compositor sequence $fps (old-rounding mutant=$mutant)",async ({fps,mutant})=>{
  await mkdir(resolve(app,".rd/tmp"),{recursive:true});
  const cacheRoot=await mkdtemp(resolve(app,".rd/tmp/pixel-matte-compositor-"));
  const matte=await fixture(cacheRoot),source=resolve(cacheRoot,"source.mp4");
  run(["-v","error","-f","lavfi","-i",`color=c=white:s=16x16:r=${fps}:d=4`,"-c:v","libx264",source]);
  const project=createDemoProject();project.width=16;project.height=16;project.fps=fps;
  project.assets[0].uri=source;project.assets[0].duration=4;
  const clip=project.tracks[0].clips[0];clip.timelineStart=7/fps;clip.sourceStart=3/fps;clip.duration=47/fps;clip.volume=0;
  const mask=createClipMask("verified-fixture","subject");mask.matteSequence=matte;clip.masks=[mask];
  const before=JSON.stringify(project),output=resolve(cacheRoot,"output.mp4");
  const actualSampling=sampling.pixelMatteSamplingFilters;
  const spy=mutant?vi.spyOn(sampling,"pixelMatteSamplingFilters").mockImplementation((...args)=>actualSampling(...args).map(f=>f.replace("round=up","round=down"))):undefined;
  try { await renderComposite(ff,fp,output,project,buildRenderPlan(project,p=>p),undefined,"libx264",30000,undefined,undefined,undefined,cacheRoot); }
  finally { spy?.mockRestore(); }
  const raw=run(["-v","error","-i",output,"-an","-fps_mode","passthrough","-pix_fmt","rgb24","-f","rawvideo","-"]);
  const stride=16*16*3;expect(raw.length/stride).toBe(54);
  const observations=Array.from({length:54},(_,n)=>{
    const index=n<7?null:floorFrameRateSampleIndex(n-7,rationalRate(fps),rationalRate(12),11);
    return {frame:n,sample:index,expected:index===null?0:20*(index+1),actual:raw[n*stride+8*16*3+8*3]};
  });
  await writeFile(resolve(cacheRoot,"evidence.json"),JSON.stringify({scope:"synthetic artifact compositor transport, not tracker quality",fps,mutant,observations,outputSha256:sha(await readFile(output)),sequenceSha256:sha(await readFile(matte.sequenceUri))},null,2));
  const mismatches=observations.filter(o=>Math.abs(o.actual-o.expected)>3);
  if(mutant) { expect(mismatches.length).toBeGreaterThan(0);expect(mismatches.some(o=>o.frame===9)).toBe(true); }
  else expect(mismatches,cacheRoot).toEqual([]);
  expect(JSON.stringify(project)).toBe(before);
  // Integrity guard remains in the real public entry, never bypassed for sampling.
  const corrupt=structuredClone(project);corrupt.tracks[0].clips[0].masks![0].matteSequence!.sequenceSha256="0".repeat(64);
  await expect(renderComposite(ff,fp,resolve(cacheRoot,"must-not-render.mp4"),corrupt,buildRenderPlan(corrupt,p=>p),undefined,"libx264",30000,undefined,undefined,undefined,cacheRoot)).rejects.toThrow();
},30000);
