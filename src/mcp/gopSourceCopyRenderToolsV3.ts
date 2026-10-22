import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { EditProject } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import { renderGopSourceCopyProjectV3, GOP_SOURCE_COPY_POLICY_V3 } from "../render/gopSourceCopyExportV3";
import { textResult, errorResult } from "./toolRuntime";

const projectHash = (project: EditProject) => createHash("sha256").update(canonicalJson(project)).digest("hex");
export interface GopSourceCopyToolDependenciesV3 {
  readProject: (path: string) => Promise<EditProject>; resolveProjectPath: (path: string) => Promise<string>;
  resolveRenderPath: (path: string) => Promise<string>; workspaceRoot: () => string;
  acquireProjectLock: (path: string) => Promise<() => Promise<void>>; render: typeof renderGopSourceCopyProjectV3;
}
async function defaultDependencies(): Promise<GopSourceCopyToolDependenciesV3> {
  const { readProject, resolveProjectPath, resolveRenderPath, workspaceRoot } = await import("./storage");
  const { acquireProjectLock } = await import("../application/projectFiles");
  return { readProject, resolveProjectPath, resolveRenderPath, workspaceRoot, acquireProjectLock, render: renderGopSourceCopyProjectV3 };
}
export const gopSourceCopyInputSchemaV3 = z.strictObject({ projectPath:z.string().min(1).max(1024),outputPath:z.string().min(1).max(1024),
  policy:z.literal(GOP_SOURCE_COPY_POLICY_V3),expectedSourceSha256:z.string().regex(/^[a-f0-9]{64}$/) });
export async function renderGopSourceCopyToolV3(input:z.infer<typeof gopSourceCopyInputSchemaV3>,signal?:AbortSignal,supplied?:GopSourceCopyToolDependenciesV3) {
  const parsed=gopSourceCopyInputSchemaV3.parse(input);signal?.throwIfAborted();const dependencies=supplied??await defaultDependencies();
  const path=await dependencies.resolveProjectPath(parsed.projectPath),project=await dependencies.readProject(parsed.projectPath),projectSha256=projectHash(project);
  const output=await dependencies.resolveRenderPath(parsed.outputPath),app=resolve(import.meta.dirname,"../..");
  const result=await dependencies.render(project,output,{assetBase:dependencies.workspaceRoot(),ffmpegPath:process.env.HAO_FFMPEG_PATH??resolve(app,"vendor/ffmpeg/win32-x64/ffmpeg.exe"),
    ffprobePath:process.env.HAO_FFPROBE_PATH??resolve(app,"vendor/ffmpeg/win32-x64/ffprobe.exe"),expectedSourceSha256:parsed.expectedSourceSha256,policy:parsed.policy,signal,
    withPublicationGuard:async operation=>{const release=await dependencies.acquireProjectLock(path);try{signal?.throwIfAborted();
      if(projectHash(await dependencies.readProject(parsed.projectPath))!==projectSha256)throw Error("PACKET_COPY_PROJECT_CHANGED");return await operation();
    }finally{await release();}}});
  return{...result,projectBinding:{path,projectId:project.id,revision:project.revision,projectSha256},mutationPerformed:false,certificationPerformed:false};
}
export function registerGopSourceCopyRenderToolsV3(server:McpServer) {
  server.registerTool("render_exact_gop_postroll_source_project",{
    description:"明示copy_exact_gop_postroll_original_streams_v3，單一中性H264 AVC66/77/100 progressive8bit Rec709。保留完整依賴prefix、有界IDR預讀與尾端參考封包，僅縮短自有MP4 candidate呈現duration；驗原rawpayload、逐格呈現與strictdecode。無聲或原AAC-LC mono/stereo raw加floatPCM完全一致才輸出，不丟音轨、不移剪點、不重編碼、不覆寫。hybrid/其他codec/跨播放器與10小時速度待驗。",
    inputSchema:gopSourceCopyInputSchemaV3,annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},
  },async(input,extra)=>{try{return textResult(await renderGopSourceCopyToolV3(input,extra.mcpReq.signal));}catch(error){return errorResult(error);}});
}
