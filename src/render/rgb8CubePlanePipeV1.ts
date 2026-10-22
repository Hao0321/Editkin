import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat,realpath} from 'node:fs/promises';
import {isAbsolute,resolve,dirname} from 'node:path';
export interface Rgb8PlanePipeOptionsV1 {ffmpegPath:string;ffmpegSha256:string;args:string[];size:number;blueIndices?:readonly number[];timeoutMs:number;signal?:AbortSignal;onSpawn?:(value:{pid:number;startedUtc:string})=>void;onReceipt?:(value:Rgb8PlanePipeReceiptV1)=>void}
export interface Rgb8PlanePipeReceiptV1 {pid:number;startedUtc:string;code:number|null;signal:string|null;closed:true;inputFrames:number;outputFrames:number;inputBytes:number;outputBytes:number;inputSha256:string;outputSha256:string;stderr:string;elapsedMs:number;executableBefore:{bytes:number;sha256:string};executableAfter?:{bytes:number;sha256:string}}
async function identity(path:string){
  if(!isAbsolute(path)||path.startsWith('\\\\'))throw Error('RGB8 調色程序需要已驗證的本機工具。');
  for(let p=resolve(path);;p=dirname(p)){const info=await lstat(p);if(info.isSymbolicLink())throw Error('RGB8 調色程序需要已驗證的本機工具。');if(p===dirname(p))break;}
  const info=await lstat(path);if(!info.isFile()||info.size>256*1024*1024||resolve(await realpath(path)).toLowerCase()!==resolve(path).toLowerCase())throw Error('RGB8 調色程序需要已驗證的本機工具。');
  const stream=createReadStream(path),hash=createHash('sha256'),timer=setTimeout(()=>stream.destroy(Error('RGB8 調色程序逾時。')),30000);
  try{for await(const block of stream)hash.update(block);return{bytes:info.size,sha256:hash.digest('hex')};}finally{clearTimeout(timer);stream.destroy();}
}
export function* rgb8InputPlanesV1(size:number,blueIndices:readonly number[]){
  if(!Number.isInteger(size)||size<2||size>256||!blueIndices.length||blueIndices.length>256||blueIndices.some(b=>!Number.isInteger(b)||b<0||b>=size))throw Error('RGB8 調色色片參數不合法。');
  for(const blue of blueIndices){const plane=new Uint8Array(size*size*3);for(let g=0;g<size;g++)for(let r=0;r<size;r++){const i=(g*size+r)*3;plane[i]=Math.round(r*255/(size-1));plane[i+1]=Math.round(g*255/(size-1));plane[i+2]=Math.round(blue*255/(size-1));}yield plane;}
}
/** One native child with simultaneous bounded stdin/stdout. Starting is lazy; returning
 * the consumer iterator kills only this child and waits for close before its file owner cleans staging. */
