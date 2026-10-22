import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type ColorGradeV2, type EditProject } from "../domain/types";
import { bakeColorGradeLut, sampleBakedGradeLut, type BakedGradeLut } from "../color/gradeLutBake";
import { renderComposite } from "./ffmpegComposite";
import { buildRenderPlan } from "./planner";

/**
 * Real bundled FFmpeg: the export graph with Color Grade v2 decodes, and its pixels follow the baked table.
 *
 * Reference = LUT(F), where F is the exact pre-LUT frame (the lossless 4:4:4 source; the Rec.709 source
 * chain is a same-size no-op). Comparing against LUT(plain H.264 export) instead feeds the plain export's
 * own 4:2:0 error through the LUT's slope: that old check read 1.575 on this seeded frame and 2.37 in a
 * full run (unseeded `gradients` draws new colours every run), against a 1.5 limit that measured codec
 * error, not the LUT. Measured with the seed (2026-10-10, hfl2_food_warm_appetite, mean 8-bit codes):
 * ProRes 4444 10-bit 4:4:4 graded vs LUT(F) 0.508; H.264 4:2:0 crf18 ungraded vs F 1.636 (the codec
 * floor), graded vs LUT(F) 1.347 — so the H.264 check is relative to the measured floor.
 * pro-w1-1: the floor depends on the content. The re-tuned food look is far more saturated, and 4:2:0 costs more
 * on saturated chroma (graded vs LUT(F) 2.557 with the plain-frame floor at 1.636), so the graded export is now
 * held to the floor of the graded picture itself: LUT(F) encoded alone with the same H.264 4:2:0 crf18 settings.
 */
