import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { createMotionGraphic } from "../motion/composition";
import { REPO_TMP, useTempRoots } from "../test/tempRoot.mjs";
import { renderProject } from "./ffmpeg";
import { renderLongChunkRawV1 } from "./longCompositeChunkV2";
import { createLongSubProjectIndexV1 } from "./longSubProjectV1";
import { withRenderProgress } from "./renderProgress";
import { probeVolumeSpace } from "./renderDiskSpace";

const run = promisify(execFile), temp = useTempRoots(), ffmpeg = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobe = resolve("vendor/ffmpeg/win32-x64/ffprobe.exe");
let root = "", source = "", ntscSource = "";
beforeAll(async () => {
  root = await temp.create("w52-bc-", { parent: REPO_TMP }); source = join(root, "original.mkv"); ntscSource = join(root, "sixty.mkv");
  await run(ffmpeg, ["-n", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=128x72:r=12:d=2", "-f", "lavfi", "-i", "sine=f=440:r=48000:d=2",
    "-c:v", "ffv1", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-c:a", "pcm_s16le", source], { windowsHide: true, timeout: 30_000 });
  await run(ffmpeg, ["-n", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=128x72:r=60:d=2", "-c:v", "ffv1", ntscSource], { windowsHide: true, timeout: 30_000 });
}, 40_000);

function movie(fps = 12, count = 8, duration = .25, path = source): EditProject {
  const value = createEmptyProject("bounded route", { id: "bounded-route", width: 128, height: 72, fps });
  value.assets.push({ id: "src", name: "original", kind: "video", uri: path, duration: 2, width: 128, height: 72,
    color: { interpretation: "rec709", primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" },
    derivatives: { sourceSha256: "a".repeat(64), generatedAt: "2026-10-18T00:00:00Z", proxyUri: join(root, "must-not-read-proxy.mp4"), proxyWidth: 16, proxyHeight: 8 } });
  for (let i = 0; i < count; i++) value.tracks[0].clips.push({ id: `c${i}`, assetId: "src", trackId: value.tracks[0].id,
    timelineStart: i * duration, sourceStart: i * duration, duration, volume: 1,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
  return value;
}
async function options(name: string) {
  const folder = join(root, name); await mkdir(folder); const workRoot = join(folder, "work"); await mkdir(workRoot);
  return { folder, options: { ffmpegPath: ffmpeg, ffprobePath: ffprobe, preferGpu: false, fontRoot: resolve("public/fonts"), colorRoot: resolve("public/color/aces2"),
    workRoot, timeoutMs: 60_000, stallTimeoutMs: 10_000 }, long: { forceClass: "long" as const, journalRegistryRoot: join(folder, "journals"),
    policy: { ramBudgetBytes: 512 * 1024 ** 2 + 3_400_000 } } };
}
async function decode(path: string, pixelFormat: string) {
  return (await run(ffmpeg, ["-v", "error", "-i", path, "-map", "0:v:0", "-pix_fmt", pixelFormat, "-f", "rawvideo", "pipe:1"],
    { windowsHide: true, timeout: 30_000, encoding: "buffer", maxBuffer: 8 * 1024 * 1024 })).stdout;
}

describe("actual renderProject bounded composite dispatch", () => {
  it.each(["ordinary", "pair16", "background", "hlg"] as const)("preserves %s frames through one final encoder, original-only decode and bounded cleanup", async variant => {
    const value = movie(), config = await options(variant);
    if (variant === "pair16") config.long.policy.ramBudgetBytes = 512 * 1024 ** 2 + 4_200_000;
    value.captions.push({ id: "cap", text: "Editkin", start: .3, duration: .3 });
    if (variant === "pair16") value.timelineTransitions = [{ schema: "editkin.timeline-transition/v1", id: "pair", trackId: value.tracks[0].id,
      fromClipId: "c0", toClipId: "c1", beforeFrames: 1, afterFrames: 1, kernel: "dissolve" }];
    if (variant === "background") {
      value.tracks[0].clips = value.tracks[0].clips.filter(clip => clip.id !== "c3");
      const graphic = createMotionGraphic("bg", "card", "", .75, .25, undefined, findMotionGraphicPreset("reel_rule_reveal").seed);
      graphic.vectorV2 = { schema: "editkin.motion-vector-stroke/v1", kind: "stroke", stack: "under_media", heightPixels: 20, revealFrames: 1,
        commands: [{ type: "M", x: 0, y: 10 }, { type: "L", x: 64, y: 10 }], widthPixels: 4, cap: "round" };
      graphic.compositeLayer = "background"; graphic.x = .1; graphic.y = .2; graphic.width = .5; graphic.fontSize = 8;
      graphic.motionV2 = { sequence: { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0 },
        entrance: { durationFrames: 1, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 1, easing: { type: "linear" } },
        exit: { durationFrames: 1, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 1, easing: { type: "linear" } } };
      value.motionGraphics.push(graphic);
    }
    if (variant === "hlg") value.colorManagement = { ...value.colorManagement!, mode: "aces2", outputTransform: "rec2100_hlg_1000" };
    const before = JSON.stringify(value), sourceSha = createHash("sha256").update(await readFile(source)).digest("hex");
    const reference = await renderProject(value, join(config.folder, "reference.mp4"), config.options);
    const bounded = await renderProject(value, join(config.folder, "bounded.mp4"), { ...config.options, longRender: config.long });
    expect(bounded.longRender?.route).toBe("ffmpeg-chunked");
    expect(bounded.chunkedCompositePipeline).toMatchObject({ frames: 24, finalEncoderInstances: 1, videoIntermediateBytes: 0,
      audio: { samples: 96000, wholeAudioStagingBytes: 0 }, encoder: { closed: true, videoFrames: 24 } });
    expect(bounded.chunkedCompositePipeline!.chunks).toBeGreaterThan(1);
    const format = bounded.longRender!.identity.pixelFormat;
    const [a, b] = await Promise.all([decode(reference.outputPath, format), decode(bounded.outputPath, format)]);
    expect(a.length).toBe(b.length); let squared = 0;
    const bytes = format === "yuv420p10le" ? 2 : 1, maximum = bytes === 2 ? 1023 : 255;
    for (let i = 0; i < a.length; i += bytes) {
      const left = bytes === 2 ? a.readUInt16LE(i) : a[i], right = bytes === 2 ? b.readUInt16LE(i) : b[i];
      squared += (left - right) ** 2;
    }
    const psnr = squared ? 10 * Math.log10(maximum * maximum / (squared / (a.length / bytes))) : Infinity;
    expect(psnr).toBeGreaterThanOrEqual(38);
    expect(bounded.longRender!.publish.checks.every(check => check.ok)).toBe(true);
    expect(bounded.longRender!.cleanup.leftovers).toEqual([]); expect(await readdir(config.options.workRoot)).toEqual([]);
    expect(JSON.stringify(value)).toBe(before); expect(createHash("sha256").update(await readFile(source)).digest("hex")).toBe(sourceSha);
  }, 120_000);

  it("keeps original ASS timing at NTSC cuts and rejects a naive local-clock negative control", async () => {
    const duration = 1001 / 30000, value = movie(30000 / 1001, 3, duration, ntscSource), config = await options("ntsc-ass");
    value.captions.push({ id: "cap", text: "BUG", start: duration + .003, duration: .02 });
    value.captionStyle = { ...value.captionStyle, fontSize: 12, marginV: 8, outlineWidth: 1, shadow: 0 };
    const frames: Buffer[] = [];
    await renderLongChunkRawV1({ project: value, options: config.options, timeoutMs: 30_000, sink: { async onFrame(frame) { frames.push(Buffer.from(frame)); } } });
    const part = createLongSubProjectIndexV1(value)({ startFrame: 1, frameCount: 1, preRollFrames: 0, ramEstimateBytes: 0 });
    let correct = Buffer.alloc(0), naive = Buffer.alloc(0);
    await renderLongChunkRawV1({ ...part, options: config.options, timeoutMs: 30_000, sink: { async onFrame(frame) { correct = Buffer.from(frame); } } });
    await renderLongChunkRawV1({ project: part.project, durationSeconds: part.durationSeconds, options: config.options, timeoutMs: 30_000,
      sink: { async onFrame(frame) { naive = Buffer.from(frame); } } });
    expect(frames).toHaveLength(3); expect(correct.equals(frames[1])).toBe(true); expect(naive.equals(frames[1])).toBe(false);
  }, 60_000);

  it("cancels after real encoder progress, keeps the previous output and releases owned work", async () => {
    const value = movie(24, 48, 1 / 24, ntscSource), config = await options("cancel"), controller = new AbortController(), reason = Error("CANCEL_BOUNDED_EXPORT");
    const target = join(config.folder, "existing.mp4"), original = Buffer.from("KEEP_USER_OUTPUT"); await writeFile(target, original);
    let progressed = false;
    await expect(withRenderProgress(snapshot => {
      if ((snapshot.doneSeconds ?? 0) > 0 && (snapshot.fraction ?? 1) < 1) { progressed = true; controller.abort(reason); }
    }, () => renderProject(value, target, { ...config.options, signal: controller.signal,
      longRender: { ...config.long, policy: { ramBudgetBytes: 512 * 1024 ** 2 + 2_400_000 } } }))).rejects.toBe(reason);
    expect(progressed).toBe(true); expect(await readFile(target)).toEqual(original); expect(await readdir(config.options.workRoot)).toEqual([]);
    expect(await readdir(config.long.journalRegistryRoot)).toEqual([]);
  }, 60_000);

  it("aborts on a simulated mid-run space shortage before replacing the user output", async () => {
    const value = movie(24, 48, 1 / 24, ntscSource), config = await options("space"), target = join(config.folder, "existing.mp4"), original = Buffer.from("KEEP_USER_OUTPUT");
    await writeFile(target, original); let low = false;
    const outcome = await withRenderProgress(snapshot => { if ((snapshot.doneSeconds ?? 0) > 0) low = true; }, () => renderProject(value, target, { ...config.options,
      longRender: { ...config.long, policy: { ramBudgetBytes: 512 * 1024 ** 2 + 2_400_000 }, probe: async path => {
        const space = await probeVolumeSpace(path); return space ? { ...space, availableBytes: low ? 0 : space.availableBytes } : undefined;
      } } })).catch(error => error);
    expect(low).toBe(true); expect(outcome).toMatchObject({ code: "LONG_RENDER_SPACE_SHORT" });
    expect(await readFile(target)).toEqual(original); expect(await readdir(config.options.workRoot)).toEqual([]);
  }, 60_000);
});
