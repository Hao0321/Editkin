import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDemoProject } from "../domain/demo";
import { alignTime } from "../domain/editGraph";
import { buildRenderPlan } from "./planner";
import { renderComposite } from "./ffmpegComposite";
import { compositeFrameClock } from "./compositeFrameClock";

const app = fileURLToPath(new URL("../../", import.meta.url));
const ff = resolve(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const fp = resolve(app, "vendor/ffmpeg/win32-x64/ffprobe.exe");
function run(args: string[]) {
  const result = spawnSync(ff, args, { windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr.toString());
  return result.stdout;
}
it.each([30,24,25,60,30000/1001,29.97])("actual composite keeps exact boundaries and final frame at %s fps", async fps => {
  await mkdir(resolve(app, ".rd/tmp"), { recursive: true });
  const dir = await mkdtemp(resolve(app, ".rd/tmp/composite-frame-clock-"));
  const project = createDemoProject(); project.width = 32; project.height = 32; project.fps = fps;
  const seed = project.tracks[0].clips[0]; project.assets = []; project.tracks[0].clips = [];
  const cuts = [0,87,185,274,360], colors = ["red","lime","blue","white"];
  for (let i=0; i<4; i++) {
    const file = resolve(dir, `${i}.mp4`);
    run(["-v","error","-f","lavfi","-i",`color=c=${colors[i]}:s=32x32:r=${fps}:d=16`,"-c:v","libx264","-pix_fmt","yuv420p",file]);
    project.assets.push({ id:`a${i}`,name:colors[i],kind:"video",uri:file,duration:16,width:32,height:32 });
    project.tracks[0].clips.push({ ...structuredClone(seed), id:`c${i}`,assetId:`a${i}`,timelineStart:cuts[i]/fps,duration:(cuts[i+1]-cuts[i])/fps,volume:0 });
  }
  const output = resolve(dir,"output.mp4");
  await renderComposite(ff,fp,output,project,buildRenderPlan(project,p=>p),undefined,"libx264",30000);
  const raw = run(["-v","error","-i",output,"-an","-fps_mode","passthrough","-pix_fmt","rgb24","-f","rawvideo","-"]);
  const stride = 32*32*3; const failures: unknown[] = [];
  expect(raw.length/stride).toBe(360);
  for (let n=0;n<360;n++) {
    const rgb=[...raw.subarray(n*stride+15*32*3+15*3,n*stride+15*32*3+15*3+3)];
    const expected = n<87?[255,0,0]:n<185?[0,255,0]:n<274?[0,0,255]:[255,255,255];
    if(rgb.some((v,c)=>Math.abs(v-expected[c])>8)) failures.push({frame:n,rgb,expected});
  }
  await writeFile(resolve(dir,"report.json"),JSON.stringify({fps,cuts,failures,output},null,2));
  expect(failures, `real per-frame pixel identity; evidence ${dir}`).toEqual([]);
}, 60000);

it("uses explicit rational ticks and the domain nearest-frame policy", () => {
  expect(compositeFrameClock(30000/1001,274/(30000/1001))).toEqual({rate:"30000/1001",startFrame:274,timestampFilters:"settb=expr=1001/30000,setpts=PTS-STARTPTS+274"});
  expect(compositeFrameClock(29.97).rate).toBe("2997/100");
  expect(compositeFrameClock(30, .49/30).startFrame).toBe(0);
  expect(compositeFrameClock(30, .51/30).startFrame).toBe(1);
  for (const value of [-1,NaN,Infinity,Number.MAX_SAFE_INTEGER]) expect(()=>compositeFrameClock(30,value)).toThrow();
  for (const value of [0,-1,NaN,Infinity]) expect(()=>compositeFrameClock(value)).toThrow();
});

it.each([
  [24000/1001, .0625625], [30000/1001, 1.0844166666666666],
  [24000/1001, 1.25/(24000/1001)], [24000/1001, 1.75/(24000/1001)],
  [30000/1001, 32.25/(30000/1001)], [30000/1001, 32.75/(30000/1001)],
])("matches actual domain alignTime including half-frame ties (%s, %s)", (fps,start) => {
  const aligned = alignTime(start,fps);
  expect(compositeFrameClock(fps,start).startFrame).toBe(Math.round(aligned*fps));
});

it.each([30,30000/1001])("source and lower-rate pixel matte have the identical first project tick at %s", fps => {
  const clock = compositeFrameClock(fps,274/fps);
  const observed:number[]=[];
  for (const [inputRate,round] of [[clock.rate,""],["12","round=down:"]] as const) {
    const result=spawnSync(ff,["-hide_banner","-f","lavfi","-i",`color=c=white:s=16x16:r=${inputRate}:d=1`,"-vf",`fps=${round}fps=${clock.rate},${clock.timestampFilters},showinfo`,"-frames:v","1","-f","null","-"],{windowsHide:true,timeout:15000});
    expect(result.status,result.stderr.toString()).toBe(0);
    observed.push(Number(result.stderr.toString().match(/n:\s*0 pts:\s*(\d+)/)![1]));
  }
  expect(observed).toEqual([274,274]);
});

it("public compositor keeps a track-matte target visible on its last intended frame", async () => {
  const dir=await mkdtemp(resolve(app,".rd/tmp/composite-track-clock-"));
  const project=createDemoProject(); project.width=32;project.height=32;
  const clip=project.tracks[0].clips[0];
  const source=resolve(dir,"white.mp4");
  run(["-v","error","-f","lavfi","-i","color=c=white:s=32x32:r=30:d=4","-c:v","libx264",source]);
  project.assets[0].uri=source;project.assets[0].duration=4;
  clip.timelineStart=274/30;clip.duration=86/30;clip.volume=0;
  clip.layer={enabled:true,role:"content",blendMode:"normal",trackMatte:{sourceClipId:"matte",mode:"luma"}};
  project.tracks.push({id:"matte-track",name:"matte",kind:"video",locked:false,muted:true,clips:[{...structuredClone(clip),id:"matte",trackId:"matte-track",layer:{enabled:true,role:"content",blendMode:"normal"}}]});
  const output=resolve(dir,"output.mp4");
  await renderComposite(ff,fp,output,project,buildRenderPlan(project,p=>p),undefined,"libx264",30000);
  const raw=run(["-v","error","-i",output,"-an","-fps_mode","passthrough","-pix_fmt","rgb24","-f","rawvideo","-"]);
  expect(raw.length/(32*32*3)).toBe(360);
  for(const n of [273,274,359]) expect(raw[n*32*32*3],`frame ${n}; ${dir}`).toBe(n===273?0:255);
},30000);
