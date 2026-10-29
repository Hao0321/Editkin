import type {McpServer} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {shotGradeMatchRequestSchemaV1,shotGradeBalanceRequestSchemaV1} from "../application/shotGradeDecisionV1";
import {proposeShotColorMatchV1,proposeAutoBalanceV1} from "../application/shotGradeEvidenceV1";
import {autoColorRuntime} from "./autoColorTools";
import {readProject} from "./storage";
import {textResult,errorResult} from "./toolRuntime";
export function registerShotGradeToolsV1(server:McpServer){
 server.registerTool("propose_shot_color_match",{description:"依目前素材與參考鏡頭的語意收據、明示中性與膚色區域，提出有界 gradeV2 對色。實際解碼核對本片段的調色後像素、膚色角度與截斷比例；回傳可編輯命令及不可變收據，不直接修改專案。ROI 是 local-layer-raster-normalized，仍需人審；不代表成片、美術或 VA 合約驗收。",
  inputSchema:z.strictObject({projectPath:z.string().min(1),...shotGradeMatchRequestSchemaV1.shape})},async({projectPath,...request},context)=>{
   try{const project=await readProject(projectPath);return textResult(await proposeShotColorMatchV1(project,request,{...autoColorRuntime(project),signal:context.mcpReq.signal}));}catch(error){return errorResult(error);}
  });
 server.registerTool("propose_auto_balance",{description:"依已封存素材收據與呼叫者明示的中性、膚色 ROI，提出有界 gradeV2 色偏平衡，保留中性區原亮度並核對膚色、食物、天空及截斷比例。只回傳可編輯命令與不可變收據，不直接修改專案，也不會自行判定白點。ROI 是 local-layer-raster-normalized，仍需人審；不代表成片、美術或 VA 合約驗收。",
  inputSchema:z.strictObject({projectPath:z.string().min(1),...shotGradeBalanceRequestSchemaV1.shape})},async({projectPath,...request},context)=>{
   try{const project=await readProject(projectPath);return textResult(await proposeAutoBalanceV1(project,request,{...autoColorRuntime(project),signal:context.mcpReq.signal}));}catch(error){return errorResult(error);}
  });
}
