import { randomUUID, createHash } from "node:crypto";
import { access, link, lstat, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import * as z from "zod/v4";
import { canonicalJson } from "../shared/canonicalJson";
import { readBoundedFile } from "../shared/boundedFile";
import type { ProjectFileIdentityV1 } from "../domain/projectFileIdentityV1";
import type { EditProject } from "../domain/types";
import type { BatchAutoEditRequest } from "./batchAutoEdit";
import type { exportVideo } from "./exportVideo";
import { batchFileSha256, materializeEditorialProject, readMaterializedEditorialProject } from "./editorialBatchResume";
import type { writeProjectFileAtomic } from "./projectFiles";

const digest=z.string().regex(/^[a-f0-9]{64}$/);
const executionSchema=z.strictObject({schema:z.literal("editkin.batch-item-execution/v1"),requestSha256:digest,sourceSha256:digest,
  phase:z.enum(["queued","applying","applied","rendering","completed"]),projectSha256:digest.optional(),
  candidatePath:z.string().min(1).max(32768).optional(),candidateSha256:digest.optional(),outputSha256:digest.optional(),editorialFingerprint:digest.optional(),musicId:z.string().optional()});
type Execution=z.infer<typeof executionSchema>;
export interface BatchResumePathsV1 {directory:string;projectPath:string;outputPath:string;receiptPath:string;}
async function exists(path:string){try{await access(path);return true;}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return false;throw error;}}
function requestHash(request:BatchAutoEditRequest){return createHash("sha256").update(canonicalJson({jobId:request.jobId,sessionId:request.sessionId,sourcePath:resolve(request.sourcePath),outputRoot:resolve(request.outputRoot),
  language:request.language??"auto",targetRatio:request.targetRatio??.65,addMusic:request.addMusic!==false,analysisMode:request.analysisMode??"semantic",editorialProfile:request.editorialProfile??"auto"})).digest("hex");}
export interface BatchResumeContextV1 {
  request:BatchAutoEditRequest;paths:BatchResumePathsV1;execution:Execution;warnings:string[];project?:EditProject;fileIdentity?:ProjectFileIdentityV1;
  output?:{duration:number;encoder:string;planner?:string;ffmpegVersion?:string};
  save(status:"RUNNING"|"COMPLETED"|"FAILED"|"CANCELLED",error?:string):Promise<void>;
}

/** Adds execution fields to the existing batch receipt. Project commits still belong to the existing origin receipt. */
export async function openBatchAutoEditResumeV1(request:BatchAutoEditRequest,paths:BatchResumePathsV1,sourceSha256:string,
  base:Record<string,unknown>,write:(path:string,value:unknown)=>Promise<void>):Promise<BatchResumeContextV1>{
  let prior:Record<string,unknown>|undefined;
  try{
    const parsed=JSON.parse((await readBoundedFile(paths.receiptPath,1024*1024)).toString("utf8"));
    if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw new Error("BATCH_RESUME_RECEIPT_INVALID");
    prior=parsed;
  }
  catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  const expected=requestHash(request);
  if(prior&&(prior.schemaVersion!==1||prior.product!=="Editkin"||prior.jobId!==request.jobId||prior.sessionId!==request.sessionId
    ||prior.projectPath!==paths.projectPath||prior.outputPath!==paths.outputPath))throw new Error("BATCH_RESUME_RECEIPT_BINDING_CHANGED");
  let execution:Execution;
  if(prior?.execution){
    execution=executionSchema.parse(prior.execution);
    if(execution.requestSha256!==expected||execution.sourceSha256!==sourceSha256||prior.sourceSha256!==execution.sourceSha256)throw new Error("BATCH_RESUME_INPUT_CHANGED");
  }else{
    if(prior&&(prior.status!=="FAILED"||prior.jobId!==request.jobId||(prior.sourceSha256&&prior.sourceSha256!==sourceSha256)))throw new Error("BATCH_RESUME_LEGACY_RECEIPT_UNVERIFIED");
    if(await exists(paths.projectPath)||await exists(paths.outputPath)||await exists(`${paths.projectPath}.batch-origin.json`))throw new Error("BATCH_RESUME_UNOWNED_ARTIFACT");
    execution={schema:"editkin.batch-item-execution/v1",requestSha256:expected,sourceSha256,phase:"queued"};
  }
  const context:BatchResumeContextV1={request,paths,execution,warnings:Array.isArray(prior?.warnings)?prior.warnings.filter((value):value is string=>typeof value==="string"):[],
    output:prior?.output as BatchResumeContextV1["output"],async save(status,error){
      await write(paths.receiptPath,{...base,createdAt:typeof prior?.createdAt==="string"?prior.createdAt:base.createdAt,status,sourceSha256,
        reviewState:"REVIEW_REQUIRED",sourcePreserved:status==="COMPLETED",editorialFingerprint:execution.editorialFingerprint,selectedMusicId:execution.musicId,
        warnings:context.warnings,output:context.output,execution:{...execution},...(error?{error}:{}),...(status==="COMPLETED"?{completedAt:new Date().toISOString()}:{})});
    }};
  if(execution.phase!=="queued"){
    const committed=await readMaterializedEditorialProject(paths.projectPath,expected,request.jobId);
    if(!committed)throw new Error("BATCH_RESUME_COMMIT_UNCERTAIN_NO_ORIGIN");
    if(execution.projectSha256&&execution.projectSha256!==committed.projectSha256)throw new Error("BATCH_RESUME_PROJECT_CHANGED");
    execution.projectSha256=committed.projectSha256;context.project=committed.project;context.fileIdentity=committed.fileIdentity;
    if(execution.phase==="applying"){execution.phase="applied";await context.save("RUNNING");}
  }else if(await exists(paths.projectPath)||await exists(paths.outputPath))throw new Error("BATCH_RESUME_UNOWNED_ARTIFACT");
  return context;
}

