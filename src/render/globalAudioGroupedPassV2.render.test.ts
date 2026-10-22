import { execFile } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { useTempRoots } from "../test/tempRoot.mjs";
import { buildRenderPlan } from "./planner";
import { prepareGlobalAudioPassV1, writeGlobalAudioPassV1 } from "./globalAudioPassV1";
import { runWithRenderWorkRootV1 } from "./renderWorkspace";

const run = promisify(execFile), temp = useTempRoots(), ffmpeg = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobe = resolve("vendor/ffmpeg/win32-x64/ffprobe.exe");
let root = "", source = "";
beforeAll(async () => {
  root = await temp.create("ga2-"); source = join(root, "stereo.wav");
  await run(ffmpeg, ["-n", "-v", "error", "-f", "lavfi", "-i", "aevalsrc=0.04*sin(2*PI*440*t)|0.03*sin(2*PI*880*t):s=48000:d=0.5", "-c:a", "pcm_f32le", source],
    { windowsHide: true, timeout: 30_000 });
}, 40_000);
function fixture(voice: number, music: number) {
  const value = createEmptyProject("grouped audio", { width: 128, height: 72, fps: 30 });
  for (const [id, count, role] of [["voice", voice, "dialogue"], ["music", music, "background-music"]] as const) {
    value.assets.push({ id, name: id, uri: source, kind: "audio", duration: .5, role });
    for (let i = 0; i < count; i++) value.tracks.push({ id: `${id}-${i}`, name: id, kind: "audio", muted: false, locked: false,
      clips: [{ id: `${id}${i}`, assetId: id, trackId: `${id}-${i}`, timelineStart: 0, sourceStart: 0,
        duration: .18, volume: .005 + i % 5 * .001, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
        audioEnvelope: { schema: "editkin.clip-audio-envelope/v1" as const, fades: { in: 0, out: 0, duration: .18, offset: 0 } } }] });
  }
  return value;
}
describe("actual grouped PCM fan-in beyond64 clips", () => {
  it.each([[65, 0], [33, 40]])("mixes%d voice and%d music overlaps in one reusable PCM allocation", async (voice, music) => {
    const project = fixture(voice, music), before = JSON.stringify(project), samples = 8640, work = join(root, `w-${voice}-${music}`); await mkdir(work);
    const audio = await prepareGlobalAudioPassV1(project, buildRenderPlan(project, uri => uri), ffprobe, 30_000), blocks: Buffer[] = [];
    const result = await runWithRenderWorkRootV1(work, () => writeGlobalAudioPassV1(audio, { samples, windowSamples: 5003,
      ffmpegPath: ffmpeg, timeoutMs: 30_000, signal: new AbortController().signal, async write(bytes) { blocks.push(Buffer.from(bytes)); } }));
    const expected = (await run(ffmpeg, ["-v", "error", "-i", source, "-af", `atrim=end_sample=${samples}`, "-ar", "48000", "-ac", "2", "-f", "f32le", "pipe:1"],
      { windowsHide: true, timeout: 30_000, encoding: "buffer", maxBuffer: 1024 ** 2 })).stdout;
    const actual = Buffer.concat(blocks), gain = (role: string) => project.tracks.filter(track => track.name === role).flatMap(track => track.clips).reduce((sum, clip) => sum + clip.volume, 0);
    const voiceGain = gain("voice"), musicGain = gain("music");
    expect(actual.length).toBe(samples * 16); expect(expected.length).toBe(samples * 8);
    let peak = 0, squared = 0;
    for (let i = 0; i < samples; i++) for (let lane = 0; lane < 4; lane++) {
      const reference = expected.readFloatLE(i * 8 + lane % 2 * 4) * (lane < 2 ? voiceGain : musicGain);
      const error = Math.abs(actual.readFloatLE(i * 16 + lane * 4) - reference); peak = Math.max(peak, error); squared += error * error;
    }
    expect(peak).toBeLessThanOrEqual(5e-6); expect(Math.sqrt(squared / (samples * 4))).toBeLessThanOrEqual(5e-7);
    expect(result.peakGroups).toBeGreaterThan(1); expect(result.peakInputs).toBeLessThanOrEqual(64);
    expect(result.pcmBufferAllocations).toBe(1); expect(result.allocatedPcmBytes).toBe(5003 * 16);
    expect(result.wholeAudioStagingBytes).toBe(0); expect(JSON.stringify(project)).toBe(before); expect(await readdir(work)).toEqual([]);
    const receipts = process.env.EDITKIN_TEST_RESULT_ROOT;
    if (receipts) { await mkdir(receipts, { recursive: true }); await writeFile(join(receipts, `grouped-${voice}-${music}.json`), JSON.stringify({ result, peak, rms: Math.sqrt(squared / (samples * 4)) }, null, 2), { flag: "wx" }); }
  }, 60_000);
  it("settles grouped producers before propagating the downstream error", async () => {
    const project = fixture(65, 0), work = join(root, "failed"); await mkdir(work);
    const audio = await prepareGlobalAudioPassV1(project, buildRenderPlan(project, uri => uri), ffprobe, 30_000), reason = Error("GROUPED_PCM_SINK_FAILED");
    await expect(runWithRenderWorkRootV1(work, () => writeGlobalAudioPassV1(audio, { samples: 8640, windowSamples: 5003,
      ffmpegPath: ffmpeg, timeoutMs: 30_000, signal: new AbortController().signal, async write() { throw reason; } }))).rejects.toBe(reason);
    expect(await readdir(work)).toEqual([]);
  }, 60_000);
  it("clears reused PCM when a voiced window is followed by empty windows", async () => {
    const project = fixture(1, 0), work = join(root, "silent-tail"); await mkdir(work);
    const audio = await prepareGlobalAudioPassV1(project, buildRenderPlan(project, uri => uri), ffprobe, 30_000), blocks: Buffer[] = [];
    const result = await runWithRenderWorkRootV1(work, () => writeGlobalAudioPassV1(audio, { samples: 16000, windowSamples: 5003,
      ffmpegPath: ffmpeg, timeoutMs: 30_000, signal: new AbortController().signal, async write(bytes) { blocks.push(Buffer.from(bytes)); } }));
    const actual = Buffer.concat(blocks);
    expect(actual.subarray(0, 8640 * 16).some(byte => byte !== 0)).toBe(true);
    expect(actual.subarray(8640 * 16).every(byte => byte === 0)).toBe(true);
    expect(result).toMatchObject({ windows: 4, processes: 2, pcmBufferAllocations: 1, allocatedPcmBytes: 5003 * 16 });
    expect(await readdir(work)).toEqual([]);
  }, 60_000);
});
