import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type ColorGradeV2, type EditProject } from "../domain/types";
import { renderComposite } from "./ffmpegComposite";
import { buildRenderPlan } from "./planner";

/**
 * Real bundled FFmpeg regression for the washed-out ACES 2.0 SDR path (pro-w1-1): a Rec.709 test chart
 * (ColorChecker-style patches, 18 % grey, black, white) exported Rec.709 in → ACES → SDR Rec.709 out.
 * Patch centres (inner 20×20 of each 40×40 tile) are compared with the decoded lossless source.
 *
 * - Without a v2 grade the ACES export is unchanged (byte-identity guarantee) and still washes the chart
 *   out — this pins the documented status quo: white ≈ 0.71, mid-grey ΔL* ≈ −8, chroma ≈ ×0.8.
 * - With a v2 grade (look strength 0 = identity grade) the clip enters ACEScct through the display inverse
 *   and the same export round-trips the chart: mid-grey |ΔL*| ≤ 1.5, white ≥ 250/255, mid contrast and
 *   chroma within ±5 % (8-bit ACEScct composite + H.264 4:2:0 crf 18 included).
 */
const app = fileURLToPath(new URL("../../", import.meta.url));
const ffmpeg = resolve(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const ffprobe = resolve(app, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const colorRoot = resolve(app, "public/color/aces2");
const TILE = 40, COLUMNS = 6, ROWS = 5, width = TILE * COLUMNS, height = TILE * ROWS, frameIndex = 7;
const GREY18 = Math.round(0.18 ** (1 / 2.4) * 255);
const PATCHES: Array<[number, number, number]> = [
  [115, 82, 68], [194, 150, 130], [98, 122, 157], [87, 108, 67], [133, 128, 177], [103, 189, 170], [214, 126, 44], [80, 91, 166],
  [193, 90, 99], [94, 60, 108], [157, 188, 64], [224, 163, 46], [56, 61, 150], [70, 148, 73], [175, 54, 60], [231, 199, 31],
  [187, 86, 149], [8, 133, 161], [243, 243, 242], [200, 200, 200], [160, 160, 160], [122, 122, 121], [85, 85, 85], [52, 52, 52],
  [GREY18, GREY18, GREY18], [255, 255, 255], [0, 0, 0], [128, 128, 128], [235, 140, 60], [70, 140, 220],
];
const CHROMATIC = [...Array(18).keys()];
let work = "";
let source: Buffer;

function run(args: string[], input?: Buffer): Buffer {
  const child = spawnSync(ffmpeg, args, { input, maxBuffer: 1 << 26, windowsHide: true, timeout: 60_000 });
  if (child.status !== 0) throw new Error(child.stderr?.toString() || String(child.error));
  return child.stdout;
}

const decodeFrame = (path: string) => run(["-v", "error", "-i", path, "-vf", `trim=start_frame=${frameIndex}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "editkin-aces-reconstruction-"));
  const frame = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const patch = PATCHES[Math.floor(y / TILE) * COLUMNS + Math.floor(x / TILE)];
      frame.set(patch, (y * width + x) * 3);
    }
  }
  run(["-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${width}x${height}`, "-r", "30", "-i", "pipe:0",
    "-c:v", "libx264", "-preset", "veryfast", "-qp", "0", "-pix_fmt", "yuv444p", join(work, "chart.mp4")], Buffer.concat(Array(30).fill(frame)));
  source = decodeFrame(join(work, "chart.mp4"));
});
afterAll(async () => { if (work) await rm(work, { recursive: true, force: true }); });

function project(aces: boolean, grade?: ColorGradeV2): EditProject {
  const value = createEmptyProject("ACES reconstruction chart", { width, height, fps: 30 });
  if (aces) value.colorManagement = { mode: "aces2", workingSpace: "ACEScct", outputTransform: "rec709_sdr", configId: "studio-config-v4.0.0_aces-v2.0_ocio-v2.5" };
  value.assets.push({ id: "chart", name: "chart", uri: join(work, "chart.mp4"), kind: "video", duration: 1, width, height, color: { interpretation: "rec709" } });
  value.tracks[0].clips.push({ id: "c", trackId: "video-main", assetId: "chart", timelineStart: 0, sourceStart: 0, duration: 0.5, volume: 0,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], ...(grade ? { gradeV2: grade } : {}) });
  return value;
}

async function render(value: EditProject, name: string): Promise<Buffer> {
  const output = join(work, `${name}.mp4`);
  await renderComposite(ffmpeg, ffprobe, output, value, buildRenderPlan(value, uri => uri), undefined, "libx264", 60_000, undefined, colorRoot);
  return decodeFrame(output);
}

/** Mean RGB (0–1) of the inner 20×20 of every tile. */
function patches(frame: Buffer): Array<[number, number, number]> {
  return PATCHES.map((_, index) => {
    const column = index % COLUMNS, row = Math.floor(index / COLUMNS);
    const sum = [0, 0, 0];
    for (let y = row * TILE + 10; y < row * TILE + 30; y += 1) {
      for (let x = column * TILE + 10; x < column * TILE + 30; x += 1) for (let channel = 0; channel < 3; channel += 1) sum[channel] += frame[(y * width + x) * 3 + channel];
    }
    return sum.map(value => value / 400 / 255) as [number, number, number];
  });
}

function lab(rgb: [number, number, number]): [number, number, number] {
  const [r, g, b] = rgb.map(value => Math.max(0, Math.min(1, value)) ** 2.4);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047, y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > (6 / 29) ** 3 ? Math.cbrt(t) : t / (3 * (6 / 29) ** 2) + 4 / 29);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

function compare(frame: Buffer) {
  const before = patches(source).map(lab), after = patches(frame).map(lab), raw = patches(frame);
  const chroma = (value: [number, number, number]) => Math.hypot(value[1], value[2]);
  return {
    midGreyDeltaL: after[24][0] - before[24][0],
    white: raw[25][1],
    contrast: (after[19][0] - after[22][0]) / (before[19][0] - before[22][0]),
    saturation: CHROMATIC.reduce((sum, index) => sum + chroma(after[index]), 0) / CHROMATIC.reduce((sum, index) => sum + chroma(before[index]), 0),
  };
}

describe("ACES 2.0 SDR export of a Rec.709 chart", () => {
  it("keeps the Rec.709 path an identity at patch centres", async () => {
    const plain = compare(await render(project(false), "rec709"));
    expect(Math.abs(plain.midGreyDeltaL)).toBeLessThan(1);
    expect(plain.white).toBeGreaterThan(0.98);
    expect(Math.abs(plain.saturation - 1)).toBeLessThan(0.03);
  }, 120_000);

  it("pins the unchanged ungraded ACES export: the Camera Rec.709 input washes the chart out", async () => {
    const shipped = compare(await render(project(true), "aces-ungraded"));
    expect(shipped.white).toBeLessThan(0.8);
    expect(shipped.midGreyDeltaL).toBeLessThan(-5);
    expect(shipped.saturation).toBeLessThan(0.9);
  }, 120_000);

  it("round-trips the chart for a v2-graded clip through the display inverse", async () => {
    const graded = compare(await render(project(true, { schema: "editkin.color-grade/v2", look: { id: "hfl2_vlog_natural_daylight", strength: 0 } }), "aces-v2-base"));
    expect(Math.abs(graded.midGreyDeltaL)).toBeLessThanOrEqual(1.5);
    expect(graded.white).toBeGreaterThanOrEqual(250 / 255);
    expect(Math.abs(graded.contrast - 1)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(graded.saturation - 1)).toBeLessThanOrEqual(0.05);
  }, 120_000);
});
