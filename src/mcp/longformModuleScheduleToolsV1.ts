import type {McpServer} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {longformModuleScheduleRequestV1Schema} from "../domain/longformModuleScheduleV1";
import {prepareLongformModuleScheduleFileV1} from "./longformModuleScheduleFileV1";
import {textResult,errorResult} from "./toolRuntime";
export const LONGFORM_MODULE_SCHEDULE_TOOL_V1="prepare_longform_module_schedule";
export const LONGFORM_MODULE_SCHEDULE_RESPONSE_BYTES_V1=256*1024;
export function registerLongformModuleScheduleToolsV1(server:McpServer,prepare:typeof prepareLongformModuleScheduleFileV1=prepareLongformModuleScheduleFileV1){
  server.registerTool(LONGFORM_MODULE_SCHEDULE_TOOL_V1,{
    description:"唯讀：檢查目前長片的模組數量與整格時間。焦點64個、概念16個、回顧3個；焦點鏈可0格間隔，各至少0.8秒。"
      +"只接受模組參照與新時間，不接受框位或動作。回傳排程上限檢查，不代表參照已解析、目標已驗證或可套用；各模組仍須實際prepare、v4 audit及完整渲染。",
    inputSchema:longformModuleScheduleRequestV1Schema.extend({projectPath:z.string().min(1).max(1024)}),
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  },async({projectPath,...input},context)=>{try{
    const result=await prepare(projectPath,input,context.mcpReq.signal);
    if(Buffer.byteLength(JSON.stringify(result),"utf8")>LONGFORM_MODULE_SCHEDULE_RESPONSE_BYTES_V1)throw Error("LONGFORM_MODULE_RESPONSE_BUDGET");
    return textResult(result);
  }catch(error){return errorResult(error);}});
}
