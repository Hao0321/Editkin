import type { McpServer } from "@modelcontextprotocol/server";
import { join, resolve } from "node:path";
import * as z from "zod/v4";
import { longformWordTimingRequestV1Schema } from "../domain/longformWordTimingV1";
import { PINNED_WHISPER_MODEL } from "../application/automaticCaptions";
import { ownLongformWordTimingJobsV1, type LongformWordTimingJobsV1 } from "../application/longformWordTimingJobsV1";
import { readLongformWordPageV1, readLongformWordIssuePageV1, type LongformWordRecognitionRuntimeV1 } from "../application/longformWordRecognitionV1";
import { errorResult, textResult } from "./toolRuntime";

export const LONGFORM_WORD_TIMING_TOOLS_V1=["start_longform_word_timing","get_longform_word_timing_job",
  "cancel_longform_word_timing_job","read_longform_words","read_longform_word_timing_issues"] as const;
const jobSchema=z.strictObject({jobId:z.string().regex(/^lw-[a-f0-9]{24}$/)});
const pageSchema=z.strictObject({artifactId:z.string().regex(/^[a-f0-9]{64}$/),offset:z.number().int().nonnegative().default(0),
  limit:z.number().int().min(1).max(200).default(100)});
export const LONGFORM_WORD_RESPONSE_BYTES_V1=256*1024;

export function longformWordRuntimeV1(environment:NodeJS.ProcessEnv=process.env):Omit<LongformWordRecognitionRuntimeV1,"signal"|"onProgress"> {
  const sourceRoot=resolve(environment.EDITKIN_WORKSPACE??environment.HAO_EDITOR_WORKSPACE??process.cwd());
  const app=resolve(import.meta.dirname,"../.."), cacheRoot=resolve(environment.EDITKIN_CACHE_ROOT??join(sourceRoot,".editkin-cache"));
  const modelRoot=resolve(environment.EDITKIN_MODEL_ROOT??(environment.APPDATA
    ? join(environment.APPDATA,"studio.hao.editkin/models") : join(sourceRoot,".editkin-models")));
  const threads=environment.EDITKIN_LONGFORM_THREADS===undefined?4:Number(environment.EDITKIN_LONGFORM_THREADS);
  if(!Number.isSafeInteger(threads)||threads<1||threads>16)throw new Error("WORD_TIMING_THREADS");
  return {sourceRoot,cacheRoot,modelRoot,threads,workRoot:resolve(environment.EDITKIN_LONGFORM_WORK_ROOT??join(cacheRoot,"longform-work")),
    modelPath:resolve(environment.EDITKIN_WHISPER_MODEL_PATH??join(modelRoot,PINNED_WHISPER_MODEL.fileName)),
    mediumModelPath:environment.EDITKIN_WHISPER_MEDIUM_MODEL_PATH===undefined?undefined:resolve(environment.EDITKIN_WHISPER_MEDIUM_MODEL_PATH),
    ffmpegPath:environment.HAO_FFMPEG_PATH??join(app,"vendor/ffmpeg/win32-x64/ffmpeg.exe"),
    ffprobePath:environment.HAO_FFPROBE_PATH??join(app,"vendor/ffmpeg/win32-x64/ffprobe.exe"),
    whisperCliPath:environment.EDITKIN_WHISPER_CLI_PATH??join(app,"vendor/whisper/win32-x64/whisper-cli.exe")};
}
function boundedResult(value:unknown){
  if(Buffer.byteLength(JSON.stringify(value),"utf8")>LONGFORM_WORD_RESPONSE_BYTES_V1)throw new Error("WORD_TIMING_RESPONSE_BUDGET: reduce limit");
  return textResult(value);
}
export interface LongformWordToolDepsV1 {
  jobs:Pick<LongformWordTimingJobsV1,"start"|"get"|"cancel">;
  words:typeof readLongformWordPageV1; issues:typeof readLongformWordIssuePageV1;
}
export function registerLongformWordTimingToolsV1(server:McpServer,environment:NodeJS.ProcessEnv=process.env,
  injected?:LongformWordToolDepsV1) {
  const runtime=longformWordRuntimeV1(environment);
  const deps=injected??{jobs:ownLongformWordTimingJobsV1(runtime),words:readLongformWordPageV1,issues:readLongformWordIssuePageV1};
  const annotations={readOnlyHint:true,destructiveHint:false,openWorldHint:false};
  server.registerTool("start_longform_word_timing",{
    description:"讀入脚本或段落、旁白及錄影／截圖，在背景辨識逐字時間。預設使用既有模型 small；可明選 medium（首次缺檔可下載約 539 MB，核對固定 SHA-256）；回傳 jobId，以查詢工具查看進度。"
      +"不修改素材或專案。時間是旁白裁切後的秒數；辨識內容仍需作者確認。連線結束會取消工作，重新開始可重用已完成分段。",
    inputSchema:longformWordTimingRequestV1Schema,annotations,
  },async(input)=>{try{return boundedResult(deps.jobs.start(input));}catch(error){return errorResult(error);}});
  server.registerTool("get_longform_word_timing_job",{
    description:"查詢逐字辨識進度。完成時回 artifactId、詞數及待確認問題數；用分頁工具讀結果。jobId 只在原連線有效。",
    inputSchema:jobSchema,annotations,
  },async({jobId})=>{try{return boundedResult(deps.jobs.get(jobId));}catch(error){return errorResult(error);}});
  server.registerTool("cancel_longform_word_timing_job",{
    description:"取消本連線的逐字辨識；CANCELLING 表示程序正在結束，CANCELLED 才表示已結束。已完成分段保留，素材不會被修改。",
    inputSchema:jobSchema,annotations:{...annotations,readOnlyHint:false},
  },async({jobId})=>{try{return boundedResult(deps.jobs.cancel(jobId));}catch(error){return errorResult(error);}});
  server.registerTool("read_longform_words",{
    description:"分頁讀取逐字時間，每頁最多 200 詞，回 nextOffset。先核對原素材仍相同；字詞時間來自實際辨識，未表示內容或字幕已驗收。",
    inputSchema:pageSchema,annotations,
  },async({artifactId,offset,limit})=>{try{return boundedResult(await deps.words(runtime,artifactId,offset,limit));}catch(error){return errorResult(error);}});
  server.registerTool("read_longform_word_timing_issues",{
    description:"分頁讀取逐字辨識的待確認問題，包括缺少時間、字詞共用時間或範圍重疊。不要替缺少時間的詞猜時間；每頁最多 200 項。",
    inputSchema:pageSchema,annotations,
  },async({artifactId,offset,limit})=>{try{return boundedResult(await deps.issues(runtime,artifactId,offset,limit));}catch(error){return errorResult(error);}});
}
