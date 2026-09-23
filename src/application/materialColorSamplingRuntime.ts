import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { materialColorCodeIdentity } from "./materialColorCodeIdentity";
import implementationPaths from "./materialColorImplementationPaths.json";
import { canonicalJson } from "../shared/canonicalJson";
import type { MaterialColorRuntime, MaterialColorRuntimeIdentity } from "./materialColorSamplingTypes";

export const colorDigest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
export const colorBytesSha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
export const MATERIAL_COLOR_IMPLEMENTATIONS=implementationPaths;
export async function colorFileSha(path: string): Promise<string> {
  const info=await stat(path);
  if (!info.isFile() || info.size>64*1024**3) throw new Error("source-or-tool-not-bounded-regular-file");
  const stream=createReadStream(path),hash=createHash("sha256");
  const timer=setTimeout(()=>stream.destroy(new Error("hash-timeout")),30000);
  try { for await (const chunk of stream) hash.update(chunk); return hash.digest("hex"); }
  finally { clearTimeout(timer);stream.destroy(); }
}
export function colorToolPaths(runtime: MaterialColorRuntime) {
  if (!isAbsolute(runtime.ffmpegPath) || (runtime.ffprobePath && !isAbsolute(runtime.ffprobePath))) throw new Error("absolute-tool-path-required");
  return { ffmpeg:runtime.ffmpegPath,ffprobe:runtime.ffprobePath??join(dirname(runtime.ffmpegPath),process.platform==="win32"?"ffprobe.exe":"ffprobe") };
}
/** Settles on close, bounds both pipes, never invokes a shell. */
export function runColorProcess(executable:string,args:string[],maximumStdout:number,timeoutMs=30000,signal?:AbortSignal):Promise<{stdout:Buffer;stderr:string}> {
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{windowsHide:true,stdio:["ignore","pipe","pipe"]});
    const chunks:Buffer[]=[];let bytes=0,stderr="",failure:Error|undefined;
    const stop=(reason:string)=>{failure??=new Error(reason);child.kill();};
    const abort=()=>stop("analysis-cancelled");
    signal?.addEventListener("abort",abort,{once:true});
    if(signal?.aborted)abort();
    const timer=setTimeout(()=>stop("process-timeout"),Math.max(1,Math.min(30000,timeoutMs)));
    child.stdout.on("data",(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>maximumStdout)stop("stdout-budget-exceeded");else chunks.push(chunk);});
    child.stderr.on("data",(chunk:Buffer)=>{if(Buffer.byteLength(stderr)+chunk.length>131072)stop("stderr-budget-exceeded");else stderr+=chunk.toString("utf8");});
    child.on("error",error=>{failure??=error;});
    child.on("close",code=>{clearTimeout(timer);signal?.removeEventListener("abort",abort);if(failure)reject(failure);else if(code!==0)reject(new Error(`process-exit-${code}`));else resolve({stdout:Buffer.concat(chunks),stderr});});
  });
}
export async function getMaterialColorRuntimeIdentity(runtime:MaterialColorRuntime):Promise<MaterialColorRuntimeIdentity> {
  const base:Omit<MaterialColorRuntimeIdentity,"identitySha256">={schema:"editkin.material-color-runtime/v1",status:"verified",tools:[],implementations:[]};
  try {
    const paths=colorToolPaths(runtime);
    for(const role of ["ffmpeg","ffprobe"] as const) {
      const before=await colorFileSha(paths[role]);
      const result=await runColorProcess(paths[role],["-version"],32768,runtime.timeoutMs,runtime.signal);
      const version=result.stdout.toString("utf8").split(/\r?\n/)[0];
      if(!version.startsWith(`${role} version `)||await colorFileSha(paths[role])!==before)throw Error("tool-identity-unverified");
      base.tools.push({role,sha256:before,version});
    }
    Object.assign(base,materialColorCodeIdentity());
  } catch(error) {base.status="unmeasured";base.reason=error instanceof Error?error.message:"runtime-identity-unverified";}
  return {...base,identitySha256:colorDigest(base)};
}
