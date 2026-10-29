import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPhoneProjectV1 } from "../application/phoneProjectV1";
import { runColorProcess } from "../application/materialColorSamplingRuntime";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { renderProject } from "./ffmpeg";
import { addCompositionFixtureV1 } from "./referencedCompositionPrepassV1.fixture";
import { HIGH_BIT_DEPTH_ALPHA_PROFILE } from "./highBitDepthAlphaDelivery";

const observed = vi.hoisted(() => ({ capture: "", finalGraph: "", encodes: [] as Array<{ codec: string; output: string }> }));
// All media calls still execute. Copy the actual private candidate before the
// production renderer publishes/removes its owned precomposition workspace.
vi.mock("./ffmpegMedia", async original => {
  const actual = await original<typeof import("./ffmpegMedia")>();
  return { ...actual, runProcess: async (...args: Parameters<typeof actual.runProcess>) => {
    const command = args[1], codecAt = command.indexOf("-c:v"), output = command.at(-1)!;
    if (codecAt >= 0) {
      observed.encodes.push({ codec: command[codecAt + 1], output });
      if (output.endsWith(".rendering.mp4")) {
        const inline = command.indexOf("-filter_complex"), file = command.indexOf("-filter_complex_script");
        observed.finalGraph = inline >= 0 ? command[inline + 1] : file >= 0 ? await readFile(command[file + 1], "utf8") : "";
      }
    }
    const result = await actual.runProcess(...args);
    if (codecAt >= 0 && command[codecAt + 1] === "ffv1" && output.endsWith(".rendering.mkv")) await copyFile(output, observed.capture);
    return result;
  } };
});

const ffmpeg = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobe = resolve("vendor/ffmpeg/win32-x64/ffprobe.exe");
const width = 64, height = 32, pixels = width * height, frames = 7;
let root: string, source: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "editkin-precomposition16-test-")); source = join(root, "source.mkv");
  observed.capture = join(root, "captured-working16.mkv");
  const frame = Buffer.alloc(pixels * 8), sourceAlpha = [0, 1, 128, 16384, 32768, 49151, 65535];
  for (let plane = 0; plane < 4; plane += 1) for (let i = 0; i < pixels; i += 1) frame.writeUInt16LE(plane === 3 ? sourceAlpha[i % sourceAlpha.length] : 32768 + plane * 128 + i % width, 2 * (plane * pixels + i));
  const raw = join(root, "source.raw"); await writeFile(raw, Buffer.concat(Array.from({ length: frames }, () => frame)));
  await runColorProcess(ffmpeg, ["-v", "error", "-nostdin", "-threads", "1", "-f", "rawvideo", "-pixel_format", "gbrap16le", "-video_size", `${width}x${height}`, "-framerate", "30", "-i", raw,
    "-frames:v", String(frames), "-c:v", "ffv1", "-level", "3", "-pix_fmt", "gbrap16le", "-color_range", "pc", source], 4096, 15_000);
});
afterAll(async () => {
  if (!root) return;
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), "editkin-precomposition16-test-"))) throw Error("Test cleanup escaped its owned fixture");
  await rm(root, { recursive: true, force: true });
});

function project() {
  const value = createPhoneProjectV1("Owned internal16 composition", { width, height, fps: 30 });
  value.colorManagement!.mode = "aces2";
  value.assets = [{ id: "source", name: "Owned coded plane", kind: "video", uri: source, duration: frames / 30, width, height, alphaMode: "opaque", color: { interpretation: "acescct", range: "pc" } }];
  const clip = { id: "root", assetId: "source", trackId: value.tracks[0].id, timelineStart: 0, sourceStart: 0, duration: frames / 30, volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] };
  value.tracks[0].clips = [clip];
  const composition = addCompositionFixtureV1(value, "used", "source", frames / 30);
  Object.assign(composition.tracks[0].clips[0], { timelineStart: 2 / 30, duration: 5 / 30, transform: { ...DEFAULT_TRANSFORM, scale: .5 } });
  clip.assetId = "asset:used";
  return value;
}
const options = () => ({ ffmpegPath: ffmpeg, ffprobePath: ffprobe, preferGpu: false, nativeCorePath: join(root, "absent-native-core.exe"), fontRoot: resolve("public/fonts"), colorRoot: resolve("public/color/aces2"), workRoot: join(root, "work"), timeoutMs: 90_000 });

describe("production lossless16 precomposition", () => {
  it("preserves transparent gaps/outside pixels and uses explicit working colour on parent reentry", async () => {
    const value = project(), before = structuredClone(value), output = join(root, "final.mp4");
    const result = await renderProject(value, output, options());
    expect(value).toEqual(before); expect(result.encoder).toBe("libx264");
    expect(observed.encodes.map(r => r.codec)).toEqual(["ffv1", "libx264"]);
    expect(observed.finalGraph).toContain("input-acescct-to-acescct.cube");
    const probe = JSON.parse((await runColorProcess(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,pix_fmt,color_range,color_space", "-of", "json", observed.capture], 8192, 15_000)).stdout.toString());
    expect(probe.streams[0]).toMatchObject({ codec_name: "ffv1", pix_fmt: "gbrap16le", color_range: "pc", color_space: "gbr" });
    const decoded = (await runColorProcess(ffmpeg, ["-v", "error", "-nostdin", "-threads", "1", "-i", observed.capture, "-frames:v", String(frames), "-f", "rawvideo", "-pix_fmt", "gbrap16le", "pipe:1"], pixels * 8 * frames, 15_000)).stdout;
    expect(decoded.length).toBe(pixels * 8 * frames);
    const alpha = (f: number, x: number, y: number) => decoded.readUInt16LE(2 * ((f * 4 + 3) * pixels + y * width + x));
    for (let f = 0; f < frames; f += 1) for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      if (f < 2 || x < 16 || x >= 48 || y < 8 || y >= 24) expect(alpha(f, x, y)).toBe(0);
      else expect(alpha(f, x, y)).toBe(65535);
    }
    expect(alpha(2, 32, 16)).toBe(65535);
  }, 100_000);
  it("continues rejecting ACES as a public transparent delivery profile", async () => {
    const before = observed.encodes.length;
    await expect(renderProject(project(), join(root, "refused.mov"), { ...options(), deliveryProfile: HIGH_BIT_DEPTH_ALPHA_PROFILE })).rejects.toThrow(/ACES|Rec\.709|rec709/);
    expect(observed.encodes.length).toBe(before);
  }, 15_000);
});
