import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { useTempRoots } from "../test/tempRoot.mjs";
import { clipAudioEnvelopeFilter } from "./clipAudioEnvelopeFilters";
import { globalAudioWindowsV1, prepareGlobalAudioPassV1, writeGlobalAudioPassV1 } from "./globalAudioPassV1";
import { buildRenderPlan } from "./planner";
import { runWithRenderWorkRootV1 } from "./renderWorkspace";

const run = promisify(execFile), temp = useTempRoots(), ffmpeg = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobe = resolve("vendor/ffmpeg/win32-x64/ffprobe.exe");
let root = "";
beforeAll(async () => {
  root = await temp.create("global-audio-pass-");
  for (const [name, rate, codec] of [["48000.wav", "48000", "pcm_f32le"], ["44100.wav", "44100", "pcm_f32le"], ["44100.m4a", "44100", "aac"]]) {
    await run(ffmpeg, ["-n", "-v", "error", "-f", "lavfi", "-i", `aevalsrc=0.16*sin(2*PI*523*t)+0.06*sin(2*PI*1573*t):s=${rate}:d=1.6`,
      "-c:a", codec, ...(codec === "aac" ? ["-b:a", "192k"] : []), join(root, name)], { windowsHide: true, timeout: 30_000 });
  }
}, 40_000);

function fixture(name: string) {
  const project = createEmptyProject("continuous audio clocks", { width: 128, height: 72, fps: 30 });
  for (const [id, path, role] of [["voice", name, "dialogue"], ["music", "48000.wav", "background-music"]]) {
    project.assets.push({ id, name: id, kind: "audio", uri: join(root, path), duration: 1.6, role });
    project.tracks.push({ id, name: id, kind: "audio", muted: false, locked: false, clips: [{ id: `${id}-clip`, assetId: id, trackId: id,
      timelineStart: id === "voice" ? .01703125 : 0, sourceStart: id === "voice" ? .13917 : .123, duration: id === "voice" ? 1.1 : 1.4,
      volume: id === "voice" ? .8 : .35, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
      ...(id === "voice" ? { audioEnvelope: { schema: "editkin.clip-audio-envelope/v1" as const,
        fades: { in: .18, out: .22, duration: 1.1, offset: 0 }, volume: { offset: .03, points: [{ id: "a", time: 0, db: -8 }, { id: "b", time: .8, db: 2 }, { id: "c", time: 1.2, db: -3 }] } } } : {}) }] });
  }
  return project;
}

/** Independent reference: decode each original from sample zero once, with no seeks or window-local envelopes. */
async function continuousReference(project: ReturnType<typeof fixture>, samples: number) {
  const args = ["-v", "error", "-f", "lavfi", "-t", String(samples / 48000), "-i", "anullsrc=r=48000:cl=stereo"],
    filters = [`[0:a]atrim=end_sample=${samples},asplit=2[v0][m0]`];
  let index = 1;
  for (const track of project.tracks.filter(track => track.kind === "audio")) for (const clip of track.clips) {
    const asset = project.assets.find(asset => asset.id === clip.assetId)!;
    args.push("-i", asset.uri);
    const start = Math.round(clip.sourceStart * 48000), length = Math.round((clip.timelineStart + clip.duration) * 48000) - Math.round(clip.timelineStart * 48000);
    const music = asset.role === "background-music", fade = Math.min(1.2, clip.duration / 5);
    const envelope = clip.audioEnvelope ? clipAudioEnvelopeFilter(clip, music) : music ? `,afade=t=in:st=0:d=${fade},afade=t=out:st=${clip.duration - fade}:d=${fade}` : "";
    filters.push(`[${index}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=start_sample=${start}:end_sample=${start + length},asetpts=PTS-STARTPTS${envelope},adelay=${Math.round(clip.timelineStart * 48000)}S:all=1,volume=${clip.volume}[a${index}]`);
    filters.push(`[${music ? "m0" : "v0"}][a${index}]amix=inputs=2:duration=longest:normalize=0,apad=whole_len=${samples},atrim=end_sample=${samples},aformat=sample_fmts=fltp:channel_layouts=stereo[${music ? "music" : "voice"}]`);
    index++;
  }
  filters.push("[voice][music]join=inputs=2:channel_layout=quad:map=0.0-FL|0.1-FR|1.0-BL|1.1-BR[lanes]");
  const { stdout } = await run(ffmpeg, [...args, "-filter_complex", filters.join(";"), "-map", "[lanes]", "-c:a", "pcm_f32le", "-ar", "48000", "-ac", "4", "-channel_layout", "quad", "-f", "f32le", "pipe:1"],
    { windowsHide: true, timeout: 30_000, encoding: "buffer", maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

describe("global PCM windows before the single master/codec", () => {
  it("carries a24h sample clock beyond signed32bit without reading full-duration media", () => {
    const samples = 24 * 3600 * 48000, windows = [...globalAudioWindowsV1(samples)];
    expect(samples).toBeGreaterThan(2 ** 31); expect(windows).toHaveLength(1440);
    expect(windows.at(-1)!.startSample + windows.at(-1)!.sampleCount).toBe(samples);
    expect(windows.reduce((sum, window) => sum + window.sampleCount, 0)).toBe(samples);
  });

  it.each([["48000.wav", 1e-5], ["44100.wav", 1e-5], ["44100.m4a", .003]])("preserves %s source phase, fades, points and quad order across odd windows", async (name, tolerance) => {
    const project = fixture(name), before = JSON.stringify(project), samples = 67200, work = join(root, name.replace(".", "-") + "-work"); await mkdir(work);
    const plan = await prepareGlobalAudioPassV1(project, buildRenderPlan(project, uri => uri), ffprobe, 30_000), blocks: Buffer[] = [];
    const receipt = await runWithRenderWorkRootV1(work, () => writeGlobalAudioPassV1(plan, { samples, ffmpegPath: ffmpeg, timeoutMs: 30_000,
      windowSamples: 5003, signal: new AbortController().signal, async write(bytes) { expect(bytes.byteLength).toBeLessThanOrEqual(262144); blocks.push(Buffer.from(bytes)); } }));
    const expected = await continuousReference(project, samples), actual = Buffer.concat(blocks);
    expect(actual.length).toBe(samples * 16); expect(actual.length).toBe(expected.length);
    let peak = 0, squared = 0;
    for (let i = 0; i < actual.length; i += 4) { const error = Math.abs(actual.readFloatLE(i) - expected.readFloatLE(i)); peak = Math.max(peak, error); squared += error * error; }
    expect(peak).toBeLessThanOrEqual(tolerance); expect(Math.sqrt(squared / (actual.length / 4))).toBeLessThanOrEqual(name.endsWith("m4a") ? 2e-4 : 1e-6);
    expect(receipt).toMatchObject({ samples, bytes: samples * 16, windows: 14, wholeAudioStagingBytes: 0 });
    expect(receipt.peakWindowBytes).toBe(5003 * 16); expect(JSON.stringify(project)).toBe(before);
  }, 60_000);

  it("does not silently finish after the downstream encoder rejects a PCM write", async () => {
    const project = fixture("48000.wav"), plan = await prepareGlobalAudioPassV1(project, buildRenderPlan(project, uri => uri), ffprobe, 30_000), reason = Error("PCM_DESTINATION_STOPPED");
    await expect(writeGlobalAudioPassV1(plan, { samples: 67200, ffmpegPath: ffmpeg, timeoutMs: 30_000, signal: new AbortController().signal,
      async write() { throw reason; } })).rejects.toBe(reason);
  }, 30_000);
});
