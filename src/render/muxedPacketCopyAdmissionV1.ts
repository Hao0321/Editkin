import type { EditProject } from "../domain/types";
import { admitPacketCopyProjectV1, admitPacketCopyMediaV1, EXACT_PACKET_COPY_POLICY_V1 } from "./packetCopyAdmissionV1";
import { aacExactWindowClockV1, readAacLcConfigurationV1 } from "./aacPacketClockV1";

export const MUXED_PACKET_COPY_POLICY_V1 = "copy_exact_idr_aac_window" as const;
export function admitMuxedPacketCopyProjectV1(project: EditProject, policy: typeof MUXED_PACKET_COPY_POLICY_V1) {
  if (policy !== MUXED_PACKET_COPY_POLICY_V1) throw Error("MUXED_COPY_EXPLICIT_POLICY_REQUIRED");
  const video = admitPacketCopyProjectV1(project, EXACT_PACKET_COPY_POLICY_V1);
  return { ...video, policy, audioPolicy: "original_aac_lc_with_verified_decoded_samples" as const };
}
/** Only a small AAC ASC, never a whole packet/movie dump. */
function ascBytes(value: unknown, expected: unknown) {
  if (typeof value !== "string" || !Number.isSafeInteger(expected) || Number(expected) < 2 || Number(expected) > 64) throw Error("MUXED_COPY_AUDIO_CONFIG_UNKNOWN");
  let position = 0; const parts: Buffer[] = [];
  for (const line of value.split(/\r?\n/).filter(s => s.trim())) {
    const match = /^([a-fA-F0-9]{8}):[ \t](.*)$/.exec(line);
    if (!match || parseInt(match[1],16) !== position) throw Error("MUXED_COPY_AUDIO_CONFIG_UNKNOWN");
    const hex = match[2].split("  ")[0].trim().replace(/[ \t]/g, "");
    if (!/^(?:[a-fA-F0-9]{2})+$/.test(hex)) throw Error("MUXED_COPY_AUDIO_CONFIG_UNKNOWN");
    const bytes = Buffer.from(hex,"hex"); position += bytes.length; if (position > Number(expected)) throw Error("MUXED_COPY_AUDIO_CONFIG_UNKNOWN"); parts.push(bytes);
  }
  const bytes=Buffer.concat(parts); if (bytes.length !== expected) throw Error("MUXED_COPY_AUDIO_CONFIG_UNKNOWN"); return bytes;
}
export function admitMuxedPacketCopyMediaV1(value: unknown, admission: ReturnType<typeof admitMuxedPacketCopyProjectV1>, output = false) {
  const data=value as {streams:Record<string,any>[];format:Record<string,any>};
  if (!data || !Array.isArray(data.streams) || data.streams.length !== 2 || data.streams[0].codec_type !== "video" || data.streams[1].codec_type !== "audio") throw Error("MUXED_COPY_EXACT_STREAM_SELECTION_REQUIRED");
  const video=admitPacketCopyMediaV1({...data,streams:[data.streams[0]]},{...admission,policy:EXACT_PACKET_COPY_POLICY_V1,audioPolicy:"source_must_have_no_audio"});
  const audio=data.streams[1],config=readAacLcConfigurationV1(ascBytes(audio.extradata,audio.extradata_size));
  if (audio.codec_name !== "aac" || audio.profile !== "LC" || audio.sample_fmt !== "fltp" || Number(audio.sample_rate) !== config.sampleRate
    || audio.channels !== config.channels || audio.channel_layout !== (config.channels === 1 ? "mono" : "stereo") || audio.time_base !== `1/${config.sampleRate}`
    || audio.start_pts !== 0 || Number(audio.start_time) !== 0 || !Number.isSafeInteger(audio.duration_ts) || audio.duration_ts <= 0) throw Error("MUXED_COPY_AUDIO_SHAPE_UNSUPPORTED");
  const audioClock=aacExactWindowClockV1(video.startTicks,video.endTicks,video.timebase,config);
  if (!output && audioClock.startSample < config.frameSamples) throw Error("MUXED_COPY_SOURCE_ORIGIN_REQUIRES_ORIGINAL_CONTAINER_ROUTE");
  if (output && audio.duration_ts !== audioClock.sampleCount) throw Error("MUXED_COPY_AUDIO_DURATION_SAMPLE_MISMATCH");
  if (!output && audio.duration_ts < audioClock.endSample) throw Error("MUXED_COPY_AUDIO_SOURCE_EOF");
  return {...video,audioConfig:config,audioClock,audioDurationSamples:audio.duration_ts,
    audioCodecBinding:JSON.stringify({codec:"aac",profile:"LC",rate:config.sampleRate,channels:config.channels,layout:audio.channel_layout,configSha256:config.configSha256}),
    audioDecodedIdentityRequired:true,assumedPnsAbsence:false};
}
