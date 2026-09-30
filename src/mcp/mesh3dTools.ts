import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { AVAILABLE_MESH_3D_TEMPLATES, assertMesh3dTemplateAvailable, prepareMesh3dTemplate } from "../application/mesh3dTemplates";
import { readProject } from "./storage";
import { textResult,errorResult } from "./toolRuntime";

export function registerMesh3dTools(server:McpServer){
  server.registerTool("list_mesh_3d_templates",{description:"只讀：列出可用的 Editkin 3D 模板。目前三個美術失敗的配方已撤回，目錄為空；不能自動套用研究稿或宣稱安裝版已更新。",inputSchema:z.strictObject({})},async()=>textResult({schema:"editkin.mesh-3d-catalog/v1",status:"DESIGN_REWORK",templates:AVAILABLE_MESH_3D_TEMPLATES,prepareTool:"prepare_mesh_3d_template",executor:"shared-cpu-triangle-zbuffer/v1",limits:{objects:32,triangles:60000,textures:6},boundary:"Research geometry remains editable in saved projects. Rejected recipes are unavailable; full 3D visual delivery remains open."}));
  server.registerTool("prepare_mesh_3d_template",{description:"只讀：只接受已恢復可用的 3D 模板。目前美術失敗的三個配方已撤回，會在讀取素材專案前拒絕。",inputSchema:z.strictObject({projectPath:z.string().min(1),templateId:z.enum(["curved_video_orbit","extruded_typography","depth_studio"]),clipId:z.string().min(1),title:z.string().trim().min(1).max(6)})},async({projectPath,...input})=>{try{assertMesh3dTemplateAvailable(input.templateId);return textResult(prepareMesh3dTemplate(await readProject(projectPath),input));}catch(error){return errorResult(error);}});
}
