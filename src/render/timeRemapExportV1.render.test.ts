import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { renderProject } from "./ffmpeg";

/**
 * Real FFmpeg export of authored clip speeds through renderProject (the one export entry): 2x and 0.5x with sound,
 * 8x (muted by name), decoded duration/frame counts, frame-to-source correspondence, pitch and A/V sync.
 * Source: synthetic testsrc2 with full-frame white flashes and 1 kHz beeps at the same instants (2 s, 5 s, 8 s).
 */
const ffmpeg = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobe = resolve("vendor/ffmpeg/win32-x64/ffprobe.exe");
const run = promisify(execFile), fps = 30, events = [2, 5, 8];
let root: string, source: string, sourceSha: string;
const flash = events.map(t => `between(t,${t},${(t + 2 / fps - 0.001).toFixed(3)})`).join("+");
const beep = events.map(t => `between(t,${t},${t + 0.1})`).join("+");

beforeAll(async () => {
  root = await mkdtemp(join(resolve(process.env.TEMP!), "w24-speed-export-")); source = join(root, "sync-source.mp4");
  await run(ffmpeg, ["-n", "-v", "error", "-f", "lavfi", "-i", `testsrc2=s=640x360:r=${fps}:d=12,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='${flash}'`,
    "-f", "lavfi", "-i", `aevalsrc='if(${beep},0.5*sin(2*PI*1000*t),0)':s=48000:d=12`, "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-g", "30",
    "-c:a", "aac", "-b:a", "192k", "-shortest", source], { windowsHide: true });
  sourceSha = createHash("sha256").update(await readFile(source)).digest("hex");
}, 120_000);
afterAll(async () => {
  if (!root) return;
  if (!resolve(root).startsWith(resolve(process.env.TEMP!) + sep)) throw Error("cleanup outside owned TEMP");
  await rm(root, { recursive: true, force: true });
});

function project(clip: { speed: number; sourceStart: number; duration: number }, options: { aces2?: boolean } = {}): EditProject {
  const p = createEmptyProject("speed export", { id: "speed-export", width: 640, height: 360, fps });
  p.assets = [{ id: "sync", name: "sync source", kind: "video", uri: source, duration: 12, width: 640, height: 360, displayAspectRatio: 640 / 360,
    color: { interpretation: "rec709", primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" },
    derivatives: { sourceSha256: sourceSha, generatedAt: "2026-10-29T00:00:00.000Z" } }];
  p.tracks[0].clips = [{ id: "speed-clip", assetId: "sync", trackId: p.tracks[0].id, timelineStart: 0, sourceStart: clip.sourceStart,
    duration: clip.duration, volume: 1, speed: clip.speed, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }];
  if (options.aces2) p.colorManagement = { mode: "aces2", workingSpace: "ACEScct", outputTransform: "rec709_sdr", configId: "studio-config-v4.0.0_aces-v2.0_ocio-v2.5" } as EditProject["colorManagement"];
  return p;
}
const options = () => ({ ffmpegPath: ffmpeg, ffprobePath: ffprobe, preferGpu: false, fontRoot: resolve("public/fonts") });

async function probe(path: string) {
  const { stdout } = await run(ffprobe, ["-v", "error", "-count_frames", "-show_entries", "stream=codec_type,nb_read_frames,duration:format=duration", "-of", "json", path], { windowsHide: true });
  const data = JSON.parse(stdout) as { streams: Array<{ codec_type: string; nb_read_frames?: string; duration?: string }>; format: { duration: string } };
  return { frames: Number(data.streams.find(s => s.codec_type === "video")!.nb_read_frames), audioDuration: Number(data.streams.find(s => s.codec_type === "audio")?.duration ?? NaN),
    videoDuration: Number(data.streams.find(s => s.codec_type === "video")!.duration), duration: Number(data.format.duration) };
}
/** Frame times (s) whose mean luma marks a white flash: onsets only. */
async function flashOnsets(path: string) {
  const { stderr } = await run(ffmpeg, ["-v", "info", "-i", path, "-vf", "signalstats,metadata=print:key=lavfi.signalstats.YAVG", "-an", "-f", "null", "-"], { windowsHide: true, maxBuffer: 64 * 1024 ** 2 });
  const luma = [...stderr.matchAll(/lavfi\.signalstats\.YAVG=([0-9.]+)/g)].map(m => Number(m[1]));
  return luma.map((value, index) => value > 200 && (index === 0 || luma[index - 1] <= 200) ? index / fps : undefined).filter((t): t is number => t !== undefined);
}
/** Mono PCM of the output, for beep onsets (first sample above a quiet threshold after silence) and pitch. */
async function pcm(path: string) {
  const { stdout } = await run(ffmpeg, ["-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"], { windowsHide: true, encoding: "buffer", maxBuffer: 256 * 1024 ** 2 });
  const buffer = stdout as unknown as Buffer;
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
}
function beepOnsets(samples: Float32Array) {
  const onsets: number[] = []; let quietRun = 0;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) > 0.1) { if (quietRun > 4800) onsets.push(i / 48000); quietRun = 0; }
    else quietRun++;
  }
  if (samples.length && Math.abs(samples[0]) > 0.1) onsets.unshift(0);
  return onsets;
}
/** Zero-crossing frequency inside the window [start, start + seconds). */
function frequency(samples: Float32Array, start: number, seconds: number) {
  const from = Math.round(start * 48000), to = Math.min(samples.length, from + Math.round(seconds * 48000)); let crossings = 0;
  for (let i = from + 1; i < to; i++) if ((samples[i - 1] < 0) !== (samples[i] < 0)) crossings++;
  return crossings / 2 / ((to - from) / 48000);
}
async function framePsnr(output: string, outputTime: number, sourceTime: number) {
  const { stderr } = await run(ffmpeg, ["-v", "info", "-ss", outputTime.toFixed(4), "-i", output, "-ss", sourceTime.toFixed(4), "-i", source,
    "-lavfi", "[0:v]trim=end_frame=1[a];[1:v]trim=end_frame=1[b];[a][b]psnr", "-f", "null", "-"], { windowsHide: true });
  return Number(/average:([0-9.inf]+)/.exec(stderr)?.[1]);
}

