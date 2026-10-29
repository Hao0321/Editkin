// Builds the exact FFmpeg argv that generates a fixture (pure FFmpeg: the argv alone reproduces it).
import {identityFilters} from './identity-video.mjs';
import {aevalsrcFilter} from './identity-audio.mjs';
import {derive} from './fixtures.mjs';

export function generatorArgs(spec, outPath, {threads} = {}) {
  const d = derive(spec);
  const {filters, layout} = identityFilters({
    width: spec.width, height: spec.height, fps: d.fps, startFrame: spec.startFrame,
    startSecondsDecimal: d.videoStartDecimal, label: spec.label,
  });
  const srcSeconds = Math.ceil(Number(d.durationSeconds.num) / Number(d.durationSeconds.den)) + 1;
  const v = [
    `testsrc2=s=${spec.width}x${spec.height}:r=${d.fpsString}:d=${srcSeconds}`,
    `trim=end_frame=${spec.frames}`,
    ...filters,
    ...(spec.vfr ? [`select='not(eq(mod(n+${spec.startFrame},${spec.vfr.dropMod}),${spec.vfr.dropRem}))'`] : []),
    // FFmpeg 8 encoders take colour properties from the frames; tag them explicitly (no pixel change).
    'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv',
    'format=yuv420p',
  ].join(',') + '[v]';
  const vid = spec.video;
  const x264 = [`keyint=${vid.keyint}`, `min-keyint=${vid.keyint}`, 'scenecut=0', `bframes=${vid.bframes}`];
  if (vid.bframes > 0) x264.push('b-adapt=0', 'b-pyramid=none');
  x264.push('open-gop=0');
  // Determinism: x264's VBV (maxrate/bufsize) reads size estimates of frames or slices still being encoded
  // by other threads, so reruns differ (measured: 299/300 packets with frame threads, 33/120 with sliced
  // threads). ABR without VBV is byte-identical across reruns (5/5 at 2 and 8 threads), so fixtures use
  // plain ABR; a spec may still ask for VBV explicitly (then the output is NOT byte-reproducible).
  const threadCount = Number(threads ?? vid.threads ?? 8);
  const args = ['-hide_banner', '-nostdin', '-n', '-loglevel', 'warning', '-filter_complex', v];
  if (spec.audio) {
    const a = spec.audio;
    args.push('-filter_complex', `${aevalsrcFilter({R: a.sampleRate, layout: a.layout, channels: a.channels, A0: d.audioStartSample})},atrim=end_sample=${d.audioSamples}[a]`);
  }
  args.push('-map', '[v]');
  if (spec.audio) args.push('-map', '[a]');
  args.push(
    '-fps_mode', 'passthrough',
    '-c:v', vid.codec, '-preset', vid.preset, '-profile:v', vid.profile, '-pix_fmt', 'yuv420p',
    '-x264-params', x264.join(':'),
    '-b:v', vid.bitrate, ...(vid.maxrate ? ['-maxrate', vid.maxrate, '-bufsize', vid.bufsize || vid.maxrate] : []),
    '-threads', String(threadCount),
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
  );
  if (spec.audio) args.push('-c:a', 'aac', '-b:a', spec.audio.bitrate);
  args.push(
    '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact', '-map_metadata', '-1', '-map_chapters', '-1',
    // Edit-list durations are stored in the movie timescale; the default 1000 rounds e.g. 120.0199 s of
    // 44.1 kHz audio up by 4 samples. lcm(frame-rate numerator, sample rate) makes every edit exact.
    '-movie_timescale', String(movieTimescale(spec, d)),
    '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', '-f', 'mp4', outPath,
  );
  return {args, layout, derived: d};
}

const gcdN = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
export function movieTimescale(spec, d) {
  const num = Number(d.fps.num);
  const other = spec.audio ? spec.audio.sampleRate : 1000;
  return num / gcdN(num, other) * other;
}
