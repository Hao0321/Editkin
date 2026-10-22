import {describe,it,expect} from "vitest";
import {createEmptyProject} from "../domain/editGraph";
import {DEFAULT_TRANSFORM,DEFAULT_COLOR} from "../domain/types";
import {longformUiFocusGeometryGraphV1} from "./longformUiFocusGeometryGraphV1";
import {compositorVideoFilters,overlayPositionedFilter} from "./ffmpegComposite";
import {buildRenderPlan} from "./planner";
import {compileClipAlphaPlan} from "../domain/clipAlphaPlan";
function fixture(){
  const project=createEmptyProject('Geometry',{width:640,height:360,fps:30}),asset={id:'source',name:'Source',uri:'owned.mkv',kind:'video' as const,duration:4,width:320,height:180};
  project.assets.push(asset);const clip={id:'clip',trackId:project.tracks[0].id,assetId:asset.id,timelineStart:.2,sourceStart:.05,duration:1,volume:0,
    transform:{...DEFAULT_TRANSFORM},color:{...DEFAULT_COLOR},keyframes:[]};project.tracks[0].clips.push(clip);
  return{project,clip,asset,probe:{duration:4,width:320,height:180,sampleAspectRatio:1,hasAudio:false,hasVideo:true}};
}
describe('source hold geometry graph',()=>{
  it('calls the unchanged actual formal geometry/placement functions and adds observational stages only',()=>{
    const{project,clip,asset,probe}=fixture(),before=structuredClone(project),plan=buildRenderPlan(project,u=>u);
    const result=longformUiFocusGeometryGraphV1(project,clip.id,asset.uri,probe,['setsar=1']);
    expect(result.originalChain).toBe(compositorVideoFilters({clip,asset,assetPath:asset.uri,probe,alphaPlan:compileClipAlphaPlan(project,clip,'formal'),inputIndex:0},'uif_video',plan,project)[0]);
    expect(result.originalPlacement).toBe(overlayPositionedFilter('uif_base','uif_video','uif_project',clip,plan,project));
    expect(result.graph).toContain('[0:v]split=2');expect(result.graph).toContain('showinfo@clock_output[uif_gray]');
    for(const stage of ['fit','clock','layout','input','scaled','output','position'])expect(result.graph).toContain('showinfo@uif_'+stage);
    expect(result.startFrame).toBe(6);expect(result.graph).toContain('[1:v]format=rgba,settb=expr=1/30,setpts=PTS-STARTPTS+6');expect(project).toEqual(before);
  });
  it('observes the actual fixed animated perspective and preserves source seek precision',()=>{
    const{project,clip,asset,probe}=fixture();clip.sourceStart=.0500004;clip.transform.scale=.7;
    project.tracks[0].clips[0].keyframes=[{id:'zoom',time:1,easing:'linear',transform:{...clip.transform,scale:1.05},color:clip.color}];
    const result=longformUiFocusGeometryGraphV1(project,clip.id,asset.uri,probe,['setsar=1']);
    expect(result.mode).toBe('fixed-perspective');expect(result.graph).toContain('perspective=');expect(result.sourceInputArgs).toContain('0.05');
  });
  it('refuses an unsupported route instead of producing a partly graded or invisible target',()=>{
    const f=fixture();f.project.tracks[0].hidden=true;expect(()=>longformUiFocusGeometryGraphV1(f.project,f.clip.id,f.asset.uri,f.probe,['setsar=1'])).toThrow('VISIBLE_SOURCE');
    f.project.tracks[0].hidden=false;f.project.tracks[0].clips[0].creative={effectPresetIds:['blur']};
    expect(()=>longformUiFocusGeometryGraphV1(f.project,f.clip.id,f.asset.uri,f.probe,['setsar=1'])).toThrow('UNSUPPORTED_ROUTE');
    f.project.tracks[0].clips[0].creative={effectPresetIds:[],lookPresetId:'film'};
    expect(()=>longformUiFocusGeometryGraphV1(f.project,f.clip.id,f.asset.uri,f.probe,['setsar=1'])).toThrow('COLOR_ROUTE');
  });
});
