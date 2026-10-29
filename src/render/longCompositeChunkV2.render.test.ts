import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type AcesOutputTransform } from "../domain/types";
import { useTempRoots } from "../test/tempRoot.mjs";
import { renderLongChunkIntermediateV2, renderLongChunkRawV1 } from "./longCompositeChunkV2";
import { runWithRenderWorkRootV1 } from "./renderWorkspace";

const temp = useTempRoots(), run = promisify(execFile);
const ffmpeg = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobe = resolve("vendor/ffmpeg/win32-x64/ffprobe.exe");
let root = "", source = "", sourceSha = "";
beforeAll(async () => {
  root = await temp.create("b2-composite-stream-"); source = join(root, "original.mkv");
  await run(ffmpeg, ["-n", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=128x72:r=30:d=3", "-c:v", "ffv1",
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", source], { windowsHide: true, timeout: 30_000 });
  sourceSha = sha(await readFile(source));
}, 40_000);

function project(transform: AcesOutputTransform = "rec709_sdr", fps = 12, duration = 1) {
  const value = createEmptyProject("B2 display stream", { id: "b2", width: 128, height: 72, fps });
  value.colorManagement = { ...value.colorManagement!, mode: "aces2", outputTransform: transform };
  value.assets.push({ id: "src", name: "original", kind: "video", uri: source, duration: 3, width: 128, height: 72,
    color: { interpretation: "rec709", primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" },
    derivatives: { sourceSha256: sourceSha, generatedAt: "2026-10-18T00:00:00Z", proxyUri: join(root, "missing-preview-only.mp4"), proxyWidth: 16, proxyHeight: 8 } });
  value.tracks[0].clips.push({ id: "clip", assetId: "src", trackId: value.tracks[0].id, timelineStart: 0, sourceStart: .25, duration, volume: 1,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR, saturation: 1.1, contrast: 1.05 }, keyframes: [] });
  value.captions.push({ id: "cap", text: "Editkin", start: .2, duration: .5 });
  return value;
}
async function options(name: string) {
  const workRoot = join(root, name); await mkdir(workRoot);
  return { ffmpegPath: ffmpeg, ffprobePath: ffprobe, preferGpu: false, fontRoot: resolve("public/fonts"), colorRoot: resolve("public/color/aces2"), workRoot, timeoutMs: 60_000 };
}
async function decode(path: string, pixelFormat: string) {
  return (await run(ffmpeg, ["-v", "error", "-i", path, "-map", "0:v:0", "-pix_fmt", pixelFormat, "-f", "rawvideo", "pipe:1"],
    { windowsHide: true, timeout: 30_000, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 })).stdout;
}
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function filesUnder(path: string): Promise<string[]> {
  const result: string[] = [];
  for (const item of await readdir(path, { withFileTypes: true })) {
    const child = join(path, item.name);
    result.push(...(item.isDirectory() ? await filesUnder(child) : [child]));
  }
  return result;
}

describe("real B2 composite stream", () => {
  it.each(["rec709_sdr", "rec2100_hlg_1000", "rec2100_pq_1000"] as const)("streams exact %s display planes without writing a raw or intermediate movie", async transform => {
    const config = await options(transform), input = project(transform), before = JSON.stringify(input), originalSha = sha(await readFile(source));
    const chunk = join(config.workRoot, "reference.mkv");
    const reference = await runWithRenderWorkRootV1(config.workRoot, () => renderLongChunkIntermediateV2({ project: input, outputPath: chunk, options: config, timeoutMs: 60_000 }));
    const frames: Buffer[] = []; let active = 0, peak = 0;
    const streamed = await renderLongChunkRawV1({ project: input, options: config, timeoutMs: 60_000,
      sink: { async onFrame(frame, index) {
        active++; peak = Math.max(peak, active); expect(index).toBe(frames.length);
        const generated = (await filesUnder(config.workRoot)).filter(path => path !== chunk);
        expect(generated.some(path => /\.(mkv|mp4|raw|rgb|yuv)$/i.test(path))).toBe(false);
        await new Promise(done => setTimeout(done, 2)); frames.push(Buffer.from(frame)); active--;
      } } });
    const decoded = await decode(chunk, reference.pixelFormat), raw = Buffer.concat(frames);
    expect(raw.equals(decoded)).toBe(true); expect(peak).toBe(1);
    expect(streamed).toMatchObject({ frameCount: 12, bytes: raw.length, videoStagingBytes: 0, maximumPendingFrames: 1, pixelFormat: reference.pixelFormat });
    expect(JSON.stringify(input)).toBe(before); expect(sha(await readFile(source))).toBe(originalSha);
    expect(await readdir(config.workRoot)).toEqual(["reference.mkv"]);
  }, 90_000);

  it("emits exactly 60 frames at 30000/1001 and keeps their order", async () => {
    const config = await options("ntsc"), input = project("rec709_sdr", 30000 / 1001, 60 * 1001 / 30000);
    const frames: string[] = [];
    const result = await renderLongChunkRawV1({ project: input, options: config, timeoutMs: 60_000,
      sink: { async onFrame(frame, index) { expect(index).toBe(frames.length); frames.push(sha(frame)); } } });
    expect(result).toMatchObject({ frameCount: 60, frameRate: { numerator: 30000, denominator: 1001 } });
    expect(new Set(frames).size).toBeGreaterThan(30); expect(await readdir(config.workRoot)).toEqual([]);
  }, 90_000);

  it("cancels a blocked downstream encoder and removes the owned preparation workspace", async () => {
    const config = await options("cancel"), controller = new AbortController(), reason = Error("CANCEL_B2"); let seen = 0;
    await expect(renderLongChunkRawV1({ project: project(), options: config, timeoutMs: 60_000,
      sink: { signal: controller.signal, async onFrame(_frame, _index, signal) {
        seen++; controller.abort(reason); expect(signal.aborted).toBe(true); await new Promise<void>(() => {});
      } } })).rejects.toBe(reason);
    expect(seen).toBe(1); expect(await readdir(config.workRoot)).toEqual([]);
  }, 30_000);

  it("does not convert a downstream rejection to a successful chunk", async () => {
    const config = await options("sink-error"), reason = Error("DOWNSTREAM_DISK_FULL");
    await expect(renderLongChunkRawV1({ project: project(), options: config, timeoutMs: 60_000,
      sink: { async onFrame() { throw reason; } } })).rejects.toBe(reason);
    expect(await readdir(config.workRoot)).toEqual([]);
  }, 30_000);

  it("requires an explicit work root and refuses an unaligned duration before staging", async () => {
    const config = await options("invalid");
    await expect(renderLongChunkRawV1({ project: project(), options: { ...config, workRoot: undefined }, timeoutMs: 60_000,
      sink: { async onFrame() {} } })).rejects.toMatchObject({ code: "LONG_RENDER_WORK_ROOT_UNAVAILABLE" });
    await expect(renderLongChunkRawV1({ project: project("rec709_sdr", 30, 1.01), options: config, timeoutMs: 60_000,
      sink: { async onFrame() {} } })).rejects.toMatchObject({ code: "LONG_RENDER_OUTPUT_QA" });
    expect(await readdir(config.workRoot)).toEqual([]);
  });
});
