import { describe, expect, it } from "vitest";
import { applyCommand } from "../domain/commands";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditorialProfileId } from "../domain/types";
import { motionGraphicV2FrameAtPlayhead } from "../motion/compositionV2";
import { assertMotionGraphicPresetBinding, findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { createMotionGraphic } from "../motion/composition";
import { buildNativeAutopilotCommand, planNativeAutopilotCreative } from "./nativeAutopilot";
import { planSemanticAutoEdit } from "./semanticAutoEdit";
import { parseProject } from "./projectFiles";
import { resolveAestheticSystem } from "./editkinAesthetic";
import type { NativeEditingPolicy } from "./nativeAutopilotPolicy";

function run(policy: NativeEditingPolicy = {format:"longform",ownership:"automatic"}, gap=8, profile:EditorialProfileId="auto", existingManual=false) {
 const project=createEmptyProject("aesthetic",{id:"aesthetic",width:640,height:360,fps:30});
 project.editorialProfile=profile;
 project.aestheticSystem=resolveAestheticSystem("food","shorts");
 if(existingManual) project.motionGraphics.push(createMotionGraphic("manual-title","title","手動文字",2,3,undefined,findMotionGraphicPreset("v2-word-cascade").seed));
 project.assets.push({id:"media",uri:"synthetic.mp4",name:"source",kind:"video",duration:12});
 const clip={id:"clip",assetId:"media",trackId:"video-main",timelineStart:0,sourceStart:0,duration:12,volume:1,transform:{...DEFAULT_TRANSFORM},color:{...DEFAULT_COLOR},keyframes:[],creative:{lookPresetId:"vlog_bright_clean",effectPresetIds:["film_grain_soft"]}};
 project.tracks.find(t=>t.id==="video-main")!.clips.push(clip);
 const cues=[{start:0,end:1,text:"關鍵結果"},{start:1+gap,end:12,text:"完整保留後續字幕"}];
 const semantic={...planSemanticAutoEdit({duration:12,fps:30,cues,targetRatio:1}),keepRanges:[{start:0,end:12}],keptDuration:12};
 const creative=planNativeAutopilotCreative({duration:12,width:640,height:360,cues,video:true,policy});
 const command=buildNativeAutopilotCommand({project,clip,transcript:{cues},semantic,creative,idFactory:(k,i)=>`${k}-${i}`}).command;
 return {before:project,after:applyCommand(project,command)};
}
describe("native aesthetic contract and bounded real Motion preset",()=>{
 it("preserves existing manual v2 and its edit/reopen capability without auto artwork generation",()=>{
  const {before,after}=run(undefined,8,"auto",true);
  expect(after.aestheticSystem).toMatchObject({primaryFamily:"shape_play",format:"longform",review:{status:"REVIEW",score:0}});
  expect(before.aestheticSystem?.format).toBe("shorts");
  const title=after.motionGraphics.find(g=>g.kind==="title")!;
  expect(after.motionGraphics).toEqual(before.motionGraphics);
  expect(after.motionGraphics).toHaveLength(1);
  expect(title.schema).toBe("hao.motion-composition/v2");
  expect(()=>assertMotionGraphicPresetBinding(title,"v2-word-cascade")).not.toThrow();
  expect(motionGraphicV2FrameAtPlayhead(after,title,title.timelineStart+1).segments.some(s=>s.opacity>0)).toBe(true);
  const edited=applyCommand(after,{type:"update_motion_graphic",graphicId:title.id,patch:{text:"新文字"}});
  const reopened=parseProject(JSON.parse(JSON.stringify(edited)));
  expect(reopened.motionGraphics[0].text).toBe("新文字");
  expect(motionGraphicV2FrameAtPlayhead(reopened,reopened.motionGraphics[0],title.timelineStart+1).visible).toBe(true);
  expect(after.tracks[0].clips[0].creative?.lookPresetId).toBe("vlog_bright_clean");
  expect(after.tracks[0].clips[0].creative?.effectPresetIds).toEqual(["film_grain_soft"]);
  expect(after.captionStyle.color).toBe("#FFFFFF");
  expect(after.captionStyle.backgroundColor).toBe("#000000B3");
 });
 it.each([{format:"longform",ownership:"manual"},{format:"unknown",ownership:"automatic"}] as const)("preserves existing contract for %o",policy=>{
  const {before,after}=run(policy);
  expect(after.aestheticSystem).toEqual(before.aestheticSystem);
  expect(after.motionGraphics).toHaveLength(0);
 });
 it("does not force dynamic titles onto calm food topics",()=>{
  const {after}=run(undefined,8,"food");
  expect(after.aestheticSystem?.primaryFamily).toBe("japanese_lifestyle_calm");
  expect(after.motionGraphics).toHaveLength(0);
 });
 it("does not substitute generic fallback when artwork is rejected",()=>{
  const {after}=run(undefined,1.5);
  expect(after.motionGraphics).toHaveLength(0);
  expect(after.director.markers.at(-1)?.note).toContain("blocked-pending-art-review");
 });
 it("does not steal continuous subtitle time for any graphic",()=>{
  const {after}=run(undefined,0);
  expect(after.motionGraphics).toHaveLength(0);
  expect(after.captions.map(c=>c.text)).toEqual(["關鍵結果","完整保留後續字幕"]);
 });
});
