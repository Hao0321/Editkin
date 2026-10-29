import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runColorProcess } from "../application/materialColorSamplingRuntime";
import { aces16AlphaOverGraphV1 } from "./aces16AlphaCompositeV1";

const ffmpeg = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"), width = 128, height = 16, pixels = width * height;
const levels = [0, 1, 128, 16384, 32768, 49151, 65535];
const background = Buffer.alloc(pixels * 8), foreground = Buffer.alloc(pixels * 8);
let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "editkin-straight16-test-"));
  for (let i = 0; i < pixels; i += 1) {
    const x = i % width;
    background.writeUInt16LE(levels[Math.floor(x / levels.length) % levels.length], 2 * (3 * pixels + i));
    foreground.writeUInt16LE(levels[x % levels.length], 2 * (3 * pixels + i));
    for (let plane = 0; plane < 3; plane += 1) {
      background.writeUInt16LE(21123 + plane * 500 + x + Math.floor(i / width), 2 * (plane * pixels + i));
      foreground.writeUInt16LE(41101 + plane * 600 + 2 * x + Math.floor(i / width), 2 * (plane * pixels + i));
    }
  }
  await writeFile(join(root, "background.raw"), background);
  await writeFile(join(root, "foreground.raw"), foreground);
});
afterAll(async () => {
  if (!root) return;
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), "editkin-straight16-test-"))) throw Error("Test cleanup escaped its owned fixture");
  await rm(root, { recursive: true, force: true });
});
const input = (name: string) => ["-f", "rawvideo", "-pixel_format", "gbrap16le", "-video_size", `${width}x${height}`, "-framerate", "30", "-i", join(root, name)];

describe("actual16-bit straight-alpha compositor", () => {
  it.each(["normal", "multiply", "screen", "difference"])("matches independent coverage equations for %s in both thread schedules", async mode => {
    const graph = aces16AlphaOverGraphV1("background", "foreground", "out", mode).join(";");
    let first: Buffer | undefined;
    for (const threads of [undefined, "1"]) {
      const result = await runColorProcess(ffmpeg, ["-v", "error", "-nostdin", "-threads", "1", ...input("background.raw"), ...input("foreground.raw"),
        ...(threads ? ["-filter_complex_threads", threads] : []), "-filter_complex", `[0:v]format=gbrap16le[background];[1:v]format=gbrap16le[foreground];${graph}`,
        "-map", "[out]", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gbrap16le", "pipe:1"], pixels * 8, 15_000);
      expect(result.stdout.length).toBe(pixels * 8);
      if (first) expect(result.stdout).toEqual(first); else first = result.stdout;
      let maximumRgbError = 0, maximumAlphaError = 0;
      for (let i = 0; i < pixels; i += 1) {
        const backgroundAlpha = background.readUInt16LE(2 * (3 * pixels + i)) / 65535;
        const foregroundAlpha = foreground.readUInt16LE(2 * (3 * pixels + i)) / 65535;
        const alpha = foregroundAlpha + backgroundAlpha * (1 - foregroundAlpha);
        maximumAlphaError = Math.max(maximumAlphaError, Math.abs(result.stdout.readUInt16LE(2 * (3 * pixels + i)) - Math.round(alpha * 65535)));
        for (let plane = 0; plane < 3; plane += 1) {
          const offset = 2 * (plane * pixels + i), back = background.readUInt16LE(offset), front = foreground.readUInt16LE(offset);
          const blend = mode === "multiply" ? back * front / 65535 : mode === "screen" ? 65535 - (65535 - back) * (65535 - front) / 65535
            : mode === "difference" ? Math.abs(back - front) : front;
          const effectiveFront = (1 - backgroundAlpha) * front + backgroundAlpha * blend;
          const expected = alpha === 0 ? 0 : Math.round((effectiveFront * foregroundAlpha + back * backgroundAlpha * (1 - foregroundAlpha)) / alpha);
          maximumRgbError = Math.max(maximumRgbError, Math.abs(result.stdout.readUInt16LE(offset) - expected));
        }
      }
      expect(maximumAlphaError).toBe(0);
      // The existing integer blend filter quantizes its blend colour once.
      expect(maximumRgbError).toBeLessThanOrEqual(mode === "normal" ? 0 : 2);
    }
  }, 30_000);
});
