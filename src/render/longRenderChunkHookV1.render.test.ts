// WP-B chunk hook renderLongChunkIntermediateV1 (design C5): one prepared chunk sub-project through the FFmpeg composite
// resolve steps into an owned lossless FFV1 .mkv whose planes equal what the single graph encodes (measured against the
// legacy x264 render of the same project). Real FFmpeg; the work root is an owned temp folder.
import { execFile } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { useTempRoots } from "../test/tempRoot.mjs";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { renderLongChunkIntermediateV1, renderProject } from "./ffmpeg";
import { runWithRenderWorkRootV1 } from "./renderWorkspace";
import { addCompositionFixtureV1 } from "./referencedCompositionPrepassV1.fixture";

const run = promisify(execFile);
const ffmpeg = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobe = resolve("vendor/ffmpeg/win32-x64/ffprobe.exe");
const WIDTH = 320, HEIGHT = 180, FRAMES = 60;
const temp = useTempRoots();
let root = "", source = "";

beforeAll(async () => {
  root = await temp.create("long-chunk-hook-");
  source = join(root, "source.mp4");
  await run(ffmpeg, ["-n", "-v", "error", "-f", "lavfi", "-i", `testsrc2=s=${WIDTH}x${HEIGHT}:r=30:d=2`, "-f", "lavfi", "-i", "sine=f=330:r=48000:d=2",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-pix_fmt", "yuv420p", "-g", "30", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
    "-c:a", "aac", "-movflags", "+faststart", source], { windowsHide: true, timeout: 60_000 });
}, 60_000);

