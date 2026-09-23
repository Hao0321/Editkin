import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createDemoProject } from "../domain/demo";
import type { EditProject } from "../domain/types";
import { buildRenderPlan, type RenderPlan } from "./planner";
import { renderProject } from "./ffmpeg";
import { runProcess } from "./ffmpegMedia";

function projectFixture(source="synthetic-source.mp4",music="synthetic-library-music.wav") {
 const p=createDemoProject();p.width=160;p.height=90;p.captions=[];p.motionGraphics=[];p.motionTracks=[];
 const asset={...p.assets[0],uri:source,duration:1,width:160,height:90};
 const first={...p.tracks[0].clips[0],id:"video-a",duration:1,timelineStart:0,sourceStart:0,volume:0};
 const second={...structuredClone(first),id:"video-b",timelineStart:1};
 p.assets=[asset,{...asset,id:"library-music",uri:music,name:"Synthetic library-role fixture, not real catalog audio",kind:"audio",role:"background-music",duration:2}];
 p.tracks=[{...p.tracks[0],clips:[first,second]},{id:"music",name:"Library music",kind:"audio",muted:false,locked:false,clips:[{...structuredClone(first),id:"music-clip",trackId:"music",assetId:"library-music",duration:2,volume:.3}]}];
 return p;
}
/** This is a task-specific assertion, NOT a new global mute policy or catalog-license validator. */
function requireMusicOnly(p:EditProject,plan:RenderPlan) {
 if(!plan.audioClips.length)throw new Error("Missing audible library music");
 for(const item of plan.audioClips){const a=p.assets.find(a=>a.id===item.clip.assetId);if(a?.id!=="library-music"||a.role!=="background-music"||item.clip.volume<=0)throw new Error("Non-library audio or silent music in plan");}
}
describe("task-scoped music-only planning",()=>{
 it("excludes both zero-volume original video sources and preserves the music",()=>{
  const p=projectFixture(),plan=buildRenderPlan(p,x=>x);
  expect(plan.audioClips.map(i=>i.clip.id)).toEqual(["music-clip"]);
  expect(()=>requireMusicOnly(p,plan)).not.toThrow();expect(p.tracks[0].clips.map(c=>c.volume)).toEqual([0,0]);
  expect(plan.videoLayers[0].segments.filter(s=>s.kind==="clip")).toHaveLength(2);
 });
 it.each([0,1])("retains deliberately enabled original source %i and rejects music-only contract",index=>{
  const p=projectFixture();p.tracks[0].clips[index].volume=.6;const plan=buildRenderPlan(p,x=>x);
  expect(plan.audioClips.some(i=>i.clip.id===p.tracks[0].clips[index].id)).toBe(true);expect(()=>requireMusicOnly(p,plan)).toThrow(/Non-library/);
 });
 it("does not call an empty music selection successful",()=>{
  const p=projectFixture();p.tracks[1].clips=[];const plan=buildRenderPlan(p,x=>x);expect(plan.audioClips).toEqual([]);expect(()=>requireMusicOnly(p,plan)).toThrow(/Missing/);
 });
 it("respects a muted music track",()=>{
  const p=projectFixture();p.tracks[1].muted=true;const plan=buildRenderPlan(p,x=>x);expect(plan.audioClips).toEqual([]);expect(()=>requireMusicOnly(p,plan)).toThrow(/Missing/);
 });
});

function spectralAmplitude(bytes:Buffer,frequency:number,startSeconds:number,durationSeconds:number) {
 const rate=48000,start=Math.round(startSeconds*rate),count=Math.round(durationSeconds*rate);let real=0,imaginary=0;
 for(let n=0;n<count;n++){const sample=bytes.readFloatLE((start+n)*4),angle=2*Math.PI*frequency*n/rate;real+=sample*Math.cos(angle);imaginary-=sample*Math.sin(angle);}
 return 2*Math.hypot(real,imaginary)/count;
}
describe("synthetic rendered music-only audio",()=>{
 it("removes 600Hz source tone and keeps 1000Hz music; enabled-source control detects leakage",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"editkin-music-only-spectrum-")),source=join(dir,"synthetic-600hz.mp4"),music=join(dir,"synthetic-library-1000hz.wav");
  const ffmpegPath=resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"),ffprobePath=resolve("vendor/ffmpeg/win32-x64/ffprobe.exe");
  await runProcess(ffmpegPath,["-v","error","-f","lavfi","-i","testsrc2=size=160x90:rate=30","-f","lavfi","-i","sine=frequency=600:sample_rate=48000","-t","1","-c:v","libx264","-c:a","aac",source],30000);
  await runProcess(ffmpegPath,["-v","error","-f","lavfi","-i","sine=frequency=1000:sample_rate=48000","-t","2","-c:a","pcm_s16le",music],30000);
  const results=[];
  for(const enabled of [false,true]){
   const p=projectFixture(source,music);if(enabled)p.tracks[0].clips[0].volume=.6;
   const output=join(dir,enabled?"negative-original-enabled.mp4":"music-only.mp4");
   const render=await renderProject(p,output,{ffmpegPath,ffprobePath,preferGpu:false});
   const decoded=spawnSync(ffmpegPath,["-v","error","-i",output,"-map","0:a:0","-ac","1","-ar","48000","-f","f32le","-"],{windowsHide:true,maxBuffer:2000000,timeout:30000});expect(decoded.status).toBe(0);
   const windows=[.45,1.45].map(start=>({start,music1000:spectralAmplitude(decoded.stdout,1000,start,.2),source600:spectralAmplitude(decoded.stdout,600,start,.2)}));
   for(const w of windows){expect(w.music1000).toBeGreaterThan(.005);if(!enabled)expect(w.source600/w.music1000).toBeLessThan(.001);}
   if(enabled)expect(windows[0].source600/windows[0].music1000).toBeGreaterThan(.05);
   results.push({enabled,output,windows,render,planAudio:buildRenderPlan(p,x=>x).audioClips.map(i=>i.clip.id)});
  }
  await writeFile(join(dir,"evidence.json"),JSON.stringify({classification:"SYNTHETIC_ONLY_NO_USER_MEDIA",threshold:"600Hz/1000Hz amplitude <0.001 (-60dB) in both music-only shot windows; not mathematical zero or subjective listening",nativeAudio:false,results},null,2));
  expect((await readFile(join(dir,"evidence.json"))).length).toBeGreaterThan(0);console.log("RETAINED_MUSIC_ONLY_SPECTRUM",dir,JSON.stringify(results.map(r=>({enabled:r.enabled,windows:r.windows}))));
 },120000);
});
