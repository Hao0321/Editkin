// HARNESS SELF-CHECK ONLY (not an Editkin route): single layer + basic grade + a caption-style box,
// encoded with x264 CRF 18. Exercises the render family of the bench runner, including the
// "high-precision reference with the same effects" hook (lossless x264, qp 0). Not product evidence.
import fs from 'node:fs';
import {FFMPEG, FFPROBE} from '../lib/env.mjs';

const VF = 'eq=contrast=1.05:saturation=1.1,drawbox=x=iw*0.1:y=ih*0.85:w=iw*0.8:h=ih*0.08:color=black@0.5:t=fill';
const TAGS = ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv'];

export default (opts = {}) => ({
  id: 'harness-example-ffmpeg-x264-basic', family: 'render',
  describe: () => ({filter: VF, encoder: 'libx264 veryfast crf 18', threads: Number(opts.threads || 8), note: 'harness self-check, not an Editkin route'}),
  async run(ctx) {
    const out = ctx.outputPath('basic.mp4');
    await ctx.stage('render', () => ctx.spawn(FFMPEG, ['-hide_banner', '-nostdin', '-n', '-loglevel', 'error', '-i', ctx.input.path, '-map', '0:v', '-map', '0:a?',
      '-vf', VF, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-threads', String(opts.threads || 8), '-pix_fmt', 'yuv420p', ...TAGS,
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out]));
    await ctx.stage('verify', () => ctx.spawn(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', out]));
    return {outputPath: out};
  },
  async reference(ctx) {
    const ref = ctx.outputPath('reference-lossless.mkv');
    if (!fs.existsSync(ref)) {
      await ctx.spawn(FFMPEG, ['-hide_banner', '-nostdin', '-n', '-loglevel', 'error', '-i', ctx.input.path, '-map', '0:v', '-vf', VF,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-threads', String(opts.threads || 8), '-pix_fmt', 'yuv420p', ...TAGS, ref]);
    }
    return ref;
  },
});
