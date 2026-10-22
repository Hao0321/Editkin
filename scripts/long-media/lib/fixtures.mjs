// LV-01 minimum matrix as deterministic synthetic fixtures (definitions + exact derived expectations).
// Long fixtures are the acceptance media; calibration fixtures are 2-minute versions with identical
// encoder settings; unit fixtures are tiny clips built by tests via makeSpec().
import {rat, parseRational, mul, ceilBig, roundHalfUpBig, toSafeNumber, toDecimalString, ratString, framePts} from './rational.mjs';

const H264 = (o = {}) => ({codec: 'libx264', profile: 'high', preset: 'veryfast', keyint: 60, bframes: 2, threads: 8, ...o});
const STEREO48 = (bitrate = '96k') => ({sampleRate: 48000, layout: 'stereo', channels: 2, bitrate});

/** Number of source frames covering at least `seconds` at `fps`. */
const framesFor = (seconds, fps) => toSafeNumber(ceilBig(mul(parseRational(seconds), parseRational(fps))), 'frames');
const startFrameAt = (seconds, fps) => framesFor(seconds, fps);

const LONG = [
  {id: 'F1-1080p30-12h', purpose: 'LV-01 main: 12 h 1080p30 CFR, 48 kHz stereo', width: 1920, height: 1080, fps: '30/1', frames: framesFor(43200, '30/1'),
    audio: STEREO48(), video: H264({bitrate: '600k'})},
  {id: 'F2-1080p2997-12h', purpose: 'LV-01: 12 h 1080p 30000/1001 CFR (drop-frame TC), 44.1 kHz stereo', width: 1920, height: 1080, fps: '30000/1001',
    frames: framesFor(43200, '30000/1001'), audio: {sampleRate: 44100, layout: 'stereo', channels: 2, bitrate: '96k'},
    video: H264({bitrate: '600k'})},
  {id: 'F3-360p2997-25h', purpose: 'LV-01 24 h+ clock/index: 25 h tiny 30000/1001; 48 kHz sample index crosses 2^32 at 89478.485 s', width: 640, height: 360,
    fps: '30000/1001', frames: framesFor(90000, '30000/1001'), audio: {sampleRate: 48000, layout: 'mono', channels: 1, bitrate: '48k'},
    video: H264({profile: 'baseline', bframes: 0, bitrate: '120k', threads: 4})},
  {id: 'F4-2160p30-30m', purpose: 'LV-01/LV-06: short 4K30', width: 3840, height: 2160, fps: '30/1', frames: framesFor(1800, '30/1'),
    audio: STEREO48('128k'), video: H264({bitrate: '4000k'})},
  {id: 'F5-1080p60-51-30m', purpose: 'LV-01: 1080p60 with 5.1 multichannel', width: 1920, height: 1080, fps: '60/1', frames: framesFor(1800, '60/1'),
    audio: {sampleRate: 48000, layout: '5.1', channels: 6, bitrate: '256k'}, video: H264({keyint: 120, bitrate: '1200k'})},
  {id: 'F6-1080p30-noaudio-30m', purpose: 'LV-01: no audio', width: 1920, height: 1080, fps: '30/1', frames: framesFor(1800, '30/1'),
    audio: null, video: H264({bitrate: '600k'})},
  {id: 'F7-1080p30-vfr-30m', purpose: 'LV-01: VFR (source frames n with n mod 7 == 3 dropped; pts keep the source clock)', width: 1920, height: 1080, fps: '30/1',
    frames: framesFor(1800, '30/1'), vfr: {dropMod: 7, dropRem: 3}, audio: STEREO48(), video: H264({bitrate: '600k'})},
  ...['A', 'B', 'C'].map((s, i) => ({id: `F8-1080p30-seg${s}-10m`, purpose: `LV-01 multi-segment composition: segment ${s} (consecutive identity)`, width: 1920, height: 1080,
    fps: '30/1', frames: framesFor(600, '30/1'), startFrame: startFrameAt(600 * i, '30/1'), audio: STEREO48(), video: H264({bitrate: '600k'})})),
];

const CALIB = [
  {id: 'C1-1080p30-2m', of: 'F1-1080p30-12h', frames: framesFor(120, '30/1')},
  {id: 'C2-1080p2997-2m', of: 'F2-1080p2997-12h', frames: framesFor(120, '30000/1001')},
  {id: 'C3-360p2997-late-2m', of: 'F3-360p2997-25h', frames: framesFor(120, '30000/1001'), startFrame: startFrameAt(89400, '30000/1001'),
    purpose: 'identity-space test at 24:50:00 (frame 2679321): the 48 kHz absolute sample index crosses 2^32 78.47 s into this clip'},
  {id: 'C4-2160p30-2m', of: 'F4-2160p30-30m', frames: framesFor(120, '30/1')},
  {id: 'C5-1080p60-51-2m', of: 'F5-1080p60-51-30m', frames: framesFor(120, '60/1')},
  {id: 'C6-1080p30-noaudio-2m', of: 'F6-1080p30-noaudio-30m', frames: framesFor(120, '30/1')},
  {id: 'C7-1080p30-vfr-2m', of: 'F7-1080p30-vfr-30m', frames: framesFor(120, '30/1')},
  {id: 'C8-1080p30-segA-1m', of: 'F8-1080p30-segA-10m', frames: framesFor(60, '30/1'), startFrame: 0},
  {id: 'C8-1080p30-segB-1m', of: 'F8-1080p30-segB-10m', frames: framesFor(60, '30/1'), startFrame: framesFor(60, '30/1')},
];

