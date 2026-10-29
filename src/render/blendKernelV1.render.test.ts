import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { linearRec709ToWorking, workingToLinearRec709 } from "../color/gradeV2Color";
import { BLEND_MODES_V1, blendKernelColourGraphV1, blendKernelOverRgba8GraphV1, sceneLinearBlendV1, w3cBlendV1, w3cCompositeV1, type NonNormalBlendModeV1 } from "./blendKernelV1";
import { blendKernelSceneLinearGraphV1 } from "./blendKernelSceneLinearV1";
import { prepareTimelineTransitionMatteLutsV1, type TimelineTransitionMatteLutsV1 } from "./timelineTransitionMatteNativeV1";

/** The blend kernel's FFmpeg graphs, run on raw frames and compared with the JS W3C reference (P1/P2). */
const run = promisify(execFile);
const app = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const ffmpeg = join(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const MODES = BLEND_MODES_V1.filter(mode => mode !== "normal") as NonNormalBlendModeV1[];
const VALUES = [0, 1, 26, 51, 64, 77, 102, 127, 128, 153, 191, 204, 230, 254, 255];
let root = "";
let luts: TimelineTransitionMatteLutsV1;
let lutDirectory: string | undefined;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "editkin-blend-kernel-"));
  ({ luts, workDirectory: lutDirectory } = await prepareTimelineTransitionMatteLutsV1("acescct"));
}, 120_000);
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  if (lutDirectory) await rm(lutDirectory, { recursive: true, force: true });
}, 120_000);

