import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import { createHistory, dispatchCommand, undo, redo } from "../domain/history";
import { clipTimeRemapClockV1, clipTimeRemapExpectedV1, type ClipTimeRemapV1 } from "../domain/clipTimeRemapV1";
import { DEFAULT_TRANSFORM, DEFAULT_COLOR, type TimelineClip } from "../domain/types";
import { TRACK_LOCKED_MESSAGE } from "../domain/trackLock";
import { RETIME_TEMPLATE_REFUSAL } from "../domain/clipRetime";
import { buildRenderPlan } from "../render/planner";
import { decodeProjectBytes, encodeProjectBytes, parseProject } from "./projectCodec";
import { createSpeedCurvePresetV1, SPEED_CURVE_PRESETS_V1 } from "./speedCurvePresetsV1";
import { moveSpeedCurvePointV1, speedCurveAnchorsV1 } from "./speedCurveEditorModelV1";
import { speedCurveForClipV1, beginSpeedCurveGestureV1, planSpeedCurveGestureV1, planResetB4ForSpeedCurveV1 } from "./speedCurveEditCommandsV1";

function fixture() {
  const project=createEmptyProject("curve",{id:"curve-editor",fps:30}),clip:TimelineClip={id:"clip",assetId:"video",trackId:"video-main",timelineStart:0,sourceStart:1,duration:4,
    volume:.7,transform:{...DEFAULT_TRANSFORM,x:.15,rotation:12},color:{...DEFAULT_COLOR,exposure:.1},keyframes:[]};
  project.assets=[{id:"video",name:"camera original",kind:"video",uri:"original.mp4",duration:32}];project.tracks[0].clips=[clip];
  return {project,clip};
}
function flat(speed:number):ClipTimeRemapV1 {
  const c=createSpeedCurvePresetV1("montage"); c.segments=[{from:{time:0,speed},control1:{time:1/3,speed},control2:{time:2/3,speed},to:{time:1,speed}}];return c;
}

