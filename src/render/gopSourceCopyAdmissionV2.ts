import type{EditProject}from"../domain/types";
import{canonicalJson}from"../shared/canonicalJson";
import{admitPacketCopyProjectV1,EXACT_PACKET_COPY_POLICY_V1}from"./packetCopyAdmissionV1";
import{admitSourcePreservingMp4V1,SOURCE_PRESERVING_POLICY_V1}from"./sourcePreservingAdmissionV1";
import{avcGopConfigurationV2}from"./avcGopConfigurationV2";
import{aacExactWindowClockV1,readAacLcConfigurationV1}from"./aacPacketClockV1";
import type{PacketTimebaseV1}from"./sourcePacketV1";

export const GOP_SOURCE_COPY_POLICY_V2="copy_exact_gop_original_streams_v2" as const;
export function admitGopSourceCopyProjectV2(project:EditProject,policy:typeof GOP_SOURCE_COPY_POLICY_V2){
 if(policy!==GOP_SOURCE_COPY_POLICY_V2)throw Error("GOP_COPY_EXPLICIT_POLICY_REQUIRED");
 return{...admitPacketCopyProjectV1(project,EXACT_PACKET_COPY_POLICY_V1),policy,audioPolicy:"preserve_optional_original_aac_or_refuse" as const};
}
function exactTick(seconds:number,tb:PacketTimebaseV1){const raw=seconds*tb.denominator/tb.numerator,tick=Math.round(raw);
 if(!Number.isSafeInteger(tick)||Math.abs(raw-tick)>Math.min(1e-5,16*Number.EPSILON*Math.max(1,Math.abs(raw))))throw Error("GOP_COPY_REQUEST_NOT_EXACT_TICK");return tick;
}
function asc(text:unknown,size:unknown){if(typeof text!=="string"||text.length>4096||!Number.isSafeInteger(size)||Number(size)<2||Number(size)>64)throw Error("GOP_COPY_AUDIO_CONFIG_UNKNOWN");let offset=0;const parts:Buffer[]=[];
 for(const line of text.split(/\r?\n/).filter(v=>v.trim())){const m=/^([0-9a-fA-F]{8}):[ \t](.*)$/.exec(line);if(!m||parseInt(m[1],16)!==offset)throw Error("GOP_COPY_AUDIO_CONFIG_UNKNOWN");const hex=m[2].split("  ")[0].trim().replace(/[ \t]/g,"");if(!/^(?:[a-fA-F0-9]{2})+$/.test(hex))throw Error("GOP_COPY_AUDIO_CONFIG_UNKNOWN");const b=Buffer.from(hex,"hex");offset+=b.length;if(offset>Number(size))throw Error("GOP_COPY_AUDIO_CONFIG_UNKNOWN");parts.push(b);}const data=Buffer.concat(parts);if(data.length!==size)throw Error("GOP_COPY_AUDIO_CONFIG_UNKNOWN");return data;
}
function movieTimescale(denominator:number,rate?:number){if(!rate){if(denominator>2147483647)throw Error("GOP_COPY_MOVIE_TIMESCALE_UNSUPPORTED");return denominator;}
 let a=BigInt(denominator),b=BigInt(rate);while(b){const r=a%b;a=b;b=r;}const value=BigInt(denominator)/a*BigInt(rate);if(value>2147483647n)throw Error("GOP_COPY_MOVIE_TIMESCALE_UNSUPPORTED");return Number(value);
}
export function admitGopSourceCopyMediaV2(value:unknown,admission:ReturnType<typeof admitGopSourceCopyProjectV2>,output=false){
 const data=value as{streams:Record<string,any>[];format:Record<string,any>};
 if(!data||!Array.isArray(data.streams)||![1,2].includes(data.streams.length)||data.streams[0].codec_type!=="video"||data.streams.length===2&&data.streams[1].codec_type!=="audio")throw Error("GOP_COPY_ORIGINAL_STREAM_SELECTION_REQUIRED");
 const whole=admitSourcePreservingMp4V1(value,{...admission,policy:SOURCE_PRESERVING_POLICY_V1,audioPolicy:"original_streams_without_normalization"}),v=data.streams[0],codec=avcGopConfigurationV2(v.extradata,v.extradata_size),timebase=whole.sourceTimebase;
 const profiles=codec.profileIdc===66?["Baseline","Constrained Baseline"]:codec.profileIdc===77?["Main"]:["High"];
 if(v.codec_name!=="h264"||!profiles.includes(v.profile)||v.is_avc!=="true"||v.nal_length_size!=="4"||v.pix_fmt!=="yuv420p"||v.field_order!=="progressive"
  ||v.width!==codec.width||v.height!==codec.height||!Number.isSafeInteger(v.has_b_frames)||v.has_b_frames<0||v.has_b_frames>16||v.start_pts!==0||Number(v.start_time)!==0
  ||!Number.isSafeInteger(v.duration_ts)||v.duration_ts<=0)throw Error("GOP_COPY_VIDEO_SHAPE_UNSUPPORTED");
 const startTicks=exactTick(admission.requestedSourceStart,timebase),endTicks=exactTick(admission.requestedSourceEnd,timebase);
 if(startTicks<0||endTicks<=startTicks||(!output&&v.duration_ts<endTicks)||(output&&v.duration_ts!==endTicks-startTicks))throw Error("GOP_COPY_VIDEO_WINDOW_OR_EOF_MISMATCH");
 const binding={codec:"h264",configSha256:codec.sha256,profile:v.profile,pixelFormat:v.pix_fmt,width:v.width,height:v.height,sar:v.sample_aspect_ratio,
  primaries:v.color_primaries,transfer:v.color_transfer,matrix:v.color_space,range:v.color_range,fieldOrder:v.field_order,hasBFrames:v.has_b_frames};
 let audio:undefined|{config:ReturnType<typeof readAacLcConfigurationV1>;clock:ReturnType<typeof aacExactWindowClockV1>;durationSamples:number;codecBinding:string};
 if(data.streams.length===2){const s=data.streams[1],config=readAacLcConfigurationV1(asc(s.extradata,s.extradata_size)),clock=aacExactWindowClockV1(startTicks,endTicks,timebase,config);
  if(s.codec_name!=="aac"||s.profile!=="LC"||s.sample_fmt!=="fltp"||Number(s.sample_rate)!==config.sampleRate||s.channels!==config.channels||s.channel_layout!==(config.channels===1?"mono":"stereo")
   ||s.time_base!==`1/${config.sampleRate}`||s.start_pts!==0||Number(s.start_time)!==0||!Number.isSafeInteger(s.duration_ts)||s.duration_ts<=0
   ||(!output&&s.duration_ts<clock.endSample)||(output&&s.duration_ts!==clock.sampleCount))throw Error("GOP_COPY_AUDIO_SHAPE_OR_DURATION_UNSUPPORTED");
  audio={config,clock,durationSamples:s.duration_ts,codecBinding:canonicalJson({codec:"aac",profile:"LC",rate:config.sampleRate,channels:config.channels,layout:s.channel_layout,configSha256:config.configSha256})};
 }
 return{...whole,codec,codecBindingCanonical:canonicalJson(binding),timebase,startTicks,endTicks,videoDurationTicks:v.duration_ts as number,audio,
  movieTimescale:movieTimescale(timebase.denominator,audio?.config.sampleRate),fullContainerMetadataPreserved:false as const,decodedPresentationRequired:true as const};
}
