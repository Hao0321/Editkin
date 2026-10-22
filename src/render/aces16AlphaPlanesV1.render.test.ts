import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runColorProcess } from "../application/materialColorSamplingRuntime";
import { aces16AlphaMultiplyV1, aces16AlphaPlaneJoinV1 } from "./aces16AlphaPlanesV1";

const ffmpeg = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"), width = 128, height = 16, pixels = width * height, frames = 3;
const levels = [0, 1, 128, 16384, 32768, 49151, 65535], frame = Buffer.alloc(pixels * 8), target = Buffer.alloc(pixels * 2), matte = Buffer.alloc(pixels * 2);
let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "editkin-alpha-planes16-test-"));
  for (let i = 0; i < pixels; i += 1) {
    const x = i % width;
    target.writeUInt16LE(levels[Math.floor(x / levels.length) % levels.length], 2 * i);
    matte.writeUInt16LE(levels[x % levels.length], 2 * i);
    for (let plane = 0; plane < 4; plane += 1) frame.writeUInt16LE(levels[(x + plane) % levels.length], 2 * (plane * pixels + i));
  }
  for (const [name, bytes] of [["colour", frame], ["target", target], ["matte", matte]] as const) await writeFile(join(root, name + ".raw"), Buffer.concat(Array.from({ length: frames }, () => bytes)));
});
afterAll(async () => {
  if (!root) return;
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), "editkin-alpha-planes16-test-"))) throw Error("Alpha test cleanup escaped its owned fixture");
  await rm(root, { recursive: true, force: true });
});
const input = (name: string, format: string) => ["-f", "rawvideo", "-pixel_format", format, "-video_size", `${width}x${height}`, "-framerate", "30", "-i", join(root, name + ".raw")];

describe("bundled16-bit planar alpha operations", () => {
  it("copies every photographic code unchanged while replacing alpha in both schedules", async () => {
    for (const threads of [undefined, "1"]) {
      const graph = `[0:v]null[colour];[1:v]null[matte];${aces16AlphaPlaneJoinV1("colour", "matte", "out")}`;
      const bytes = (await runColorProcess(ffmpeg, ["-v", "error", "-nostdin", "-threads", "1", ...input("colour", "gbrap16le"), ...input("matte", "gray16le"),
        ...(threads ? ["-filter_complex_threads", threads] : []), "-filter_complex", graph, "-map", "[out]", "-frames:v", String(frames), "-f", "rawvideo", "-pix_fmt", "gbrap16le", "pipe:1"], pixels * 8 * frames, 15_000)).stdout;
      expect(bytes.length).toBe(pixels * 8 * frames);
      for (let f = 0; f < frames; f += 1) for (let plane = 0; plane < 4; plane += 1) for (let i = 0; i < pixels; i += 1) {
        expect(bytes.readUInt16LE(2 * ((f * 4 + plane) * pixels + i))).toBe(plane === 3 ? matte.readUInt16LE(2 * i) : frame.readUInt16LE(2 * (plane * pixels + i)));
      }
    }
  }, 30_000);
  it("matches independent full-range multiplication for all49 alpha pairs in both schedules", async () => {
    for (const threads of [undefined, "1"]) {
      const graph = `[0:v]null[target];[1:v]null[matte];${aces16AlphaMultiplyV1("target", "matte", "out")}`;
      const bytes = (await runColorProcess(ffmpeg, ["-v", "error", "-nostdin", "-threads", "1", ...input("target", "gray16le"), ...input("matte", "gray16le"),
        ...(threads ? ["-filter_complex_threads", threads] : []), "-filter_complex", graph, "-map", "[out]", "-frames:v", String(frames), "-f", "rawvideo", "-pix_fmt", "gray16le", "pipe:1"], pixels * 2 * frames, 15_000)).stdout;
      expect(bytes.length).toBe(pixels * 2 * frames);
      for (let f = 0; f < frames; f += 1) for (let i = 0; i < pixels; i += 1) expect(bytes.readUInt16LE(2 * (f * pixels + i))).toBe(Math.floor(target.readUInt16LE(2 * i) * matte.readUInt16LE(2 * i) / 65535));
    }
  }, 30_000);
});
