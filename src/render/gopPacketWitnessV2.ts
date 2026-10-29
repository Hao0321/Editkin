import{createHash}from"node:crypto";
import{parseSourcePacketV1,packetTimeKeyV1,type SourcePacketV1,type PacketTimebaseV1,type witnessAvcPacketV1}from"./sourcePacketV1";

export interface GopSourcePacketV2 extends SourcePacketV1{discard:boolean}
export function parseGopSourcePacketV2(line:string):GopSourcePacketV2{
 const match=/(?:^|\|)flags=([KD_]+)(?:\r)?$/.exec(line);
 if(!match)throw Error("GOP_PACKET_FLAGS_UNKNOWN");
 const normalized=line.replace(/flags=[KD_]+(?=\r?$)/,"flags="+match[1].replace(/D/g,"_"));
 return{...parseSourcePacketV1(normalized),discard:match[1].includes("D")};
}
export interface GopPacketLimitsV2{maxPrerollTicks:number;maxReorderTicks:number;maxPendingPackets:number;maxGopPackets:number}
function coverage(anchor:number,limits:GopPacketLimitsV2){let end=anchor,packets=0,peak=0;const pending=new Map<number,number>();
 return{accept(p:GopSourcePacketV2){if(p.pts<end||pending.has(p.pts))throw Error("GOP_PRESENTATION_DUPLICATE_OR_CROSS_ANCHOR");pending.set(p.pts,p.duration);peak=Math.max(peak,pending.size);if(peak>limits.maxPendingPackets||++packets>limits.maxGopPackets)throw Error("GOP_REORDER_OR_PACKET_LIMIT");
  while(pending.has(end)){const duration=pending.get(end)!;pending.delete(end);end+=duration;if(!Number.isSafeInteger(end))throw Error("GOP_PRESENTATION_TICKS_UNSAFE");}},
 finish(boundary:number){if(pending.size||end!==boundary)throw Error("GOP_PRESENTATION_GAP_OR_INCOMPLETE_DEPENDENCY");},
 get end(){return end;},get completePrefix(){return pending.size===0;},get peak(){return peak;},get packets(){return packets;}};
}
/** Full raw prefix since the closest preceding IDR, with bounded presentation reorder and no shifted cut. */
export function gopPacketWindowV2(start:number,end:number,timebase:PacketTimebaseV1,mode:"source"|"output",limits:GopPacketLimitsV2){
 if(![start,end,limits.maxPrerollTicks,limits.maxReorderTicks,limits.maxPendingPackets,limits.maxGopPackets].every(Number.isSafeInteger)
  ||start<0||end<=start||limits.maxPrerollTicks<0||limits.maxReorderTicks<1||limits.maxPendingPackets<1||limits.maxPendingPackets>64||limits.maxGopPackets<1||limits.maxGopPackets>8192
  ||(mode!=="source"&&mode!=="output")||(mode==="output"&&start!==0))throw Error("GOP_WINDOW_OR_LIMIT_INVALID");
 const tb={...timebase};packetTimeKeyV1(0,tb);const cap={...limits};let cover:ReturnType<typeof coverage>|undefined,digest:ReturnType<typeof createHash>|undefined,anchor:number|undefined;
 let selected=0,total=0,complete=false,startSeen=false,lastDts:number|undefined,peak=0,failure:unknown,finished=false;
 const guard=(run:()=>void)=>{if(failure!==undefined)throw failure;if(finished)throw Error("GOP_WITNESS_ALREADY_FINISHED");try{run();}catch(e){failure=e;throw e;}};
 return{accept(p:GopSourcePacketV2,w:Awaited<ReturnType<typeof witnessAvcPacketV1>>){guard(()=>{
  if(![p.pts,p.dts,p.duration,p.pos,p.size,p.pts+p.duration,p.pos+p.size,p.pts-p.dts].every(Number.isSafeInteger)||p.duration<1||p.pos<0||p.size<1
   ||Math.abs(p.pts-p.dts)>cap.maxReorderTicks||lastDts!==undefined&&p.dts<=lastDts)throw Error("GOP_PACKET_CLOCK_OR_RANGE_UNSUPPORTED");
  if(!/^[a-f0-9]{64}$/.test(w.payloadSha256)||w.bytes!==p.size||typeof w.idr!=="boolean"||p.key!==w.idr)throw Error("GOP_IDR_OR_PAYLOAD_WITNESS_MISMATCH");
  if(mode==="source"&&(p.pts<0||p.discard)||mode==="output"&&p.discard!==(p.pts<0))throw Error("GOP_PACKET_PRESENTATION_DISCARD_UNKNOWN");
  lastDts=p.dts;total++;if(!Number.isSafeInteger(total))throw Error("GOP_PACKET_COUNT_UNSAFE");
  if(w.idr){
   cover?.finish(p.pts);peak=Math.max(peak,cover?.peak??0);
   if(!cover&&(mode==="source"?p.pts!==0:p.pts>0||-p.pts>cap.maxPrerollTicks))throw Error("GOP_SOURCE_ORIGIN_OR_PREROLL_UNKNOWN");
   cover=coverage(p.pts,cap);
   if(mode==="source"&&p.pts<=start&&!complete||mode==="output"&&anchor===undefined){anchor=p.pts;digest=createHash("sha256");selected=0;startSeen=false;}
  }else if(!cover)throw Error("GOP_FIRST_PACKET_NOT_TRUE_IDR");
  cover!.accept(p);peak=Math.max(peak,cover!.peak);
  if(mode==="output"||!complete){
   if(anchor===undefined||!digest)throw Error("GOP_SELECTED_ANCHOR_MISSING");
   if(p.pts>=end)throw Error("GOP_END_REQUIRES_POSTROLL_OR_BOUNDARY_RENDER");
   const clock=[packetTimeKeyV1(p.pts-start,tb),packetTimeKeyV1(p.dts-start,tb),packetTimeKeyV1(p.duration,tb),p.size,p.key?1:0].join(",");
   digest.update(clock+"\n");digest.update(w.payloadSha256+"\n");selected++;startSeen ||= p.pts===start;if(!Number.isSafeInteger(selected))throw Error("GOP_PACKET_COUNT_UNSAFE");
   if(cover!.end===end&&cover!.completePrefix){if(!startSeen)throw Error("GOP_START_NOT_EXACT_PRESENTATION_FRAME");if(start-anchor>cap.maxPrerollTicks)throw Error("GOP_PREROLL_LIMIT");complete=true;}
  }
 });},finish(sourceEndTicks:number){guard(()=>{
  if(!Number.isSafeInteger(sourceEndTicks)||sourceEndTicks<=0)throw Error("GOP_SOURCE_END_UNKNOWN");cover?.finish(sourceEndTicks);
  if(!complete||!selected||anchor===undefined||!digest)throw Error("GOP_SELECTED_DEPENDENCY_PREFIX_INCOMPLETE");
 });finished=true;
 return{rawStartTicks:anchor!,rawEndTicks:end,requestedStartTicks:start,requestedEndTicks:end,retainedPackets:selected,sourcePackets:total,
  relativeRawStartTime:packetTimeKeyV1(anchor!-start,tb),relativeRawEndTime:packetTimeKeyV1(end-start,tb),
  prerollTicks:start-anchor!,maxPendingPacketsObserved:peak,payloadAndDecodeTimelineSha256:digest!.digest("hex"),
  rawPresentationCoverageComplete:true as const,decodedPresentationAndPixelIdentityStillRequired:true as const};}
 };
}
export function verifyGopPacketCopyV2(source:ReturnType<ReturnType<typeof gopPacketWindowV2>["finish"]>,output:ReturnType<ReturnType<typeof gopPacketWindowV2>["finish"]>){
 for(const w of [source,output])if(!w.rawPresentationCoverageComplete||!Number.isSafeInteger(w.retainedPackets)||w.retainedPackets<1||!Number.isSafeInteger(w.sourcePackets)||w.sourcePackets<w.retainedPackets
  ||!/^[a-f0-9]{64}$/.test(w.payloadAndDecodeTimelineSha256)||!/^(-?(0|[1-9]\d*))\/[1-9]\d*$/.test(w.relativeRawStartTime)||!/^([1-9]\d*)\/[1-9]\d*$/.test(w.relativeRawEndTime))throw Error("GOP_WITNESS_SHAPE_INVALID");
 if(source.relativeRawStartTime!==output.relativeRawStartTime||source.relativeRawEndTime!==output.relativeRawEndTime||source.retainedPackets!==output.retainedPackets
  ||source.payloadAndDecodeTimelineSha256!==output.payloadAndDecodeTimelineSha256)throw Error("GOP_COPIED_PAYLOAD_OR_DECODE_TIMELINE_CHANGED");
 return{rawGopPrefixAndPayloadExact:true,copiedPackets:output.retainedPackets,prerollTicks:output.prerollTicks,
  payloadAndDecodeTimelineSha256:output.payloadAndDecodeTimelineSha256,decodedPresentationAndPixelIdentityStillRequired:true};
}
