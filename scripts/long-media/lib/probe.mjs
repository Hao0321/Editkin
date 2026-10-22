// ffprobe wrappers returning raw JSON plus a compact facts object.
import {FFPROBE} from './env.mjs';
import {runChecked} from './proc.mjs';
import {parseRational, ratString} from './rational.mjs';

export async function ffprobeJson(file, {countPackets = false, timeoutMs = 600000} = {}) {
  const args = ['-hide_banner', '-v', 'error', '-show_format', '-show_streams', '-of', 'json'];
  if (countPackets) args.push('-count_packets');
  args.push(file);
  const r = await runChecked(FFPROBE, args, {timeoutMs});
  return {json: JSON.parse(r.stdoutTail), argv: [FFPROBE, ...args], wallMs: r.wallMs};
}

const pick = (o, keys) => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));
const num = v => (v === undefined || v === 'N/A' ? undefined : Number(v));

export function probeFacts(json) {
  const f = json.format || {};
  const v = (json.streams || []).find(s => s.codec_type === 'video');
  const a = (json.streams || []).filter(s => s.codec_type === 'audio');
  const facts = {
    format: {
      ...pick(f, ['format_name', 'start_time', 'duration']),
      size: num(f.size), bitRate: num(f.bit_rate), nbStreams: f.nb_streams,
    },
    video: null,
    audio: a.map(s => ({
      index: s.index, ...pick(s, ['codec_name', 'profile', 'sample_fmt', 'channel_layout', 'time_base', 'start_pts', 'start_time', 'duration_ts', 'duration']),
      sampleRate: num(s.sample_rate), channels: s.channels, nbFrames: num(s.nb_frames), bitRate: num(s.bit_rate),
      nbReadPackets: num(s.nb_read_packets), initialPadding: s.initial_padding,
    })),
  };
  if (v) {
    facts.video = {
      index: v.index,
      ...pick(v, ['codec_name', 'profile', 'pix_fmt', 'sample_aspect_ratio', 'display_aspect_ratio', 'r_frame_rate', 'avg_frame_rate',
        'time_base', 'start_pts', 'start_time', 'duration_ts', 'duration', 'color_range', 'color_space', 'color_transfer',
        'color_primaries', 'field_order', 'level', 'refs', 'has_b_frames', 'closed_captions']),
      width: v.width, height: v.height, nbFrames: num(v.nb_frames), bitRate: num(v.bit_rate), nbReadPackets: num(v.nb_read_packets),
    };
  }
  return facts;
}

/** {num, den} from an ffprobe "1/15360"-style string. */
export const tbOf = s => parseRational(s);
export const tbString = r => ratString(r);
