import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_COLOR } from "../domain/types";
import { primaryToneFilters } from "./primaryGrade";

const app = fileURLToPath(new URL("../../", import.meta.url));
const ffmpeg = process.platform === "win32" ? resolve(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe") : "ffmpeg";
const width = 256;
const height = 8;
const legacyBalance = "colorbalance=rs=0:gs=0:bs=0:rm=0:gm=0:bm=0:rh=0:gh=0:bh=0:pl=1";

/** Independent byte-authored edge colours; no production grader generates the oracle. */
function edgeRamp() {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const ramp = Math.round(x * 0.6) + 32;
      const colour = [[255, ramp, 0], [0, ramp, 255], [ramp, 255, 0], [255, 0, ramp]][y % 4];
      pixels.set([...colour, x], (y * width + x) * 4);
    }
  }
  return pixels;
}

function filterPixels(pixels: Buffer, filters: string[]) {
  const result = spawnSync(ffmpeg, ["-v", "error", "-nostdin", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${width}x${height}`, "-i", "pipe:0", "-vf", [...filters, "format=rgba"].join(","), "-frames:v", "1", "-f", "rawvideo", "pipe:1"], {
    input: pixels, windowsHide: true, timeout: 15_000, maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(`Real FFmpeg pixel test failed: ${result.error ?? result.stderr.toString()}`);
  expect(result.stdout.byteLength).toBe(pixels.byteLength);
  return result.stdout;
}

function assertIdentity(actual: Buffer, expected: Buffer) {
  expect(actual.length).toBe(expected.length);
  let maxDifference = 0;
  for (let i = 0; i < actual.length; i += 1) maxDifference = Math.max(maxDifference, Math.abs(actual[i] - expected[i]));
  expect(maxDifference, "neutral colour controls must preserve chromatic endpoint pixels").toBeLessThanOrEqual(1);
}

function assertChromaticAndAlpha(actual: Buffer, expected: Buffer) {
  let neutralized = 0;
  for (let i = 0; i < actual.length; i += 4) {
    expect(actual[i + 3], "colour balance must not modify alpha").toBe(expected[i + 3]);
    if (Math.max(actual[i], actual[i + 1], actual[i + 2]) - Math.min(actual[i], actual[i + 1], actual[i + 2]) < 32) neutralized += 1;
  }
  expect(neutralized, "saturated colour edges must not become neutral-grey islands").toBe(0);
}

describe("real decoded primary-tone colour boundary regression", () => {
  it("calibrates the byte oracle against identity and the actual old pl=1 defect", () => {
    const pixels = edgeRamp();
    assertIdentity(filterPixels(pixels, ["null"]), pixels);
    const broken = filterPixels(pixels, [legacyBalance]);
    expect(() => assertIdentity(broken, pixels)).toThrow(/neutral colour controls/);
    expect(() => assertChromaticAndAlpha(broken, pixels)).toThrow(/neutral-grey islands/);
  });

  it("keeps production neutral tone controls an identity including 0/255 boundaries and alpha", () => {
    const pixels = edgeRamp();
    const output = filterPixels(pixels, primaryToneFilters(DEFAULT_COLOR));
    assertIdentity(output, pixels);
    assertChromaticAndAlpha(output, pixels);
  });

  it.each([
    [0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
  ])("preserves colour boundaries with temperature=%s tint=%s", (temperature, tint) => {
    const pixels = edgeRamp();
    const output = filterPixels(pixels, primaryToneFilters({ ...DEFAULT_COLOR, temperature, tint }));
    assertChromaticAndAlpha(output, pixels);
    expect(output.equals(pixels), "non-neutral controls must still have a real pixel effect").toBe(false);
  });

  it("does not reintroduce neutral-grey islands when shadows/highlights trigger the production tone stage", () => {
    const pixels = edgeRamp();
    const output = filterPixels(pixels, primaryToneFilters({ ...DEFAULT_COLOR, shadows: -0.035, highlights: -0.24, whites: -0.12 }));
    assertChromaticAndAlpha(output, pixels);
    expect(output.equals(pixels)).toBe(false);
  });
});
