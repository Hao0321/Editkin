import { describe, expect, it } from "vitest";
import { compileTimeRemapClockV1, timeRemapSourceBoundaryV1, type BezierSpeedPointV1 } from "../domain/timeRemapClockV1";
import type { ClipTimeRemapV1 } from "../domain/clipTimeRemapV1";
import { createSpeedCurvePresetV1, SPEED_CURVE_PRESETS_V1 } from "./speedCurvePresetsV1";
import { validateSpeedCurveEditorV1, speedCurveAnchorsV1, speedCurvePointWindowV1, insertSpeedCurvePointV1,
  moveSpeedCurvePointV1, moveSpeedCurveHandleV1, deleteSpeedCurvePointV1, nudgeSpeedCurvePointV1 } from "./speedCurveEditorModelV1";

function clock(curve: ClipTimeRemapV1) {
  return compileTimeRemapClockV1({ timelineDurationSeconds: 1, sourceStartSeconds: 0, sourceDurationSeconds: 65,
    outputRate: { numerator: 30, denominator: 1 }, direction: curve.direction, segments: curve.segments });
}
function independentlySample(curve: ClipTimeRemapV1, x: number) {
  const s = curve.segments.find(s => x >= s.from.time && x <= s.to.time)!;
  const b = (key: keyof BezierSpeedPointV1, u: number) => (1-u)**3*s.from[key]+3*(1-u)**2*u*s.control1[key]+3*(1-u)*u**2*s.control2[key]+u**3*s.to[key];
  let lo=0,hi=1; for(let i=0;i<64;i++){const u=(lo+hi)/2;if(b("time",u)<x)lo=u;else hi=u;}
  return b("speed",(lo+hi)/2);
}

