import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { EditProject } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import { renderMuxedPacketCopyProjectV1 } from "../render/muxedPacketCopyExportV1";
import { MUXED_PACKET_COPY_POLICY_V1 } from "../render/muxedPacketCopyAdmissionV1";
import { textResult, errorResult } from "./toolRuntime";

const projectHash = (project: EditProject) => createHash("sha256").update(canonicalJson(project)).digest("hex");
export interface MuxedPacketCopyToolDependenciesV1 {
  readProject: (path: string) => Promise<EditProject>; resolveProjectPath: (path: string) => Promise<string>;
  resolveRenderPath: (path: string) => Promise<string>; workspaceRoot: () => string;
  acquireProjectLock: (path: string) => Promise<() => Promise<void>>; render: typeof renderMuxedPacketCopyProjectV1;
}
async function defaultDependencies(): Promise<MuxedPacketCopyToolDependenciesV1> {
  const { readProject, resolveProjectPath, resolveRenderPath, workspaceRoot } = await import("./storage");
  const { acquireProjectLock } = await import("../application/projectFiles");
  return { readProject, resolveProjectPath, resolveRenderPath, workspaceRoot, acquireProjectLock, render: renderMuxedPacketCopyProjectV1 };
}
export const muxedPacketCopyInputSchemaV1 = z.strictObject({ projectPath:z.string().min(1).max(1024),outputPath:z.string().min(1).max(1024),
  policy:z.literal(MUXED_PACKET_COPY_POLICY_V1),expectedSourceSha256:z.string().regex(/^[a-f0-9]{64}$/) });
export async function renderMuxedPacketCopyToolV1(input:z.infer<typeof muxedPacketCopyInputSchemaV1>,signal?:AbortSignal,supplied?:MuxedPacketCopyToolDependenciesV1) {
  const parsed=muxedPacketCopyInputSchemaV1.parse(input);signal?.throwIfAborted();const dependencies=supplied??await defaultDependencies();
  const path=await dependencies.resolveProjectPath(parsed.projectPath),project=await dependencies.readProject(parsed.projectPath),projectSha256=projectHash(project);
  const output=await dependencies.resolveRenderPath(parsed.outputPath),app=resolve(import.meta.dirname,"../..");
  const result=await dependencies.render(project,output,{assetBase:dependencies.workspaceRoot(),ffmpegPath:process.env.HAO_FFMPEG_PATH??resolve(app,"vendor/ffmpeg/win32-x64/ffmpeg.exe"),
    ffprobePath:process.env.HAO_FFPROBE_PATH??resolve(app,"vendor/ffmpeg/win32-x64/ffprobe.exe"),expectedSourceSha256:parsed.expectedSourceSha256,policy:parsed.policy,signal,
    withPublicationGuard:async operation=>{const release=await dependencies.acquireProjectLock(path);try{signal?.throwIfAborted();
      if(projectHash(await dependencies.readProject(parsed.projectPath))!==projectSha256)throw Error("PACKET_COPY_PROJECT_CHANGED");return await operation();
    }finally{await release();}}});
  return{...result,projectBinding:{path,projectId:project.id,revision:project.revision,projectSha256},mutationPerformed:false,certificationPerformed:false};
}
export function registerMuxedPacketCopyRenderToolsV1(server:McpServer) {
  server.registerTool("render_exact_muxed_packet_copy_project",{
    description:"明示copy_exact_idr_aac_window，僅輸出單一中性H264 AVC無重排影片+AAC-LC單聲道/立體聲的精確IDR及音訊封包邊界。保留碼流、驗影片封包與原片從頭解碼的floatPCM取樣身份，PNS狀態/取樣/時長對不上就拒絕；不丟音軌、不移剪點、不覆寫。驗證含原片解碼耗時，不宣稱10小時速度或完整hybrid；不合條件須一般渲染。",
    inputSchema:muxedPacketCopyInputSchemaV1,annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},
  },async(input,extra)=>{try{return textResult(await renderMuxedPacketCopyToolV1(input,extra.mcpReq.signal));}catch(error){return errorResult(error);}});
}
