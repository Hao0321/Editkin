import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { EditProject } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import { renderPacketCopyProjectV1 } from "../render/packetCopyExportV1";
import { EXACT_PACKET_COPY_POLICY_V1 } from "../render/packetCopyAdmissionV1";
import { textResult, errorResult } from "./toolRuntime";

const projectHash = (project: EditProject) => createHash("sha256").update(canonicalJson(project)).digest("hex");
export interface PacketCopyToolDependenciesV1 {
  readProject: (path: string) => Promise<EditProject>; resolveProjectPath: (path: string) => Promise<string>;
  resolveRenderPath: (path: string) => Promise<string>; workspaceRoot: () => string;
  acquireProjectLock: (path: string) => Promise<() => Promise<void>>; render: typeof renderPacketCopyProjectV1;
}
async function defaultDependencies(): Promise<PacketCopyToolDependenciesV1> {
  const { readProject, resolveProjectPath, resolveRenderPath, workspaceRoot } = await import("./storage");
  const { acquireProjectLock } = await import("../application/projectFiles");
  return { readProject, resolveProjectPath, resolveRenderPath, workspaceRoot, acquireProjectLock, render: renderPacketCopyProjectV1 };
}
export const packetCopyInputSchemaV1 = z.strictObject({ projectPath:z.string().min(1).max(1024),outputPath:z.string().min(1).max(1024),
  policy:z.literal(EXACT_PACKET_COPY_POLICY_V1),expectedSourceSha256:z.string().regex(/^[a-f0-9]{64}$/) });
export async function renderPacketCopyToolV1(input:z.infer<typeof packetCopyInputSchemaV1>,signal?:AbortSignal,supplied?:PacketCopyToolDependenciesV1) {
  const parsed=packetCopyInputSchemaV1.parse(input);signal?.throwIfAborted();const dependencies=supplied??await defaultDependencies();
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
export function registerPacketCopyRenderToolsV1(server:McpServer) {
  server.registerTool("render_exact_packet_copy_project",{
    description:"明示copy_exact_idr_video_window，僅輸出單一中性H264 AVC無聲来源的精確IDR剪接區間。逐筆檢查NAL、codec config、保留封包與PTS/DTS及完整解碼；不重新編碼，不偷移剪點，不覆寫輸出。含音訊、重排影格、非IDR起點、特效或多片段會拒絕並須用一般渲染，不丟音軌；10小時速度/完整hybrid/GUI仍待驗。",
    inputSchema:packetCopyInputSchemaV1,annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},
  },async(input,extra)=>{try{return textResult(await renderPacketCopyToolV1(input,extra.mcpReq.signal));}catch(error){return errorResult(error);}});
}
