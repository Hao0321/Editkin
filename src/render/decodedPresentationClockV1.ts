import { createHash } from "node:crypto";
import { packetTimeKeyV1, type PacketTimebaseV1 } from "./sourcePacketV1";

export interface DecodedFrameClockV1 { pts: number; bestEffortPts: number; duration: number }
/** Empty excluded side-data produces one trailing pipe in pinned ffprobe8.1. */
export function parseDecodedFrameClockV1(line: string): DecodedFrameClockV1 {
  if (Buffer.byteLength(line) > 4096) throw Error("PRESENTED_FRAME_LINE_LIMIT");
  const fields: Record<string,string> = Object.create(null), allowed = new Set(["pts","best_effort_timestamp","duration"]);
  for (const item of line.replace(/\r$/, "").replace(/\|$/, "").split("|")) {
    const at=item.indexOf("="),key=item.slice(0,at),value=item.slice(at+1);
    if (at<1 || !allowed.has(key) || Object.hasOwn(fields,key) || !/^-?(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw Error("PRESENTED_FRAME_FIELDS_UNKNOWN");
    fields[key]=value;
  }
  if (Object.keys(fields).length!==3) throw Error("PRESENTED_FRAME_FIELDS_UNKNOWN");
  const frame={pts:Number(fields.pts),bestEffortPts:Number(fields.best_effort_timestamp),duration:Number(fields.duration)};
  if (frame.pts!==frame.bestEffortPts || frame.pts<0 || frame.duration<=0 || !Number.isSafeInteger(frame.pts+frame.duration)) throw Error("PRESENTED_FRAME_CLOCK_UNKNOWN");
  return frame;
}
/** One-frame lookbehind derives actual hold from next PTS, not nominalFPS or intermediate packet duration. */
export function decodedPresentationWindowV1(start: number,end: number,timebase: PacketTimebaseV1,mode:"source"|"output") {
  if (![start,end].every(Number.isSafeInteger) || start<0 || end<=start || (mode!=="source"&&mode!=="output") || (mode==="output"&&start!==0)) throw Error("PRESENTED_FRAME_WINDOW_INVALID");
  const tb={...timebase};packetTimeKeyV1(0,tb);
  const digest=createHash("sha256");let previous:DecodedFrameClockV1|undefined,accepted=0,retained=0,lastEnd:number|undefined,failure:unknown,done=false;
  const guard=(operation:()=>void)=>{if(failure!==undefined)throw failure;if(done)throw Error("PRESENTED_FRAME_WITNESS_ALREADY_FINISHED");try{operation();}catch(error){failure=error;throw error;}};
  const flush=(frame:DecodedFrameClockV1,nextPts:number)=>{
    if (nextPts<=frame.pts || !Number.isSafeInteger(nextPts)) throw Error("PRESENTED_FRAME_ORDER_INVALID");
    if (frame.pts<start) { if(nextPts>start)throw Error("PRESENTED_FRAME_START_NOT_EXACT_BOUNDARY");return; }
    if (frame.pts>=end) return;
    if (!retained&&frame.pts!==start) throw Error("PRESENTED_FRAME_START_MISSING");
    if (nextPts>end) throw Error("PRESENTED_FRAME_END_NOT_EXACT_BOUNDARY");
    digest.update(`${packetTimeKeyV1(frame.pts-start,tb)},${packetTimeKeyV1(nextPts-frame.pts,tb)}\n`);
    retained++;lastEnd=nextPts;if(!Number.isSafeInteger(retained))throw Error("PRESENTED_FRAME_COUNT_UNSAFE");
  };
  return { accept(frame:DecodedFrameClockV1) { guard(()=>{
    if (![frame.pts,frame.bestEffortPts,frame.duration].every(Number.isSafeInteger) || frame.pts<0 || frame.pts!==frame.bestEffortPts || frame.duration<=0 || !Number.isSafeInteger(frame.pts+frame.duration)) throw Error("PRESENTED_FRAME_CLOCK_UNKNOWN");
    if (!previous&&frame.pts!==0) throw Error("PRESENTED_FRAME_ORIGIN_SHIFTED");
    if (mode==="output"&&frame.pts>=end) throw Error("PRESENTED_FRAME_EXTRA_OR_SUBSTITUTED");
    if (previous) flush(previous,frame.pts);
    previous={...frame};accepted++;if(!Number.isSafeInteger(accepted))throw Error("PRESENTED_FRAME_COUNT_UNSAFE");
  });}, finish() {
    guard(()=>{if(!previous)throw Error("PRESENTED_FRAME_EMPTY");flush(previous,previous.pts+previous.duration);if(!retained||lastEnd!==end)throw Error("PRESENTED_FRAME_WINDOW_EOF");});done=true;
    return { frames:retained,decodedFramesAccepted:accepted,startTicks:start,endTicks:end,duration:packetTimeKeyV1(end-start,tb),
      presentationTimelineSha256:digest.digest("hex"),lookbehindFrames:1 as const,complete:true as const };
  } };
}
export function verifyDecodedPresentationIdentityV1(source:ReturnType<ReturnType<typeof decodedPresentationWindowV1>["finish"]>,output:ReturnType<ReturnType<typeof decodedPresentationWindowV1>["finish"]>) {
  for (const witness of [source,output]) {
    if (!witness.complete || !Number.isSafeInteger(witness.frames) || witness.frames<1 || !/^[a-f0-9]{64}$/.test(witness.presentationTimelineSha256)
      || witness.duration.length>128 || !/^[1-9]\d*\/[1-9]\d*$/.test(witness.duration)) throw Error("PRESENTED_FRAME_WITNESS_SHAPE_INVALID");
  }
  if (!source.complete||!output.complete||source.frames!==output.frames||source.duration!==output.duration||source.presentationTimelineSha256!==output.presentationTimelineSha256) throw Error("PRESENTED_FRAME_TIMELINE_IDENTITY_MISMATCH");
  return { presentedFrames:output.frames,decodedPresentationTimelineExact:true,duration:output.duration,presentationTimelineSha256:output.presentationTimelineSha256,
    pixelIdentityStillRequired:true,rawGopDependencyProofStillRequired:true };
}
