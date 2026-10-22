// Decode helpers: exact-pts video frames (via settb + showinfo) and absolute-position audio windows (asettb + ashowinfo).
import {FFMPEG} from './env.mjs';
import {runChecked} from './proc.mjs';
import {toDecimalString, ratString, rat, mul, ceilBig, toSafeNumber} from './rational.mjs';

const SHOWINFO = /Parsed_showinfo_\d+ @ [^\]]+\] n:\s*(\d+) pts:\s*(-?\d+) pts_time:\S+\s+duration:\s*(-?\d+).*?fmt:(\S+).*?s:(\d+)x(\d+).*?iskey:(\d) type:(\w)/;
const ASHOWINFO = /Parsed_ashowinfo_\d+ @ [^\]]+\] n:(\d+) pts:(-?\d+) .*?channels:(\d+).*?rate:(\d+) nb_samples:(\d+)/;

/**
 * Decodes up to `count` video frames starting at the first frame with pts >= start (rational seconds).
 * region: 'band' (top `bandRows` rows, gray8) | 'full-gray' | 'full-yuv420p'.
 * Returns frames with integer pts in `timeBase` (the stream time base) and their pixel data.
 */
export async function decodeVideoFrames(file, {start, count, timeBase, width, height, region = 'band', bandRows, streamIndex = 0, timeoutMs = 600000}) {
  const ss = toDecimalString(start, 6);
  const crop = region === 'band' ? `,crop=${width}:${bandRows}:0:0` : '';
  const pixFmt = region === 'full-yuv420p' ? 'yuv420p' : 'gray';
  const rows = region === 'band' ? bandRows : height;
  const frameBytes = pixFmt === 'gray' ? width * rows : width * rows * 3 / 2;
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'info', '-copyts', '-ss', ss, '-i', file,
    '-map', `0:v:${streamIndex}`, '-an', '-sn', '-dn', '-frames:v', String(count),
    // passthrough: rawvideo output would otherwise get CFR vsync, which duplicates frames into VFR gaps
    // (calibration caught this on C7: raw frames 0,1,2,2,4 against showinfo pts 0,1,2,4,5).
    '-vf', `settb=${ratString(timeBase)},showinfo${crop}`, '-fps_mode', 'passthrough', '-pix_fmt', pixFmt, '-f', 'rawvideo', 'pipe:1'];
  const infos = [];
  const r = await runChecked(FFMPEG, args, {collectStdout: true, timeoutMs, onStderrLine: l => { const m = SHOWINFO.exec(l); if (m) infos.push(m); }});
  const n = Math.floor(r.stdout.length / frameBytes);
  // The graph may pull one frame past the -frames:v limit; frames stay in order, so the first n entries match.
  if (n > infos.length || r.stdout.length % frameBytes) throw new Error(`decoded ${n} raw frames (${r.stdout.length} B) but showinfo reported ${infos.length} (${file} @ ${ss})`);
  const frames = infos.slice(0, n).map((m, i) => ({
    pts: Number(m[2]), duration: Number(m[3]), decodedWidth: Number(m[5]), decodedHeight: Number(m[6]),
    key: m[7] === '1', type: m[8], data: r.stdout.subarray(i * frameBytes, (i + 1) * frameBytes),
  }));
  return {frames, argv: [FFMPEG, ...args], wallMs: r.wallMs, rows, pixFmt};
}

/**
 * Decodes `samples` audio samples starting at the first sample with time >= start.
 * Returns the absolute stream sample index of the first returned sample and per-channel Float32 arrays.
 *
 * Pre-roll: AAC needs the previous frame for its MDCT overlap. An input seek that lands exactly on a packet
 * boundary decodes the first frame without it, which mutes up to about one frame; e.g. `-ss 0` on a stream
 * without B-frame delay skips the priming packet (measured on F3: samples 0..456 came out silent while a plain
 * decode had the full chirp). So the decode starts `prerollSamples` earlier (or at the stream start, without
 * -ss) and the pre-roll is dropped here.
 */
export async function decodeAudioWindow(file, {start, samples, sampleRate, streamIndex = 0, timeoutMs = 600000, prerollSamples = 4096}) {
  const target = toSafeNumber(ceilBig(mul(start, rat(sampleRate))), 'start sample');
  const seekSample = target - prerollSamples;
  const pre = seekSample > 0 ? ['-ss', toDecimalString(rat(seekSample, sampleRate), 6)] : [];
  const want = samples + Math.max(0, target - Math.max(0, seekSample)) + 2048;
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'info', '-copyts', ...pre, '-i', file,
    '-map', `0:a:${streamIndex}`, '-vn', '-sn', '-dn',
    '-af', `asettb=1/${sampleRate},ashowinfo,atrim=end_sample=${want}`, '-f', 'f32le', '-c:a', 'pcm_f32le', 'pipe:1'];
  const infos = [];
  const r = await runChecked(FFMPEG, args, {collectStdout: true, timeoutMs, onStderrLine: l => { const m = ASHOWINFO.exec(l); if (m) infos.push(m); }});
  if (!infos.length) return {firstSample: null, channels: [], argv: [FFMPEG, ...args], wallMs: r.wallMs};
  const ch = Number(infos[0][3]), rate = Number(infos[0][4]);
  if (rate !== sampleRate) throw new Error(`decoded audio rate ${rate} != expected ${sampleRate}`);
  const decodedFirst = Number(infos[0][2]);
  // contiguity of the frames that contributed to the decoded range
  let expectNext = decodedFirst, gaps = 0, have = 0;
  for (const m of infos) { if (have >= want) break; if (Number(m[2]) !== expectNext) gaps++; expectNext = Number(m[2]) + Number(m[5]); have += Number(m[5]); }
  const ab = new ArrayBuffer(r.stdout.length - (r.stdout.length % 4));
  new Uint8Array(ab).set(r.stdout.subarray(0, ab.byteLength));
  const f = new Float32Array(ab);
  const total = Math.floor(f.length / ch);
  const drop = Math.max(0, Math.min(total, target - decodedFirst)); // pre-roll samples before the target
  const n = Math.max(0, Math.min(samples, total - drop));
  const channels = Array.from({length: ch}, () => new Float32Array(n));
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) channels[c][i] = f[(i + drop) * ch + c];
  return {firstSample: decodedFirst + drop, channels, channelCount: ch, gaps, prerollDropped: drop, argv: [FFMPEG, ...args], wallMs: r.wallMs};
}
