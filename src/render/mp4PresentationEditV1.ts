import type{FileHandle}from"node:fs/promises";
import{canonicalJson}from"../shared/canonicalJson";
import type{PacketTimebaseV1}from"./sourcePacketV1";

export interface Mp4EditIoV1{
 identity():Promise<{dev:string;ino:string;bytes:number;mtimeNs:string;ctimeNs:string}>;
 read(position:number,length:number):Promise<Buffer>;
 write(position:number,bytes:Buffer):Promise<void>;
 sync():Promise<void>;
}
export function mp4EditFileHandleV1(handle:FileHandle):Mp4EditIoV1{return{
 async identity(){const s=await handle.stat({bigint:true});if(!s.isFile()||s.size<1n||s.size>BigInt(Number.MAX_SAFE_INTEGER))throw Error("MP4_EDIT_FILE_UNKNOWN");return{dev:String(s.dev),ino:String(s.ino),bytes:Number(s.size),mtimeNs:String(s.mtimeNs),ctimeNs:String(s.ctimeNs)};},
 async read(position,length){const b=Buffer.alloc(length);let read=0;while(read<length){const r=await handle.read(b,read,length-read,position+read);if(!r.bytesRead)throw Error("MP4_EDIT_EARLY_EOF");read+=r.bytesRead;}return b;},
 async write(position,b){let done=0;while(done<b.length){const r=await handle.write(b,done,b.length-done,position+done);if(!r.bytesWritten)throw Error("MP4_EDIT_WRITE_STALLED");done+=r.bytesWritten;}},async sync(){await handle.sync();}
};}
type Box={type:string;start:number;body:number;end:number;children:Box[]};
export interface Mp4PresentationPlanV1{
 schema:"editkin.mp4-presentation-edit/v1";identity:Awaited<ReturnType<Mp4EditIoV1["identity"]>>;
 duration:{ticks:number;timebase:PacketTimebaseV1};handlers:("vide"|"soun")[];movieTimescale:number;targetMovieTicks:string;
 fields:{kind:"movie-duration"|"track-duration"|"edit-duration";offset:number;beforeHex:string;afterHex:string}[];
 boxesRead:number;headerBytesRead:number;payloadBytesRead:0;
}
/** Narrow non-fragmented grammar for a newly owned candidate; no mdat/media_time/stts/ctts changes. */
export async function planMp4PresentationEditV1(io:Mp4EditIoV1,duration:Mp4PresentationPlanV1["duration"],handlers:readonly("vide"|"soun")[]):Promise<Mp4PresentationPlanV1>{
 const{ticks,timebase}=duration;if(![ticks,timebase.numerator,timebase.denominator].every(v=>Number.isSafeInteger(v)&&v>0)||handlers.length<1||handlers.length>2||handlers[0]!=="vide"||handlers.length===2&&handlers[1]!=="soun")throw Error("MP4_EDIT_REQUEST_UNKNOWN");
 const identity=await io.identity();if(!Number.isSafeInteger(identity.bytes)||identity.bytes<8)throw Error("MP4_EDIT_FILE_UNKNOWN");let boxesRead=0,headerBytesRead=0;
 const read=async(position:number,length:number)=>{if(!Number.isSafeInteger(position)||position<0||length<1||length>32||position+length>identity.bytes)throw Error("MP4_EDIT_RANGE_INVALID");const b=await io.read(position,length);if(b.length!==length)throw Error("MP4_EDIT_EARLY_EOF");headerBytesRead+=length;return b;};
 const containers=new Set(["moov","trak","edts","mdia"]);
 async function walk(begin:number,end:number,depth:number):Promise<Box[]>{if(depth>8)throw Error("MP4_EDIT_DEPTH_LIMIT");const result:Box[]=[];let at=begin;
  while(at<end){if(++boxesRead>256||at+8>end)throw Error("MP4_EDIT_BOX_LIMIT_OR_TRUNCATED");const h=await read(at,8);let size=BigInt(h.readUInt32BE(0)),header=8;const type=h.toString("ascii",4,8);
   if(size===1n){if(at+16>end)throw Error("MP4_EDIT_BOX_TRUNCATED");size=(await read(at+8,8)).readBigUInt64BE();header=16;}if(size===0n)size=BigInt(end-at);
   if(size<BigInt(header)||size>BigInt(end-at)||size>BigInt(Number.MAX_SAFE_INTEGER))throw Error("MP4_EDIT_BOX_RANGE_INVALID");if(["moof","mvex","mfra","sidx"].includes(type))throw Error("MP4_EDIT_FRAGMENTED_UNSUPPORTED");
   const box:Box={type,start:at,body:at+header,end:at+Number(size),children:[]};if(containers.has(type))box.children=await walk(box.body,box.end,depth+1);result.push(box);at=box.end;
  }if(at!==end)throw Error("MP4_EDIT_BOX_RANGE_INVALID");return result;
 }
 const top=await walk(0,identity.bytes,0),one=(items:Box[],type:string)=>{const m=items.filter(v=>v.type===type);if(m.length!==1)throw Error("MP4_EDIT_BOX_CARDINALITY");return m[0];},moov=one(top,"moov");one(top,"mdat");
 const inside=async(box:Box,offset:number,length:number)=>{if(box.body+offset+length>box.end)throw Error("MP4_EDIT_BOX_FIELD_TRUNCATED");return read(box.body+offset,length);};
 const ftyp=one(top,"ftyp"),brand=(await inside(ftyp,0,4)).toString("ascii");if(!["isom","iso2","mp41","mp42","avc1","M4V ","dash"].includes(brand))throw Error("MP4_EDIT_BRAND_UNSUPPORTED");
 const mvhd=one(moov.children,"mvhd"),movieHead=await inside(mvhd,0,4),version=movieHead[0];if(version>1||movieHead.subarray(1).some(v=>v!==0))throw Error("MP4_EDIT_VERSION_UNSUPPORTED");const movieTimescale=(await inside(mvhd,version?20:12,4)).readUInt32BE();if(!movieTimescale||movieTimescale>2147483647)throw Error("MP4_EDIT_TIMESCALE_UNKNOWN");
 const numerator=BigInt(ticks)*BigInt(timebase.numerator)*BigInt(movieTimescale),denominator=BigInt(timebase.denominator);if(numerator%denominator)throw Error("MP4_EDIT_DURATION_NOT_EXACT");const target=numerator/denominator;if(target<1n||target>0xffffffffffffffffn)throw Error("MP4_EDIT_DURATION_OVERFLOW");
 const fields:Mp4PresentationPlanV1["fields"]=[];
 const field=async(box:Box,offset:number,width:4|8,kind:Mp4PresentationPlanV1["fields"][number]["kind"])=>{const before=await inside(box,offset,width),value=width===4?BigInt(before.readUInt32BE()):before.readBigUInt64BE();if(value<target)throw Error("MP4_EDIT_CANNOT_EXTEND_PRESENTATION");if(width===4&&target>0xffffffffn)throw Error("MP4_EDIT_DURATION_VERSION_UPGRADE_REQUIRED");const after=Buffer.alloc(width);if(width===4)after.writeUInt32BE(Number(target));else after.writeBigUInt64BE(target);fields.push({kind,offset:box.body+offset,beforeHex:before.toString("hex"),afterHex:after.toString("hex")});};
 await field(mvhd,version?24:16,version?8:4,"movie-duration");const tracks=moov.children.filter(v=>v.type==="trak");if(tracks.length!==handlers.length)throw Error("MP4_EDIT_TRACK_CARDINALITY");
 for(let i=0;i<tracks.length;i++){const track=tracks[i],tkhd=one(track.children,"tkhd"),mdia=one(track.children,"mdia"),handler=one(mdia.children,"hdlr"),actual=(await inside(handler,8,4)).toString("ascii");if(actual!==handlers[i])throw Error("MP4_EDIT_HANDLER_MISMATCH");
  const mdhd=one(mdia.children,"mdhd"),mh=await inside(mdhd,0,4),mdv=mh[0];if(mdv>1||mh.subarray(1).some(v=>v!==0)||(await inside(mdhd,mdv?20:12,4)).readUInt32BE()===0)throw Error("MP4_EDIT_MEDIA_HEADER_UNKNOWN");
  const th=await inside(tkhd,0,4),tkver=th[0];if(tkver>1||th.readUIntBE(1,3)>7)throw Error("MP4_EDIT_VERSION_UNSUPPORTED");await field(tkhd,tkver?28:20,tkver?8:4,"track-duration");const elst=one(one(track.children,"edts").children,"elst"),head=await inside(elst,0,8),ev=head[0];if(ev>1||head.subarray(1,4).some(v=>v!==0)||head.readUInt32BE(4)!==1)throw Error("MP4_EDIT_EDITLIST_SHAPE_UNSUPPORTED");
  const entry=await inside(elst,8,ev?20:12),mediaTime=ev?entry.readBigInt64BE(8):BigInt(entry.readInt32BE(4));if(mediaTime<0n||entry.readInt16BE(ev?16:8)!==1||entry.readInt16BE(ev?18:10)!==0)throw Error("MP4_EDIT_MEDIA_TIME_OR_RATE_UNSUPPORTED");
  await field(elst,8,ev?8:4,"edit-duration");
 }
 if(canonicalJson(await io.identity())!==canonicalJson(identity))throw Error("MP4_EDIT_FILE_CHANGED_DURING_PLAN");
 return{schema:"editkin.mp4-presentation-edit/v1",identity,duration:{ticks,timebase:{...timebase}},handlers:[...handlers],movieTimescale,targetMovieTicks:String(target),fields,boxesRead,headerBytesRead,payloadBytesRead:0};
}
/** Rebuild the exact plan before mutation; caller must hold the owned-candidate handle and publication guard. */
export async function applyMp4PresentationEditV1(io:Mp4EditIoV1,plan:Mp4PresentationPlanV1){
 if(plan.schema!=="editkin.mp4-presentation-edit/v1")throw Error("MP4_EDIT_PLAN_UNKNOWN");const fresh=await planMp4PresentationEditV1(io,plan.duration,plan.handlers);if(canonicalJson(fresh)!==canonicalJson(plan))throw Error("MP4_EDIT_PLAN_STALE_OR_TAMPERED");
 const written:Mp4PresentationPlanV1["fields"]=[];
 try{for(const f of fresh.fields){if((await io.read(f.offset,f.beforeHex.length/2)).toString("hex")!==f.beforeHex)throw Error("MP4_EDIT_FIELD_CHANGED");written.push(f);await io.write(f.offset,Buffer.from(f.afterHex,"hex"));}await io.sync();for(const f of written)if((await io.read(f.offset,f.afterHex.length/2)).toString("hex")!==f.afterHex)throw Error("MP4_EDIT_READBACK_MISMATCH");const after=await io.identity();if(after.dev!==fresh.identity.dev||after.ino!==fresh.identity.ino||after.bytes!==fresh.identity.bytes)throw Error("MP4_EDIT_OWNER_CHANGED");
  return{presentationDurationPatched:true,changedFields:written.length,targetMovieTicks:fresh.targetMovieTicks,payloadBytesWritten:0,fullDecodeAndPacketIdentityStillRequired:true};
 }catch(error){let restored=true;for(const f of written.reverse()){try{const b=await io.read(f.offset,f.afterHex.length/2);if(b.toString("hex")===f.afterHex)await io.write(f.offset,Buffer.from(f.beforeHex,"hex"));else if(b.toString("hex")!==f.beforeHex)restored=false;}catch{restored=false;}}try{await io.sync();}catch{restored=false;}if(!restored)throw Error("MP4_EDIT_ROLLBACK_UNPROVEN");throw error;}
}
