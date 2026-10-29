import { describe,expect,it } from "vitest";
import { prepareMesh3dTemplate,MESH_3D_TEMPLATES } from "./mesh3dTemplates";
import { createEmptyProject,migrateProject,validateProject } from "../domain/editGraph";
import { DEFAULT_COLOR,DEFAULT_TRANSFORM } from "../domain/types";
import { createHistory,dispatchCommand,undo,redo } from "../domain/history";
import { projectSchema,editorCommandSchema } from "../domain/schema";
import { renderReviewContentJson } from "../shared/renderReviewContent";
import { buildGpuEngineVideoPreviewGraph } from "../render/gpuCompositor";
import { motionCommandFamilies } from "./motionTreatment";
import { materializeMesh3dProject } from "../render/mesh3dRender";
function fixture(){const p=createEmptyProject("mesh",{width:540,height:960,fps:30});p.assets.push({id:"video",name:"owned",kind:"video",uri:"C:/owned.mp4",duration:6,color:{interpretation:"rec709"}});p.tracks[0].clips.push({id:"footage",assetId:"video",trackId:p.tracks[0].id,timelineStart:0,sourceStart:0,duration:6,volume:.7,transform:{...DEFAULT_TRANSFORM},color:{...DEFAULT_COLOR},keyframes:[]});return p;}
describe("mesh scene project and command product contract",()=>{
  it.each(MESH_3D_TEMPLATES)("$id saves/reopens, binds v4 treatment, and ordinary undo restores the real project",({id})=>{
    const p=fixture(),before=JSON.stringify(p),prepared=prepareMesh3dTemplate(p,{templateId:id,clipId:"footage",title:"真實素材"});expect(JSON.stringify(p)).toBe(before);
    const command=editorCommandSchema.parse(prepared.commands[0]),history=dispatchCommand(createHistory(p),command);
    const reopened=validateProject(migrateProject(projectSchema.parse(JSON.parse(JSON.stringify(history.present)))));
    expect(reopened.scene3d).toEqual(JSON.parse(JSON.stringify(prepared.scene)));expect(undo(history).present).toEqual(p);expect(redo(undo(history)).present).toEqual(history.present);
    expect(motionCommandFamilies(command)).toEqual(expect.arrayContaining(["motion","title","vfx","transitions_camera"]));
    expect(renderReviewContentJson(reopened)).not.toBe(renderReviewContentJson(p));
    expect(buildGpuEngineVideoPreviewGraph(reopened,0)).toBeUndefined();
    const baked=materializeMesh3dProject(reopened,"C:/mesh-output.mp4",6);expect(baked.scene3d).toBeUndefined();expect(baked.tracks.filter(t=>t.kind==="audio").flatMap(t=>t.clips).find(c=>c.volume===.7)?.assetId).toBe("video");validateProject(baked);
  });
  it("rejects HDR, unbound footage, effect omissions, malformed cameras and object budgets",()=>{
    const p=fixture();expect(()=>prepareMesh3dTemplate(p,{templateId:"depth_studio",clipId:"absent",title:"素材"})).toThrow("影片材質");
    p.assets[0].color={interpretation:"hlg"};expect(()=>prepareMesh3dTemplate(p,{templateId:"curved_video_orbit",clipId:"footage",title:"素材"})).toThrow("Rec.709");
    p.assets[0].color={interpretation:"rec709"};p.tracks[0].clips[0].creative={effectPresetIds:["fake-effect"]};expect(()=>prepareMesh3dTemplate(p,{templateId:"curved_video_orbit",clipId:"footage",title:"素材"})).toThrow("濾鏡");
    delete p.tracks[0].clips[0].creative;const scene=prepareMesh3dTemplate(p,{templateId:"curved_video_orbit",clipId:"footage",title:"素材"}).scene;
    scene.segments[0].camera.near=1;scene.segments[0].camera.far=.1;expect(()=>validateProject({...p,scene3d:scene})).toThrow();
    scene.segments[0].camera.far=40;scene.segments[0].objects=Array(33).fill(scene.segments[0].objects[0]);expect(()=>validateProject({...p,scene3d:scene})).toThrow();
  });
});