describe("authored clip speed renders through the one export entry", () => {
  it.each([
    { name: "2x", speed: 2, sourceStart: 0, duration: 6, expectedEvents: [1, 2.5, 4] },
    { name: "0.5x", speed: 0.5, sourceStart: 1.5, duration: 8, expectedEvents: [1, 7] },
  ])("$name: exact length and frames, frames from the right source time, pitch kept, sound in sync", async ({ name, speed, sourceStart, duration, expectedEvents }) => {
    const output = join(root, `speed-${name}.mp4`);
    const result = await renderProject(project({ speed, sourceStart, duration }), output, options());
    expect(result.timeRemap).toMatchObject({ schema: "editkin.time-remap-export/v1", route: "source_clock_cache_bake",
      clips: [{ clipId: "speed-clip", speed, curve: false, frames: duration * fps, audio: "pitch_preserved", audioEngine: "shared_bin_phase_vocoder_v1" }] });
    const measured = await probe(output);
    expect(measured.frames).toBe(duration * fps);
    expect(Math.abs(measured.videoDuration - duration)).toBeLessThanOrEqual(1 / fps);
    expect(Math.abs(measured.audioDuration - duration)).toBeLessThanOrEqual(0.05);
    // Every output frame comes from sourceStart + t * speed (a 1x mapping would not match).
    const psnr: Array<[number, number, number]> = [];
    for (const t of [0.4, duration / 2 + 0.2]) {
      const right = await framePsnr(output, t, sourceStart + t * speed), wrong = await framePsnr(output, t, sourceStart + t);
      psnr.push([t, right, wrong]);
      // One frame each: the matching source frame survives the bake and the x264 encode (~40 dB); a 1x mapping does not.
      expect(right).toBeGreaterThan(35); expect(right).toBeGreaterThan(wrong + 10);
    }
    console.log(`W24_PSNR_${name}=${JSON.stringify(psnr)}`);
    const flashes = await flashOnsets(output), samples = await pcm(output), beeps = beepOnsets(samples);
    expect(flashes.map(t => Number(t.toFixed(3)))).toEqual(expectedEvents.map(t => Number(t.toFixed(3))));
    expect(beeps).toHaveLength(expectedEvents.length);
    // A/V sync: each beep starts within 45 ms of its flash (about one frame plus vocoder framing).
    beeps.forEach((t, index) => expect(Math.abs(t - flashes[index])).toBeLessThanOrEqual(0.045));
    // Pitch kept: the 1 kHz beep stays 1 kHz (2x would be 2 kHz, 0.5x 500 Hz without pitch correction).
    expect(frequency(samples, beeps[0] + 0.02, Math.min(0.04, 0.1 / speed - 0.03))).toBeGreaterThan(900);
    expect(frequency(samples, beeps[0] + 0.02, Math.min(0.04, 0.1 / speed - 0.03))).toBeLessThan(1100);
    console.log(`W24_SPEED_${name}=${JSON.stringify({ result: result.timeRemap, measured, flashes, beeps })}`);
    // A second export of the same clip reuses the cached bake.
    const again = await renderProject(project({ speed, sourceStart, duration }), join(root, `speed-${name}-again.mp4`), options());
    expect(again.timeRemap?.clips[0].cacheHit).toBe(true);
  }, 600_000);

  it("8x keeps the picture and mutes the sound by name (outside the 0.5–4x pitch-preserving range)", async () => {
    const output = join(root, "speed-8x.mp4");
    const result = await renderProject(project({ speed: 8, sourceStart: 0, duration: 1.5 }), output, options());
    expect(result.timeRemap?.clips[0]).toMatchObject({ speed: 8, frames: 45, audio: "muted", muteReason: "speed_outside_pitch_range" });
    expect((await probe(output)).frames).toBe(45);
    const samples = await pcm(output);
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0)).toBeLessThan(0.01);
    // Frames come from t * 8: output 0.5 s shows source 4.0 s.
    expect(await framePsnr(output, 0.5, 4)).toBeGreaterThan(35);
  }, 600_000);

  it("refuses what the export cannot render with the named reason, before any bake", async () => {
    const output = join(root, "aces", "speed-aces.mp4");
    await expect(renderProject(project({ speed: 2, sourceStart: 0, duration: 4 }, { aces2: true }), output, options())).rejects.toThrow("CLIP_SPEED_ACES2_UNSUPPORTED");
    await expect(readdir(join(root, "aces"))).rejects.toThrow();
  }, 120_000);
});
