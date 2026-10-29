import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { EditProject } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import { renderGopSourceCopyProjectV2 } from "../render/gopSourceCopyExportV2";
import { GOP_SOURCE_COPY_POLICY_V2 } from "../render/gopSourceCopyAdmissionV2";
import { textResult, errorResult } from "./toolRuntime";

const projectHash = (project: EditProject) => createHash("sha256").update(canonicalJson(project)).digest("hex");
export interface GopSourceCopyToolDependenciesV2 {
  readProject: (path: string) => Promise<EditProject>; resolveProjectPath: (path: string) => Promise<string>;
  resolveRenderPath: (path: string) => Promise<string>; workspaceRoot: () => string;
  acquireProjectLock: (path: string) => Promise<() => Promise<void>>; render: typeof renderGopSourceCopyProjectV2;
}
async function defaultDependencies(): Promise<GopSourceCopyToolDependenciesV2> {
  const { readProject, resolveProjectPath, resolveRenderPath, workspaceRoot } = await import("./storage");
  const { acquireProjectLock } = await import("../application/projectFiles");
  return { readProject, resolveProjectPath, resolveRenderPath, workspaceRoot, acquireProjectLock, render: renderGopSourceCopyProjectV2 };
}
export const gopSourceCopyInputSchemaV2 = z.strictObject({ projectPath:z.string().min(1).max(1024),outputPath:z.string().min(1).max(1024),
  policy:z.literal(GOP_SOURCE_COPY_POLICY_V2),expectedSourceSha256:z.string().regex(/^[a-f0-9]{64}$/) });
export async function renderGopSourceCopyToolV2(input:z.infer<typeof gopSourceCopyInputSchemaV2>,signal?:AbortSignal,supplied?:GopSourceCopyToolDependenciesV2) {
  const parsed=gopSourceCopyInputSchemaV2.parse(input);signal?.throwIfAborted();const dependencies=supplied??await defaultDependencies();
  const path=await dependencies.resolveProjectPath(parsed.projectPath),stored=await dependencies.readProject(parsed.projectPath),projectSha256=projectHash(stored);
  // Read exactly the media that was checked (renderMediaBinding.ts): granted outside files by canonical path, nothing unchecked.
  const{bindProjectMediaForRender}=await import("./renderMediaBinding"),project=await bindProjectMediaForRender(stored);
  const output=await dependencies.resolveRenderPath(parsed.outputPath),app=resolve(import.meta.dirname,"../..");
  const result=await dependencies.render(project,output,{assetBase:dependencies.workspaceRoot(),ffmpegPath:process.env.HAO_FFMPEG_PATH??resolve(app,"vendor/ffmpeg/win32-x64/ffmpeg.exe"),
    ffprobePath:process.env.HAO_FFPROBE_PATH??resolve(app,"vendor/ffmpeg/win32-x64/ffprobe.exe"),expectedSourceSha256:parsed.expectedSourceSha256,policy:parsed.policy,signal,
    withPublicationGuard:async operation=>{const release=await dependencies.acquireProjectLock(path);try{signal?.throwIfAborted();
      if(projectHash(await dependencies.readProject(parsed.projectPath))!==projectSha256)throw Error("PACKET_COPY_PROJECT_CHANGED");return await operation();
    }finally{await release();}}});
  return{...result,projectBinding:{path,projectId:project.id,revision:project.revision,projectSha256},mutationPerformed:false,certificationPerformed:false};
}
export function registerGopSourceCopyRenderToolsV2(server:McpServer) {
  server.registerTool("render_exact_gop_source_project",{
    description:"明示copy_exact_gop_original_streams_v2，單一中性H264 AVC66/77/100 progressive8bit Rec709，完整依賴prefix及有界IDR預讀。保留無聲或原AAC-LC mono/stereo，驗raw封包、逐格呈現、strictdecode及原片從頭floatPCM取樣；不丟音轨、不移剪點、不重編碼、不覆寫。postroll/hybrid/其他codec須正確渲染；驗證耗時計入成本，10小時速度未測。",
    inputSchema:gopSourceCopyInputSchemaV2,annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},
  },async(input,extra)=>{try{return textResult(await renderGopSourceCopyToolV2(input,extra.mcpReq.signal));}catch(error){return errorResult(error);}});
}
