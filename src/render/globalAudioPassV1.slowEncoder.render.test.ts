import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { useTempRoots } from "../test/tempRoot.mjs";
import { prepareGlobalAudioPassV1, writeGlobalAudioPassV1 } from "./globalAudioPassV1";
import { buildRenderPlan } from "./planner";
import { withRenderLifetime } from "./renderLifetime";
import { runWithRenderWorkRootV1 } from "./renderWorkspace";

/**
 * Render fixes 2026-10-22: a single-group PCM window (up to 60 s, about 46 MB) used to be relayed to the encoder from
 * inside the decoder's onFrame. The encoder takes audio only as fast as video arrives, so on a slow composite the relay
 * outlasted the decoder's no-progress window and the render failed with RAW_VIDEO_STALLED although every write was
 * acknowledged. Here each 256 KiB write takes 1 s (about 5 s per window) and the stall window is 3 s.
 */
const run = promisify(execFile), temp = useTempRoots(), ffmpeg = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobe = resolve("vendor/ffmpeg/win32-x64/ffprobe.exe");
let root = "";
beforeAll(async () => {
  root = await temp.create("global-audio-slow-encoder-");
  await run(ffmpeg, ["-n", "-v", "error", "-f", "lavfi", "-i", "aevalsrc=0.2*sin(2*PI*440*t):s=48000:d=1.6", "-c:a", "pcm_f32le", join(root, "tone.wav")], { windowsHide: true, timeout: 30_000 });
}, 40_000);

describe("global PCM relay to a slow encoder", () => {
  it("is not a decoder stall while the encoder keeps acknowledging writes", async () => {
    const project = createEmptyProject("slow encoder audio", { width: 128, height: 72, fps: 30 });
    project.assets.push({ id: "voice", name: "voice", kind: "audio", uri: join(root, "tone.wav"), duration: 1.6, role: "dialogue" });
    project.tracks.push({ id: "voice", name: "voice", kind: "audio", muted: false, locked: false, clips: [{ id: "voice-clip", assetId: "voice", trackId: "voice",
      timelineStart: 0, sourceStart: 0, duration: 1.4, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }] });
    const samples = 67200, work = join(root, "work"); await mkdir(work);
    const plan = await prepareGlobalAudioPassV1(project, buildRenderPlan(project, uri => uri), ffprobe, 30_000);
    let bytes = 0;
    const receipt = await withRenderLifetime({ timeoutMs: 120_000, stallMs: 3_000 }, () => runWithRenderWorkRootV1(work, () => writeGlobalAudioPassV1(plan, {
      samples, ffmpegPath: ffmpeg, timeoutMs: 60_000, signal: new AbortController().signal,
      async write(block) { await new Promise(done => setTimeout(done, 1_000)); bytes += block.byteLength; } })));
    expect(bytes).toBe(samples * 16);
    expect(receipt).toMatchObject({ samples, bytes: samples * 16, windows: 1 });
  }, 120_000);
});