async function graph(inputs: Array<{ name: string; format: string; data: Buffer }>, width: number, height: number, filters: string[], outputFormat: string, bytes: number): Promise<Buffer> {
  const args = ["-v", "error", "-nostdin"];
  for (const input of inputs) {
    const path = join(root, `${input.name}-${Math.random().toString(36).slice(2)}.raw`);
    await writeFile(path, input.data);
    args.push("-f", "rawvideo", "-pixel_format", input.format, "-video_size", `${width}x${height}`, "-framerate", "30", "-i", path);
  }
  const labels = inputs.map((input, index) => `[${index}:v]format=${input.format}[${input.name}]`);
  args.push("-filter_complex", [...labels, ...filters].join(";"), "-map", "[out]", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", outputFormat, "pipe:1");
  const { stdout } = await run(ffmpeg, args, { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  expect(stdout.length).toBe(bytes);
  return stdout;
}

describe.skipIf(!existsSync(ffmpeg))("blend kernel v1 FFmpeg lowering", () => {
  it("8-bit rgba composite equals W3C source-over with blend for every mode (opaque and transparent backdrop)", async () => {
    // Pixel grid: every backdrop value × every source value, with three backdrop alphas and three source alphas.
    const pairs: Array<[number, number, number, number]> = [];
    for (const ab of [255, 0]) for (const as of [255, 128, 37]) for (const b of VALUES) for (const s of VALUES) pairs.push([b, ab, s, as]);
    const width = pairs.length, height = 1;
    const backdrop = Buffer.alloc(width * 4), source = Buffer.alloc(width * 4);
    pairs.forEach(([b, ab, s, as], index) => {
      backdrop.set([b, Math.round(b * 0.6), 255 - b, ab], index * 4);
      source.set([s, 255 - s, Math.round(s * 0.3), as], index * 4);
    });
    for (const mode of MODES) {
      const out = await graph([{ name: "bd", format: "rgba", data: backdrop }, { name: "ly", format: "rgba", data: source }], width, height,
        blendKernelOverRgba8GraphV1("bd", "ly", "out", mode), "rgba", width * 4);
      let maximum = 0;
      for (let index = 0; index < width; index += 1) {
        const at = index * 4;
        const reference = w3cCompositeV1(
          { r: backdrop[at] / 255, g: backdrop[at + 1] / 255, b: backdrop[at + 2] / 255, a: backdrop[at + 3] / 255 },
          { r: source[at] / 255, g: source[at + 1] / 255, b: source[at + 2] / 255, a: source[at + 3] / 255 }, mode);
        if (reference.a === 0) continue;
        for (const [channel, value] of [reference.r, reference.g, reference.b].entries()) maximum = Math.max(maximum, Math.abs(out[at + channel] - Math.round(value * 255)));
        maximum = Math.max(maximum, Math.abs(out[at + 3] - Math.round(reference.a * 255)));
      }
      expect({ mode, maximum: maximum <= 2 }).toEqual({ mode, maximum: true });
    }
  }, 120_000);

  it("16-bit colour stage equals W3C B(Cb, Cs) for every mode, including the dodge/burn 0/1 corners", async () => {
    const levels = [0, 1, 6554, 16384, 32767, 32768, 49151, 58982, 65534, 65535];
    const width = levels.length * levels.length;
    const backdrop = Buffer.alloc(width * 8), source = Buffer.alloc(width * 8);
    for (let i = 0; i < width; i += 1) for (let plane = 0; plane < 4; plane += 1) {
      backdrop.writeUInt16LE(plane === 3 ? 65535 : levels[Math.floor(i / levels.length)], 2 * (plane * width + i));
      source.writeUInt16LE(plane === 3 ? 65535 : levels[i % levels.length], 2 * (plane * width + i));
    }
    for (const mode of MODES) {
      const out = await graph([{ name: "bd", format: "gbrap16le", data: backdrop }, { name: "ly", format: "gbrap16le", data: source }], width, 1,
        [...blendKernelColourGraphV1("bd", "ly", "mix", mode, 16), "[mix]format=gbrap16le[out]"], "gbrap16le", width * 8);
      let maximum = 0;
      for (let i = 0; i < width; i += 1) {
        const expected = Math.round(w3cBlendV1(mode, levels[Math.floor(i / levels.length)] / 65535, levels[i % levels.length] / 65535) * 65535);
        maximum = Math.max(maximum, Math.abs(out.readUInt16LE(2 * i) - expected));
      }
      expect({ mode, maximum: maximum <= 2 }).toEqual({ mode, maximum: true });
    }
  }, 120_000);

  it("ACES 2 scene-linear blend: untouched pixels stay bit-exact, black screen and white multiply are identities, values follow the linear W3C reference", async () => {
    const width = 64, height = 1;
    const backdrop = Buffer.alloc(width * 8), source = Buffer.alloc(width * 8);
    const cct = (index: number, plane: number) => Math.round(65535 * (0.05 + 0.85 * ((index * 7 + plane * 13) % 64) / 63));
    for (let i = 0; i < width; i += 1) for (let plane = 0; plane < 4; plane += 1) {
      backdrop.writeUInt16LE(plane === 3 ? 65535 : cct(i, plane), 2 * (plane * width + i));
      // Columns 0–15: layer alpha 0 (untouched); 16–31: opaque; 32–63: partial.
      source.writeUInt16LE(plane === 3 ? (i < 16 ? 0 : i < 32 ? 65535 : 32768) : cct(i + 11, plane + 1), 2 * (plane * width + i));
    }
    const at = (buffer: Buffer, plane: number, i: number) => buffer.readUInt16LE(2 * (plane * width + i));
    const run16 = (layer: Buffer, mode: NonNormalBlendModeV1) => graph([{ name: "bd", format: "gbrap16le", data: backdrop }, { name: "ly", format: "gbrap16le", data: layer }], width, height,
      blendKernelSceneLinearGraphV1({ backdrop: "bd", layer: "ly", output: "out", mode, luts, precision: "gbrap16le", opaqueBackdrop: true }), "gbrap16le", width * 8);
    // ACEScct codes of scene-linear black and white (AP1), opaque.
    const solid = (value: number) => { const buffer = Buffer.alloc(width * 8); for (let i = 0; i < width; i += 1) for (let plane = 0; plane < 4; plane += 1) buffer.writeUInt16LE(plane === 3 ? 65535 : value, 2 * (plane * width + i)); return buffer; };
    const blackCode = Math.round(linearRec709ToWorking([0, 0, 0], "acescct")[0] * 65535), whiteCode = Math.round(linearRec709ToWorking([1, 1, 1], "acescct")[0] * 65535);
    for (const [mode, layer] of [["screen", solid(blackCode)], ["multiply", solid(whiteCode)], ["color_dodge", solid(blackCode)]] as const) {
      const out = await run16(layer, mode);
      let maximum = 0;
      for (let i = 0; i < width; i += 1) for (let plane = 0; plane < 3; plane += 1) maximum = Math.max(maximum, Math.abs(at(out, plane, i) - at(backdrop, plane, i)));
      expect({ mode, maximum: maximum <= 2 }).toEqual({ mode, maximum: true });
    }
    for (const mode of MODES) {
      const out = await run16(source, mode);
      let untouched = 0, maximum = 0, worst = "";
      for (let i = 0; i < width; i += 1) {
        // gbrap16le planes are G, B, R.
        const rgb = (buffer: Buffer) => [at(buffer, 2, i), at(buffer, 0, i), at(buffer, 1, i)].map(v => v / 65535) as [number, number, number];
        if (i < 16) { for (let plane = 0; plane < 4; plane += 1) untouched = Math.max(untouched, Math.abs(at(out, plane, i) - at(backdrop, plane, i))); continue; }
        const alpha = at(source, 3, i) / 65535;
        const b = workingToLinearRec709(rgb(backdrop), "acescct"), s = workingToLinearRec709(rgb(source), "acescct");
        const mixed = w3cCompositeV1({ r: b[0], g: b[1], b: b[2], a: 1 }, { r: s[0], g: s[1], b: s[2], a: alpha }, mode, sceneLinearBlendV1);
        const expected = linearRec709ToWorking([mixed.r, mixed.g, mixed.b], "acescct").map(v => Math.round(Math.max(0, Math.min(1, v)) * 65535));
        const actual = rgb(out).map(v => Math.round(v * 65535));
        for (let c = 0; c < 3; c += 1) { const d = Math.abs(actual[c] - expected[c]); if (d > maximum) worst = `px${i} c${c} got ${actual[c]} expected ${expected[c]} b=${rgb(backdrop).map(v => v.toFixed(4))} s=${rgb(source).map(v => v.toFixed(4))} a=${alpha.toFixed(3)}`; maximum = Math.max(maximum, d); }
      }
      expect({ mode, untouched }).toEqual({ mode, untouched: 0 });
      // 16-bit ACEScct codes: a few codes is far below one 8-bit display code.
      expect({ mode, maximum: maximum <= 16 ? "ok" : `${maximum} ${worst}` }).toEqual({ mode, maximum: "ok" });
    }
  }, 300_000);
});