describe("speed curve command preparation beside unchanged UI and reducers",()=>{
  it.each(SPEED_CURVE_PRESETS_V1.map(p=>p.id))("applies %s through one Undo/Redo and exact project byte codec",id=>{
    const {project,clip}=fixture(), before=structuredClone(project), curve=createSpeedCurvePresetV1(id), gesture=beginSpeedCurveGestureV1(project,clip.id);
    const plan=planSpeedCurveGestureV1(project,gesture,curve);expect(plan.command).toBeDefined();
    const h=dispatchCommand(createHistory(project),plan.command!);
    expect(h.past).toHaveLength(1);expect(undo(h).present).toEqual(project);expect(redo(undo(h)).present).toEqual(h.present);
    expect(h.present.tracks[0].clips[0]).toEqual({...clip,timeRemap:curve});expect(h.present.assets).toEqual(project.assets);
    expect(decodeProjectBytes(encodeProjectBytes(h.present))).toEqual(parseProject(h.present));expect(project).toEqual(before);
    expect(plan).toMatchObject({certification:"pending",vaDefaultEligible:false,ordinaryPreviewIntegrated:false,exportHookIntegrated:false});
    expect(()=>buildRenderPlan(h.present,x=>x)).toThrow("SHARED_FRAME_CONSUMER_REQUIRED");
  });
  it("many scratch moves produce zero history writes; only the final gesture plan is dispatched",()=>{
    const {project,clip}=fixture(), h=createHistory(project), gesture=beginSpeedCurveGestureV1(project,clip.id);
    let scratch=createSpeedCurvePresetV1("montage");
    for(let i=0;i<20;i++)scratch=moveSpeedCurvePointV1(scratch,1,{time:.4+i/100,speed:.1+i/50});
    expect(h.past).toHaveLength(0);expect(h.present).toEqual(project);
    const plan=planSpeedCurveGestureV1(project,gesture,scratch), committed=dispatchCommand(h,plan.command!);
    expect(committed.past).toHaveLength(1);expect(committed.present.tracks[0].clips[0].timeRemap).toEqual(scratch);
  });
  it("a discarded or unchanged gesture leaves the exact source project/history without a command",()=>{
    const {project,clip}=fixture(), before=JSON.stringify(project), gesture=beginSpeedCurveGestureV1(project,clip.id);
    expect(planSpeedCurveGestureV1(project,gesture,gesture.initialCurve).command).toBeUndefined();expect(JSON.stringify(project)).toBe(before);
    expect(gesture.initialCurve.audioMode).toBe("follow_speed");
  });
  it("normalizes existing scalar slow motion without ever creating an invalid intermediate1x",()=>{
    const {project,clip}=fixture();clip.duration=40;clip.speed=.25;project.assets[0].duration=12;
    expect(()=>applyCommand(project,{type:"set_clip_speed",clipId:clip.id,expected:clipTimeRemapExpectedV1(clip),speed:null})).toThrow("超過素材");
    const plan=planSpeedCurveGestureV1(project,beginSpeedCurveGestureV1(project,clip.id),flat(.2));
    expect(plan.command?.commands).toHaveLength(3);
    const h=dispatchCommand(createHistory(project),plan.command!), target=h.present.tracks[0].clips[0];
    expect(target).not.toHaveProperty("speed");expect(target.duration).toBe(40);
    expect(clipTimeRemapClockV1(h.present,target,h.present.assets[0])?.consumedSourceSeconds).toBe(8);
    expect(h.past).toHaveLength(1);expect(undo(h).present).toEqual(project);
  });
  it("can leave a12hour scalar hold through the same atomic batch with bounded metadata",()=>{
    const {project,clip}=fixture();clip.duration=43200;clip.speed=0;project.assets[0].duration=12;
    const plan=planSpeedCurveGestureV1(project,beginSpeedCurveGestureV1(project,clip.id),flat(.0001));
    const next=applyCommand(project,plan.command!),target=next.tracks[0].clips[0],clock=clipTimeRemapClockV1(next,target,next.assets[0])!;
    expect(clock.totalOutputFrames).toBe(1296000);expect(clock.consumedSourceSeconds).toBeCloseTo(4.32,13);
    expect(JSON.stringify(plan).length).toBeLessThan(5000);expect(project.tracks[0].clips[0].speed).toBe(0);
  });
  it("reads absolute effective speed once even when in-memory adjacent anchors share an object",()=>{
    const {project,clip}=fixture();clip.speed=.5;clip.timeRemap=createSpeedCurvePresetV1("impact");
    clip.timeRemap.segments[1].from=clip.timeRemap.segments[0].to;
    const before=JSON.stringify(project),curve=speedCurveForClipV1(project,clip.id);
    expect(speedCurveAnchorsV1(curve).map(p=>p.speed)).toEqual([.5,1.5,.5]);expect(JSON.stringify(project)).toBe(before);
  });
  it.each(["clip","asset","fps","sourceWindow"] as const)("rejects a stale %s edit without overwriting the intervening edit",kind=>{
    const {project,clip}=fixture(), gesture=beginSpeedCurveGestureV1(project,clip.id);
    if(kind==="clip")clip.transform.rotation=50;if(kind==="asset")project.assets[0].uri="other.mp4";
    if(kind==="fps")project.fps=24;if(kind==="sourceWindow")clip.sourceStart=2;
    const after=JSON.stringify(project);expect(()=>planSpeedCurveGestureV1(project,gesture,createSpeedCurvePresetV1("impact"))).toThrow("GESTURE_STALE");expect(JSON.stringify(project)).toBe(after);
  });
  it("retains existing reducer track/template/temporal refusal and original source bytes",()=>{
    for(const protection of ["locked","template","linked"]){
      const {project,clip}=fixture(),gesture=beginSpeedCurveGestureV1(project,clip.id);
      if(protection==="locked")project.tracks[0].locked=true;
      if(protection==="template"){
        const snapshot={editorialProfile:project.editorialProfile,aestheticSystem:null,captionStyle:structuredClone(project.captionStyle),clips:[]};
        project.templateApplication={schema:"editkin.template-application/v1",sessionId:"curve-ownership",templateId:"movie-template",templateName:"Owned movie",format:"long",createdAt:"2026-10-17T00:00:00Z",
          before:structuredClone(snapshot),applied:structuredClone(snapshot),generatedClips:[{clipId:clip.id,trackId:clip.trackId}]};
      }
      if(protection==="linked")clip.linkGroupId="linked";
      const before=JSON.stringify(project);
      expect(()=>planSpeedCurveGestureV1(project,protection==="linked"?beginSpeedCurveGestureV1(project,clip.id):gesture,createSpeedCurvePresetV1("impact")))
        .toThrow(protection==="locked"?TRACK_LOCKED_MESSAGE:protection==="template"?RETIME_TEMPLATE_REFUSAL:"TEMPORAL_BINDING");
      expect(JSON.stringify(project)).toBe(before);
    }
  });
  it("refuses excessive source consumption without clamping the curve or leaving a partial scalar hold",()=>{
    const {project,clip}=fixture();clip.speed=.25;clip.duration=40;project.assets[0].duration=12;
    const before=JSON.stringify(project);
    expect(()=>planSpeedCurveGestureV1(project,beginSpeedCurveGestureV1(project,clip.id),createSpeedCurvePresetV1("impact"))).toThrow("HANDLES_INSUFFICIENT");
    expect(JSON.stringify(project)).toBe(before);
  });
  it.each([false,true])("resets a trimmed B4 original window in one Undo, preserving both media assets; reverse%s",reverse=>{
    const {project,clip}=fixture(),original=project.assets[0];original.duration=20;
    project.assets.push({...original,id:"b4",uri:"retimed.mkv",duration:3,clipRetime:{schema:"editkin.clip-retime/v1",sourceAssetId:original.id,sourceStart:2,sourceDuration:6,rate:2,reverse}});
    clip.assetId="b4";clip.sourceStart=.5;clip.duration=1.5;
    project.tracks[0].clips.push({...structuredClone(clip),id:"next",assetId:original.id,timelineStart:1.5,sourceStart:10,duration:1});
    expect(()=>beginSpeedCurveGestureV1(project,clip.id)).toThrow("RESET_B4_REQUIRED");
    const before=JSON.stringify(project), plan=planResetB4ForSpeedCurveV1(project,clip.id), h=dispatchCommand(createHistory(project),plan.command);
    expect(plan).toMatchObject({sourceAssetId:original.id,sourceStart:reverse?4:3,duration:3});
    expect(h.present.tracks[0].clips[0]).toMatchObject({assetId:original.id,sourceStart:reverse?4:3,duration:3,transform:clip.transform,color:clip.color,volume:clip.volume});
    expect(h.present.tracks[0].clips[1].timelineStart).toBe(3);expect(h.present.assets).toEqual(project.assets);
    expect(h.past).toHaveLength(1);expect(undo(h).present).toEqual(project);expect(JSON.stringify(project)).toBe(before);
    expect(decodeProjectBytes(encodeProjectBytes(h.present))).toEqual(parseProject(h.present));
  });
  it("refuses missing B4 originals without fabricating a replacement or removing the derivative",()=>{
    const {project,clip}=fixture();project.assets[0].clipRetime={schema:"editkin.clip-retime/v1",sourceAssetId:"missing",sourceStart:0,sourceDuration:8,rate:2,reverse:false};
    const before=JSON.stringify(project);expect(()=>planResetB4ForSpeedCurveV1(project,clip.id)).toThrow("原素材已不在專案中");expect(JSON.stringify(project)).toBe(before);
  });
});
