import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { clipTimeRemapClockV1 } from "../domain/clipTimeRemapV1";
import { timeRemapFrameIntervalV1, timeRemapCfrBlendSampleV1 } from "../domain/timeRemapClockV1";
import { createSpeedCurvePresetV1 } from "../application/speedCurvePresetsV1";
import { planTimeRemapExportWindowsV1 } from "./timeRemapExportWindowPlanV1";
const MIB=1024**2;
function fixture(duration=2,fps=8){
  const p=createDemoProject();p.fps=fps;p.width=64;p.height=40;
  Object.assign(p.assets[0],{uri:"D:/owned/original.mp4",duration:duration+4,width:64,height:40,license:"local fixture",provenance:"synthetic",redistributable:false});
  Object.assign(p.tracks[0].clips[0],{timelineStart:3.25,sourceStart:.25,duration,timeRemap:createSpeedCurvePresetV1("montage",{audioMode:"mute"})});return p;
}
function plan(p=fixture(),limits:Parameters<typeof planTimeRemapExportWindowsV1>[1]["limits"]={}){
  return planTimeRemapExportWindowsV1(p,{sourceSha256ByAssetId:{"asset-demo":"a".repeat(64)},limits});
}
describe("H8 bounded original-clock export-window plan (no export-hook promotion)",()=>{
  it.each(["forward","reverse"] as const)("covers every %s frame once with the original full curve and no floating slice offset",direction=>{
    const p=fixture();p.tracks[0].clips[0].timeRemap!.direction=direction;const before=structuredClone(p),schedule=plan(p,{maximumWindowSeconds:.375});
    const original=clipTimeRemapClockV1(p,p.tracks[0].clips[0],p.assets[0])!;let next=0;
    for(let n=0;n<schedule.clips[0].windows;n++){
      const w=schedule.window("clip-demo",n),c=w.sourceStage.tracks[0].clips[0];
      expect(w.outputFrameWindow.firstFrame).toBe(next);expect(c.duration).toBe(2);expect(c.sourceStart).toBe(.25);expect(c.timeRemap).toEqual(p.tracks[0].clips[0].timeRemap);
      expect(w.timelineStart).toBe(3.25+next/8);expect(w.estimatedOutputBytes).toBeLessThanOrEqual(schedule.limits.maximumWindowMediaBytes);
      for(let i=next;i<next+w.outputFrameWindow.frames;i++)expect(timeRemapCfrBlendSampleV1(w.clock,i,{timing:"cfr",frameRate:{numerator:8,denominator:1},decodedFrameCount:48}))
        .toEqual(timeRemapCfrBlendSampleV1(original,i,{timing:"cfr",frameRate:{numerator:8,denominator:1},decodedFrameCount:48}));
      next+=w.outputFrameWindow.frames;
    }
    expect(next).toBe(16);expect(schedule.window("clip-demo",5).outputFrameWindow).toEqual({firstFrame:15,frames:1});expect(p).toEqual(before);expect(schedule.ordinaryExportIntegrated).toBe(false);
  });
  it("rejects the task-shaped counterfactual of restarting a normalized curve in a later window",()=>{
    const p=fixture(),s=plan(p,{maximumWindowSeconds:.375}),w=s.window("clip-demo",2),bad=structuredClone(p);bad.tracks[0].clips[0].duration=w.interval.encodedDuration;
    const sliced=clipTimeRemapClockV1(bad,bad.tracks[0].clips[0],bad.assets[0])!;
    const expected=timeRemapFrameIntervalV1(w.clock,w.outputFrameWindow.firstFrame),counterfactual=timeRemapFrameIntervalV1(sliced,0);
    expect(expected.sourceLow).toBeGreaterThan(counterfactual.sourceLow+.01);expect(w.clock.timelineDurationSeconds).toBe(2);
  });
  it.each([12,24])("queries the final frame of a %sh 4K60 movie without materializing a movie-sized window/frame array",hours=>{
    const p=fixture(hours*3600,60);p.width=p.assets[0].width=3840;p.height=p.assets[0].height=2160;
    const s=plan(p),entry=s.clips[0],last=s.window("clip-demo",entry.windows-1);
    expect(entry.totalFrames).toBe(hours*3600*60);expect(entry.windows).toBeGreaterThan(100_000);expect(s.clips.length).toBe(1);
    expect(s.planningMetadataBytes).toBeLessThan(8192);expect(last.outputFrameWindow.firstFrame+last.outputFrameWindow.frames).toBe(entry.totalFrames);
    expect(last.clock.timelineDurationSeconds).toBe(hours*3600);expect(last.estimatedOutputBytes).toBeLessThanOrEqual(256*MIB);
    expect(Object.values(s).filter(Array.isArray).map(a=>a.length)).toEqual([1]);
  });
  it("preserves a non-guessed rational frame rate at the final NTSC window",()=>{
    const fps=30000/1001,p=fixture(180*1001/30000,fps),s=plan(p,{maximumWindowSeconds:.2}),last=s.window("clip-demo",s.clips[0].windows-1);
    expect(s.clips[0].outputRate).toEqual({numerator:30000,denominator:1001});expect(last.interval.endFrame).toBe(180);expect(last.clock.timelineDurationSeconds).toBe(p.tracks[0].clips[0].duration);
  });
  it("bounds raster/window/metadata budgets and snapshots only the source clock used by later windows",()=>{
    const p=fixture(),before=structuredClone(p),s=plan(p,{maximumWindowMediaBytes:3*MIB});const a=s.window("clip-demo",0),b=s.window("clip-demo",0);
    expect(a.clock).toBe(b.clock);a.sourceStage.tracks[0].clips[0].timeRemap!.segments[0].from.speed=9;a.sourceStage.assets[0].license="mutated";
    p.fps=24;p.tracks[0].clips[0].sourceStart=2;p.assets[0].uri="D:/wrong.mp4";
    const stable=s.window("clip-demo",0);expect(stable.sourceStage.fps).toBe(8);expect(stable.sourceStage.assets[0].uri.replaceAll("\\","/")).toBe("D:/owned/original.mp4");
    expect(stable.sourceStage.assets[0].license).toBe(before.assets[0].license);expect(stable.sourceStage.tracks[0].clips[0].sourceStart).toBe(.25);
    expect(()=>plan(before,{maximumWindowMediaBytes:MIB})).toThrow("ONE_FRAME");expect(()=>plan(before,{maximumPlanningMetadataBytes:1024})).toThrow("METADATA_BUDGET");
  });
  it.each([NaN,Number.MAX_SAFE_INTEGER,-1,2.5,Infinity])("rejects invalid window index %s",index=>{expect(()=>plan().window("clip-demo",index)).toThrow("WINDOW_INDEX_INVALID");});
  it("does not accept a missing/inherited source SHA, an unknown clip, or an oversized window cap",()=>{
    const p=fixture();expect(()=>planTimeRemapExportWindowsV1(p,{sourceSha256ByAssetId:{}})).toThrow("SOURCE_SHA_REQUIRED");
    expect(()=>planTimeRemapExportWindowsV1(p,{sourceSha256ByAssetId:Object.create({"asset-demo":"a".repeat(64)})})).toThrow("SOURCE_SHA_REQUIRED");
    expect(()=>plan().window("constructor",0)).toThrow("CLIP_UNKNOWN");expect(()=>plan(p,{maximumWindowSeconds:61})).toThrow("LIMITS_INVALID");
  });
  it("keeps following audio explicit and refuses unsupported HDR and fractional frame durations",()=>{
    const p=fixture();p.tracks[0].clips[0].timeRemap!.audioMode="follow_speed";const w=plan(p).window("clip-demo",0);
    expect(w.sourceStage.tracks[0].clips[0].volume).toBe(1);expect(w.audio.followingSourceAudioMustBeConsumedSeparately).toBe(true);
    p.assets[0].color={interpretation:"rec709",primaries:"bt2020",transfer:"smpte2084"};expect(()=>plan(p)).toThrow("REC709_RGB8");
    delete p.assets[0].color;p.tracks[0].clips[0].duration=2.01;expect(()=>plan(p)).toThrow("CLOCK_OR_SOURCE_RASTER_INVALID");
  });
});
