import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { longformSentenceAlignmentRequestV1Schema } from "../domain/longformSentenceAlignmentV1";
import { ownLongformSentenceAlignmentJobsV1, type LongformSentenceAlignmentJobsV1 } from "../application/longformSentenceAlignmentJobsV1";
import { readLongformSentenceAlignmentPageV1 } from "../application/longformSentenceAlignmentRuntimeV1";
import { longformWordRuntimeV1 } from "./longformWordTimingToolsV1";
import { errorResult, textResult } from "./toolRuntime";

export const LONGFORM_SENTENCE_ALIGNMENT_TOOLS_V1=["start_longform_sentence_alignment","get_longform_sentence_alignment_job",
  "cancel_longform_sentence_alignment_job","read_longform_sentences","read_longform_chapters"]as const;
export const LONGFORM_ALIGNMENT_RESPONSE_BYTES_V1=256*1024;
const jobSchema=z.strictObject({jobId:z.string().regex(/^la-[a-f0-9]{24}$/)});
const pageSchema=z.strictObject({artifactId:z.string().regex(/^[a-f0-9]{64}$/),offset:z.number().int().nonnegative().default(0),
  limit:z.number().int().min(1).max(200).default(100)});
export interface LongformSentenceToolDepsV1 {
  jobs:Pick<LongformSentenceAlignmentJobsV1,"start"|"get"|"cancel">;page:typeof readLongformSentenceAlignmentPageV1;
}
function boundedResult(value:unknown){
  if(Buffer.byteLength(JSON.stringify(value),"utf8")>LONGFORM_ALIGNMENT_RESPONSE_BYTES_V1)throw new Error("LONGFORM_ALIGNMENT_RESPONSE_BUDGET: reduce limit");
  return textResult(value);
}
export function registerLongformSentenceAlignmentToolsV1(server:McpServer,environment:NodeJS.ProcessEnv=process.env,
  injected?:LongformSentenceToolDepsV1){
  const runtime=longformWordRuntimeV1(environment),deps=injected??{jobs:ownLongformSentenceAlignmentJobsV1(runtime),page:readLongformSentenceAlignmentPageV1};
  const annotations={readOnlyHint:true,destructiveHint:false,openWorldHint:false};
  server.registerTool("start_longform_sentence_alignment",{
    description:"使用逐字辨識 artifactId，在背景將原腳本的每句對到錄影候選並分章。錄影有聲音時使用既有已安裝模型；也可引用已準備的錄影逐字稿或語意證據。"
      +"保留完整旁白，不修改素材或專案。缺少時間、模糊片段與語意候選仍需作者確認。回 jobId，連線結束會取消工作。",
    inputSchema:longformSentenceAlignmentRequestV1Schema,annotations,
  },async input=>{try{return boundedResult(deps.jobs.start(input));}catch(error){return errorResult(error);}});
  server.registerTool("get_longform_sentence_alignment_job",{
    description:"查詢句子／錄影／章節對齊進度。完成時回 artifactId、句數、章節數及保留的旁白秒數；結果仍待確認。jobId 只在原連線有效。",
    inputSchema:jobSchema,annotations,
  },async({jobId})=>{try{return boundedResult(deps.jobs.get(jobId));}catch(error){return errorResult(error);}});
  server.registerTool("cancel_longform_sentence_alignment_job",{
    description:"取消本連線的句子對齊工作。CANCELLING 代表程序正在結束，CANCELLED 才表示已結束；已完成辨識分段保留。",
    inputSchema:jobSchema,annotations:{...annotations,readOnlyHint:false},
  },async({jobId})=>{try{return boundedResult(deps.jobs.cancel(jobId));}catch(error){return errorResult(error);}});
  for(const kind of["sentences","chapters"]as const)server.registerTool(kind==="sentences"?"read_longform_sentences":"read_longform_chapters",{
    description:kind==="sentences"?"分頁讀原腳本句子、辨識時間及最多三個錄影片段候選。時間／素材先核對原證據仍有效；候選不代表畫面內容已確認。每頁最多200句，過長可減少limit。":
      "分頁讀原腳本章節與辨識時間。缺少聲音時間的章節保留待確認標記，不猜開始／結束時間；每頁最多200章。",
    inputSchema:pageSchema,annotations,
  },async({artifactId,offset,limit})=>{try{return boundedResult(await deps.page(runtime,artifactId,kind,offset,limit));}catch(error){return errorResult(error);}});
}
