import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { LongformUiFocusProjectTraceV1, type LongformUiFocusProjectTraceConfigV1, type LongformUiFocusProjectTraceFrameV1 } from "./longformUiFocusProjectTraceV1";
import { LongformUiFocusProjectGeometryTraceV1 } from "../render/longformUiFocusProjectGeometryTraceV1";
import type { LongformUiFocusGeometryWitnessV1 } from "../domain/longformUiFocusProjectGeometryV1";
export interface LongformUiFocusGeometryProcessResultV1 {
  frames:Array<LongformUiFocusProjectTraceFrameV1&{imageSha256:string}>;geometry:LongformUiFocusGeometryWitnessV1[];
  sourceTimestampOffsetPts:number;inputFramesObserved:number;outputFramesObserved:number;droppedSourceFrames:number;duplicatedSourceFrames:number;
  geometryFramesObserved:number;stdoutBytes:number;stderrBytes:number;processStdoutSha256:string;processStderrSha256:string;
}
/** The exact source-clock lane and real geometry lane share one decoded input.
 * Prefix pixels stream away; at most 256 selected hashes/witnesses are retained.
 * Completion/cancellation settles only on the real child close event. */
export function runLongformUiFocusGeometryProcessV1(executable:string,args:string[],config:LongformUiFocusProjectTraceConfigV1,
  mode:LongformUiFocusGeometryWitnessV1['affine']['mode'],selectedFrames:ReadonlySet<number>,signal?:AbortSignal){
  signal?.throwIfAborted();const selected=new Set(selectedFrames);
  return new Promise<LongformUiFocusGeometryProcessResultV1>((resolve,reject)=>{
    const frameBytes=config.width*config.height;
    if(!Number.isSafeInteger(frameBytes)||frameBytes<1||frameBytes>1280**2||!selected.size||selected.size>256
      ||[...selected].some(n=>!Number.isSafeInteger(n)||n<config.timelineStartFrame)){reject(Error('UI_FOCUS_GEOMETRY_PROCESS_CONFIG'));return;}
    const metadata:LongformUiFocusProjectTraceFrameV1[]=[],pixels:Buffer[]=[],frames:LongformUiFocusGeometryProcessResultV1['frames']=[],geometry:LongformUiFocusGeometryWitnessV1[]=[];
    let partial=Buffer.allocUnsafe(frameBytes),partialBytes=0,consumed=0,stdoutBytes=0,stderrBytes=0,carry='',failure:Error|undefined;
    const stdoutHash=createHash('sha256'),stderrHash=createHash('sha256');
    const flush=()=>{while(metadata.length&&pixels.length){const row=metadata.shift()!,gray=pixels.shift()!;
      if(row.frame!==consumed++)throw Error('UI_FOCUS_GEOMETRY_PROCESS_PIPE_ORDER');
      if(selected.has(row.projectFrame))frames.push({...row,imageSha256:createHash('sha256').update(gray).digest('hex')});}};
    const clock=new LongformUiFocusProjectTraceV1(config,row=>{metadata.push(row);
      if(metadata.length>1024)throw Error('UI_FOCUS_GEOMETRY_PROCESS_METADATA_BUDGET');flush();});
    const stages=new LongformUiFocusProjectGeometryTraceV1(config.timelineStartFrame,config.projectTimeBase,mode,row=>{
      if(selected.has(row.projectFrame))geometry.push(row);},config.timelineStartFrame);
    const child=spawn(executable,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
    const stop=(error:Error)=>{failure??=error;child.kill();},abort=()=>stop(Error('analysis-cancelled'));
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const timer=setTimeout(()=>stop(Error('UI_FOCUS_GEOMETRY_PROCESS_TIMEOUT')),180000);
    child.stdout.on('data',(chunk:Buffer)=>{if(failure)return;try{
      stdoutBytes+=chunk.length;if(stdoutBytes>64*1024**3)throw Error('UI_FOCUS_GEOMETRY_PROCESS_STDOUT_BUDGET');stdoutHash.update(chunk);
      let at=0;while(at<chunk.length){const n=Math.min(frameBytes-partialBytes,chunk.length-at);chunk.copy(partial,partialBytes,at,at+n);partialBytes+=n;at+=n;
        if(partialBytes===frameBytes){pixels.push(partial);partial=Buffer.allocUnsafe(frameBytes);partialBytes=0;
          if(pixels.length>32)throw Error('UI_FOCUS_GEOMETRY_PROCESS_PIXELS_BUDGET');flush();}}
    }catch(error){stop(error instanceof Error?error:Error(String(error)));}});
    const line=(value:string)=>{clock.line(value);stages.line(value);};
    child.stderr.on('data',(chunk:Buffer)=>{if(failure)return;try{
      stderrBytes+=chunk.length;if(stderrBytes>256*1024**2)throw Error('UI_FOCUS_GEOMETRY_PROCESS_STDERR_BUDGET');stderrHash.update(chunk);carry+=chunk.toString('utf8');
      let newline:number;while((newline=carry.indexOf('\n'))>=0){line(carry.slice(0,newline).replace(/\r$/,''));carry=carry.slice(newline+1);}
      if(carry.length>65536)throw Error('UI_FOCUS_GEOMETRY_PROCESS_LINE_BUDGET');
    }catch(error){stop(error instanceof Error?error:Error(String(error)));}});
    child.on('error',error=>{failure??=error;});
    child.on('close',(code,terminalSignal)=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(failure){reject(failure);return;}
      try{if(code!==0||terminalSignal)throw Error('UI_FOCUS_GEOMETRY_PROCESS_EXIT_'+code);if(carry)line(carry.replace(/\r$/,''));flush();
        const summary=clock.finish(),observed=stages.finish();
        if(partialBytes||metadata.length||pixels.length||consumed!==summary.outputFramesObserved||stdoutBytes!==consumed*frameBytes
          ||observed.framesObserved!==consumed||frames.length!==selected.size||geometry.length!==selected.size)
          throw Error('UI_FOCUS_GEOMETRY_PROCESS_COVERAGE');
        resolve({frames,geometry,...summary,geometryFramesObserved:observed.framesObserved,stdoutBytes,stderrBytes,
          processStdoutSha256:stdoutHash.digest('hex'),processStderrSha256:stderrHash.digest('hex')});
      }catch(error){reject(error);}});
  });
}
