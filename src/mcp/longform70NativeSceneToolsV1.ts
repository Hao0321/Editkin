import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { longform70NativeSceneRequestV1Schema } from "../domain/longform70NativeSceneV1";
import { listLongform70NativeRecipesV1 } from "../application/longform70NativeSceneV1";
import { prepareLongform70NativeSceneFileV1 } from "./longform70NativeSceneFileV1";
import { errorResult, textResult } from "./toolRuntime";

export const LONGFORM70_NATIVE_TOOLS_V1=["list_longform_native_recipes","prepare_longform_native_scene"]as const;
export const LONGFORM70_NATIVE_RESPONSE_BYTES_V1=256*1024;
export function registerLongform70NativeSceneToolsV1(server:McpServer,environment:NodeJS.ProcessEnv=process.env,
  prepare:typeof prepareLongform70NativeSceneFileV1=prepareLongform70NativeSceneFileV1){
  const annotations={readOnlyHint:true,destructiveHint:false,openWorldHint:false};
  server.registerTool("list_longform_native_recipes",{
    description:"唯讀：列出 longform70 的八個原生場景配方、文字槽與四角色配色。幾何、字型與動作依原核准規格；每次需新文案、旁白影格與證據。新版本未經美術認證，不進預設選擇。",
    inputSchema:z.strictObject({}),annotations,
  },async()=>textResult(listLongform70NativeRecipesV1()));
  server.registerTool("prepare_longform_native_scene",{
    description:"唯讀：把一個 longform70 場景編譯成可編輯原生文字／向量。使用當前專案、確切實體字形、整格旁白窗口、完整主張停留及單行網址；不猜文案／證據，不更動來源或音訊。回傳 flat commands、明選variants與精簡字形收據。仍須新v4素材／設計宣告、獨立audit及一次套用，渲染後交Claude驗收；PREPARED不是已套用或美術通過。",
    inputSchema:longform70NativeSceneRequestV1Schema.safeExtend({projectPath:z.string().min(1).max(1024)}),annotations,
  },async({projectPath,...input},context)=>{try{
    const result=await prepare(projectPath,input,environment,context.mcpReq.signal);
    if(Buffer.byteLength(JSON.stringify(result),"utf8")>LONGFORM70_NATIVE_RESPONSE_BYTES_V1)throw Error("LONGFORM70_RESPONSE_BUDGET");
    return textResult(result);
  }catch(error){return errorResult(error);}});
}
