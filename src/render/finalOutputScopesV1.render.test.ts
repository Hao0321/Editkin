import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { renderProject } from "./ffmpeg";
import { collectRenderArtifactIdentity } from "./renderArtifactIdentity";
import { outputColorMetadataArgs } from "./outputColorMetadata";
import { measureFinalOutputScopesV1 } from "./finalOutputScopesV1";
import { readFinalPixelScopePageV1, type FinalPixelScopeMeasurement } from "../color/finalPixelScopesV1";
const app=fileURLToPath(new URL("../../",import.meta.url)),ffmpeg=resolve(app,"vendor/ffmpeg/win32-x64/ffmpeg.exe"),ffprobe=resolve(app,"vendor/ffmpeg/win32-x64/ffprobe.exe");
const width=96,height=48,frames=6;let root="";
function run(args:string[],input?:Buffer){const child=spawnSync(ffmpeg,args,{input,windowsHide:true,maxBuffer:1<<24,timeout:30000});if(child.error||child.status!==0)throw Error(child.error?.message??child.stderr.toString());return child.stdout;}
function movie(name:string,colors:number[][],hlg=false){
  const input=Buffer.alloc(width*height*3*frames);
  for(let frame=0;frame<frames;frame++)for(let pixel=0;pixel<width*height;pixel++)input.set(colors[frame%colors.length],(frame*width*height+pixel)*3);
  run(["-v","error","-f","rawvideo","-pixel_format","rgb24","-video_size",`${width}x${height}`,"-framerate","30","-i","pipe:0",
    "-vf",`scale=in_range=full:out_range=limited:out_color_matrix=${hlg?"bt2020":"bt709"},format=yuv444p`,"-c:v","libx264","-qp","0","-pix_fmt","yuv444p",
    ...outputColorMetadataArgs("libx264",hlg?"rec2100_hlg_1000":"rec709_sdr"),join(root,name)],input);
}
beforeAll(async()=>{root=await mkdtemp(join(tmpdir(),"editkin-final-output-scopes-"));
  movie("base.mp4",[[180,40,40],[40,180,40],[90,140,40],[170,80,40],[50,130,50],[140,40,80]]);movie("blue.mp4",[[40,40,210]]);
  // Explicit authored BT2020 HLG code values, not SDR camera appearance relabelled as a reference.
  movie("hlg.mp4",[[160,130,110],[90,110,160]],true);
});
afterAll(async()=>{if(!root)return;if(!resolve(root).startsWith(resolve(tmpdir())+sep)||!basename(root).startsWith("editkin-final-output-scopes-"))throw Error("Unexpected owned test directory");await rm(root,{recursive:true});});
function project(hlg=false):EditProject{
  const value=createEmptyProject("Final output numerical scope controls",{width,height,fps:30});
  value.assets.push({id:"base",name:"authored-codes",uri:join(root,hlg?"hlg.mp4":"base.mp4"),kind:"video",duration:frames/30,width,height,
    color:hlg?{interpretation:"hlg",primaries:"bt2020",transfer:"arib-std-b67",matrix:"bt2020nc",range:"tv"}:{interpretation:"rec709",primaries:"bt709",transfer:"bt709",matrix:"bt709",range:"tv"}});
  value.tracks[0].clips.push({id:"base-clip",trackId:value.tracks[0].id,assetId:"base",timelineStart:0,sourceStart:0,duration:frames/30,volume:0,transform:{...DEFAULT_TRANSFORM},color:{...DEFAULT_COLOR},keyframes:[]});
  if(!hlg){value.assets.push({id:"blue",name:"own-blue-overlay",uri:join(root,"blue.mp4"),kind:"video",duration:frames/30,width,height,color:{interpretation:"rec709"}});
    value.tracks.push({id:"overlay",name:"Overlay numerical control",kind:"video",locked:false,muted:false,clips:[{id:"blue-clip",trackId:"overlay",assetId:"blue",timelineStart:0,sourceStart:0,duration:frames/30,volume:0,
      transform:{...DEFAULT_TRANSFORM,scale:.5,x:24},color:{...DEFAULT_COLOR},keyframes:[]}]});}
  return value;
}
function histogram(measurement:FinalPixelScopeMeasurement,plane:"red"|"green"|"blue"|"luma"){
  return readFinalPixelScopePageV1(measurement,{scope:"histogram",plane,offset:0,limit:256}).values;
}
describe("scopes from actual current renderer output",()=>{
  it("measures the final overlay and exact selected frame, not the original media frame",async()=>{
    const output=join(root,"composed.mp4"),result=await renderProject(project(),output,{ffmpegPath:ffmpeg,ffprobePath:ffprobe,preferGpu:false,timeoutMs:60000,workRoot:root});
    expect(result.artifactIdentity).toBeDefined();const artifact=result.artifactIdentity!;
    const measured=await measureFinalOutputScopesV1({outputPath:output,artifact,timelineFrame:2,options:{histogramBins:16}}, {ffmpegPath:ffmpeg,ffprobePath:ffprobe});
    const independent=run(["-v","error","-noautorotate","-i",output,"-vf","select='eq(n,2)',scale=in_range=limited:out_range=full:in_color_matrix=bt709,format=rgba64le","-frames:v","1","-fps_mode","passthrough","-pix_fmt","rgba64le","-f","rawvideo","pipe:1"]);
    expect(measured.receipt.rgbSha256).toBe(createHash("sha256").update(independent).digest("hex"));
    expect(measured.receipt.decodedOutputTime).toBeCloseTo(2/30,9);expect(measured.measurement.pixelCount).toBe(width*height);
    expect(histogram(measured.measurement,"blue").slice(8).reduce((sum,count)=>sum+count,0)).toBeGreaterThan(width*height*.15);
    for(const plane of ["red","green","blue","luma"] as const)expect(histogram(measured.measurement,plane).reduce((sum,count)=>sum+count,0)).toBe(width*height);
    const neighbour=await measureFinalOutputScopesV1({outputPath:output,artifact,timelineFrame:3},{ffmpegPath:ffmpeg,ffprobePath:ffprobe});
    expect(neighbour.receipt.rgbSha256).not.toBe(measured.receipt.rgbSha256);
  },120000);
  it("measures HLG source after the actual SDR render and refuses the still-HLG encoded input",async()=>{
    const sourceProbe=spawnSync(ffprobe,["-v","error","-select_streams","v:0","-show_entries","stream=color_primaries,color_transfer,color_space","-of","json",join(root,"hlg.mp4")],{windowsHide:true,timeout:30000});
    expect(sourceProbe.status).toBe(0);expect(JSON.parse(sourceProbe.stdout.toString()).streams[0]).toMatchObject({color_primaries:"bt2020",color_transfer:"arib-std-b67",color_space:"bt2020nc"});
    const output=join(root,"hlg-to-sdr.mp4"),result=await renderProject(project(true),output,{ffmpegPath:ffmpeg,ffprobePath:ffprobe,preferGpu:false,timeoutMs:60000,workRoot:root});
    const measured=await measureFinalOutputScopesV1({outputPath:output,artifact:result.artifactIdentity!,timelineFrame:1},{ffmpegPath:ffmpeg,ffprobePath:ffprobe});
    expect(measured.receipt.sourceMetadata).toMatchObject({color_primaries:"bt709",color_transfer:"bt709",color_space:"bt709"});
    expect(measured.measurement.interpretation).toMatchObject({values:"encoded-rgb-code",transfer:"bt709"});
    const sourceArtifact=await collectRenderArtifactIdentity(join(root,"hlg.mp4"),result.artifactIdentity!.projectContentSha256,ffprobe);
    await expect(measureFinalOutputScopesV1({outputPath:join(root,"hlg.mp4"),artifact:sourceArtifact,timelineFrame:1},{ffmpegPath:ffmpeg,ffprobePath:ffprobe})).rejects.toThrow("SDR");
  },120000);
});
