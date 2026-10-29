import type {McpServer} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type {registerLongformUiFocusToolsV1} from "./longformUiFocusToolsV1";
import type {LongformUiFocusHoldJobsV1} from "../application/longformUiFocusHoldJobsV1";
import {longformUiFocusGeometryFileRequestV1Schema} from "../domain/longformUiFocusGeometryFileV1";
import {ownLongformUiFocusGeometryJobsV1,type LongformUiFocusGeometryJobDepsV1} from "../application/longformUiFocusGeometryJobsV1";
import {prepareLongformUiFocusProjectClockV1} from "../application/longformUiFocusProjectClockRuntimeV1";
import {prepareLongformUiFocusGeometryV1,longformUiFocusGeometryAlgorithmSha256V1} from "../application/longformUiFocusGeometryRuntimeV1";
import {describeLongformUiFocusGeometryV1} from "../application/longformUiFocusGeometryDraftV1";
import {colorDigest} from "../application/materialColorSamplingRuntime";
import {readProject} from "./storage";
import {textResult,errorResult} from "./toolRuntime";
export const LONGFORM_UI_FOCUS_GEOMETRY_TOOLS_V1=['start_longform_ui_focus_geometry','get_longform_ui_focus_geometry_job',
  'cancel_longform_ui_focus_geometry_job','read_longform_ui_focus_geometry_frames'] as const;
export const LONGFORM_UI_FOCUS_GEOMETRY_RESPONSE_BYTES_V1=256*1024;
const jobSchema=z.strictObject({jobId:z.string().regex(/^ug-[a-f0-9]{24}$/)});
function bounded(value:unknown){if(Buffer.byteLength(JSON.stringify(value))>LONGFORM_UI_FOCUS_GEOMETRY_RESPONSE_BYTES_V1)throw Error('UI_FOCUS_GEOMETRY_RESPONSE_BUDGET');return textResult(value);}
export function registerLongformUiFocusGeometryToolsV1(server:McpServer,session:ReturnType<typeof registerLongformUiFocusToolsV1>,holds:LongformUiFocusHoldJobsV1,
  injected?:LongformUiFocusGeometryJobDepsV1){
  const{runtime}=session;
  const jobs=ownLongformUiFocusGeometryJobsV1(injected??{
    admitHold:id=>holds.assertReadyOwned(id),
    prepare:(holdJobId,signal)=>holds.withReadyResult(holdJobId,async(hold,validateHold,artifact)=>{
      const project=await readProject(artifact.request.projectPath);
      const validateCurrent=async()=>{await validateHold();signal.throwIfAborted();};
      const clock=await prepareLongformUiFocusProjectClockV1(project,artifact,hold,{...runtime,signal,validateCurrent});
      const handle=await prepareLongformUiFocusGeometryV1(project,artifact,hold,clock,{...runtime,signal,validateCurrent});return{project,handle};
    },signal),
    validateCurrent:(holdJobId,value,signal)=>holds.withReadyResult(holdJobId,async(hold,_validateHold,artifact)=>{
      const project=await readProject(artifact.request.projectPath);
      const draft=describeLongformUiFocusGeometryV1(value.project,value.handle);
      if(draft.holdReceiptSha256!==hold.receiptSha256||draft.artifactId!==artifact.artifactId||colorDigest(project)!==draft.projectCanonicalSha256
        ||draft.provider.implementationSha256!==await longformUiFocusGeometryAlgorithmSha256V1())throw Error('UI_FOCUS_GEOMETRY_CURRENT_OWNER_CHANGED');
    },signal),
  });
  const annotations={readOnlyHint:true,destructiveHint:false,openWorldHint:false};
  server.registerTool('start_longform_ui_focus_geometry',{
    description:'從本連線已查看、已確認且逐格追蹤成功的holdJobId，背景驗證目前專案縮放、裁切、鏡像與旋轉後的實際框位。'
      +'來源影格與座標都由工具取得；不接受手填框位、路徑或收據。尚不修改專案、不代表原生完整呈現或美術驗收；約每10秒查工作。',
    inputSchema:longformUiFocusGeometryFileRequestV1Schema,annotations,
  },async input=>{try{return bounded(jobs.start(input));}catch(error){return errorResult(error);}});
  server.registerTool('get_longform_ui_focus_geometry_job',{
    description:'查詢本連線的專案框位驗證工作。完成結果重新檢查目前已確認的追蹤、專案與來源；仍待可編輯焦點與原生完整呈現。',inputSchema:jobSchema,annotations,
  },async({jobId})=>{try{return bounded(await jobs.get(jobId));}catch(error){return errorResult(error);}});
  server.registerTool('cancel_longform_ui_focus_geometry_job',{
    description:'取消本連線專案框位驗證工作；所有實際分析程序關閉後才到CANCELLED。連線結束也取消並等待關閉。',inputSchema:jobSchema,
    annotations:{...annotations,readOnlyHint:false},
  },async({jobId})=>{try{return bounded(jobs.cancel(jobId));}catch(error){return errorResult(error);}});
  server.registerTool('read_longform_ui_focus_geometry_frames',{
    description:'分頁讀實際來源PTS、來源像素指紋、合成階段尺寸與專案框位。每頁最多32格；先重查目前專案與本連線已確認的追蹤工作。'
      +'框位以project-display正規化座標表示；不推論整個按鈕邊緣，不代表可編輯焦點已完成。',
    inputSchema:jobSchema.extend({offset:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(32).default(16)}),annotations,
  },async({jobId,offset,limit})=>{try{return bounded(await jobs.read(jobId,offset,limit));}catch(error){return errorResult(error);}});
  return jobs;
}
