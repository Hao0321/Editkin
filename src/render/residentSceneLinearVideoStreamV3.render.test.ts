import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, watch, type FSWatcher } from "node:fs";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { useTempRoots } from "../test/tempRoot.mjs";
import { renderProject, type RenderOptions } from "./ffmpeg";
import { probeVolumeSpace } from "./renderDiskSpace";

const run = promisify(execFile), temp = useTempRoots(), ffmpeg = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobe = resolve("vendor/ffmpeg/win32-x64/ffprobe.exe"),
  native = resolve("native/bin/win32-x64/editkin-gpu-compositor.exe");
let root = "", source = "", audio = "";
beforeAll(async () => {
  root = await temp.create("rv3-"); source = join(root, "original.mp4"); audio = join(root, "voice.wav");
  await run(ffmpeg, ["-n", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=128x72:r=24:d=4", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16",
    "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", source], { windowsHide: true, timeout: 30_000 });
  await run(ffmpeg, ["-n", "-v", "error", "-f", "lavfi", "-i", "aevalsrc=0.12*sin(2*PI*440*t):s=48000:d=4", "-c:a", "pcm_f32le", audio], { windowsHide: true, timeout: 30_000 });
  const receipts = process.env.EDITKIN_TEST_RESULT_ROOT;
  if (receipts) {
    await mkdir(receipts, { recursive: true });
    for (const [path, name] of [[source, "original.mp4"], [audio, "voice.wav"]]) await copyFile(path, join(receipts, name), constants.COPYFILE_EXCL);
  }
}, 40_000);
function fixture(split: boolean, seconds = 2) {
  const project = createEmptyProject("resident V3 control", { width: 128, height: 72, fps: 24 });
  project.colorManagement = { ...project.colorManagement!, mode: "aces2", outputTransform: "rec709_sdr" };
  project.assets.push({ id: "src", name: "original", kind: "video", uri: source, duration: 4, width: 128, height: 72, displayAspectRatio: 128 / 72,
    color: { interpretation: "rec709", primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" },
    derivatives: { sourceSha256: "a".repeat(64), generatedAt: "2026-10-18T00:00:00Z", proxyUri: join(root, "MUST_NOT_READ_PROXY.mp4"), proxyWidth: 16, proxyHeight: 8 } });
  project.tracks[0].clips.push({ id: "v", assetId: "src", trackId: project.tracks[0].id, timelineStart: 0, sourceStart: 0, duration: seconds,
    volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
  project.assets.push({ id: "voice", name: "voice", kind: "audio", uri: audio, duration: 4, role: "dialogue" });
  project.tracks.push({ id: "a", name: "voice", kind: "audio", muted: false, locked: false,
    clips: Array.from({ length: split ? 65 : 1 }, (_, i) => ({ id: `a${i}`, assetId: "voice", trackId: "a",
      timelineStart: split ? i * .025 : 0, sourceStart: split ? i * .025 : 0, duration: split ? .025 : 1.625, volume: .35,
      transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] })) });
  return project;
}
async function sandbox(name: string) {
  const folder = join(root, name), work = join(folder, "work"), journals = join(folder, "journals"); await mkdir(work, { recursive: true });
  const options: RenderOptions = { ffmpegPath: ffmpeg, ffprobePath: ffprobe, gpuCompositorPath: native, preferGpu: false,
    workRoot: work, fontRoot: resolve("public/fonts"), colorRoot: resolve("public/color/aces2"), timeoutMs: 90_000, stallTimeoutMs: 15_000,
    longRender: { forceClass: "long", journalRegistryRoot: journals } };
  return { folder, work, journals, options };
}
async function frames(path: string) {
  return (await run(ffmpeg, ["-v", "error", "-i", path, "-map", "0:v:0", "-f", "framemd5", "pipe:1"],
    { windowsHide: true, timeout: 30_000, maxBuffer: 1024 ** 2 })).stdout.split(/\r?\n/).filter(line => line && !line.startsWith("#"));
}
async function pcm(path: string) {
  return (await run(ffmpeg, ["-v", "error", "-i", path, "-map", "0:a:0", "-t", "2", "-ar", "48000", "-ac", "2", "-f", "f32le", "pipe:1"],
    { windowsHide: true, timeout: 30_000, encoding: "buffer", maxBuffer: 2 * 1024 ** 2 })).stdout;
}
describe("real native resident V3 with global grouped audio", () => {
  it.each([0, .01])("renders65 sequential audio clips with a%ds partial-frame tail and the same decoded video/audio as V2", async tail => {
    const suffix = tail ? "_tail" : "", box = await sandbox("complete" + suffix), project = fixture(true, 2 + tail), before = JSON.stringify(project), originalSha = createHash("sha256").update(await readFile(source)).digest("hex");
    const reference = await renderProject(fixture(false, 2 + tail), join(box.folder, "v2.mp4"), box.options);
    const result = await renderProject(project, join(box.folder, "v3.mp4"), box.options);
    expect(reference.longRender?.route).toBe("resident-stream-v2"); expect(result.longRender?.route).toBe("resident-stream-v3");
    expect(result.residentStreamV3Pipeline).toMatchObject({ schema: "editkin.resident-png-stream/v3", consumedFrames: 48,
      encoderWrites: 48, encoderClosed: true, retainedConsumedFrames: 0, maximumPendingDiskFrames: 1, finalEncoderInstances: 1,
      audio: { samples: Math.round((2 + tail) * 48000), bytes: Math.round((2 + tail) * 48000) * 16, pcmBufferAllocations: 1, wholeAudioStagingBytes: 0 } });
    expect(result.residentStreamV3Pipeline!.peakQueuedFrames).toBeLessThanOrEqual(result.residentStreamV3Pipeline!.queueCapacity);
    expect(result.residentVideoPipeline?.firstFrameSha256).toBe(reference.residentVideoPipeline?.firstFrameSha256);
    expect(result.residentVideoPipeline?.lastFrameSha256).toBe(reference.residentVideoPipeline?.lastFrameSha256);
    expect(await frames(result.outputPath)).toEqual(await frames(reference.outputPath));
    if (tail) {
      const short = await renderProject(fixture(false, 2 + tail), join(box.folder, "short.mp4"), { ...box.options, longRender: undefined });
      expect(await frames(short.outputPath)).toEqual(await frames(result.outputPath));
      const raw = await run(ffprobe, ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=duration_ts,time_base,sample_rate", "-of", "json", short.outputPath], { windowsHide: true, timeout: 30_000 });
      const stream = JSON.parse(raw.stdout).streams[0], [n, d] = stream.time_base.split("/").map(Number);
      const samples = Math.round(Number(stream.duration_ts) * n / d * Number(stream.sample_rate));
      expect(Math.abs(samples - 96480)).toBeLessThanOrEqual(1024);
    }
    const [actual, expected] = await Promise.all([pcm(result.outputPath), pcm(reference.outputPath)]); expect(actual.length).toBe(expected.length);
    let squared = 0, peak = 0;
    for (let i = 0; i < actual.length; i += 4) { const error = Math.abs(actual.readFloatLE(i) - expected.readFloatLE(i)); peak = Math.max(peak, error); squared += error * error; }
    const rms = Math.sqrt(squared / (actual.length / 4)); expect(rms).toBeLessThanOrEqual(3e-4);
    expect(result.longRender!.publish.checks.every(check => check.ok)).toBe(true); expect(result.longRender!.cleanup.leftovers).toEqual([]);
    expect(await readdir(box.work)).toEqual([]); expect(await readdir(box.journals)).toEqual([]);
    expect(JSON.stringify(project)).toBe(before); expect(createHash("sha256").update(await readFile(source)).digest("hex")).toBe(originalSha);
    const receipts = process.env.EDITKIN_TEST_RESULT_ROOT;
    if (receipts) {
      for (const [path, name] of [[reference.outputPath, "reference-v2" + suffix + ".mp4"], [result.outputPath, "actual-v3" + suffix + ".mp4"]]) await copyFile(path, join(receipts, name), constants.COPYFILE_EXCL);
      await writeFile(join(receipts, "REAL_RESIDENT_V3" + suffix + ".json"), JSON.stringify({ result, reference, rms, peak, originalSha, tail, decodedAudioComparisonSeconds: 2 }, null, 2), { flag: "wx" });
    }
  }, 120_000);
  it.each(["cancel", "space"] as const)("handles%s after observing real native PNG output and preserves the prior file", async mode => {
    const box = await sandbox(mode), controller = new AbortController(), reason = Error("CANCEL_REAL_RESIDENT_V3"), target = join(box.folder, "existing.mp4");
    const previous = Buffer.from("KEEP_PREVIOUS_USER_OUTPUT"); await writeFile(target, previous);
    let observed = false, observedAt = 0, releaseMs = 0, watcher: FSWatcher | undefined;
    const options: RenderOptions = { ...box.options, signal: controller.signal, longRender: { ...box.options.longRender,
      onRunStarted(run) {
        releaseMs = run.policy.releaseMs;
        watcher = watch(run.runDirectory, { recursive: true }, (_event, name) => {
          if (!observed && name?.toString().includes("frame-00000004.png")) {
            observed = true; observedAt = performance.now(); if (mode === "cancel") controller.abort(reason);
          }
        });
      },
      probe: async path => { const space = await probeVolumeSpace(path); return space && observed && mode === "space" ? { ...space, availableBytes: 0 } : space; },
    } };
    try {
      const failure = await renderProject(fixture(true, 4), target, options).catch(error => error);
      const stopLatencyMs = performance.now() - observedAt;
      expect(observed).toBe(true);
      if (mode === "cancel") expect(failure).toBe(reason); else expect(failure).toMatchObject({ code: "LONG_RENDER_SPACE_SHORT" });
      expect(await readFile(target)).toEqual(previous); expect(await readdir(box.work)).toEqual([]); expect(await readdir(box.journals)).toEqual([]);
      expect(stopLatencyMs).toBeLessThanOrEqual(releaseMs);
      const receipts = process.env.EDITKIN_TEST_RESULT_ROOT;
      if (receipts) await writeFile(join(receipts, `CONTROL_${mode}.json`), JSON.stringify({ observed, stopLatencyMs, releaseMs, previousOutputPreserved: true, workAndJournalsEmpty: true }, null, 2), { flag: "wx" });
    } finally { watcher?.close(); }
  }, 90_000);
});
