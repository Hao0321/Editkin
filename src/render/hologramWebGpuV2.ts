import {validateHologramFrameV2,type HologramFrameInputV2} from "../domain/hologramMaterialV2";
import {hologramParametersV2} from "./hologramMaterialV2";
import {HOLOGRAM_SHADER_V2} from "./hologramShaderV2";

interface BufferV2{mapAsync(mode:number):Promise<void>;getMappedRange():ArrayBuffer;unmap():void;destroy():void}
interface ShaderV2{getCompilationInfo():Promise<{messages:readonly{type:string;message:string}[]}>}
interface PipelineV2{getBindGroupLayout(index:number):unknown}
interface EncoderV2{beginComputePass():{setPipeline(p:PipelineV2):void;setBindGroup(index:number,g:unknown):void;dispatchWorkgroups(x:number):void;end():void};copyBufferToBuffer(a:BufferV2,aOffset:number,b:BufferV2,bOffset:number,bytes:number):void;finish():unknown}
export interface HologramGpuDeviceV2{
  limits:{maxStorageBuffersPerShaderStage:number;maxStorageBufferBindingSize:number;maxBufferSize:number;maxComputeWorkgroupsPerDimension:number};
  lost:Promise<{message:string}>;
  queue:{writeBuffer(b:BufferV2,offset:number,data:Uint32Array|Float32Array):void;submit(commands:unknown[]):void;onSubmittedWorkDone():Promise<void>};
  createShaderModule(options:{code:string}):ShaderV2;
  createComputePipelineAsync(options:{layout:string;compute:{module:ShaderV2;entryPoint:string}}):Promise<PipelineV2>;
  createBuffer(options:{size:number;usage:number}):BufferV2;
  createBindGroup(options:{layout:unknown;entries:{binding:number;resource:{buffer:BufferV2}}[]}):unknown;
  createCommandEncoder():EncoderV2;
  pushErrorScope(filter:string):void;popErrorScope():Promise<{message:string}|null>;
}
const deviceStates=new WeakMap<HologramGpuDeviceV2,{active:boolean;lost:boolean;poisoned:boolean}>();
function stateFor(device:HologramGpuDeviceV2){
  let state=deviceStates.get(device);if(!state){state={active:false,lost:false,poisoned:false};deviceStates.set(device,state);const captured=state;void device.lost.then(()=>{captured.lost=true;});}return state;
}
async function boundedGpuWaitV2<T>(operation:Promise<T>,state:{poisoned:boolean}):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{state.poisoned=true;reject(Error("HOLOGRAM_V2_GPU_TIMEOUT"));},30000);})]);}
  finally{if(timer)clearTimeout(timer);}
}

/** Caller owns the adapter/device. No fake CPU fallback, filesystem staging, or device destruction. */
export async function renderHologramWebGpuV2(device:HologramGpuDeviceV2,input:HologramFrameInputV2,signal?:AbortSignal){
  const material=validateHologramFrameV2(input),owned={...input,material,coverage:input.coverage.slice(),baseLinearRgba:input.baseLinearRgba.slice()},n=input.width*input.height,workgroups=Math.ceil(n/64);
  if(device.limits.maxStorageBuffersPerShaderStage<8||n*16>device.limits.maxStorageBufferBindingSize||n*16>device.limits.maxBufferSize||workgroups>device.limits.maxComputeWorkgroupsPerDimension)throw Error("HOLOGRAM_V2_GPU_LIMIT");
  const check=()=>{if(signal?.aborted)throw Error("HOLOGRAM_V2_CANCELLED");};check();
  const state=stateFor(device);if(state.active||state.lost||state.poisoned)throw Error("HOLOGRAM_V2_GPU_BUSY_LOST_OR_TIMED_OUT");state.active=true;
  const wait=<T>(operation:Promise<T>)=>boundedGpuWaitV2(operation,state);
  const buffers:BufferV2[]=[];let submitted=false,finished=false,mapped=false,scopeOpen=false;
  const create=(bytes:number,usage:number)=>{const b=device.createBuffer({size:bytes,usage});buffers.push(b);return b;};
  try{
    device.pushErrorScope("validation");scopeOpen=true;
    const shader=device.createShaderModule({code:HOLOGRAM_SHADER_V2}),info=await wait(shader.getCompilationInfo());check();
    const errors=info.messages.filter(m=>m.type==="error");if(errors.length)throw Error(`HOLOGRAM_V2_SHADER_INVALID: ${errors.map(m=>m.message).join("; ")}`);
    const pipelines=[];for(const entryPoint of ["horizontal","vertical","composite"]){pipelines.push(await wait(device.createComputePipelineAsync({layout:"auto",compute:{module:shader,entryPoint}})));check();}
    const storage=128,copyDst=8,copySrc=4,mapRead=1;
    const sizes=[n*4,n*16,n*4,n*4,n*4,n*4,n*16,80];
    const entries=sizes.map((bytes,i)=>({binding:i,resource:{buffer:create(bytes,storage|copyDst|(i===6?copySrc:0))}}));
    const readback=create(n*16,mapRead|copyDst),encoder=device.createCommandEncoder();
    device.queue.writeBuffer(entries[0].resource.buffer,0,owned.coverage);device.queue.writeBuffer(entries[1].resource.buffer,0,owned.baseLinearRgba);device.queue.writeBuffer(entries[7].resource.buffer,0,hologramParametersV2(owned));
    for(const pipeline of pipelines){
      // Auto layouts omit unused bindings. Each entry point has its exact binding subset.
      const needed=pipeline===pipelines[0]?[0,2,3,7]:pipeline===pipelines[1]?[2,3,4,5,7]:[0,1,4,5,6,7];
      const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:entries.filter(e=>needed.includes(e.binding))});
      const pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(workgroups);pass.end();
    }
    encoder.copyBufferToBuffer(entries[6].resource.buffer,0,readback,0,n*16);check();device.queue.submit([encoder.finish()]);submitted=true;
    await wait(device.queue.onSubmittedWorkDone());finished=true;check();if(state.lost)throw Error("HOLOGRAM_V2_GPU_LOST");
    const validation=await wait(device.popErrorScope());scopeOpen=false;if(validation)throw Error(`HOLOGRAM_V2_GPU_VALIDATION: ${validation.message}`);
    await wait(readback.mapAsync(mapRead));mapped=true;check();const output=new Float32Array(readback.getMappedRange()).slice();readback.unmap();mapped=false;
    return{output,receipt:{schema:"editkin.hologram-gpu-receipt/v2" as const,renderer:"actual WGSL compute" as const,width:input.width,height:input.height,frame:input.frame,fps:input.fps,logicalBufferBytes:sizes.reduce((a,b)=>a+b,0)+n*16,qualityState:"ART_PENDING_CLAUDE" as const,defaultEnabled:false as const,nativeIntegrated:false as const}};
  }finally{
    if(submitted&&!finished&&!state.poisoned)await wait(device.queue.onSubmittedWorkDone()).catch(()=>undefined);
    if(mapped)buffers.at(-1)?.unmap();
    if(scopeOpen&&!state.poisoned)await wait(device.popErrorScope()).catch(()=>null);
    try{for(const b of buffers)b.destroy();}finally{state.active=false;}
  }
}
