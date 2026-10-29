import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { AVAILABLE_MESH_3D_TEMPLATES, assertMesh3dTemplateAvailable, prepareMesh3dTemplate } from "../application/mesh3dTemplates";
import { readProject } from "./storage";
import { textResult,errorResult } from "./toolRuntime";
import { mesh3dOverlaysV1Schema } from "../motion/mesh3dOverlayV1";
import { MESH3D_SCENE_BUDGET_V1 } from "../motion/mesh3dScene";
import { prepareMesh3dOverlaysV1, mesh3dOverlaySourcesV1Schema } from "../application/mesh3dOverlayCommandsV1";

export function registerMesh3dTools(server:McpServer){
  server.registerTool("prepare_mesh_3d_overlays",{description:"只讀：為現有可編輯 3D 場景驗證指定的 2D 來源、附著點與遮擋，可從已匯入素材新增靜音片段，回傳單一可復原批次。未套用、未認證美術、未更新安裝版。",inputSchema:z.strictObject({projectPath:z.string().min(1),bindings:mesh3dOverlaysV1Schema,newSources:mesh3dOverlaySourcesV1Schema.optional()})},async({projectPath,bindings,newSources})=>{try{return textResult(prepareMesh3dOverlaysV1(await readProject(projectPath),bindings,newSources));}catch(error){return errorResult(error);}});
  server.registerTool("list_mesh_3d_templates",{description:"只讀：列出可用的 Editkin 3D 模板。目前三個美術失敗的配方已撤回，目錄為空；不能自動套用研究稿或宣稱安裝版已更新。",inputSchema:z.strictObject({})},async()=>textResult({schema:"editkin.mesh-3d-catalog/v1",status:"DESIGN_REWORK",templates:AVAILABLE_MESH_3D_TEMPLATES,prepareTool:"prepare_mesh_3d_template",executor:"shared-cpu-triangle-zbuffer/v1",limits:MESH3D_SCENE_BUDGET_V1,boundary:"Research geometry remains editable in saved projects. Rejected recipes are unavailable; full 3D visual delivery remains open."}));
  server.registerTool("prepare_mesh_3d_template",{description:"只讀：只接受已恢復可用的 3D 模板。目前美術失敗的三個配方已撤回，會在讀取素材專案前拒絕。",inputSchema:z.strictObject({projectPath:z.string().min(1),templateId:z.enum(["curved_video_orbit","extruded_typography","depth_studio"]),clipId:z.string().min(1),title:z.string().trim().min(1).max(6)})},async({projectPath,...input})=>{try{assertMesh3dTemplateAvailable(input.templateId);return textResult(prepareMesh3dTemplate(await readProject(projectPath),input));}catch(error){return errorResult(error);}});
}
