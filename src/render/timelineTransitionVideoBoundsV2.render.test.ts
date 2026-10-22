import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { runColorProcess } from "../application/materialColorSamplingRuntime";
import { renderComposite } from "./ffmpegComposite";
import { buildRenderPlan } from "./planner";
import { probeMedia } from "./mediaProcess";

const ffmpeg=resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"),ffprobe=resolve("vendor/ffmpeg/win32-x64/ffprobe.exe");
let root:string;
beforeAll(async()=>{
  root=await mkdtemp(join(tmpdir(),"editkin-pair-video-bounds-v2-"));
  await runColorProcess(ffmpeg,["-v","error","-nostdin","-threads","1","-filter_threads","1",
    "-f","lavfi","-i","testsrc2=size=64x32:rate=10:duration=0.8",
    "-f","lavfi","-i","sine=frequency=440:sample_rate=48000:duration=2",
    "-map","0:v:0","-map","1:a:0","-c:v","libx264","-crf","0","-pix_fmt","yuv420p","-c:a","aac",
    "-color_primaries","bt709","-color_trc","bt709","-colorspace","bt709",join(root,"long-audio.mp4")],8192,20000);
});
afterAll(async()=>{
  if(!root)return;
  if(dirname(resolve(root))!==resolve(tmpdir())||!root.startsWith(join(tmpdir(),"editkin-pair-video-bounds-v2-")))throw Error("Video bounds cleanup escaped its owned fixture");
  await rm(root,{recursive:true,force:true});
});
function project(){
  const p=createDemoProject();p.width=64;p.height=32;p.fps=10;p.captions=[];p.motionGraphics=[];
  p.assets=[{id:"clip-source",name:"Owned longer-audio source",kind:"video",uri:join(root,"long-audio.mp4"),width:64,height:32,duration:2,color:{interpretation:"rec709"}}];
  const first=p.tracks[0].clips[0];first.assetId="clip-source";first.sourceStart=0.4;first.duration=0.4;first.volume=0;
  p.tracks[0].clips=[first,{...structuredClone(first),id:"incoming",timelineStart:0.4}];
  p.timelineTransitions=[{schema:"editkin.timeline-transition/v1",id:"tail-cut",trackId:first.trackId,fromClipId:first.id,toClipId:"incoming",beforeFrames:2,afterFrames:2,kernel:"dissolve"}];
  return p;
}
describe("current video stream availability for paired source handles",()=>{
  it("refuses missing video handles even when longer audio inflates container duration",async()=>{
    const p=project(),probe=await probeMedia(p.assets[0].uri,ffprobe);
    expect(probe.hasAudio).toBe(true);expect(probe.duration).toBeGreaterThan(1.8);
    const before=structuredClone(p),output=join(root,"missing-tail.mp4");
    await expect(renderComposite(ffmpeg,ffprobe,output,p,buildRenderPlan(p,uri=>uri),undefined,"libx264",30000))
      .rejects.toThrow("TIMELINE_TRANSITION_ACTUAL_HANDLE_MISSING");
    expect(p).toEqual(before);
    await expect(stat(output)).rejects.toMatchObject({code:"ENOENT"});
  },45000);
});
