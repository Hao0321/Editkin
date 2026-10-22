import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runColorProcess } from "../application/materialColorSamplingRuntime";
import { timelineTransitionMixGraphV1, type TransitionWorkingEncodingV1 } from "./timelineTransitionMixV1";

const ffmpeg = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"), width = 128, height = 16, pixels = width * height, frames = 5;
const levels = [0, 1, 128, 16384, 32768, 49151, 65535], a = Buffer.alloc(pixels * 8), b = Buffer.alloc(pixels * 8);
let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "editkin-pair-kernel16-test-"));
  for (let i = 0; i < pixels; i += 1) {
    const x = i % width;
    a.writeUInt16LE(levels[Math.floor(x / levels.length) % levels.length], 2 * (3 * pixels + i));
    b.writeUInt16LE(levels[x % levels.length], 2 * (3 * pixels + i));
    for (let plane = 0; plane < 3; plane += 1) {
      a.writeUInt16LE(21123 + plane * 200 + x, 2 * (plane * pixels + i));
      b.writeUInt16LE(41101 + plane * 300 + 2 * x, 2 * (plane * pixels + i));
    }
  }
  await writeFile(join(root, "a.raw"), Buffer.concat(Array.from({ length: frames }, () => a)));
  await writeFile(join(root, "b.raw"), Buffer.concat(Array.from({ length: frames }, () => b)));
});
afterAll(async () => {
  if (!root) return;
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), "editkin-pair-kernel16-test-"))) throw Error("Pair kernel cleanup escaped its owned fixture");
  await rm(root, { recursive: true, force: true });
});
const input = (name: string) => ["-f", "rawvideo", "-pixel_format", "gbrap16le", "-video_size", `${width}x${height}`, "-framerate", "30", "-i", join(root, name + ".raw")];
// Independent scalar reference, including the working transfer's black value.
const decode = (v: number, space: TransitionWorkingEncodingV1) => space === "linear" ? v : space === "rec709_display" ? Math.pow(v, 2.4)
  : v <= .155251141552511 ? (v - .0729055341958355) / 10.5402377416545 : Math.pow(2, v * 17.52 - 9.72);
const encode = (v: number, space: TransitionWorkingEncodingV1) => space === "linear" ? v : space === "rec709_display" ? Math.pow(Math.max(0, v), 1 / 2.4)
  : v <= .0078125 ? 10.5402377416545 * v + .0729055341958355 : (Math.log2(v) + 9.72) / 17.52;
const cases = (["linear", "acescct", "rec709_display"] as const).flatMap(space => (["dissolve", "dip"] as const).map(kernel => ({ space, kernel })));

describe("actual16-bit scene-linear paired-source kernel", () => {
  it.each(cases)("$kernel/$space matches49 alpha pairs, clock endpoints and both schedules", async ({ space, kernel }) => {
    let first: Buffer | undefined;
    for (const threads of [undefined, "1"]) {
      const graph = `[0:v]format=gbrap16le[a];[1:v]format=gbrap16le[b];${timelineTransitionMixGraphV1("a", "b", "out", { startFrame: 0, durationFrames: 4 }, kernel, space).join(";")}`;
      const bytes = (await runColorProcess(ffmpeg, ["-v", "error", "-nostdin", "-threads", "1", ...input("a"), ...input("b"),
        ...(threads ? ["-filter_complex_threads", threads] : []), "-filter_complex", graph, "-map", "[out]", "-frames:v", String(frames), "-f", "rawvideo", "-pix_fmt", "gbrap16le", "pipe:1"], pixels * 8 * frames, 15_000)).stdout;
      expect(bytes.length).toBe(pixels * 8 * frames); if (first) expect(bytes).toEqual(first); else first = bytes;
      let maximumAlphaError = 0, maximumRgbError = 0;
      for (let f = 0; f < frames; f += 1) for (let i = 0; i < pixels; i += 1) {
        const u = f / 4, ca = a.readUInt16LE(2 * (3 * pixels + i)) / 65535, cb = b.readUInt16LE(2 * (3 * pixels + i)) / 65535;
        const wa = (kernel === "dissolve" ? 1 - u : Math.max(0, 1 - 2 * u)) * ca;
        const wb = (kernel === "dissolve" ? u : Math.max(0, 2 * u - 1)) * cb;
        const wk = kernel === "dissolve" ? 0 : 1 - Math.abs(2 * u - 1), alpha = wa + wb + wk;
        maximumAlphaError = Math.max(maximumAlphaError, Math.abs(bytes.readUInt16LE(2 * ((f * 4 + 3) * pixels + i)) - Math.round(alpha * 65535)));
        for (let plane = 0; plane < 3; plane += 1) {
          const o = 2 * (plane * pixels + i), aa = a.readUInt16LE(o), bb = b.readUInt16LE(o);
          const value = alpha === 0 ? 0 : u === 0 ? aa : u === 1 ? bb : Math.round(Math.max(0, Math.min(1, encode((wa * decode(aa / 65535, space) + wb * decode(bb / 65535, space)) / alpha, space))) * 65535);
          maximumRgbError = Math.max(maximumRgbError, Math.abs(bytes.readUInt16LE(2 * ((f * 4 + plane) * pixels + i)) - value));
        }
      }
      expect(maximumAlphaError).toBe(0); expect(maximumRgbError).toBeLessThanOrEqual(1);
    }
  }, 30_000);
});
