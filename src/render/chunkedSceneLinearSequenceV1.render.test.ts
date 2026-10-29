import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { useTempRoots } from "../test/tempRoot.mjs";
import { renderProject, type RenderOptions } from "./ffmpeg";
import type { NativeAces2OutputTransform } from "./aces2SdrVideo";
const run = promisify(execFile), temp = useTempRoots(), ffmpeg = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"),
  ffprobe = resolve("vendor/ffmpeg/win32-x64/ffprobe.exe"), native = resolve("native/bin/win32-x64/editkin-gpu-compositor.exe");
let root = "", first = "", second = "", audio = "";
beforeAll(async () => {
  root = await temp.create("c4-native-"); first = join(root, "first.ekf32"); second = join(root, "second.ekf32"); audio = join(root, "original.wav");
  for (const [path, phase] of [[first, 0], [second, 1]] as const) {
    const bytes = Buffer.alloc(16 + 64 * 36 * 16); Buffer.from([69, 75, 70, 51, 50, 86, 49, 0]).copy(bytes); bytes.writeUInt32LE(64, 8); bytes.writeUInt32LE(36, 12);
    for (let y = 0; y < 36; y++) for (let x = 0; x < 64; x++) [phase ? .07 : .04 + x / 16, phase ? 3.5 : .03 + y / 18, phase ? .12 : .2 + (x % 7) / 9, 1]
      .forEach((value, channel) => bytes.writeFloatLE(value, 16 + ((y * 64 + x) * 4 + channel) * 4));
    await writeFile(path, bytes, { flag: "wx" });
  }
  await run(ffmpeg, ["-n", "-v", "error", "-f", "lavfi", "-i", "aevalsrc=0.12*sin(2*PI*443*t)+0.025*sin(2*PI*1297*t):s=48000:d=4", "-c:a", "pcm_f32le", "-ac", "2", audio], { windowsHide: true, timeout: 30_000 });
}, 40_000);
function fixture(output: NativeAces2OutputTransform, seconds = .5, fps = 24, sound = false) {
  const p = createEmptyProject("bounded float native", { width: 64, height: 36, fps });
  p.colorManagement = { ...p.colorManagement!, mode: "aces2", outputTransform: output };
  for (const [id, uri] of [["first", first], ["second", second]]) p.assets.push({ id, name: id, kind: "image", uri, duration: seconds, width: 64, height: 36,
    alphaMode: "straight", color: { interpretation: "linear_rec709" } });
  for (const [id, start, duration] of [["first", 0, .25], ["second", .25, seconds - .25]] as const) p.tracks[0].clips.push({ id, assetId: id, trackId: p.tracks[0].id,
    timelineStart: start, sourceStart: 0, duration, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
  if (sound) {
    for (const [id, role, volume, timelineStart, duration] of [["voice", "dialogue", .8, .03125, seconds - .1], ["music", "background-music", .2, 0, seconds]] as const) {
      p.assets.push({ id, kind: "audio", name: id, uri: audio, duration: 4, role });
      p.tracks.push({ id, name: id, kind: "audio", locked: false, muted: false, clips: [{ ...p.tracks[0].clips[0], id, trackId: id, assetId: id,
        timelineStart, sourceStart: .08325, duration, volume }] });
    }
    p.captionStyle = { ...p.captionStyle, fontSize: 12, marginV: 2, outlineWidth: 1 };
    p.captions = [{ id: "caption", text: "CLOCK", start: .135, duration: 1.511 }];
  }
  return p;
}
async function renderPair(name: string, project: ReturnType<typeof fixture>) {
  const directory = join(root, name), work = join(directory, "work"), journals = join(directory, "journals"); await mkdir(work, { recursive: true });
  const options: RenderOptions = { ffmpegPath: ffmpeg, ffprobePath: ffprobe, gpuCompositorPath: native, preferGpu: false, workRoot: work,
    fontRoot: resolve("public/fonts"), colorRoot: resolve("public/color/aces2"), nativeCorePath: join(root, "no-audio-override.exe"), timeoutMs: 60_000, stallTimeoutMs: 15_000 };
  const before = JSON.stringify(project), reference = await renderProject(project, join(directory, "reference.mp4"), options),
    result = await renderProject(project, join(directory, "candidate.mp4"), { ...options, longRender: { forceClass: "long", policy: { stagingCapBytes: 1024 ** 2 }, journalRegistryRoot: journals } });
  const frames = async (path: string) => (await run(ffmpeg, ["-v", "error", "-i", path, "-map", "0:v:0", "-f", "framemd5", "pipe:1"], { windowsHide: true, timeout: 30_000 })).stdout
    .split(/\r?\n/).filter(row => row && !row.startsWith("#"));
  const actualFrames = await frames(result.outputPath), expectedFrames = await frames(reference.outputPath);
  expect(actualFrames).toEqual(expectedFrames); expect(actualFrames.length).toBe(Math.round(result.duration * project.fps));
  const pipeline = result.chunkedSceneLinearPipeline!; expect(pipeline.chunks).toBeGreaterThanOrEqual(2);
  expect(pipeline.encoderClosed).toBe(true); expect(pipeline.encoderFrames).toBe(actualFrames.length); expect(pipeline.finalEncoderInstances).toBe(1);
  expect(pipeline.videoIntermediateBytes).toBe(0); expect(pipeline.peakBatchBytes).toBeLessThanOrEqual(pipeline.maximumBatchBytes);
  expect(pipeline.metadataBytes).toBeLessThanOrEqual(pipeline.maximumMetadataBytes); expect(result.longRender!.publish.checks.every(check => check.ok)).toBe(true);
  expect(JSON.stringify(project)).toBe(before); expect(await readdir(work)).toEqual([]); expect(await readdir(journals)).toEqual([]);
  const receipts = process.env.EDITKIN_TEST_RESULT_ROOT;
  if (receipts) {
    await mkdir(receipts, { recursive: true }); for (const [path, suffix] of [[reference.outputPath, "reference"], [result.outputPath, "candidate"]]) await copyFile(path, join(receipts, `${name}-${suffix}.mp4`));
    await writeFile(join(receipts, name + ".json"), JSON.stringify({ reference, result, decodedFrames: actualFrames }, null, 2), { flag: "wx" });
  }
  return { reference, result };
}
describe("real scene-linear GPU batches and one final encode", () => {
  it.each(["rec709_sdr", "rec2100_hlg_1000", "rec2100_pq_1000"] as const)("preserves decoded%s frames across two different scenes", async output => {
    const pair = await renderPair(output, fixture(output)); expect(pair.result.chunkedSceneLinearPipeline!.frames).toBe(12);
  }, 90_000);
  it("retains global ASS and96480samples through a60frame fractionalNTSC output", async () => {
    const pair = await renderPair("ntsc-audio-ass", fixture("rec709_sdr", 2.01, 30000 / 1001, true));
    const decode = async (path: string) => (await run(ffmpeg, ["-v", "error", "-i", path, "-map", "0:a:0", "-t", "2.01", "-ar", "48000", "-ac", "2", "-f", "f32le", "pipe:1"],
      { windowsHide: true, timeout: 30_000, encoding: "buffer", maxBuffer: 2 * 1024 ** 2 })).stdout;
    const actual = await decode(pair.result.outputPath), expected = await decode(pair.reference.outputPath); expect(actual.length).toBe(96480 * 8); expect(expected.length).toBe(actual.length);
    let squared = 0; for (let offset = 0; offset < actual.length; offset += 4) squared += (actual.readFloatLE(offset) - expected.readFloatLE(offset)) ** 2;
    const rms = Math.sqrt(squared / (actual.length / 4)); expect(rms).toBeLessThanOrEqual(3e-4);
    expect(pair.result.chunkedSceneLinearPipeline!.audio).toMatchObject({ samples: 96480, wholeAudioStagingBytes: 0, pcmBufferAllocations: 1 });
    const receipts = process.env.EDITKIN_TEST_RESULT_ROOT;
    if (receipts) await writeFile(join(receipts, "FULL_AUDIO_RMS.json"), JSON.stringify({ rms, samples: 96480, frames: 60, seconds: 2.01 }, null, 2), { flag: "wx" });
  }, 120_000);
});
