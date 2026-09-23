import {describe,it,expect} from "vitest";
import {mkdtemp,readFile,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {createHash} from "node:crypto";
import {createDemoProject} from "../domain/demo";
import {renderProject} from "./ffmpeg";
import {runProcess} from "./ffmpegMedia";
import {assertMusicOnlyProject,compareMusicPcm,runMusicOnlyQa} from "../../scripts/music-only-audio-qa";
import {creativeAssetUri} from "../application/creativeLibrary";
function fixture(source:string,music:string){const p=createDemoProject();p.width=160;p.height=90;p.captions=[];p.motionGraphics=[];p.motionTracks=[];p.assets=[{...p.assets[0],uri:source,duration:2},{id:"bgm",kind:"audio",role:"background-music",name:"synthetic library fixture",uri:music,duration:3}];const c={...p.tracks[0].clips[0],duration:1,volume:0};p.tracks=[{...p.tracks[0],clips:[{...c,id:"v1"},{...c,id:"v2",timelineStart:1}]},{id:"music",name:"music",kind:"audio",locked:false,muted:false,clips:[{...c,id:"m",trackId:"music",assetId:"bgm",sourceStart:.5,duration:2,volume:.3}]}];return p;}
describe("final music-only QA",()=>{
 it("rejects enabled original, separated bypass, missing and muted BGM",()=>{
  const p=fixture(resolve("synthetic.mp4"),resolve("synthetic.wav"));expect(()=>assertMusicOnlyProject(p,"bgm")).not.toThrow();
  const original=structuredClone(p);original.tracks[0].clips[1].volume=.6;expect(()=>assertMusicOnlyProject(original,"bgm")).toThrow(/Original/);
  const missing=structuredClone(p);missing.tracks[1].clips=[];expect(()=>assertMusicOnlyProject(missing,"bgm")).toThrow(/Missing/);
  const muted=structuredClone(p);muted.tracks[1].muted=true;expect(()=>assertMusicOnlyProject(muted,"bgm")).toThrow(/Missing/);
  const bypass=structuredClone(p);bypass.assets.push({...bypass.assets[1],id:"separated-original"});bypass.tracks[1].clips.push({...bypass.tracks[1].clips[0],id:"bypass",assetId:"separated-original"});expect(()=>assertMusicOnlyProject(bypass,"bgm")).toThrow(/bypass/);
 });
 it("waveform controls catch extra source, silence and wrong gain",()=>{
  const ref=Buffer.alloc(48000*2*4),extra=Buffer.alloc(ref.length),quiet=Buffer.alloc(ref.length);
  for(let i=0;i<48000;i++)for(let c=0;c<2;c++){const m=.1*Math.sin(2*Math.PI*1000*i/48000),s=.06*Math.sin(2*Math.PI*600*i/48000),at=(i*2+c)*4;ref.writeFloatLE(m,at);extra.writeFloatLE(m+s,at);quiet.writeFloatLE(m*.5,at);}
  expect(compareMusicPcm(ref,ref).pass).toBe(true);expect(compareMusicPcm(ref,extra).pass).toBe(false);expect(compareMusicPcm(ref,quiet).pass).toBe(false);expect(compareMusicPcm(ref,Buffer.alloc(ref.length)).pass).toBe(false);expect(compareMusicPcm(Buffer.alloc(ref.length),Buffer.alloc(ref.length)).pass).toBe(false);
 });
 it("compares actual native and FFmpeg renders against independent music references",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"editkin-music-qa-controls-")),source=join(dir,"synthetic-source.mp4"),music=join(dir,"synthetic-library.wav");
  const ffmpegPath=resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"),ffprobePath=resolve("vendor/ffmpeg/win32-x64/ffprobe.exe");
  await runProcess(ffmpegPath,["-v","error","-f","lavfi","-i","testsrc2=size=160x90:rate=30","-f","lavfi","-i","sine=frequency=600:sample_rate=48000","-t","2","-c:v","libx264","-c:a","aac",source],30000);
  await runProcess(ffmpegPath,["-v","error","-f","lavfi","-i","sine=frequency=1000:sample_rate=48000","-t","3","-c:a","pcm_s16le",music],30000);
  const project=fixture(source,music),musicSha256=createHash("sha256").update(await readFile(music)).digest("hex");
  const musicBytes=(await readFile(music)).length;
  // Synthetic manifest validation fixture; not evidence of real media licensing/attestation.
  await writeFile(join(dir,"editkin-personal-music.json"),JSON.stringify({schemaVersion:2,id:"studio.hao.personal-music-library",distributionScope:"community-redistributable",redistributable:true,provenanceAudit:{status:"owner_attested_ai_generated",publicExportAllowed:true,attestationId:"owner-attestation-2026-08-22",independentPlatformTermsVerified:false},assetCount:1,assetBytes:musicBytes,assets:[{id:"music:synthetic",name:"SYNTHETIC TEST ONLY",category:"music",role:"background-music",domains:["test"],mediaKind:"audio",path:"synthetic-library.wav",bytes:musicBytes,sha256:musicSha256,license:"HAO-COMMUNITY-ASSET-GRANT-1.0",rightsBasis:"owner-attestation-2026-08-22",redistributable:true,duration:3,bpm:100,provenance:"synthetic-fixture",renderer:"media-asset"}]}));
  await writeFile(join(dir,"editkin-pack.json"),JSON.stringify({schemaVersion:1,id:"synthetic.pack",name:"Synthetic",version:"1.0.0",attribution:"test",source:{privateImagesEmbedded:false},assetCount:1,assetBytes:musicBytes,portability:{relativePathsOnly:true,privateWorkspaceEmbedded:false,originalPrivateReferencesEmbedded:false},assets:[{id:"music:synthetic",name:"Synthetic",category:"music",role:"background-music",domains:["test"],mediaKind:"audio",path:"synthetic-library.wav",bytes:musicBytes,sha256:musicSha256,license:"CC0-1.0",provenance:"synthetic-fixture",renderer:"media-asset"}]}));
  const results=[];
  for(const native of [false,true]){const output=join(dir,`${native?"native":"ffmpeg"}.mp4`),renderResult=await renderProject(project,output,{ffmpegPath,ffprobePath,preferGpu:false,...(native?{nativeCorePath:resolve("native/bin/win32-x64/hao-core.exe")}: {})});
   if(native)expect(renderResult.nativeAudio?.nativeGraphExecution).toBe(true);
   const report=await runMusicOnlyQa({project,output,musicAssetId:"bgm",musicSha256,renderResult,ffmpegPath});results.push(report);expect(report.metrics.pass,JSON.stringify(report.metrics)).toBe(true);
   if(native){
    const stored=structuredClone(project);stored.assets[1].uri=creativeAssetUri("music:synthetic");const before=JSON.stringify(stored);
    await expect(runMusicOnlyQa({project:stored,output,musicAssetId:"bgm",musicSha256,renderResult,ffmpegPath})).rejects.toThrow(/explicit creativePackRoot/);
    const semanticReport=await runMusicOnlyQa({project:stored,output,musicAssetId:"bgm",musicSha256,renderResult,ffmpegPath,creativePackRoot:dir,personalMusicRoot:dir});expect(semanticReport.metrics.pass).toBe(true);expect(JSON.stringify(stored)).toBe(before);results.push(semanticReport);
    const leaked=join(dir,"negative-added-600hz.wav"),referencePcm=join(dir,"reference-decoded.f32le"),leakedPcm=join(dir,"negative-decoded.f32le");
    await runProcess(ffmpegPath,["-v","error","-i",output,"-f","lavfi","-i","sine=frequency=600:sample_rate=48000","-filter_complex","[1:a]volume=0.6[source];[0:a][source]amix=inputs=2:duration=first:normalize=0[out]","-map","[out]","-t","2","-c:a","pcm_f32le",leaked],30000);
    for(const [from,to] of [[join(report.dir,"reference.m4a"),referencePcm],[leaked,leakedPcm]])await runProcess(ffmpegPath,["-v","error","-i",from,"-af","apad,atrim=end_sample=96000","-ar","48000","-ac","2","-f","f32le",to],30000);
    const negative=compareMusicPcm(await readFile(referencePcm),await readFile(leakedPcm));expect(negative.pass).toBe(false);await writeFile(join(dir,"negative-added-source-comparison.json"),JSON.stringify(negative,null,2));
   }
   await expect(runMusicOnlyQa({project,output,musicAssetId:"bgm",musicSha256:"0".repeat(64),renderResult,ffmpegPath})).rejects.toThrow(/hash mismatch/);
  }
  await writeFile(join(dir,"evidence.json"),JSON.stringify(results,null,2));console.log("MUSIC_QA_SYNTHETIC_REAL_ROUTES",dir,results.map(r=>({profile:r.profile,status:r.status,dir:r.dir})));
 },120000);
});
