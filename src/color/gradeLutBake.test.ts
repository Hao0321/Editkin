import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ColorGradeV2 } from "../domain/types";
import { parseCubeFile } from "./cubeLut";
import { applyColorGradeV2Rgb } from "./gradeV2";
import { bakeColorGradeLut, bakedGradeLutCubeText, exportColorGradeV2Cube, ffmpegRenderCubeText, GRADE_LUT_SIZE, sampleBakedGradeLut } from "./gradeLutBake";
import { gradeV2LutFilters } from "./gradeV2Ffmpeg";

const app = fileURLToPath(new URL("../../", import.meta.url));
const ffmpeg = resolve(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe");

const smooth: ColorGradeV2 = { schema: "editkin.color-grade/v2", nodes: [
  { id: "primary", lift: { master: 0.02, b: 0.01 }, gain: { master: 0.05 }, gamma: { r: 0.05 }, contrast: 1.08 },
] };
const creative: ColorGradeV2 = { schema: "editkin.color-grade/v2", look: { id: "hfl2_travel_clear_air" } };

describe("Color Grade v2 65³ bake", () => {
  it("bakes .cube order (red fastest) and the identity grid exactly", () => {
    const identity = bakeColorGradeLut({ schema: "editkin.color-grade/v2" }, "rec709_display");
    expect(identity.size).toBe(GRADE_LUT_SIZE);
    expect(identity.values.length).toBe(65 ** 3 * 3);
    const index = (r: number, g: number, b: number) => ((b * 65 + g) * 65 + r) * 3;
    expect([...identity.values.slice(index(64, 0, 0), index(64, 0, 0) + 3)]).toEqual([1, 0, 0]);
    expect([...identity.values.slice(index(0, 0, 64), index(0, 0, 64) + 3)]).toEqual([0, 0, 1]);
    const middle = identity.values.slice(index(32, 16, 48), index(32, 16, 48) + 3);
    expect(middle[0]).toBeCloseTo(0.5, 6); expect(middle[1]).toBeCloseTo(0.25, 6); expect(middle[2]).toBeCloseTo(0.75, 6);
  });

  it("matches the CPU reference (max < 1.5 codes at the black clamp kink, mean < 0.02 code) for a smooth primary grade", () => {
    const baked = bakeColorGradeLut(smooth, "rec709_display");
    let seed = 11, sum = 0, maximum = 0, count = 0;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let sample = 0; sample < 3000; sample += 1) {
      const rgb: [number, number, number] = [random(), random(), random()];
      const direct = applyColorGradeV2Rgb(smooth, "rec709_display", rgb).map(value => Math.min(1, Math.max(0, value)));
      const lut = sampleBakedGradeLut(baked, rgb);
      for (let channel = 0; channel < 3; channel += 1) {
        const error = Math.abs(lut[channel] - direct[channel]) * 255;
        maximum = Math.max(maximum, error); sum += error; count += 1;
      }
    }
    expect(maximum).toBeLessThan(1.5);
    expect(sum / count).toBeLessThan(0.02);
  });

  it("writes .cube text whose parsed values are bit-identical to the in-memory table", () => {
    const baked = bakeColorGradeLut(creative, "acescct");
    const parsed = parseCubeFile(bakedGradeLutCubeText(baked, "test"));
    expect(parsed.kind).toBe("3d");
    expect(parsed.size).toBe(65);
    expect(Buffer.from(parsed.values.buffer).equals(Buffer.from(baked.values.buffer))).toBe(true);
    expect(bakeColorGradeLut(creative, "acescct")).toBe(baked);
  });

  it("exports the whole grade and names the spatial parts the LUT cannot hold", () => {
    const exported = exportColorGradeV2Cube({ schema: "editkin.color-grade/v2", look: { id: "hfl2_vlog_soft_film" } }, "rec709_display", "Soft film");
    expect(exported.text.startsWith('TITLE "Soft film · Editkin Color Grade v2 (Rec.709 display in/out)"\nLUT_3D_SIZE 65\n')).toBe(true);
    expect(exported.omittedSpatial.sort()).toEqual(["grain", "halation"]);
    expect(exported.text.trimEnd().split("\n")).toHaveLength(65 ** 3 + 2);
  });

  it("FFmpeg lut3d with the truncation-compensated render copy equals round(preview sampler) on 8-bit rgba", async () => {
    const work = await mkdtemp(join(tmpdir(), "editkin-grade-lut-parity-"));
    try {
      const baked = bakeColorGradeLut(creative, "rec709_display");
      const lutPath = join(work, "grade.cube");
      await writeFile(lutPath, ffmpegRenderCubeText(baked, "parity", false));
      const width = 96, height = 64;
      const source = Buffer.alloc(width * height * 4);
      let seed = 3;
      const random = () => (seed = (seed * 48271) % 2147483647) % 256;
      for (let pixel = 0; pixel < width * height; pixel += 1) {
        source[pixel * 4] = random(); source[pixel * 4 + 1] = random(); source[pixel * 4 + 2] = random(); source[pixel * 4 + 3] = 255;
      }
      const filter = [...gradeV2LutFilters(lutPath, false), "format=rgba"].join(",");
      const child = spawnSync(ffmpeg, ["-v", "error", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${width}x${height}`, "-i", "pipe:0",
        "-vf", filter, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { input: source, maxBuffer: 1 << 24, windowsHide: true });
      expect(child.status, child.stderr?.toString()).toBe(0);
      const output = child.stdout;
      let maximum = 0, mismatched = 0;
      for (let pixel = 0; pixel < width * height; pixel += 1) {
        const expected = sampleBakedGradeLut(baked, [source[pixel * 4] / 255, source[pixel * 4 + 1] / 255, source[pixel * 4 + 2] / 255]);
        for (let channel = 0; channel < 3; channel += 1) {
          const difference = Math.abs(output[pixel * 4 + channel] - Math.round(expected[channel] * 255));
          maximum = Math.max(maximum, difference); if (difference) mismatched += 1;
        }
        expect(output[pixel * 4 + 3]).toBe(255);
      }
      // Only float32 ties at exactly .5 may round differently.
      expect(maximum).toBeLessThanOrEqual(1);
      expect(mismatched / (width * height * 3)).toBeLessThan(0.002);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 30_000);
});
