import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat,realpath} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
async function toolIdentity(path:string){
  if(!isAbsolute(path)||path.startsWith('\\\\'))throw Error('整套調色 LUT 需要已驗證的本機工具。');
  const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>256*1024*1024||(await realpath(path)).toLowerCase()!==path.replaceAll('/','\\').toLowerCase()&&process.platform==='win32')throw Error('整套調色 LUT 需要已驗證的本機工具。');
  const hash=createHash('sha256');for await(const part of createReadStream(path))hash.update(part);return{bytes:info.size,sha256:hash.digest('hex')};
}
/** A single bounded child. Cancellation/errors settle only after its close event; no shell or output file. */
export async function runWholeGradeCubeProcessV1(options:{ffmpegPath:string;ffmpegSha256:string;args:string[];input:Uint8Array;maximumOutput:number;timeoutMs:number;signal?:AbortSignal;onSpawn?:(receipt:{pid:number;startedUtc:string})=>void}){
  options.signal?.throwIfAborted();
  if(!/^[a-f0-9]{64}$/.test(options.ffmpegSha256)||!Number.isSafeInteger(options.maximumOutput)||options.maximumOutput<=0||options.maximumOutput>16*1024*1024||options.input.byteLength>32*1024*1024||!Number.isFinite(options.timeoutMs)||options.timeoutMs<=0||options.timeoutMs>30000)throw Error('整套調色 LUT 工作預算不合法。');
  const before=await toolIdentity(options.ffmpegPath);if(before.sha256!==options.ffmpegSha256)throw Error('整套調色 LUT 工具版本已變更。');options.signal?.throwIfAborted();
  const started=Date.now();
  const result=await new Promise<{bytes:Buffer;stderr:string;pid:number;code:number;closed:true;elapsedMs:number;startedUtc:string}>((resolve,reject)=>{
    const child=spawn(options.ffmpegPath,options.args,{windowsHide:true,stdio:['pipe','pipe','pipe']});
    const chunks:Buffer[]=[];let count=0,stderr='',failure:Error|undefined;const stop=(error:Error)=>{failure??=error;child.kill();};
    const abort=()=>stop(Error('整套調色 LUT 匯出已取消。'));const timer=setTimeout(()=>stop(Error('整套調色 LUT 工作逾時。')),options.timeoutMs);
    child.once('spawn',()=>{try{options.onSpawn?.({pid:child.pid!,startedUtc:new Date(started).toISOString()});}catch(error){stop(error instanceof Error?error:Error(String(error)));}});
    options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
    child.stdout.on('data',(chunk:Buffer)=>{count+=chunk.length;if(count>options.maximumOutput)stop(Error('整套調色 LUT 回讀超過上限。'));else chunks.push(chunk);});
    child.stderr.on('data',(chunk:Buffer)=>{if(Buffer.byteLength(stderr)+chunk.length>131072)stop(Error('整套調色 LUT 診斷超過上限。'));else stderr+=chunk.toString('utf8');});
    child.on('error',error=>{failure??=error;});child.stdin.on('error',error=>stop(error));
    child.once('close',(code,signal)=>{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);const receipt={pid:child.pid??0,code,signal,closed:true,elapsedMs:Date.now()-started,startedUtc:new Date(started).toISOString()};
      if(failure||code!==0)reject(Object.assign(failure??Error('整套調色 LUT 運算失敗。'),{childReceipt:receipt,stderr}));
      else resolve({bytes:Buffer.concat(chunks),stderr,pid:child.pid!,code:0,closed:true,elapsedMs:receipt.elapsedMs,startedUtc:receipt.startedUtc});});
    // Node's pipe performs bounded backpressure; one atlas is retained until end, not per-frame buffers.
    child.stdin.end(options.input);
  });
  const after=await toolIdentity(options.ffmpegPath);if(after.sha256!==before.sha256)throw Error('整套調色 LUT 工具版本已變更。');
  return{...result,executableBefore:before,executableAfter:after};
}
