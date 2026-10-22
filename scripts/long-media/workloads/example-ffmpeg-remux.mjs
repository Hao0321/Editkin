// HARNESS SELF-CHECK ONLY (not an Editkin route): FFmpeg stream-copy remux of the input fixture.
// Exercises the copy family of the bench runner end to end; its numbers are not product evidence.
import {FFMPEG, FFPROBE} from '../lib/env.mjs';

export default () => ({
  id: 'harness-example-ffmpeg-remux', family: 'copy',
  describe: () => ({what: 'ffmpeg -map 0 -c copy -movflags +faststart', note: 'harness self-check, not an Editkin route'}),
  async run(ctx) {
    const out = ctx.outputPath('remux.mp4');
    await ctx.stage('mux', () => ctx.spawn(FFMPEG, ['-hide_banner', '-nostdin', '-n', '-loglevel', 'error', '-i', ctx.input.path, '-map', '0', '-c', 'copy',
      '-movflags', '+faststart', out]));
    await ctx.stage('verify', () => ctx.spawn(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', out]));
    return {outputPath: out};
  },
});
