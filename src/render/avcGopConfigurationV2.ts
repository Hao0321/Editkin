import {createHash} from "node:crypto";

function rbsp(nal:Buffer) {
  const bytes:number[]=[];let zeros=0;
  for(let i=1;i<nal.length;i++){
    const value=nal[i];
    if(zeros>=2&&value===3){if(i+1>=nal.length||nal[i+1]>3)throw Error("GOP_AVC_RBSP_INVALID");zeros=0;continue;}
    bytes.push(value);zeros=value===0?zeros+1:0;
  }
  return Buffer.from(bytes);
}
function bitReader(data:Buffer){let at=0;const bits=(n:number)=>{if(at+n>data.length*8)throw Error("GOP_AVC_SPS_TRUNCATED");let v=0;for(let i=0;i<n;i++,at++)v=v*2+((data[Math.floor(at/8)]>>(7-at%8))&1);return v;};
 const ue=()=>{let n=0;while(!bits(1)){if(++n>31)throw Error("GOP_AVC_GOLOMB_UNSUPPORTED");}return 2**n-1+bits(n);};
 return{bits,ue,se:()=>{const n=ue();return n%2?(n+1)/2:-n/2;}};
}
function spsInfo(nal:Buffer,header:Buffer){const r=bitReader(rbsp(nal)),profile=r.bits(8),compat=r.bits(8),level=r.bits(8),spsId=r.ue();
 if(profile!==header[1]||compat!==header[2]||level!==header[3]||spsId>31||(compat&3))throw Error("GOP_AVC_SPS_HEADER_MISMATCH");
 let chroma=1,luma=8,chromaDepth=8;
 if(profile===100){chroma=r.ue();if(chroma!==1)throw Error("GOP_AVC_CHROMA_UNSUPPORTED");luma=8+r.ue();chromaDepth=8+r.ue();if(luma!==8||chromaDepth!==8)throw Error("GOP_AVC_DEPTH_UNSUPPORTED");r.bits(1);
  if(r.bits(1))for(let i=0;i<8;i++)if(r.bits(1)){let last=8,next=8;for(let j=0;j<(i<6?16:64);j++){if(next)next=((last+r.se())%256+256)%256;last=next||last;}}
 }
 if(r.ue()>12)throw Error("GOP_AVC_FRAME_NUMBER_UNSUPPORTED");const order=r.ue();if(order===0){if(r.ue()>12)throw Error("GOP_AVC_POC_UNSUPPORTED");}else if(order===1){r.bits(1);r.se();r.se();const count=r.ue();if(count>255)throw Error("GOP_AVC_POC_UNSUPPORTED");for(let i=0;i<count;i++)r.se();}else if(order!==2)throw Error("GOP_AVC_POC_UNSUPPORTED");
 const references=r.ue();if(references>16)throw Error("GOP_AVC_REFERENCE_LIMIT");r.bits(1);const mbWidth=r.ue(),mapHeight=r.ue(),frameOnly=r.bits(1);if(!frameOnly)throw Error("GOP_AVC_INTERLACED_UNSUPPORTED");r.bits(1);
 let left=0,right=0,top=0,bottom=0;if(r.bits(1)){left=r.ue();right=r.ue();top=r.ue();bottom=r.ue();}
 const width=(mbWidth+1)*16-2*(left+right),height=(mapHeight+1)*16-2*(top+bottom);
 if(![width,height].every(v=>Number.isSafeInteger(v)&&v>0&&v<=32768))throw Error("GOP_AVC_GEOMETRY_UNSUPPORTED");
 return{profileIdc:profile,spsId,chromaFormat:chroma,bitDepth:luma,chromaBitDepth:chromaDepth,progressive:true as const,width,height,references,
  remainingVuiRequiresDecoderValidation:true as const};
}
/** Bounded AVC66/77/100 config. Full decoder/metadata/pixel evidence remains required. */
export function avcGopConfigurationV2(text:unknown,expectedBytes:unknown){
 if(typeof text!=="string"||text.length>262144||!Number.isSafeInteger(expectedBytes)||Number(expectedBytes)<7||Number(expectedBytes)>65536)throw Error("GOP_AVC_CONFIG_UNKNOWN");
 let offset=0;const chunks:Buffer[]=[];
 for(const line of text.split(/\r?\n/).filter(v=>v.trim())){const m=/^([a-fA-F0-9]{8}):[ \t](.*)$/.exec(line);if(!m||parseInt(m[1],16)!==offset)throw Error("GOP_AVC_DUMP_INVALID");const hex=m[2].split("  ")[0].trim().replace(/[ \t]/g,"");if(!/^(?:[a-fA-F0-9]{2})+$/.test(hex))throw Error("GOP_AVC_DUMP_INVALID");const b=Buffer.from(hex,"hex");offset+=b.length;if(offset>Number(expectedBytes))throw Error("GOP_AVC_DUMP_INVALID");chunks.push(b);}
 const data=Buffer.concat(chunks);if(data.length!==expectedBytes||data[0]!==1||![66,77,100].includes(data[1])||data[4]!==255||data[5]!==225)throw Error("GOP_AVC_CONFIG_UNSUPPORTED");
 let at=6;const parameter=(type:number)=>{if(at+2>data.length)throw Error("GOP_AVC_PARAMETER_TRUNCATED");const n=data.readUInt16BE(at);at+=2;if(n<2||at+n>data.length||(data[at]&128)||(data[at]&31)!==type)throw Error("GOP_AVC_PARAMETER_INVALID");const result=data.subarray(at,at+n);at+=n;return result;};
 const sps=parameter(7),info=spsInfo(sps,data);if(data[at++]!==1)throw Error("GOP_AVC_MULTIPLE_PARAMETERS_UNSUPPORTED");const pps=parameter(8),p=bitReader(rbsp(pps)),ppsId=p.ue();if(ppsId>255||p.ue()!==info.spsId)throw Error("GOP_AVC_PPS_BINDING_MISMATCH");
 if(at<data.length){if(info.profileIdc!==100||data.length-at!==4||data[at++]!==253||data[at++]!==248||data[at++]!==248||data[at++]!==0)throw Error("GOP_AVC_EXTENSION_UNSUPPORTED");}
 if(at!==data.length)throw Error("GOP_AVC_EXTRA_DATA_UNSUPPORTED");
 return{...info,ppsId,sha256:createHash("sha256").update(data).digest("hex"),bytes:data.length,nalLengthBytes:4 as const,fullCodecAdmission:false as const};
}