export async function commitBatchAutoEditProjectV1(context:BatchResumeContextV1,project:EditProject,writeProject:typeof writeProjectFileAtomic){
  context.execution.phase="applying";await context.save("RUNNING");
  const committed=await materializeEditorialProject(context.paths.projectPath,context.execution.requestSha256,context.request.jobId,project,{writeProject});
  context.project=committed.project;context.fileIdentity=committed.fileIdentity;context.execution.projectSha256=committed.projectSha256;context.execution.phase="applied";
  await context.save("RUNNING");return committed.project;
}
async function assertProject(context:BatchResumeContextV1){
  const committed=await readMaterializedEditorialProject(context.paths.projectPath,context.execution.requestSha256,context.request.jobId);
  if(!committed||committed.projectSha256!==context.execution.projectSha256)throw new Error("BATCH_RESUME_PROJECT_CHANGED");
}
async function candidateIdentity(context:BatchResumeContextV1,path:string){
  const file=resolve(path),directory=resolve(context.paths.directory),same=(a:string,b:string)=>process.platform==="win32"?a.toLowerCase()===b.toLowerCase():a===b;
  if(!same(dirname(file),directory)||!new RegExp(`^\\.editkin-batch-${context.request.jobId}-[a-f0-9-]{36}\\.mp4$`).test(basename(file)))throw new Error("BATCH_CANDIDATE_NOT_OWNED");
  const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink())throw new Error("BATCH_CANDIDATE_NOT_REGULAR");
  return batchFileSha256(file);
}
export async function renderBatchAutoEditResumeV1(context:BatchResumeContextV1,render:typeof exportVideo,options:Parameters<typeof exportVideo>[0]["options"],
  verifySource:()=>Promise<void>):Promise<void>{
  const signal=options?.signal;signal?.throwIfAborted();await assertProject(context);
  const execution=context.execution,paths=context.paths;
  if(execution.phase==="completed"){
    const info=await lstat(paths.outputPath);if(!info.isFile()||info.isSymbolicLink()||await batchFileSha256(paths.outputPath)!==execution.outputSha256)throw new Error("BATCH_RESUME_OUTPUT_CHANGED");return;
  }
  if(execution.candidatePath&&execution.candidateSha256){
    if(await candidateIdentity(context,execution.candidatePath)!==execution.candidateSha256)throw new Error("BATCH_CANDIDATE_CHANGED");
    await verifySource();await assertProject(context);signal?.throwIfAborted();
    if(await exists(paths.outputPath)){
      const info=await lstat(paths.outputPath);if(!info.isFile()||info.isSymbolicLink()||await batchFileSha256(paths.outputPath)!==execution.candidateSha256)throw new Error("BATCH_RESUME_OUTPUT_CHANGED");
    }else await link(execution.candidatePath,paths.outputPath);
  }else{
    if(await exists(paths.outputPath))throw new Error("BATCH_RESUME_UNOWNED_OUTPUT");
    execution.candidatePath=join(paths.directory,`.editkin-batch-${context.request.jobId}-${randomUUID()}.mp4`);execution.phase="rendering";
    await context.save("RUNNING");signal?.throwIfAborted();
    const output=await render({project:context.project!,outputPath:execution.candidatePath,options});
    signal?.throwIfAborted();await verifySource();await assertProject(context);
    execution.candidateSha256=await candidateIdentity(context,execution.candidatePath);
    context.output={duration:output.duration,encoder:output.encoder,planner:output.planner,ffmpegVersion:output.ffmpegVersion};
    await context.save("RUNNING");signal?.throwIfAborted();await link(execution.candidatePath,paths.outputPath);
  }
  // Link + completed receipt form the promotion boundary: a late abort does not erase a committed output.
  execution.outputSha256=execution.candidateSha256;execution.phase="completed";await context.save("COMPLETED");
  // Once the receipt records completion the staging name is only a second hard link to the output; remove that stray
  // `.editkin-batch-<job>-<uuid>.mp4`. Unverified or interrupted candidates are never removed here (they stay as evidence).
  if(execution.candidatePath&&await sameFile(execution.candidatePath,paths.outputPath))await rm(execution.candidatePath,{force:true});
}
async function sameFile(left:string,right:string){
  try{const [a,b]=await Promise.all([lstat(left,{bigint:true}),lstat(right,{bigint:true})]);return a.isFile()&&b.isFile()&&a.dev===b.dev&&a.ino===b.ino&&a.ino!==0n;}
  catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return false;throw error;}
}