function project(): EditProject {
  const value = createEmptyProject("chunk hook", { id: "chunk-hook", width: WIDTH, height: HEIGHT, fps: 30 });
  value.assets.push({ id: "src", name: "source", kind: "video", uri: source, duration: 2, width: WIDTH, height: HEIGHT, color: { interpretation: "rec709", primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" } });
  value.tracks[0].clips.push({ id: "clip", assetId: "src", trackId: value.tracks[0].id, timelineStart: 0, sourceStart: 0, duration: 2, volume: 1,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR, contrast: 1.1, saturation: 1.05 }, keyframes: [] });
  value.captions.push({ id: "cap", text: "chunk", start: .3, duration: 1 });
  return value;
}

/** Raw planes exactly as stored (no range or matrix conversion). */
async function rawPlanes(path: string): Promise<Buffer> {
  const { stdout } = await run(ffmpeg, ["-v", "error", "-nostdin", "-i", path, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "yuv420p", "pipe:1"],
    { windowsHide: true, timeout: 60_000, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

function lumaPsnr(left: Buffer, right: Buffer, frame: number): number {
  const frameBytes = WIDTH * HEIGHT * 1.5, offset = frame * frameBytes;
  let squared = 0;
  for (let index = 0; index < WIDTH * HEIGHT; index += 1) { const delta = left[offset + index] - right[offset + index]; squared += delta * delta; }
  return squared === 0 ? Infinity : 10 * Math.log10(255 * 255 / (squared / (WIDTH * HEIGHT)));
}

describe("WP-B chunk hook renderLongChunkIntermediateV1", () => {
  it("requires a real display-tagged FFV1 chunk and compares its decoded planes with the single graph", async () => {
    const work = join(root, "work"); await mkdir(work);
    const options = { ffmpegPath: ffmpeg, ffprobePath: ffprobe, preferGpu: false, fontRoot: resolve("public/fonts"), timeoutMs: 180_000 };
    const reference = await renderProject(project(), join(root, "single-graph.mp4"), { ...options, workRoot: work });
    const chunkPath = join(work, "chunk-000.mkv");
    const result = await runWithRenderWorkRootV1(work, () => renderLongChunkIntermediateV1({ project: project(), outputPath: chunkPath, options, timeoutMs: 180_000 }));
    expect(result).toMatchObject({ schema: "editkin.long-chunk-intermediate/v1", codec: "ffv1", container: "matroska", pixelFormat: "yuv420p",
      width: WIDTH, height: HEIGHT, frameRate: { numerator: 30, denominator: 1 }, frameCount: FRAMES, durationSeconds: 2 });
    const [chunk, single] = await Promise.all([rawPlanes(chunkPath), rawPlanes(reference.outputPath)]);
    expect(chunk.length).toBe(FRAMES * WIDTH * HEIGHT * 1.5);
    const psnr = Array.from({ length: FRAMES }, (_, frame) => lumaPsnr(chunk, single, frame));
    expect(Math.min(...psnr)).toBeGreaterThanOrEqual(38);
  }, 300_000);

  it("pins the mechanism with plain FFmpeg: RGB working tags give identity-matrix planes, display tags give the lossless display planes", async () => {
    const folder = join(root, "mechanism"); await mkdir(folder);
    const encode = async (name: string, args: string[]) => { const path = join(folder, name);
      await run(ffmpeg, ["-n", "-v", "error", "-f", "lavfi", "-i", `testsrc2=s=${WIDTH}x${HEIGHT}:r=30:d=1,format=gbrpf32le`, "-vf", "format=yuv420p", ...args, path], { windowsHide: true, timeout: 60_000 });
      return (await rawPlanes(path)).subarray(0, WIDTH * HEIGHT * 1.5); };
    const working = await encode("working.mkv", ["-c:v", "ffv1", "-level", "3", "-color_range", "pc", "-colorspace", "rgb"]);
    const display = await encode("display.mkv", ["-c:v", "ffv1", "-level", "3", "-color_range", "tv", "-colorspace", "bt709"]);
    const lossless = await encode("lossless-x264.mp4", ["-c:v", "libx264", "-qp", "0", "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"]);
    expect(display.equals(lossless)).toBe(true);
    expect(working.equals(lossless)).toBe(false);
    const chroma = working.subarray(WIDTH * HEIGHT);
    expect(Math.min(...chroma)).toBe(0); expect(Math.max(...chroma)).toBe(255);
  }, 120_000);

  it("refuses requests outside the FFmpeg-composite chunk contract before rendering", async () => {
    const options = { ffmpegPath: ffmpeg, ffprobePath: ffprobe, fontRoot: resolve("public/fonts") };
    const folder = join(root, "refusals"); await mkdir(folder);
    await expect(renderLongChunkIntermediateV1({ project: project(), outputPath: join(folder, "chunk.mp4"), options, timeoutMs: 60_000 })).rejects.toMatchObject({ code: "LONG_RENDER_OUTPUT_QA" });
    await writeFile(join(folder, "exists.mkv"), "x");
    await expect(renderLongChunkIntermediateV1({ project: project(), outputPath: join(folder, "exists.mkv"), options, timeoutMs: 60_000 })).rejects.toMatchObject({ code: "LONG_RENDER_OUTPUT_QA" });
    const linear = project(); linear.assets[0].color = { interpretation: "linear_rec709" }; linear.colorManagement = { ...linear.colorManagement!, mode: "aces2" };
    await expect(renderLongChunkIntermediateV1({ project: linear, outputPath: join(folder, "linear.mkv"), options, timeoutMs: 60_000 })).rejects.toMatchObject({ code: "LONG_RENDER_ROUTE_NOT_AVAILABLE" });
    const nested = project(); const clip = nested.tracks[0].clips[0]; addCompositionFixtureV1(nested, "used", "src", 2); clip.assetId = "asset:used";
    await expect(renderLongChunkIntermediateV1({ project: nested, outputPath: join(folder, "nested.mkv"), options, timeoutMs: 60_000 })).rejects.toMatchObject({ code: "LONG_RENDER_ROUTE_NOT_AVAILABLE" });
    expect((await readdir(folder)).sort()).toEqual(["exists.mkv"]);
  }, 120_000);
});