export function makeSpec(o) {
  const s = {set: 'unit', startFrame: 0, vfr: null, audio: null, label: '', ...o};
  if (!s.id || !s.width || !s.height || !s.fps || !s.frames || !s.video) throw new TypeError('spec needs id, width, height, fps, frames, video');
  if (!s.label) s.label = `${s.id.split('-').slice(0, 2).join(' ')}${s.vfr ? ' VFR' : ''}`;
  return s;
}

const longById = new Map(LONG.map(f => [f.id, makeSpec({...f, set: 'long', label: ''})]));
const calibById = new Map(CALIB.map(c => {
  const base = longById.get(c.of);
  return [c.id, makeSpec({...base, ...c, set: 'calib', purpose: c.purpose || `calibration (2 min) version of ${c.of}: identical encoder settings`, label: ''})];
}));

export const LONG_IDS = [...longById.keys()];
export const CALIB_IDS = [...calibById.keys()];
export function getSpec(id) {
  const s = longById.get(id) || calibById.get(id);
  if (!s) throw new Error(`unknown fixture id ${id}; known: ${[...LONG_IDS, ...CALIB_IDS].join(', ')}`);
  return structuredClone(s);
}

export const isDropped = (absIndex, vfr) => !!vfr && absIndex % vfr.dropMod === vfr.dropRem;

/** Exact expectations derived from a spec. */
export function derive(spec) {
  const fps = parseRational(spec.fps);
  const duration = framePts(spec.frames, fps);
  const videoStart = framePts(spec.startFrame, fps);
  let outputFrames = spec.frames;
  if (spec.vfr) {
    const {dropMod: m, dropRem: r} = spec.vfr;
    const cnt = (end) => (end <= r ? 0 : Math.floor((end - 1 - r) / m) + 1); // abs indices < end with i % m == r
    outputFrames = spec.frames - (cnt(spec.startFrame + spec.frames) - cnt(spec.startFrame));
  }
  const lastSource = (() => { let i = spec.frames - 1; while (i > 0 && isDropped(spec.startFrame + i, spec.vfr)) i--; return i; })();
  const d = {
    fps, fpsString: ratString(fps), durationSeconds: duration, durationDecimal: toDecimalString(duration, 6),
    videoStartSeconds: videoStart, videoStartDecimal: toDecimalString(videoStart, 9),
    sourceFrames: spec.frames, outputFrames, lastSourceLocalIndex: lastSource, lastAbsIndex: spec.startFrame + lastSource,
    lastPtsSeconds: framePts(lastSource, fps),
  };
  if (spec.audio) {
    const R = spec.audio.sampleRate;
    d.audioStartSample = toSafeNumber(roundHalfUpBig(mul(videoStart, rat(R))), 'audio start sample');
    d.audioSamples = toSafeNumber(ceilBig(mul(duration, rat(R))), 'audio samples');
  }
  const kbps = v => Number(String(v).replace(/k$/i, '')) * (/(k)$/i.test(String(v)) ? 1000 : 1);
  const secs = Number(duration.num) / Number(duration.den);
  const aBps = spec.audio ? kbps(spec.audio.bitrate) : 0;
  // ABR without VBV (deterministic) converges on the target over the run; 1.25x is the planning worst case.
  // With an explicit maxrate the VBV cap bounds it instead.
  const vWorst = spec.video.maxrate ? kbps(spec.video.maxrate) : 1.25 * kbps(spec.video.bitrate);
  d.estimateBytes = {
    expected: Math.ceil(secs * (kbps(spec.video.bitrate) + aBps) / 8 * 1.01 + 2 ** 20),
    worstCase: Math.ceil(secs * (vWorst + aBps) / 8 * 1.03 + 2 ** 21),
  };
  return d;
}

/** Rebuilds a spec from a fixture manifest (manifest.spec is describe() output). */
export function specFromManifest(m) {
  const s = m.spec;
  return makeSpec({id: s.id, set: s.set, purpose: s.purpose, width: s.width, height: s.height, fps: s.fps, frames: s.sourceFrames,
    startFrame: s.startFrame, vfr: s.vfr, audio: s.audio, video: s.video});
}

export function describe(spec) {
  const d = derive(spec);
  return {
    id: spec.id, set: spec.set, purpose: spec.purpose, width: spec.width, height: spec.height, fps: d.fpsString,
    sourceFrames: d.sourceFrames, outputFrames: d.outputFrames, startFrame: spec.startFrame, vfr: spec.vfr,
    durationSeconds: d.durationDecimal, audio: spec.audio, video: spec.video, estimateBytes: d.estimateBytes,
  };
}
