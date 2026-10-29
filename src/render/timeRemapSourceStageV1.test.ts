import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { createSpeedCurvePresetV1 } from "../application/speedCurvePresetsV1";
import { createTimeRemapSourceStageV1 } from "./timeRemapSourceStageV1";

describe("shared original-clock source bake", () => {
  it("retains source rights and the entire authored clock, leaves decoration on the original, and removes proxies", () => {
    const p=createDemoProject(),a=p.assets[0],c=p.tracks[0].clips[0];
    Object.assign(a,{license:"internal fixture",provenance:"synthetic local input",redistributable:false,derivatives:{sourceSha256:"a".repeat(64),proxyUri:"MUST_NOT_USE_PROXY.mp4",proxyWidth:16,proxyHeight:9,generatedAt:"2026-10-18T00:00:00Z"}});
    Object.assign(c,{timelineStart:3.25,sourceStart:.5,duration:4,volume:.3,speed:.5,timeRemap:createSpeedCurvePresetV1("montage",{audioMode:"follow_speed"}),transform:{...DEFAULT_TRANSFORM,x:.1,scale:1.2},color:{...DEFAULT_COLOR,brightness:.1}});
    const before=structuredClone(p),stage=createTimeRemapSourceStageV1(p,c,a,"D:/owned/original.mp4"),baked=stage.tracks[0].clips[0];
    expect(stage.assets[0]).toEqual({...structuredClone(a),uri:"D:/owned/original.mp4",derivatives:undefined});
    expect(Object.hasOwn(stage.assets[0],"derivatives")).toBe(false);
    expect(baked).toMatchObject({timelineStart:0,sourceStart:.5,duration:4,speed:.5,timeRemap:c.timeRemap,volume:1,transform:DEFAULT_TRANSFORM,color:DEFAULT_COLOR,keyframes:[]});
    expect(p).toEqual(before);baked.timeRemap!.segments[0].from.speed=3;stage.assets[0].license="caller edit";expect(p).toEqual(before);
  });
  it("does not add omitted clocks or turn constant following audio into silence",()=>{
    const p=createDemoProject(),c=p.tracks[0].clips[0];c.speed=.5;c.volume=0;
    const baked=createTimeRemapSourceStageV1(p,c,p.assets[0],p.assets[0].uri).tracks[0].clips[0];
    expect(baked.volume).toBe(1);expect(baked.speed).toBe(.5);expect(Object.hasOwn(baked,"timeRemap")).toBe(false);
    delete c.speed;const ordinary=createTimeRemapSourceStageV1(p,c,p.assets[0],p.assets[0].uri).tracks[0].clips[0];expect(Object.hasOwn(ordinary,"speed")).toBe(false);
  });
});
