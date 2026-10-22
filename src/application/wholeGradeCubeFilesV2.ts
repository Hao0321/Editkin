import { lstat, mkdir, open, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { readBoundedFile } from "../shared/boundedFile";
import { exportWholeGradeCubeV2, wholeGradeCubeSha256V2, type WholeGradeCubeArtifactV2,
  type WholeGradeCubeSourceV2, type WholeGradeCubeRuntimeV2 } from "./wholeGradeCubeExportV2";

export type WholeGradeCubeFilePhaseV2="before_directory"|"directory_created"|"cube_written"|"receipt_written";
export interface WholeGradeCubeFileOptionsV2 {
  outputDirectory:string;
  onPhase?:(phase:WholeGradeCubeFilePhaseV2)=>void|Promise<void>;
}
const samePath=(a:string,b:string)=>process.platform==="win32"?a.toLowerCase()===b.toLowerCase():a===b;
const sameIdentity=(a:Stats,b:Stats)=>a.dev===b.dev&&a.ino===b.ino&&a.birthtimeMs===b.birthtimeMs;
function targetPath(input:string):string {
  if(typeof input!=="string"||!isAbsolute(input)||input.length>1024||input.startsWith("\\\\")||input.startsWith("//")||/[\u0000-\u001f\u007f]/u.test(input))throw Error("WHOLE_GRADE_V2_OUTPUT_PATH");
  const target=resolve(input),root=resolve(target).slice(0,process.platform==="win32"?3:1);
  if(target.startsWith("\\\\")||dirname(target)===target||/[. ]$/u.test(basename(target))||target.slice(root.length).split(sep).some(p=>p.includes(":")))throw Error("WHOLE_GRADE_V2_OUTPUT_PATH");
  return target;
}
async function pins(parent:string) {
  const chain:string[]=[];
  for(let p=parent;;p=dirname(p)){chain.push(p);if(p===dirname(p))break;if(chain.length>64)throw Error("WHOLE_GRADE_V2_OUTPUT_PATH");}
  const result:Array<{path:string;stat:Stats}>=[];
  for(const path of chain.reverse()) {
    const stat=await lstat(path);
    if(!stat.isDirectory()||stat.isSymbolicLink()||!samePath(await realpath(path),path))throw Error("WHOLE_GRADE_V2_DIRECTORY_REPARSE");
    result.push({path,stat});
  }
  return result;
}
async function verify(directories:Awaited<ReturnType<typeof pins>>) {
  for(const pin of directories) {
    const now=await lstat(pin.path);
    if(!now.isDirectory()||now.isSymbolicLink()||!sameIdentity(now,pin.stat)||!samePath(await realpath(pin.path),pin.path))throw Error("WHOLE_GRADE_V2_DIRECTORY_CHANGED");
  }
}
async function absent(target:string) {
  try{await lstat(target);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}
  throw Error("WHOLE_GRADE_V2_OUTPUT_EXISTS");
}

/** Exclusive local output bundle, following the existing sidecar policy. No old file is replaced.
 * A failed/cancelled partially written owned bundle is retained and explicitly reported incomplete.
 * The generic desktop engine-task bridge remains a separate integrator hook.
 */
export async function exportWholeGradeCubeFilesV2(source:WholeGradeCubeSourceV2,runtime:WholeGradeCubeRuntimeV2,options:WholeGradeCubeFileOptionsV2) {
  runtime.signal?.throwIfAborted();
  const target=targetPath(options.outputDirectory),parents=await pins(dirname(target));await absent(target);
  const artifact=await exportWholeGradeCubeV2(source,runtime);
  return publish(artifact,target,parents,options);
}
async function publish(artifact:WholeGradeCubeArtifactV2,target:string,parents:Awaited<ReturnType<typeof pins>>,options:WholeGradeCubeFileOptionsV2) {
  const receipt={...artifact.receipt,cube:{...artifact.receipt.cube,fileName:"grade.cube"}};
  const receiptText=JSON.stringify(receipt,null,2)+"\n";
  if(Buffer.byteLength(receiptText)>64*1024)throw Error("WHOLE_GRADE_V2_RECEIPT_BUDGET");
  const files=[{name:"grade.cube",text:artifact.text,bytes:artifact.receipt.cube.utf8Bytes,sha256:artifact.receipt.cube.sha256},
    {name:"grade.receipt.json",text:receiptText,bytes:Buffer.byteLength(receiptText),sha256:wholeGradeCubeSha256V2(receiptText)}];
  let created=false;
  const check=async()=>{await artifact.assertCurrent();await verify(parents);};
  const phase=async(p:WholeGradeCubeFilePhaseV2)=>{await options.onPhase?.(p);await check();};
  try {
    await phase("before_directory");await absent(target);
    try{await mkdir(target);}catch(error){if((error as NodeJS.ErrnoException).code==="EEXIST")throw Error("WHOLE_GRADE_V2_OUTPUT_EXISTS");throw error;}
    created=true;const own=await pins(target);await phase("directory_created");
    for(let index=0;index<files.length;index++) {
      const file=files[index];await check();await verify(own);
      const handle=await open(join(target,file.name),"wx",0o600);
      try{await handle.writeFile(file.text,"utf8");await handle.sync();}finally{await handle.close();}
      await phase(index===0?"cube_written":"receipt_written");
    }
    for(const file of files) {
      await check();await verify(own);
      const bytes=await readBoundedFile(join(target,file.name),file.bytes);
      if(bytes.length!==file.bytes||wholeGradeCubeSha256V2(bytes)!==file.sha256)throw Error("WHOLE_GRADE_V2_FINAL_PAIR_CHANGED");
    }
    await check();await verify(own);
    return {status:"COMPLETE" as const,outputDirectory:target,bindingSha256:artifact.bindingSha256,
      files:files.map(({name,bytes,sha256})=>({name,path:join(target,name),bytes,sha256})),
      completePairVerified:true as const,filesystemTransactionAtomic:false as const,receipt};
  } catch(cause) {
    if(!created)throw cause;
    throw Object.assign(Error("WHOLE_GRADE_V2_INCOMPLETE_OUTPUT: partial owned bundle preserved",{cause}),
      {outputDirectory:target,completePairVerified:false,partialOutputPreserved:true});
  }
}
