import type { EditProject } from "../domain/types";
import { projectDuration } from "../domain/editGraph";
import { validateMesh3dProject } from "../domain/mesh3dValidation";
import type { Mesh3dCamera, Mesh3dObject, Mesh3dPose, Mesh3dScene, Mesh3dSegment } from "../motion/mesh3dScene";

export const MESH_3D_TEMPLATES = [
  { id:"curved_video_orbit",name:"曲面影片 · 鏡頭環繞",purpose:"讓真實素材成為曲面主體，緩慢繞行看見厚度與遮擋" },
  { id:"extruded_typography",name:"實體字 · 材質揭示",purpose:"用有厚度、倒角和光線的短標題帶出同一份素材" },
  { id:"depth_studio",name:"影片攝影棚 · 深度推進",purpose:"鏡頭穿過藍白立體框架，最後停留在真實素材" },
] as const;
export type Mesh3dTemplateId = typeof MESH_3D_TEMPLATES[number]["id"];
// Preserve the research compiler and saved projects, but withdraw rejected
// visual recipes from both editor creation and automatic recommendations.
export const AVAILABLE_MESH_3D_TEMPLATES: readonly typeof MESH_3D_TEMPLATES[number][] = [];
export function assertMesh3dTemplateAvailable(id: Mesh3dTemplateId): void {
  if (!AVAILABLE_MESH_3D_TEMPLATES.some(template => template.id === id)) {
    throw new Error("目前的 3D 場景模板已撤回，正在重新設計；請保留原素材畫面。");
  }
}
export const BLUE_GRID_3D_BACKGROUND = {color:"#FFFFFF",gridColor:"#E0EAF8",spacing:72,grid:true};
const pose = (position: [number,number,number], rotationDegrees: [number,number,number] = [0,0,0], scale: [number,number,number] = [1,1,1]): Mesh3dPose => ({position,rotationDegrees,scale});
const cam = (position: [number,number,number],target: [number,number,number] = [0,0,0]): Mesh3dCamera => ({position,target,verticalFovDegrees:42,near:.1,far:40});
const surface = (color:string,clipId?:string,grid=false) => ({color,clipId,grid,unlit:Boolean(clipId)});
function text(id:string,value:string,height:number,position:[number,number,number],rotation:[number,number,number]=[0,0,0]): Mesh3dObject {
  return {id,name:value,geometry:{kind:"text",text:value,fontFamily:"Noto Sans TC",fontWeight:900,height:Math.min(height,2.65/[...value].length),depth:.085,bevel:.004},pose:pose(position,rotation),keyframes:[],material:surface("#175CD3")};
}
export function mesh3dTemplateSegment(kind:Mesh3dTemplateId, clipId:string, start:number,duration:number,title:string): Mesh3dSegment {
  const objects: Mesh3dObject[] = [], camera = cam([0,.5,7.8],[0,0,0]);
  const floor: Mesh3dObject = {id:"studio-floor",name:"白色網格地板",geometry:{kind:"box",width:7,height:.06,depth:12},pose:pose([0,-2.45,-2]),keyframes:[],material:{...surface("#F8FAFF",undefined,true),unlit:true}};
  let cameraKeyframes: Mesh3dSegment["cameraKeyframes"] = [];
  if (kind==="curved_video_orbit") {
    objects.push(floor,text("headline",title,.45,[0,2.1,.1]));
    objects.push({id:"curved-footage",name:"曲面主素材",geometry:{kind:"curved_video",radius:3.6,width:3.15,height:3.55,segments:32},pose:pose([0,-.12,.3],[0,-8,0]),keyframes:[{time:duration*.65,pose:pose([0,-.12,.3],[0,7,0]),easing:"smooth"},{time:duration,pose:pose([0,-.12,.3],[0,7,0]),easing:"hold"}],material:surface("#FFFFFF",clipId)});
    objects.push({id:"depth-orb",name:"前景藍色球體",geometry:{kind:"sphere",radius:.17,segments:20},pose:pose([1.4,-1.62,1.15]),keyframes:[],material:surface("#2E90FA")});
    objects.push({id:"back-orb",name:"後景藍色球體",geometry:{kind:"sphere",radius:.12,segments:20},pose:pose([-1.62,1.2,-.3]),keyframes:[],material:surface("#175CD3")});
    cameraKeyframes=[{time:duration*.65,camera:cam([.35,.55,7.7]),easing:"smooth"},{time:duration,camera:cam([.35,.55,7.7]),easing:"hold"}];
  } else if(kind==="extruded_typography") {
    objects.push(floor);
    const heading=text("headline",title,.69,[0,1.8,.65],[8,-13,0]);
    heading.keyframes=[{time:duration*.42,pose:pose([0,1.8,.65],[3,8,0]),easing:"smooth"},{time:duration,pose:pose([0,1.8,.65],[3,8,0]),easing:"hold"}];objects.push(heading);
    objects.push({id:"video-sphere",name:"影片球面材質",geometry:{kind:"sphere",radius:1.03,segments:40},pose:pose([0,-.35,.1],[0,-90,0]),keyframes:[{time:duration*.72,pose:pose([0,-.35,.1],[0,-74,0]),easing:"smooth"},{time:duration,pose:pose([0,-.35,.1],[0,-74,0]),easing:"hold"}],material:surface("#FFFFFF",clipId)});
    objects.push({id:"halo",name:"實體藍色圓環",geometry:{kind:"torus",radius:1.26,tube:.032,segments:48},pose:pose([0,-.35,-.7],[12,0,0]),keyframes:[],material:surface("#2E90FA")});
  } else {
    objects.push(floor,text("headline",title,.43,[0,2,.15]));
    objects.push({id:"studio-footage",name:"攝影棚影片屏幕",geometry:{kind:"curved_video",radius:10,width:2.75,height:3.1,segments:20},pose:pose([0,-.1,-1.6]),keyframes:[],material:surface("#FFFFFF",clipId)});
    // Three real box frames recede in world space; camera travel reveals occlusion and parallax.
    for(let i=0;i<3;i++) {
      const z = .2+i*1.3, thickness=.055, w=3.42+i*.12,h=4.25+i*.1;
      for(const [side,position,width,height] of [["left",[-w/2,-.7,z],thickness,h],["right",[w/2,-.7,z],thickness,h],["top",[0,h/2-.7,z],w,thickness],["bottom",[0,-h/2-.7,z],w,thickness]] as const) objects.push({id:`frame-${i}-${side}`,name:`第 ${i+1} 層棚框 ${side}`,geometry:{kind:"box",width,height,depth:.08},pose:pose([...position]),keyframes:[],material:surface(i===0?"#175CD3":"#BFD7FC")});
    }
    camera.position=[.45,.35,9.2];cameraKeyframes=[{time:duration*.7,camera:cam([0,.25,7.2],[0,-.05,-1.1]),easing:"smooth"},{time:duration,camera:cam([0,.25,7.2],[0,-.05,-1.1]),easing:"hold"}];
  }
  return {id:`${kind}-${clipId}`,name:MESH_3D_TEMPLATES.find(t=>t.id===kind)!.name,timelineStart:start,duration,camera,cameraKeyframes,objects};
}
export function prepareMesh3dTemplate(project:EditProject,input:{templateId:Mesh3dTemplateId;clipId:string;title:string}) {
  const duration=projectDuration(project);
  if(duration<3||duration>60||[...input.title].length>6||!input.title.trim())throw new Error("3D 展示需 3～60 秒，實體主標最多六字；原有影片素材須覆蓋完整時間軸");
  const scene: Mesh3dScene={schema:"editkin.mesh-scene/v1",enabled:true,background:{...BLUE_GRID_3D_BACKGROUND},light:{direction:[-.4,.7,1],ambient:.68,intensity:.36},segments:[mesh3dTemplateSegment(input.templateId,input.clipId,0,duration,input.title.trim())]};
  validateMesh3dProject({...project,scene3d:scene});
  return {scene,commands:[{type:"set_mesh_3d_scene" as const,scene}],readOnly:true,execution:"ordinary command validation/apply/save/reopen/render; visual review remains required",capabilityBoundary:"Rec.709 opaque CPU mesh raster; no native GPU mesh executor, shadow maps, PBR or HDR"};
}