export async function* rgb8CubePlanePipeV1(options:Rgb8PlanePipeOptionsV1):AsyncGenerator<Uint8Array>{
  options.signal?.throwIfAborted();const blue=options.blueIndices?[...options.blueIndices]:Array.from({length:options.size},(_,i)=>i);
  if(!Number.isInteger(options.size)||options.size<2||options.size>256||!Number.isFinite(options.timeoutMs)||options.timeoutMs<=0||options.timeoutMs>120000||!/^[a-f0-9]{64}$/.test(options.ffmpegSha256)||!blue.length||blue.length>256||blue.some(b=>!Number.isInteger(b)||b<0||b>=options.size))throw Error('RGB8 調色色片參數不合法。');
  const before=await identity(options.ffmpegPath);if(before.sha256!==options.ffmpegSha256)throw Error('RGB8 調色工具版本已變更。');options.signal?.throwIfAborted();
  const started=Date.now(),child=spawn(options.ffmpegPath,options.args,{windowsHide:true,stdio:['pipe','pipe','pipe']}),frameBytes=options.size*options.size*3,expectedBytes=frameBytes*blue.length;
  let failure:Error|undefined,completed=false,inputFrames=0,outputFrames=0,inputBytes=0,outputBytes=0,stderr='',terminal:{code:number|null;signal:string|null}|undefined,after:{bytes:number;sha256:string}|undefined;
  const inputHash=createHash('sha256'),outputHash=createHash('sha256'),stop=(error:Error)=>{failure??=error;child.kill();},abort=()=>stop(Error('RGB8 調色匯出已取消。'));
  const closed=new Promise<void>(resolve=>child.once('close',(code,signal)=>{terminal={code,signal};resolve();}));
  child.on('error',error=>{failure??=error;});child.stdin.on('error',error=>stop(error));
  child.stderr.on('data',(block:Buffer)=>{if(Buffer.byteLength(stderr)+block.length>131072)stop(Error('RGB8 調色診斷超過上限。'));else stderr+=block.toString('utf8');});
  child.once('spawn',()=>{try{options.onSpawn?.({pid:child.pid!,startedUtc:new Date(started).toISOString()});}catch(error){stop(error instanceof Error?error:Error(String(error)));}});
  options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();const timer=setTimeout(()=>stop(Error('RGB8 調色程序逾時。')),options.timeoutMs);
  const drain=()=>new Promise<void>((resolve,reject)=>{
    const finish=(error?:Error)=>{child.stdin.off('drain',ready);child.stdin.off('error',failed);child.stdin.off('close',ended);error?reject(error):resolve();};
    const ready=()=>finish(),failed=(error:Error)=>finish(error),ended=()=>finish(failure??Error('RGB8 調色色片回讀不完整。'));
    child.stdin.once('drain',ready);child.stdin.once('error',failed);child.stdin.once('close',ended);if(child.stdin.destroyed||terminal)ended();
  });
  const pump=(async()=>{for(const plane of rgb8InputPlanesV1(options.size,blue)){if(failure)throw failure;options.signal?.throwIfAborted();inputHash.update(plane);inputBytes+=plane.byteLength;inputFrames++;if(!child.stdin.write(plane))await drain();}child.stdin.end();})().catch(error=>stop(error instanceof Error?error:Error(String(error))));
  let frame=new Uint8Array(frameBytes),used=0;
  try{
    for await(const raw of child.stdout){const block=raw as Buffer;outputBytes+=block.length;if(outputBytes>expectedBytes){stop(Error('RGB8 調色色片回讀超過上限。'));throw failure;}
      outputHash.update(block);let offset=0;while(offset<block.length){const take=Math.min(frameBytes-used,block.length-offset);frame.set(block.subarray(offset,offset+take),used);used+=take;offset+=take;if(used===frameBytes){outputFrames++;yield frame;frame=new Uint8Array(frameBytes);used=0;}if(failure)throw failure;options.signal?.throwIfAborted();}
    }
    await closed;await pump;if(failure)throw failure;if(terminal?.code!==0)throw Error('RGB8 調色程序失敗。');
    if(used||outputBytes!==expectedBytes||outputFrames!==blue.length||inputFrames!==blue.length)throw Error('RGB8 調色色片回讀不完整。');
    after=await identity(options.ffmpegPath);if(after.sha256!==before.sha256)throw Error('RGB8 調色工具版本已變更。');completed=true;
  }finally{
    if(!completed&&!terminal)stop(failure??Error('RGB8 調色匯出已取消。'));await closed;await pump;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);
    const receipt:Rgb8PlanePipeReceiptV1={pid:child.pid??0,startedUtc:new Date(started).toISOString(),...terminal!,closed:true,inputFrames,outputFrames,inputBytes,outputBytes,inputSha256:inputHash.digest('hex'),outputSha256:outputHash.digest('hex'),stderr,elapsedMs:Date.now()-started,executableBefore:before,...(after?{executableAfter:after}:{})};options.onReceipt?.(receipt);
  }
}