const app = fileURLToPath(new URL("../../", import.meta.url));
const ffmpeg = resolve(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const ffprobe = resolve(app, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const width = 180, height = 320, frameIndex = 7;
let work = "";
let source: Buffer;

function run(args: string[], input?: Buffer): Buffer {
  const child = spawnSync(ffmpeg, args, { input, maxBuffer: 1 << 26, windowsHide: true, timeout: 60_000 });
  if (child.status !== 0) throw new Error(child.stderr?.toString() || String(child.error));
  return child.stdout;
}

function decodeFrame(path: string): Buffer {
  return run(["-v", "error", "-i", path, "-vf", `trim=start_frame=${frameIndex}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
}

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "editkin-grade-v2-render-"));
  // Smooth, seeded gradients (no sharp edges) so 4:2:0 subsampling stays small and every run sees the same pixels.
  run(["-v", "error", "-f", "lavfi", "-i", `gradients=s=${width}x${height}:c0=0x2050c0:c1=0xe0a070:c2=0x30a050:c3=0xf0e0d0:nb_colors=4:speed=0:seed=20261010:d=1:r=30`,
    "-c:v", "libx264", "-preset", "veryfast", "-qp", "0", "-pix_fmt", "yuv444p", join(work, "source.mp4")]);
  source = decodeFrame(join(work, "source.mp4"));
});
afterAll(async () => { if (work) await rm(work, { recursive: true, force: true }); });

function project(grade?: ColorGradeV2): EditProject {
  const value = createEmptyProject("Grade v2 render", { width, height, fps: 30 });
  value.assets.push({ id: "a", name: "a", uri: join(work, "source.mp4"), kind: "video", duration: 1, width, height, color: { interpretation: "rec709" } });
  value.tracks[0].clips.push({ id: "c", trackId: "video-main", assetId: "a", timelineStart: 0, sourceStart: 0, duration: 0.5, volume: 0,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], ...(grade ? { gradeV2: grade } : {}) });
  return value;
}

async function renderFrame(value: EditProject, name: string, master = false): Promise<Buffer> {
  const output = join(work, `${name}.${master ? "mov" : "mp4"}`);
  await renderComposite(ffmpeg, ffprobe, output, value, buildRenderPlan(value, uri => uri), undefined, master ? "prores_ks" : "libx264", 60_000,
    undefined, undefined, undefined, undefined, master);
  return decodeFrame(output);
}

/** Mean absolute 8-bit error of `frame` against `reference(pixel)` (0–1 floats). */
function meanError(frame: Buffer, reference: (pixel: number) => readonly number[]): number {
  let total = 0;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const expected = reference(pixel);
    for (let channel = 0; channel < 3; channel += 1) total += Math.abs(frame[pixel * 3 + channel] - expected[channel] * 255);
  }
  return total / (width * height * 3);
}

const sourcePixel = (pixel: number) => [source[pixel * 3] / 255, source[pixel * 3 + 1] / 255, source[pixel * 3 + 2] / 255] as [number, number, number];
const graded = (baked: BakedGradeLut) => (pixel: number) => sampleBakedGradeLut(baked, sourcePixel(pixel));

describe("Color Grade v2 real export", () => {
  const grade: ColorGradeV2 = { schema: "editkin.color-grade/v2", look: { id: "hfl2_food_warm_appetite" } };

  it("applies the shared table exactly on a 10-bit 4:4:4 delivery", async () => {
    const baked = bakeColorGradeLut(grade, "rec709_display");
    const frame = await renderFrame(project(grade), "graded-master", true);
    expect(frame.length).toBe(width * height * 3);
    // Measured 0.508: 16-bit lut3d + 10-bit 4:4:4 ProRes round trip + 8-bit decode.
    expect(meanError(frame, graded(baked))).toBeLessThan(0.75);
    // The grade really changed the picture (it is not an identity pass-through).
    expect(meanError(frame, sourcePixel)).toBeGreaterThan(3);
  }, 120_000);

  it("adds no error beyond the H.264 4:2:0 codec floor on the standard MP4 delivery", async () => {
    const baked = bakeColorGradeLut(grade, "rec709_display");
    const plain = await renderFrame(project(), "plain");
    const frame = await renderFrame(project(grade), "graded");
    const codecFloor = meanError(plain, sourcePixel);
    // The graded picture's own floor: LUT(F) made into the same kind of lossless 4:4:4 source and exported
    // ungraded through the same graph, so source conversion and 4:2:0 cost match the graded export.
    const reference = Buffer.alloc(width * height * 3);
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const value = graded(baked)(pixel);
      for (let channel = 0; channel < 3; channel += 1) reference[pixel * 3 + channel] = Math.round(Math.max(0, Math.min(1, value[channel])) * 255);
    }
    run(["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${width}x${height}`, "-r", "30", "-i", "pipe:0",
      "-c:v", "libx264", "-preset", "veryfast", "-qp", "0", "-pix_fmt", "yuv444p", join(work, "graded-source.mp4")], Buffer.concat(Array(30).fill(reference)));
    const floorProject = project();
    floorProject.assets[0].uri = join(work, "graded-source.mp4");
    const gradedFloor = meanError(await renderFrame(floorProject, "graded-floor"), graded(baked));
    // A steep table also magnifies the sub-code difference between the graph's own 8-bit source conversion and F
    // (measured on the 10-bit 4:4:4 master, as in the test above); budget that once, plus a small slack. A lost
    // truncation compensation (+0.5 code on every channel of the 8-bit path) still breaks this bound.
    const master = await renderFrame(project(grade), "graded-master-h264-check", true);
    const masterError = meanError(master, graded(baked));
    const gradeError = meanError(frame, graded(baked));
    expect(codecFloor).toBeLessThan(2.5);
    expect(gradedFloor).toBeLessThan(3.5);
    expect(masterError).toBeLessThan(0.75);
    expect(gradeError).toBeLessThan(gradedFloor + masterError + 0.25);
  }, 120_000);

  it("renders every spatial finishing stage in one valid graph", async () => {
    const finished: ColorGradeV2 = { schema: "editkin.color-grade/v2", look: { id: "hfl2_vlog_soft_film" },
      finishing: { halation: { amount: 0.3, threshold: 0.6 }, bloom: { amount: 0.2, threshold: 0.6 }, vignette: { amount: 0.4 }, grain: { amount: 0.3, size: 1.5 } } };
    const frame = await renderFrame(project(finished), "finished");
    const plain = await renderFrame(project(), "plain-2");
    const corner = (buffer: Buffer) => buffer[0] + buffer[1] + buffer[2];
    const center = (buffer: Buffer) => { const index = ((height >> 1) * width + (width >> 1)) * 3; return buffer[index] + buffer[index + 1] + buffer[index + 2]; };
    expect(frame.length).toBe(width * height * 3);
    // The vignette darkens corners much more than the centre.
    expect(corner(plain) - corner(frame)).toBeGreaterThan(center(plain) - center(frame) + 20);
  }, 120_000);
});
