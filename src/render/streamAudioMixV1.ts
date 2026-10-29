import type { EditProject } from "../domain/types";
import type { RenderPlan } from "./planner";
import { clipAudioEnvelopeFilter } from "./clipAudioEnvelopeFilters";
import { finite } from "./ffmpegExpressions";
import { masterAudioFilter, probeMedia } from "./ffmpegMedia";

/** Candidate admission limits, not a measured whole-export RAM bound. */
export const STREAM_AUDIO_MAX_CLIPS_V1 = 64;
export const STREAM_AUDIO_MAX_ARGUMENT_CHARS_V1 = 24_000;
export const STREAM_AUDIO_MAX_FILTER_BYTES_V1 = 16 * 1024 ** 2;

/** Keep the legacy nominal audio graph, but place its inputs after video pipe:0.
 * No whole-duration PCM/AAC intermediate, proxy, resampling-policy change or dropped clip. */
export async function buildStreamAudioMixV1(project: EditProject, plan: RenderPlan, options: {
  inputOffset: number;
  ffprobePath?: string;
  signal?: AbortSignal;
  probe?: (path: string, ffprobePath?: string) => Promise<{ hasAudio: boolean }>;
}) {
  if (!Number.isSafeInteger(options.inputOffset) || options.inputOffset < 0 || options.inputOffset > 64
    || !Number.isFinite(plan.duration) || plan.duration <= 0) throw Error("STREAM_AUDIO_REQUEST_INVALID");
  if (plan.audioClips.length > STREAM_AUDIO_MAX_CLIPS_V1) throw Error("STREAM_AUDIO_SOURCE_BUDGET_EXCEEDED");
  const active = () => options.signal?.throwIfAborted();
  const inputArgs = ["-f", "lavfi", "-t", finite(plan.duration), "-i", "anullsrc=r=48000:cl=stereo"];
  const filters = [`[${options.inputOffset}:a]atrim=duration=${finite(plan.duration)},asetpts=PTS-STARTPTS[abase]`];
  const voiceLabels = ["[abase]"], musicLabels: string[] = [], audioStreams = new Map<string, boolean>();
  let inputIndex = options.inputOffset + 1, audioIndex = 0;
  for (const item of plan.audioClips) {
    active();
    const clip = item.clip, asset = project.assets.find(candidate => candidate.id === clip.assetId);
    if (!asset) throw Error(`找不到音訊素材：${clip.assetId}`);
    if (!item.assetPath || item.assetPath.includes("\0")
      || ![clip.sourceStart, clip.timelineStart, clip.duration, clip.volume].every(Number.isFinite)
      || clip.sourceStart < 0 || clip.timelineStart < 0 || clip.duration <= 0 || clip.volume < 0
      || !Number.isSafeInteger(Math.round(clip.timelineStart * 1000))) throw Error("STREAM_AUDIO_CLIP_INVALID");
    let hasAudio = audioStreams.get(item.assetPath);
    if (hasAudio === undefined) {
      hasAudio = (await (options.probe ?? probeMedia)(item.assetPath, options.ffprobePath)).hasAudio;
      active(); audioStreams.set(item.assetPath, hasAudio);
    }
    if (!hasAudio) continue;
    inputArgs.push("-ss", finite(clip.sourceStart), "-t", finite(clip.duration), "-i", item.assetPath);
    // Windows command lines are bounded even though the filter graph lives in an owned script.
    if (inputArgs.reduce((sum, argument) => sum + 2 * argument.length + 3, 0) > STREAM_AUDIO_MAX_ARGUMENT_CHARS_V1)
      throw Error("STREAM_AUDIO_ARGUMENT_BUDGET_EXCEEDED");
    const label = `aclip${audioIndex}`, music = asset.role === "background-music", fade = music ? Math.min(1.2, clip.duration / 5) : 0;
    const fadeFilter = clip.audioEnvelope ? clipAudioEnvelopeFilter(clip, music) : music && fade > 0
      ? `,afade=t=in:st=0:d=${finite(fade)},afade=t=out:st=${finite(Math.max(0, clip.duration - fade))}:d=${finite(fade)}` : "";
    filters.push(`[${inputIndex}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${finite(clip.duration)},asetpts=PTS-STARTPTS${fadeFilter},adelay=${Math.round(clip.timelineStart * 1000)}:all=1,volume=${finite(clip.volume)}[${label}]`);
    (music ? musicLabels : voiceLabels).push(`[${label}]`); inputIndex++; audioIndex++;
  }
  filters.push(`${voiceLabels.join("")}amix=inputs=${voiceLabels.length}:duration=longest:normalize=0[voicemix]`);
  if (musicLabels.length) {
    filters.push(`${musicLabels.join("")}amix=inputs=${musicLabels.length}:duration=longest:normalize=0${voiceLabels.length > 1 ? "[musicbus-source]" : "[musicbus]"}`);
    if (voiceLabels.length > 1) {
      // FFmpeg sidechaincompress forwards EOF before draining the other FIFO.
      // Both inputs continue with silence; explicit pre-master trim keeps the nominal duration.
      // No authored sample inside that duration is replaced or buffered as a whole file.
      filters.push("[musicbus-source]apad[musicbus]");
      filters.push("[voicemix]asplit=2[voiceout][voicekey-source]");
      filters.push("[voicekey-source]apad[voicekey]");
      filters.push("[musicbus][voicekey]sidechaincompress=threshold=0.025:ratio=8:attack=25:release=360:makeup=1[duckedmusic]");
      filters.push(`[voiceout][duckedmusic]amix=inputs=2:duration=longest:normalize=0[premaster-untrimmed]`);
      filters.push(`[premaster-untrimmed]atrim=duration=${finite(plan.duration)}[premaster]`);
    } else filters.push("[voicemix][musicbus]amix=inputs=2:duration=longest:normalize=0[premaster]");
    filters.push(masterAudioFilter("[premaster]", plan.duration));
  } else if (voiceLabels.length > 1) filters.push(masterAudioFilter("[voicemix]", plan.duration));
  else filters.push(`[voicemix]atrim=duration=${finite(plan.duration)},asetpts=PTS-STARTPTS[aout]`);
  const filterComplex = filters.join(";");
  if (Buffer.byteLength(filterComplex, "utf8") > STREAM_AUDIO_MAX_FILTER_BYTES_V1) throw Error("STREAM_AUDIO_FILTER_BUDGET_EXCEEDED");
  active();
  return { inputArgs, filterComplex, outputLabel: "[aout]", codecArgs: ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"],
    sourceCount: audioIndex, noWholeAudioIntermediate: true as const };
}
