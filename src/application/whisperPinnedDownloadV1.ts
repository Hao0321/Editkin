import {createHash,randomUUID} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {lstat,open,realpath,mkdir,link,unlink} from 'node:fs/promises';
import {request as httpsRequest} from 'node:https';
import {basename,join,resolve} from 'node:path';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import type {WhisperModelDescriptor} from './automaticCaptions';
export interface PinnedModelInspectionV1 {exists:boolean;valid:boolean;bytes:number;sha256:string}
export interface PinnedModelDownloadRuntimeV1 {modelRoot:string;modelPath?:string;signal?:AbortSignal}
export interface PinnedModelDownloadDepsV1 {stream:(url:URL,maximumBytes:number,signal:AbortSignal)=>Promise<Readable>}
function validatePin(pin:WhisperModelDescriptor){
 const url=new URL(pin.url);if(url.protocol!=='https:'||url.username||url.password)throw Error('WHISPER_MODEL_URL_INVALID');
 if(!/^[a-z0-9][a-z0-9._-]{2,100}$/i.test(pin.fileName)||basename(pin.fileName)!==pin.fileName||!Number.isSafeInteger(pin.bytes)||pin.bytes<1||pin.bytes>2*1024*1024*1024||!/^[a-f0-9]{64}$/.test(pin.sha256))throw Error('WHISPER_MODEL_PIN_INVALID');
}
const samePath=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
export async function inspectPinnedModelFileV1(path:string,pin:WhisperModelDescriptor,signal?:AbortSignal):Promise<PinnedModelInspectionV1>{
 validatePin(pin);signal?.throwIfAborted();const absolute=resolve(path);let before;
 try{before=await lstat(absolute);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {exists:false,valid:false,bytes:0,sha256:''};throw error;}
 if(!before.isFile()||before.isSymbolicLink()||!samePath(await realpath(absolute),absolute))throw Error('WHISPER_MODEL_ALIAS_OR_TYPE');
 if(before.size!==pin.bytes)return {exists:true,valid:false,bytes:before.size,sha256:''};
 const handle=await open(absolute,'r');try{const first=await handle.stat();if(!first.isFile()||first.size!==before.size||first.ino!==before.ino)throw Error('WHISPER_MODEL_READ_DRIFT');
  const digest=createHash('sha256'),buffer=Buffer.allocUnsafe(4*1024*1024);let position=0;
  while(position<first.size){signal?.throwIfAborted();const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,first.size-position),position);if(bytesRead===0)throw Error('WHISPER_MODEL_READ_DRIFT');digest.update(buffer.subarray(0,bytesRead));position+=bytesRead;}
  signal?.throwIfAborted();const after=await handle.stat();if(first.size!==after.size||first.mtimeMs!==after.mtimeMs||first.ctimeMs!==after.ctimeMs||first.ino!==after.ino)throw Error('WHISPER_MODEL_READ_DRIFT');const sha256=digest.digest('hex');return {exists:true,valid:sha256===pin.sha256,bytes:position,sha256};
 }finally{await handle.close();}
}
async function httpsModelStreamV1(url:URL,maximumBytes:number,signal:AbortSignal,redirects=0):Promise<Readable>{
 signal.throwIfAborted();if(redirects>6||url.protocol!=='https:'||url.username||url.password)throw Error('WHISPER_MODEL_REDIRECT_INVALID');
 return new Promise((accept,reject)=>{const request=httpsRequest(url,{signal,headers:{'user-agent':'Editkin-local-model/1'}},response=>{
  const status=response.statusCode??0;if([301,302,303,307,308].includes(status)){const location=response.headers.location;response.destroy();if(!location){reject(Error('WHISPER_MODEL_REDIRECT_MISSING'));return;}httpsModelStreamV1(new URL(location,url),maximumBytes,signal,redirects+1).then(accept,reject);return;}
  if(status!==200){response.destroy();reject(Error('WHISPER_MODEL_DOWNLOAD_HTTP_'+status));return;}
  const declared=Number(response.headers['content-length']??0);if(!Number.isSafeInteger(declared)||declared<0||declared>maximumBytes){response.destroy();reject(Error('WHISPER_MODEL_DOWNLOAD_SIZE'));return;}accept(response);
 });request.once('error',reject);request.setTimeout(60000,()=>request.destroy(Error('WHISPER_MODEL_DOWNLOAD_STALLED')));request.end();});
}
const production:PinnedModelDownloadDepsV1={stream:httpsModelStreamV1};
/** Only fixed descriptor callers admit a model. Generic byte pins allow a
 * tiny owned transport fixture to exercise actual disk publication controls.
 * Existing invalid destinations and explicitly configured paths are preserved. */
export async function ensurePinnedModelFileV1(runtime:PinnedModelDownloadRuntimeV1,pin:WhisperModelDescriptor,downloadIfMissing=true,deps:PinnedModelDownloadDepsV1=production):Promise<{path:string;downloaded:boolean}>{
 validatePin(pin);runtime.signal?.throwIfAborted();const configured=runtime.modelPath?.trim(),root=resolve(runtime.modelRoot),destination=configured?resolve(configured):join(root,pin.fileName);
 const existing=await inspectPinnedModelFileV1(destination,pin,runtime.signal);if(existing.valid)return {path:destination,downloaded:false};
 if(existing.exists||configured)throw Error('WHISPER_MODEL_CONFIGURED_OR_EXISTING_PIN_INVALID');if(!downloadIfMissing)throw Error('WHISPER_MODEL_MISSING_DOWNLOAD_DISABLED');
 await mkdir(root,{recursive:true});const rootStat=await lstat(root);if(!rootStat.isDirectory()||rootStat.isSymbolicLink()||!samePath(await realpath(root),root))throw Error('WHISPER_MODEL_ROOT_ALIAS');
 const temporary=join(root,'.'+pin.fileName+'.'+process.pid+'.'+randomUUID()+'.download'),deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(Error('WHISPER_MODEL_DOWNLOAD_TIMEOUT')),15*60*1000);
 const signal=runtime.signal?AbortSignal.any([runtime.signal,deadline.signal]):deadline.signal;let created=false;
 try{const input=await deps.stream(new URL(pin.url),pin.bytes,signal);if(signal.aborted){input.destroy();signal.throwIfAborted();}let received=0;
  const limiter=new Transform({transform(chunk:Buffer,_encoding,callback){received+=chunk.length;if(received>pin.bytes)callback(Error('WHISPER_MODEL_DOWNLOAD_SIZE'));else callback(null,chunk);}});
  const output=createWriteStream(temporary,{flags:'wx',mode:0o600});output.once('open',()=>{created=true;});await pipeline(input,limiter,output,{signal});
  const downloaded=await inspectPinnedModelFileV1(temporary,pin,signal);if(!downloaded.valid)throw Error('WHISPER_MODEL_DOWNLOAD_PIN_MISMATCH');
  const handle=await open(temporary,'r+');try{await handle.sync();}finally{await handle.close();}signal.throwIfAborted();
  if(!samePath(await realpath(root),root))throw Error('WHISPER_MODEL_ROOT_CHANGED');
  try{await link(temporary,destination);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||!(await inspectPinnedModelFileV1(destination,pin,signal)).valid)throw error;}
  if(!(await inspectPinnedModelFileV1(destination,pin,signal)).valid)throw Error('WHISPER_MODEL_PUBLISHED_PIN_INVALID');
  return {path:destination,downloaded:true};
 }finally{clearTimeout(timer);if(created){if(!samePath(await realpath(root),root))throw Error('WHISPER_MODEL_PARTIAL_ROOT_CHANGED');await unlink(temporary);}}
}
