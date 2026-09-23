import { extname,isAbsolute } from "node:path";
import { DEFAULT_COLOR_MANAGEMENT, type MediaAsset } from "../domain/types";
import { analyzeShotColor, type ShotColorFrame } from "../color/shotColorAnalysis";
import { compositorSourceColorPlan } from "../render/sourceColorFilters";
import { colorBytesSha,colorDigest,colorFileSha,colorToolPaths,getMaterialColorRuntimeIdentity,runColorProcess } from "./materialColorSamplingRuntime";
import { materialColorRequestSnapshot,validateMaterialColorRequest,verifyMaterialColorReceipt } from "./materialColorSamplingValidation";
import type { MaterialColorReceipt,MaterialColorRequest,MaterialColorRuntime,MaterialColorRuntimeIdentity } from "./materialColorSamplingTypes";
import { sourceDisplayColorMetadata } from "./sourceDisplayMetadata";
import { sourceDisplayFrame } from "./sourceDisplayFrame";
export type * from "./materialColorSamplingTypes";
export { getMaterialColorRuntimeIdentity,verifyMaterialColorReceipt,materialColorRequestSnapshot };

export async function sampleMaterialColor(inputRequest:MaterialColorRequest,runtime:MaterialColorRuntime,expectedIdentity?:MaterialColorRuntimeIdentity):Promise<MaterialColorReceipt> {
  validateMaterialColorRequest(inputRequest);
  const request=structuredClone(inputRequest);
  const requestSnapshot=materialColorRequestSnapshot(request);
  const identity=await getMaterialColorRuntimeIdentity(runtime);
  if(expectedIdentity&&colorDigest(expectedIdentity)!==colorDigest(identity))throw Error("runtime-identity-drift");
  const receipt:MaterialColorReceipt={schema:"editkin.material-color-receipt/v1",status:"unmeasured",reason:"not-sampled",receiptSha256:"",identity,request:requestSnapshot,
    source:{sha256:request.sourceSha256,start:request.sourceStart,duration:request.duration},
    coverage:{requestedCount:request.samples.length,sampledCount:0,sceneCount:request.sceneCount,sceneCountVerified:request.sceneCountVerified??false,sceneAttributionVerified:request.sceneCuts!==undefined,...(request.sceneCuts!==undefined?{sceneCuts:request.sceneCuts}:{}),sampledSceneIndices:[],omittedSceneIndices:Array.from({length:request.sceneCount},(_,n)=>n)},mapping:[]};
  const finish=(status:"unmeasured"|"not_applicable"|"measured",reason?:string,measurements?:ReturnType<typeof analyzeShotColor>):MaterialColorReceipt=>{
    const scenes=[...new Set(receipt.mapping.map(m=>m.sceneIndex))].sort((a,b)=>a-b);
    const result={...receipt,status,...(status==="measured"?{measurements}:{reason:reason??"sampling-failed"}),coverage:{...receipt.coverage,sampledCount:receipt.mapping.length,sampledSceneIndices:scenes,omittedSceneIndices:Array.from({length:request.sceneCount},(_,n)=>n).filter(n=>!scenes.includes(n))}} as MaterialColorReceipt;
    if(status==="measured")delete (result as unknown as Record<string,unknown>).reason;
    result.receiptSha256=colorDigest({...result,receiptSha256:undefined});verifyMaterialColorReceipt(result);return result;
  };
  if(request.kind==="audio")return finish("not_applicable","audio-has-no-color-surface");
  try {
    if(identity.status!=="verified")throw Error("runtime-identity-unverified");
    if(!isAbsolute(request.sourcePath)||[".exr",".json"].includes(extname(request.sourcePath).toLowerCase()))throw Error("unsupported-source-container");
    const management=request.colorManagement??DEFAULT_COLOR_MANAGEMENT;
    if(management.mode!=="rec709"||management.outputTransform!=="rec709_sdr")throw Error("non-rec709-analysis-output");
    receipt.source.beforeSha256=await colorFileSha(request.sourcePath);
    if(receipt.source.beforeSha256!==request.sourceSha256)throw Error("source-sha-mismatch");
    const tools=colorToolPaths(runtime),timeout=Math.min(30000,Math.max(1,runtime.timeoutMs??30000)),deadline=Date.now()+120000;
    const probeResult=await runColorProcess(tools.ffprobe,["-v","error","-show_streams","-show_format","-of","json",request.sourcePath],131072,timeout,runtime.signal);
    const probe=JSON.parse(probeResult.stdout.toString("utf8"));
    const streams=Array.isArray(probe.streams)?probe.streams.filter((s:Record<string,unknown>)=>s.codec_type==="video"):[];
    if(streams.length!==1)throw Error("single-video-stream-required");
    const stream=streams[0] as Record<string,unknown>;
    const origin=Number(probe.format?.start_time??stream.start_time);
    if(!Number.isFinite(origin))throw Error("source-timeline-origin-unverified");
    receipt.probe={sha256:colorBytesSha(probeResult.stdout),metadata:{stream,format:probe.format},timelineOrigin:origin};
    const verifiedColor=sourceDisplayColorMetadata(stream,request.color),input=verifiedColor.interpretation as "rec709"|"hlg"|"pq";
    const width=Number(stream.width),height=Number(stream.height);
    if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>32768||height>32768)throw Error("invalid-source-dimensions");
    const asset:MediaAsset={id:"color-reference",name:"neutral-color-reference",uri:request.sourcePath,kind:request.kind,duration:request.duration,color:verifiedColor};
    const filters=[...compositorSourceColorPlan(asset,Math.min(256,width),Math.min(256,height),"rgba",255,management,undefined,0).filters,"format=rgb24"];
    receipt.normalization={interpretation:input,filters,format:"rgb8",transfer:"bt709-oetf",primaries:"bt709",range:"full",exposure:0,creativeLook:false};
    const frames:ShotColorFrame[]=[];let totalPixels=0;
    for(const sample of request.samples) {
      const remaining=deadline-Date.now();if(remaining<=0)throw Error("sampling-time-budget");
      const target=request.sourceStart+sample.time;
      // copyts preserves the decoded source timestamp; select guards keyframe
      // seek differences. Never substitute the requested seek time for the PTS.
      const vf=[`select='gte(t,${origin+target})'`,...filters,"showinfo"].join(",");
      const result=await runColorProcess(tools.ffmpeg,["-hide_banner","-loglevel","info","-nostdin","-copyts","-ss",String(target),"-i",request.sourcePath,"-map","0:v:0","-an","-vf",vf,"-frames:v","1","-fps_mode","passthrough","-pix_fmt","rgb24","-f","rawvideo","pipe:1"],256*256*3,Math.min(timeout,remaining),runtime.signal);
      const decoded=sourceDisplayFrame(result.stderr,origin,request.sourceStart,request.duration,sample.time,256);
      const {pts,timeBase:{numerator,denominator},sourceTime,relativeTime,width:w,height:h}=decoded;
      if(result.stdout.length!==w*h*3)throw Error("truncated-or-invalid-rgb-surface");
      totalPixels+=w*h;if(totalPixels>786432)throw Error("rgb-pixel-budget");
      const sceneIndex=request.sceneCuts?.filter(cut=>relativeTime>=cut).length??sample.sceneIndex;
      receipt.mapping.push({id:sample.id,sceneIndex,requestedSceneIndex:sample.sceneIndex,requestedTime:sample.time,decodedPts:pts,timeBase:{numerator,denominator},decodedSourceTime:sourceTime,decodedRelativeTime:relativeTime,width:w,height:h,rawRgbSha256:colorBytesSha(result.stdout)});
      if(frames.some(f=>f.timeSeconds===relativeTime))throw Error("duplicate-decoded-frame");
      frames.push({sampleId:sample.id,timeSeconds:relativeTime,width:w,height:h,format:"rgb8",primaries:"bt709",transfer:"bt709-oetf",range:"full",pixels:result.stdout});
    }
    receipt.source.afterSha256=await colorFileSha(request.sourcePath);
    if(receipt.source.afterSha256!==request.sourceSha256)throw Error("source-drift");
    const finalIdentity=await getMaterialColorRuntimeIdentity(runtime);
    if(finalIdentity.identitySha256!==identity.identitySha256)throw Error("runtime-identity-drift");
    return finish("measured",undefined,analyzeShotColor(frames));
  } catch(error) {
    if(error instanceof Error&&error.message==="runtime-identity-drift")throw error;
    if(identity.status==="verified"&&colorDigest(await getMaterialColorRuntimeIdentity(runtime))!==colorDigest(identity))throw Error("runtime-identity-drift");
    if(receipt.source.beforeSha256)try {receipt.source.afterSha256=await colorFileSha(request.sourcePath);}catch{/* failed source remains explicitly unverified */}
    const reason=error instanceof Error&&/^[a-z][a-z0-9-]+$/.test(error.message)?error.message:"sampling-failed";
    return finish("unmeasured",reason);
  }
}
