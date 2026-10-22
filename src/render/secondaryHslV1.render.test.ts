import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type ColorGradeV2, type EditProject } from "../domain/types";
import { bakeColorGradeLut, sampleBakedGradeLut } from "../color/gradeLutBake";
import { renderComposite } from "./ffmpegComposite";
import { buildRenderPlan } from "./planner";

const app = fileURLToPath(new URL("../../", import.meta.url));
const ffmpeg = resolve(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobe = resolve(app, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const width = 96, height = 48;
let root = "", source: Buffer;
function run(args: string[], input?: Buffer): Buffer {
  const child = spawnSync(ffmpeg, args, { input, maxBuffer: 1 << 24, windowsHide: true, timeout: 60_000 });
  if (child.error || child.status !== 0) throw new Error(child.error?.message || child.stderr.toString());
  return child.stdout;
}
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "editkin-secondary-hsl-render-"));
  const rgb = Buffer.alloc(width * height * 3), patches = [[180, 40, 40], [40, 150, 40], [40, 40, 180], [128, 128, 128], [170, 90, 40], [40, 150, 150]];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) patches[Math.floor(x / 16)].forEach((component, channel) => { rgb[(y * width + x) * 3 + channel] = component; });
  run(["-v", "error", "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", `${width}x${height}`, "-framerate", "30", "-i", "pipe:0", "-c:v", "ffv1", "-pix_fmt", "gbrp16le", join(root, "source.mkv")], Buffer.concat([rgb, rgb, rgb]));
  // Exact pre-LUT working surface: the independent RGB8 decode is not the high16 source conversion.
  source = run(["-v", "error", "-i", join(root, "source.mkv"), "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,format=gbrap16le`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gbrap16le", "pipe:1"]);
});
afterAll(async () => {
  if (!root) return;
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !basename(root).startsWith("editkin-secondary-hsl-render-")) throw new Error("Unexpected owned test directory");
  await rm(root, { recursive: true });
});
function project(grade: ColorGradeV2): EditProject {
  const value = createEmptyProject("Secondary HSL actual output", { width, height, fps: 30 });
  value.assets.push({ id: "a", name: "synthetic-patches", uri: join(root, "source.mkv"), kind: "video", duration: .1, width, height, color: { interpretation: "rec709" } });
  value.tracks[0].clips.push({ id: "c", trackId: value.tracks[0].id, assetId: "a", timelineStart: 0, sourceStart: 0, duration: .1, volume: 0,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], gradeV2: grade });
  return value;
}
async function frame(grade: ColorGradeV2, name: string): Promise<Buffer> {
  const value = project(grade), output = join(root, `${name}.mov`);
  await renderComposite(ffmpeg, ffprobe, output, value, buildRenderPlan(value, uri => uri), undefined, "prores_ks", 60_000,
    undefined, undefined, undefined, undefined, true);
  return run(["-v", "error", "-i", output, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
}
describe("secondary HSL current bundled FFmpeg composite", () => {
  it("decodes actual selected/unselected output pixels from the same shared65³ table", async () => {
    const grade: ColorGradeV2 = { schema: "editkin.color-grade/v2", nodes: [{ id: "secondary", offset: { r: .08 }, secondaryHslV1: {
      schema: "editkin.secondary-hsl/v1", selectorSpace: "working_rgb_code", qualifier: { hue: { centerDegrees: 0, halfWidthDegrees: 15, softnessDegrees: 20 } },
      outside: { offset: { b: .06 } },
    } }] };
    const baked = bakeColorGradeLut(grade, "rec709_display"), output = await frame(grade, "secondary");
    const baseline = await frame({ schema: "editkin.color-grade/v2" }, "baseline");
    expect(output.length).toBe(width * height * 3);
    expect(source.length).toBe(width * height * 8);
    let error = 0, changed = 0;
    for (let pixel = 0; pixel < width * height; pixel++) {
      const pixels = width * height;
      // FFmpeg gbrap16le plane order: G, B, R, A, unsigned little-endian16.
      expect(source.readUInt16LE((pixels * 3 + pixel) * 2)).toBe(65535);
      const rgb: [number, number, number] = [source.readUInt16LE((pixels * 2 + pixel) * 2) / 65535, source.readUInt16LE(pixel * 2) / 65535, source.readUInt16LE((pixels + pixel) * 2) / 65535];
      const expected = sampleBakedGradeLut(baked, rgb);
      for (let channel = 0; channel < 3; channel++) {
        error += Math.abs(output[pixel * 3 + channel] - expected[channel] * 255);
        changed += Math.abs(output[pixel * 3 + channel] - baseline[pixel * 3 + channel]);
      }
    }
    expect(error / output.length).toBeLessThan(.9);
    expect(changed / output.length).toBeGreaterThan(3);
  }, 120_000);
  it("keeps actual decoded output byte identical when the new selector is disabled", async () => {
    const plain: ColorGradeV2 = { schema: "editkin.color-grade/v2", nodes: [{ id: "same", offset: { r: .05 }, mix: .7 }] };
    const disabled: ColorGradeV2 = structuredClone(plain);
    disabled.nodes![0].secondaryHslV1 = { schema: "editkin.secondary-hsl/v1", selectorSpace: "working_rgb_code", enabled: false,
      qualifier: { hue: { centerDegrees: 0, halfWidthDegrees: 20 } }, outside: { gain: { b: .5 } } };
    expect(await frame(disabled, "disabled")).toEqual(await frame(plain, "plain"));
  }, 120_000);
});
