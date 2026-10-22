import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { useTempRoots } from "../test/tempRoot.mjs";
import { longRenderOutputStagingDirectoryV1, longRenderPartPathV1, probeLongPartV1, publishLongRenderOutputV1 } from "./longRenderPublishV1";
import type { LongOutputIdentityPlanV1 } from "./longRenderContractsV1";

const run = promisify(execFile);
const ffmpeg = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobe = resolve("vendor/ffmpeg/win32-x64/ffprobe.exe");
const temp = useTempRoots();
let root = "", encoded = "";
const runId = "0f0e0d0c-0b0a-4908-8706-050403020100";

const identity = (patch: Partial<LongOutputIdentityPlanV1> = {}): LongOutputIdentityPlanV1 => ({
  schema: "editkin.long-output-identity-plan/v1", container: "mp4", width: 64, height: 36, frameRate: { numerator: 30, denominator: 1 }, expectedFrames: 30,
  durationSeconds: 1, pixelFormat: "yuv420p", colorPrimaries: "bt709", colorTransfer: "bt709", colorMatrix: "bt709", encoder: "libx264",
  encoderArgs: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18"], audio: { codec: "aac", sampleRate: 48000, channels: 2, expectedSamples: 48_000 }, ...patch });

beforeAll(async () => {
  root = await temp.create("long-publish-");
  encoded = join(root, "encoded.mp4");
  await run(ffmpeg, ["-n", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=64x36:r=30:d=1", "-f", "lavfi", "-i", "sine=f=440:r=48000:d=1",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-colorspace", "bt709", "-color_trc", "bt709",
    "-bsf:v", "h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-t", "1", "-video_track_timescale", "90000", "-movflags", "+faststart", encoded], { windowsHide: true, timeout: 60_000 });
}, 60_000);

async function stage(name: string) {
  const requested = join(root, name, "film.mp4");
  const part = longRenderPartPathV1(requested, runId);
  await mkdir(dirname(part), { recursive: true });
  await copyFile(encoded, part);
  await writeFile(requested, "previous user output");
  return { requested, part };
}

describe("long-render .part publication", () => {
  it("names the part inside an owned staging directory beside the requested output", () => {
    const requested = resolve("D:/out/My Film.mp4");
    expect(longRenderOutputStagingDirectoryV1(requested, runId)).toBe(join(dirname(requested), `.My Film.mp4.${runId}.editkin-long`));
    expect(basename(longRenderPartPathV1(requested, runId))).toBe(`.My Film.mp4.${runId}.editkin-long.part.mp4`);
    expect(longRenderPartPathV1(resolve("D:/out/master.mov"), runId).endsWith(".part.mov")).toBe(true);
  });

  it("publishes only after every identity check passes, replacing the previous output in one rename", async () => {
    const { requested, part } = await stage("pass");
    const recorded: string[] = [];
    const receipt = await publishLongRenderOutputV1({ partPath: part, requestedPath: requested, identity: identity(), ffprobePath: ffprobe,
      journal: { runId, path: "", live: () => [], recordCreated: async () => undefined, recordRemoved: async path => { recorded.push(path); } } });
    expect(receipt.checks.every(check => check.ok)).toBe(true);
    expect(receipt.probe).toMatchObject({ width: 64, height: 36, frameRate: "30/1", frames: 30, pixelFormat: "yuv420p", colorPrimaries: "bt709", audioCodec: "aac", audioSampleRate: 48000, audioChannels: 2 });
    expect(Math.abs(receipt.probe.audioSamples! - 48_000)).toBeLessThanOrEqual(1024);
    expect(await readFile(requested)).toEqual(await readFile(encoded));
    await expect(stat(part)).rejects.toMatchObject({ code: "ENOENT" });
    expect(recorded).toEqual([part]);
  });

  it.each([
    ["size", { width: 1920 }], ["frame rate", { frameRate: { numerator: 25, denominator: 1 } }], ["frame count", { expectedFrames: 33 }],
    ["pixel format", { pixelFormat: "yuv420p10le" }], ["colour", { colorTransfer: "smpte2084" }], ["audio samples", { audio: { codec: "aac", sampleRate: 48000, channels: 2, expectedSamples: 96_000 } }],
    ["audio codec", { audio: { codec: "pcm_s24le", sampleRate: 48000, channels: 2, expectedSamples: 48_000 } }],
  ] as Array<[string, Partial<LongOutputIdentityPlanV1>]>)("refuses a %s mismatch and leaves the previous output untouched", async (name, patch) => {
    const { requested, part } = await stage(`fail-${name.replace(/\s/g, "-")}`);
    await expect(publishLongRenderOutputV1({ partPath: part, requestedPath: requested, identity: identity(patch), ffprobePath: ffprobe }))
      .rejects.toMatchObject({ code: "LONG_RENDER_OUTPUT_QA" });
    expect(await readFile(requested, "utf8")).toBe("previous user output");
    expect((await stat(part)).isFile()).toBe(true);
  });

  it("reads the container frame count and audio sample count the checks rely on", async () => {
    expect(await probeLongPartV1(encoded, ffprobe)).toMatchObject({ frames: 30, videoDurationSeconds: 1 });
  });
});
