import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { atempoFilters, generateClipMediaDerivative } from "./clipMediaDerivatives";
import { mediaFileSha256, runConversionProcess } from "./mediaConversion";
import { exportVideo } from "./exportVideo";

const app=resolve(import.meta.dirname,'../..'),ffmpegPath=join(app,'vendor/ffmpeg/win32-x64/ffmpeg.exe'),ffprobePath=join(app,'vendor/ffmpeg/win32-x64/ffprobe.exe');
let root:string,source:string;
beforeAll(async()=>{
  root=await mkdtemp(join(tmpdir(),'editkin-clip-media-real-'));source=join(root,'source.mp4');
  await runConversionProcess(ffmpegPath,['-hide_banner','-loglevel','error','-nostdin','-n','-f','lavfi','-i','testsrc2=size=160x90:rate=30:duration=4',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=4','-c:v','libx264','-threads','2','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-shortest',source]);
},60_000);
afterAll(async()=>{
  if(!root)return;
  if(dirname(resolve(root))!==resolve(tmpdir())||!basename(root).startsWith('editkin-clip-media-real-'))throw Error('Unowned fixture cleanup');
  await rm(root,{recursive:true,force:true});
});
function raw(path:string,time:number,audio=false):Buffer {
  const result=spawnSync(ffmpegPath,['-hide_banner','-loglevel','error','-nostdin','-ss',String(time),'-i',path,...(audio?
    ['-t','1','-vn','-ac','1','-ar','48000','-f','s16le','pipe:1']:['-frames:v','1','-an','-vf','scale=160:90','-pix_fmt','rgb24','-f','rawvideo','pipe:1'])],{windowsHide:true,timeout:60_000,maxBuffer:2_000_000});
  if(result.status!==0)throw Error(String(result.stderr));
  return result.stdout;
}
const request={operation:'retime' as const,sourceAssetId:'original',sourceStart:0,sourceDuration:4,fps:30};
describe('actual FFmpeg clip derivatives',()=>{
  it('chains supported tempo factors for the entire0.25–4 interval',()=>{
    expect(atempoFilters(.25)).toEqual(['atempo=0.5','atempo=0.5']);expect(atempoFilters(4)).toEqual(['atempo=2','atempo=2']);
    for(const rate of [.25,.5,.75,1,1.5,2,3,4])expect(atempoFilters(rate).map(value=>Number(value.split('=')[1])).reduce((a,b)=>a*b,1)).toBeCloseTo(rate,10);
    expect(()=>atempoFilters(NaN)).toThrow();
  });
  for(const [label,rate,reverse] of [['double',2,false],['reverse',1,true]] as const)it(`${label}: preview source and actual export frames agree; audio stays near440Hz`,async()=>{
    const generated=await generateClipMediaDerivative({...request,sourcePath:source,rate,reverse},{cacheRoot:root,ffmpegPath,ffprobePath});
    const project=createEmptyProject('Real parity',{id:label,width:160,height:90,fps:30});
    project.assets=[generated.asset];project.tracks[0].clips=[{id:'clip',assetId:generated.asset.id,trackId:project.tracks[0].id,
      timelineStart:0,sourceStart:0,duration:generated.duration,volume:1,transform:{...DEFAULT_TRANSFORM},color:{...DEFAULT_COLOR},keyframes:[]}];
    const outputPath=join(root,`${label}-export.mp4`);
    const rendered=await exportVideo({project,outputPath,options:{ffmpegPath,ffprobePath,preferGpu:false,workRoot:join(root,'render-work'),timeoutMs:120_000}});
    const measurements=[];
    for(const time of [.1,.6,1.2]){
      const preview=raw(generated.asset.uri,time),exported=raw(outputPath,time);
      expect(preview.length).toBe(160*90*3);expect(exported.length).toBe(preview.length);
      let difference=0;for(let index=0;index<preview.length;index++)difference+=Math.abs(preview[index]-exported[index]);
      const meanAbsoluteRgbError=difference/preview.length;expect(meanAbsoluteRgbError).toBeLessThan(8);
      measurements.push({time,meanAbsoluteRgbError});
    }
    const pitch=(path:string)=>{
      const audio=raw(path,.2,true);let crossings=0;
      const begin=4800,end=Math.min(audio.length/2-1,43200);
      for(let index=begin;index<end;index++)if(audio.readInt16LE(index*2)<=0&&audio.readInt16LE((index+1)*2)>0)crossings++;
      return crossings*48000/(end-begin);
    };
    const measuredHz=pitch(generated.asset.uri),exportedMeasuredHz=pitch(outputPath);
    for(const frequency of [measuredHz,exportedMeasuredHz]){expect(frequency).toBeGreaterThan(430);expect(frequency).toBeLessThan(450);}
    expect(generated.duration).toBe(4/rate);expect(generated.asset.derivatives?.proxyUri).toBeUndefined();
    const proofLabel=process.env.EDITKIN_B4_PARITY_ATTEMPT??'ATTEMPT1';expect(proofLabel).toMatch(/^[A-Z0-9_]+$/);
    const evidence=join(app,'.rd/benchmarks/usable-v1-20261009/work/r57-b4-codex',`REAL_${label.toUpperCase()}_PARITY_${proofLabel}.json`);
    if(process.env.EDITKIN_B4_WRITE_PARITY_RECEIPTS==='1') await writeFile(evidence,JSON.stringify({status:'REAL_DERIVATIVE_EXPORT_PARITY_GREEN',rate,reverse,measurements,measuredHz,exportedMeasuredHz,sourceSha256:generated.sourceSha256,
      derivativeSha256:generated.sha256,exportedSha256:await mediaFileSha256(outputPath),rendered,previewSourceIsAssetUri:true},null,2)+'\n',{flag:'wx'});
  },150_000);
  it('extracts a real still, refuses stale pinned media and refuses reverse longer than60 seconds',async()=>{
    const result=await generateClipMediaDerivative({...request,operation:'freeze',sourcePath:source,sourceStart:1},{cacheRoot:root,ffmpegPath,ffprobePath});
    expect(result.asset).toMatchObject({kind:'image',duration:2,width:160,height:90});
    await expect(generateClipMediaDerivative({...request,sourcePath:source,sourceSha256:'0'.repeat(64)},{cacheRoot:root,ffmpegPath,ffprobePath})).rejects.toThrow('原素材已變更');
    // Length validation runs before any output generation, even on a longer metadata-only request.
    await expect(generateClipMediaDerivative({...request,sourcePath:source,reverse:true,sourceDuration:61},{cacheRoot:root,ffmpegPath,ffprobePath})).rejects.toThrow('60 秒');
  },60_000);
});