describe("uncertified curve presets and editing geometry", () => {
  it.each([["montage", .625], ["impact", 2], ["bullet_time", .325], ["jump", 1.75]] as const)("keeps %s source consumption, bounds and certification explicit", (id, area) => {
    const curve = createSpeedCurvePresetV1(id);
    expect(clock(curve).consumedSourceSeconds).toBeCloseTo(area, 13);
    expect(curve.audioMode).toBe("mute"); expect(curve.direction).toBe("forward");
    expect(speedCurveAnchorsV1(curve).length).toBeLessThanOrEqual(8);
    expect(SPEED_CURVE_PRESETS_V1.find(p=>p.id===id)).toMatchObject({ certification:"pending", vaDefaultEligible:false });
  });
  it("returns isolated settings, and never promotes follow audio or reversed presets to ready", () => {
    const a=createSpeedCurvePresetV1("montage"), b=createSpeedCurvePresetV1("montage",{direction:"reverse",audioMode:"follow_speed"});
    a.segments[0].control1.speed=60; expect(b.segments[0].control1.speed).toBe(1);
    expect(b).toMatchObject({direction:"reverse",audioMode:"follow_speed"});
    expect(()=>createSpeedCurvePresetV1("toString" as never)).toThrow("PRESET_UNKNOWN");
  });
  it.each(["forward","reverse"] as const)("inserts an anchor without changing the independently sampled curve or integral: %s", direction => {
    const original:ClipTimeRemapV1={...createSpeedCurvePresetV1("impact",{direction}),segments:[{from:{time:0,speed:.25},control1:{time:.02,speed:0},control2:{time:.94,speed:5},to:{time:1,speed:1.2}}]};
    const before=JSON.stringify(original), split=insertSpeedCurvePointV1(original,.37), a=clock(original), b=clock(split.curve);
    expect(split.changed).toBe(true); expect(split.pointIndex).toBe(1); expect(split.curve.segments).toHaveLength(2);
    for(let i=0;i<=200;i++){
      expect(Math.abs(independentlySample(original,i/200)-independentlySample(split.curve,i/200))).toBeLessThan(1e-10);
      expect(Math.abs(timeRemapSourceBoundaryV1(a,i/200)-timeRemapSourceBoundaryV1(b,i/200))).toBeLessThan(1e-10);
    }
    expect(JSON.stringify(original)).toBe(before);
  });
  it("selects existing endpoints/anchors without producing duplicate points", () => {
    const p=createSpeedCurvePresetV1("montage");
    for(const [time,index] of [[0,0],[.5,1],[1,2]])expect(insertSpeedCurvePointV1(p,time)).toMatchObject({changed:false,pointIndex:index,curve:p});
  });
  it("moves an anchor with both connected handles, maintaining continuity and the source speed bounds", () => {
    const original=createSpeedCurvePresetV1("montage"), before=JSON.stringify(original);
    const curve=moveSpeedCurvePointV1(original,1,{time:.7,speed:63.9});
    expect(curve.segments[0].to).toEqual(curve.segments[1].from);
    expect(curve.segments[0].to).toEqual({time:.7,speed:63.9});
    expect(curve.segments[0].control2.time).toBeGreaterThanOrEqual(curve.segments[0].control1.time);
    expect(curve.segments[1].control1.time).toBeLessThanOrEqual(curve.segments[1].control2.time);
    expect(()=>clock(curve)).not.toThrow(); expect(JSON.stringify(original)).toBe(before);
  });
  it("keeps explicit control handle time within its two neighbours, including speeds0 and64", () => {
    const p=createSpeedCurvePresetV1("montage");
    const a=moveSpeedCurveHandleV1(p,0,"control1",{time:100,speed:100});
    expect(a.segments[0].control1).toEqual({...p.segments[0].control2,speed:64});
    const b=moveSpeedCurveHandleV1(a,0,"control2",{time:-1,speed:-1});
    expect(b.segments[0].control2).toEqual({...a.segments[0].control1,speed:0});expect(()=>clock(b)).not.toThrow();
  });
  it("deletes only an interior point and retains the two remaining outer handles", () => {
    const p=createSpeedCurvePresetV1("montage"), result=deleteSpeedCurvePointV1(p,1);
    expect(result.segments).toEqual([{from:p.segments[0].from,control1:p.segments[0].control1,control2:p.segments[1].control2,to:p.segments[1].to}]);
    expect(()=>deleteSpeedCurvePointV1(p,0)).toThrow("ENDPOINT_REQUIRED");expect(()=>deleteSpeedCurvePointV1(p,2)).toThrow("ENDPOINT_REQUIRED");
  });
  it("pages257 anchors in groups of8 without truncation, and can edit anchors outside the first page", () => {
    const p=createSpeedCurvePresetV1("montage");p.segments=Array.from({length:256},(_,i)=>({from:{time:i/256,speed:1},control1:{time:i/256,speed:1},control2:{time:(i+1)/256,speed:1},to:{time:(i+1)/256,speed:1}}));
    const before=JSON.stringify(p), window=speedCurvePointWindowV1(p,255);
    expect(window).toMatchObject({total:257,offset:249});expect(window.points).toHaveLength(8);expect(window.points.at(-1)?.index).toBe(256);
    const moved=moveSpeedCurvePointV1(p,200,{time:200/256,speed:2}); expect(moved.segments).toHaveLength(256);expect(moved.segments[199].to.speed).toBe(2);
    expect(()=>insertSpeedCurvePointV1(p,.501)).toThrow("SEGMENT_LIMIT");expect(JSON.stringify(p)).toBe(before);
  });
  it.each([30,30000/1001])("uses the actual frame interval and ten-frame Shift step at fps%s", fps => {
    const p=createSpeedCurvePresetV1("montage"), right=nudgeSpeedCurvePointV1(p,1,"ArrowRight",10,fps), left=nudgeSpeedCurvePointV1(p,1,"ArrowLeft",10,fps,true);
    expect(right.segments[0].to.time-.5).toBeCloseTo(1/fps/10,14);
    expect(left.segments[0].to.time-.5).toBeCloseTo(-10/fps/10,14);
    expect(nudgeSpeedCurvePointV1(p,0,"ArrowRight",10,fps)).toEqual(p);
  });
  it("changes speed multiplicatively and stops horizontal keys before crossing another point", () => {
    const p=createSpeedCurvePresetV1("montage");
    expect(nudgeSpeedCurvePointV1(p,1,"ArrowUp",1,30).segments[0].to.speed).toBeCloseTo(.25*1.1,14);
    expect(nudgeSpeedCurvePointV1(p,1,"ArrowDown",1,30,true).segments[0].to.speed).toBeCloseTo(.25/1.1**10,14);
    expect(nudgeSpeedCurvePointV1(p,1,"ArrowRight",1,1,true)).toEqual(p);
  });
  it.each([NaN,Infinity,-1,1.1])("rejects invalid insert time%s before modifying input", value => {
    const p=createSpeedCurvePresetV1("montage"), before=JSON.stringify(p);expect(()=>insertSpeedCurvePointV1(p,value)).toThrow();expect(JSON.stringify(p)).toBe(before);
  });
  it("rejects crossing, fixed endpoint time, malformed indices/handles and invalid keyboard clocks", () => {
    const p=createSpeedCurvePresetV1("montage");
    expect(()=>moveSpeedCurvePointV1(p,1,{time:1,speed:1})).toThrow("POINTS_CROSS");
    expect(()=>moveSpeedCurvePointV1(p,0,{time:.1,speed:1})).toThrow("ENDPOINT_TIME_FIXED");
    expect(()=>moveSpeedCurvePointV1(p,3,{time:.5,speed:1})).toThrow("POINT_INDEX_INVALID");
    expect(()=>moveSpeedCurveHandleV1(p,0,"bad" as never,{time:.2,speed:1})).toThrow("HANDLE_INVALID");
    expect(()=>nudgeSpeedCurvePointV1(p,1,"ArrowUp",1,0)).toThrow("KEY_CLOCK_INVALID");
    expect(()=>nudgeSpeedCurvePointV1(p,1,"Enter" as never,1,30)).toThrow("KEY_UNSUPPORTED");
  });
  it("uses the existing strict compiler for continuity and monotone handles", () => {
    const p=createSpeedCurvePresetV1("montage");p.segments[1].from.speed=2;expect(()=>validateSpeedCurveEditorV1(p)).toThrow("CONTINUITY");
    const q=createSpeedCurvePresetV1("impact");q.segments[0].control1.time=.4;q.segments[0].control2.time=.1;
    expect(()=>validateSpeedCurveEditorV1(q)).toThrow("NON_MONOTONE");
  });
});
