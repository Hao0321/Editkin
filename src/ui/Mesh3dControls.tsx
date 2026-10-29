import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";
import { useState } from "react";
import type { EditProject } from "../domain/types";
import type { EditorCommand } from "../domain/commands";
import { AVAILABLE_MESH_3D_TEMPLATES, assertMesh3dTemplateAvailable, prepareMesh3dTemplate, type Mesh3dTemplateId } from "../application/mesh3dTemplates";
import type { Mesh3dScene } from "../motion/mesh3dScene";
import "./mesh3dControls.css";

export default function Mesh3dControls({project,clipId,onCommand}:{project:EditProject;clipId?:string;onCommand:(command:EditorCommand)=>void}){
  useI18n();
  const [templateId,setTemplateId]=useState<Mesh3dTemplateId>("curved_video_orbit"),[title,setTitle]=useState("讓素材說話"),[error,setError]=useState("");
  const scene=project.scene3d,apply=(next:Mesh3dScene)=>onCommand({type:"set_mesh_3d_scene",scene:next});
  const edit=(update:(next:Mesh3dScene)=>void)=>{if(!scene)return;const next=structuredClone(scene);update(next);apply(next);};
  return <details className="mesh-3d-controls" open={Boolean(scene?.enabled)} data-testid="mesh-3d-controls">
    <summary>{uiText("立體 Motion 場景")}</summary>
    {AVAILABLE_MESH_3D_TEMPLATES.length>0 ? <>
    <label>{uiText("3D 場景模板")}<select aria-label={uiText("3D 場景模板")} value={templateId} onChange={e=>setTemplateId(e.target.value as Mesh3dTemplateId)}>{AVAILABLE_MESH_3D_TEMPLATES.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
    <label>{uiText("實體主標")}<input aria-label={uiText("3D 實體主標")} value={title} maxLength={6} onChange={e=>setTitle(e.target.value)}/></label>
    <button type="button" className="mini-action" disabled={!clipId} onClick={()=>{try{assertMesh3dTemplateAvailable(templateId);const result=prepareMesh3dTemplate(project,{templateId,clipId:clipId!,title});apply(result.scene);setError("");}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}}}>{uiText("建立可編輯 3D 場景")}</button>
    </> : <p>{uiText("3D 場景模板正在重新設計。")}</p>}
    {error && <p role="alert">{error}</p>}
    {scene?.enabled && <>
      <label>{uiText("網格間距")}<input type="number" aria-label={uiText("3D 網格間距")} min={24} max={200} value={scene.background.spacing} onChange={e=>edit(next=>{next.background.spacing=Number(e.target.value);})}/></label>
      <label>{uiText("場景背景")}<input type="color" aria-label={uiText("3D 場景背景")} value={scene.background.color} onChange={e=>edit(next=>{next.background.color=e.target.value;})}/></label>
      <label>{uiText("環境光")}<input type="number" aria-label={uiText("3D 環境光")} min={0} max={1} step={.05} value={scene.light.ambient} onChange={e=>edit(next=>{next.light.ambient=Number(e.target.value);})}/></label>
      {scene.segments.map((segment,index)=><details key={segment.id}><summary>{segment.name}</summary>
        <label>{uiText("相機視角")}<input type="number" aria-label={uiText("{value0}相機視角", { value0: String(segment.name) })} min={15} max={100} value={segment.camera.verticalFovDegrees} onChange={e=>edit(next=>{next.segments[index].camera.verticalFovDegrees=Number(e.target.value);for(const key of next.segments[index].cameraKeyframes)key.camera.verticalFovDegrees=Number(e.target.value);})}/></label>
        {segment.objects.map((object,objectIndex)=><details key={object.id}><summary>{object.name}</summary>
          {object.geometry.kind==="text"&&<label>{uiText("文字")}<input aria-label={uiText("{value0}立體文字", { value0: String(object.name) })} value={object.geometry.text} maxLength={6} onChange={e=>edit(next=>{const geometry=next.segments[index].objects[objectIndex].geometry;if(geometry.kind==="text")geometry.text=e.target.value;})}/></label>}
          {object.material.clipId&&<label>{uiText("影片素材")}<select aria-label={uiText("{value0}影片素材", { value0: String(object.name) })} value={object.material.clipId} onChange={e=>edit(next=>{next.segments[index].objects[objectIndex].material.clipId=e.target.value;})}>{project.tracks.filter(t=>t.kind==="video"&&!t.hidden).flatMap(t=>t.clips).map(c=><option key={c.id} value={c.id}>{project.assets.find(a=>a.id===c.assetId)?.name??c.id}</option>)}</select></label>}
          <label>{uiText("材質顏色")}<input type="color" aria-label={uiText("{value0}材質顏色", { value0: String(object.name) })} value={object.material.color} onChange={e=>edit(next=>{next.segments[index].objects[objectIndex].material.color=e.target.value;})}/></label>
          <label>{uiText("前後深度")}<input type="number" aria-label={uiText("{value0}前後深度", { value0: String(object.name) })} step={.1} value={object.pose.position[2]} onChange={e=>edit(next=>{const item=next.segments[index].objects[objectIndex],delta=Number(e.target.value)-item.pose.position[2];item.pose.position[2]+=delta;for(const key of item.keyframes)key.pose.position[2]+=delta;})}/></label>
          {object.geometry.kind==="text"&&<label>{uiText("文字厚度")}<input type="number" aria-label={uiText("{value0}文字厚度", { value0: String(object.name) })} min={.01} max={.6} step={.01} value={object.geometry.depth} onChange={e=>edit(next=>{const geometry=next.segments[index].objects[objectIndex].geometry;if(geometry.kind==="text")geometry.depth=Number(e.target.value);})}/></label>}
        </details>)}
      </details>)}
      <button type="button" className="mini-action" onClick={()=>onCommand({type:"set_mesh_3d_scene"})}>{uiText("移除 3D 場景")}</button>
    </>}
  </details>;
}
