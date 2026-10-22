import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPhoneProjectV1 } from "../application/phoneProjectV1";
import { runColorProcess } from "../application/materialColorSamplingRuntime";
import { createClipMask } from "../domain/masks";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { renderComposite } from "./ffmpegComposite";
import { buildRenderPlan } from "./planner";

const ffmpeg = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobe = resolve("vendor/ffmpeg/win32-x64/ffprobe.exe");
const width = 64, height = 32, pixels = width * height, sourceFrames = 40, frames = 24, fps = 30;
const levels = [0, 1, 128, 16384, 32768, 49151, 65535];
let root: string, sequence = 0;
const workingSources: Buffer[] = [];
const sourceValue = (side: number, f: number, plane: number, x: number) => plane === 3
  ? levels[side === 0 ? Math.floor(x / 7) % 7 : x % 7] : 21000 + side * 12000 + f * (side ? 113 : 79) + plane * 331 + x;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "editkin-paired-producer16-test-"));
  for (const side of [0, 1]) {
    const raw = Buffer.alloc(sourceFrames * pixels * 8), audio = Buffer.alloc(sourceFrames * 1600 * 4);
    for (let f = 0; f < sourceFrames; f += 1) for (let plane = 0; plane < 4; plane += 1) for (let i = 0; i < pixels; i += 1)
      raw.writeUInt16LE(sourceValue(side, f, plane, i % width), 2 * ((f * 4 + plane) * pixels + i));
    for (let i = 0; i < audio.length / 4; i += 1) audio.writeFloatLE(.1 * Math.sin(2 * Math.PI * (220 + side * 440 + Math.floor(i / 1600) * 3) * i / 48000), i * 4);
    await writeFile(join(root, `${side}.raw`), raw); await writeFile(join(root, `${side}.pcm`), audio);
    await runColorProcess(ffmpeg, ["-v", "error", "-nostdin", "-threads", "1", "-f", "rawvideo", "-pixel_format", "gbrap16le", "-video_size", `${width}x${height}`, "-framerate", String(fps), "-i", join(root, `${side}.raw`),
      "-f", "f32le", "-ar", "48000", "-ac", "1", "-i", join(root, `${side}.pcm`), "-map", "0:v", "-map", "1:a", "-frames:v", String(sourceFrames), "-c:v", "ffv1", "-level", "3", "-pix_fmt", "gbrap16le", "-color_range", "pc", "-c:a", "pcm_f32le", join(root, `${side}.mkv`)], 4096, 15_000);
    const read = async (filter: string[]) => (await runColorProcess(ffmpeg, ["-v", "error", "-nostdin", "-threads", "1", "-i", join(root, `${side}.mkv`), ...filter,
      "-frames:v", String(sourceFrames), "-f", "rawvideo", "-pix_fmt", "gbrap16le", "pipe:1"], raw.length, 15_000)).stdout;
    expect((await read([])).equals(raw), "Unique-frame FFV1 fixture must retain every original code").toBe(true);
    // Reference covers only the declared input transform. It has no clip,
    // placement, alpha-over, transition or timeline compositor code.
    workingSources[side] = await read(["-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease:threads=1,format=gbrap16le,format=gbrapf32le,lut3d=file='public/color/aces2/luts/input-acescct-to-acescct.cube':interp=tetrahedral,format=gbrap16le`]);
    expect(workingSources[side].length).toBe(raw.length);
    for (let f = 0; f < sourceFrames; f += 1) for (let i = 0; i < pixels; i += 1)
      expect(workingSources[side].readUInt16LE(2 * ((f * 4 + 3) * pixels + i))).toBe(sourceValue(side, f, 3, i % width));
  }
});
afterAll(async () => {
  if (!root) return;
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), "editkin-paired-producer16-test-"))) throw Error("Paired producer cleanup escaped its owned fixture");
  await rm(root, { recursive: true, force: true });
});
function project(kernel?: "dissolve" | "dip"): EditProject {
  const p = createPhoneProjectV1("Owned paired producer fixture", { width, height, fps }); p.colorManagement!.mode = "aces2";
  p.assets = [0, 1].map(side => ({ id: String(side), name: "Owned unique-frame movie", uri: join(root, `${side}.mkv`), kind: "video" as const, duration: sourceFrames / fps,
    width, height, alphaMode: "straight" as const, color: { interpretation: "acescct" as const, range: "pc" as const } }));
  p.tracks[0].clips = [0, 1].map(side => ({ id: `clip${side}`, assetId: String(side), trackId: p.tracks[0].id, timelineStart: side * 12 / fps, sourceStart: (12 + side * 12) / fps,
    duration: 12 / fps, volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }));
  if (kernel) p.timelineTransitions = [{ schema: "editkin.timeline-transition/v1", id: "owned-cut", trackId: p.tracks[0].id, fromClipId: "clip0", toClipId: "clip1", beforeFrames: 4, afterFrames: 4, kernel }];
  return p;
}
async function render(p: EditProject): Promise<{ output: string; bytes: Buffer }> {
  const before = structuredClone(p), output = join(root, `output${sequence++}.mkv`);
  await renderComposite(ffmpeg, ffprobe, output, p, buildRenderPlan(p, uri => uri), undefined, "ffv1", 90_000, undefined, resolve("public/color/aces2"), undefined, undefined, true);
  expect(p).toEqual(before);
  const bytes = (await runColorProcess(ffmpeg, ["-v", "error", "-nostdin", "-threads", "1", "-i", output, "-frames:v", String(frames), "-f", "rawvideo", "-pix_fmt", "gbrap16le", "pipe:1"], frames * pixels * 8, 15_000)).stdout;
  expect(bytes.length).toBe(frames * pixels * 8); return { output, bytes };
}
// Independent transfer and pair equations. Every source frame is distinct.
const linear = (v: number) => v <= .155251141552511 ? (v - .0729055341958355) / 10.5402377416545 : 2 ** (v * 17.52 - 9.72);
const cct = (v: number) => v <= .0078125 ? 10.5402377416545 * v + .0729055341958355 : (Math.log2(v) + 9.72) / 17.52;
const workingValue = (side: number, f: number, plane: number, x: number) => workingSources[side].readUInt16LE(2 * ((f * 4 + plane) * pixels + x));
function expected(kernel: "dissolve" | "dip", f: number, plane: number, x: number): number {
  const inWindow = f >= 8 && f < 16, side = f < 12 ? 0 : 1;
  if (!inWindow) return plane === 3 || sourceValue(side, f + 12, 3, x) > 0 ? workingValue(side, f + 12, plane, x) : 0;
  const u = (f - 8) / 8, aa = sourceValue(0, f + 12, 3, x) / 65535, ab = sourceValue(1, f + 12, 3, x) / 65535;
  const wa = (kernel === "dip" ? Math.max(0, 1 - 2 * u) : 1 - u) * aa, wb = (kernel === "dip" ? Math.max(0, 2 * u - 1) : u) * ab;
  const black = kernel === "dip" ? 1 - Math.abs(2 * u - 1) : 0, alpha = wa + wb + black;
  if (plane === 3) return Math.round(alpha * 65535);
  if (!alpha) return 0;
  if (u === 0) return workingValue(0, f + 12, plane, x);
  return Math.round(Math.max(0, Math.min(1, cct((wa * linear(workingValue(0, f + 12, plane, x) / 65535) + wb * linear(workingValue(1, f + 12, plane, x) / 65535)) / alpha))) * 65535);
}
describe("actual complete paired-source16-bit movie producer", () => {
  it.each(["dissolve", "dip"] as const)("%s uses genuine pre/post source frames, exact window and all49 alpha pairs", async kernel => {
    const { bytes } = await render(project(kernel));
    let alphaError = 0, rgbError = 0, witness = {};
    for (let f = 0; f < frames; f += 1) for (let plane = 0; plane < 4; plane += 1) for (let i = 0; i < pixels; i += 1) {
      const error = Math.abs(bytes.readUInt16LE(2 * ((f * 4 + plane) * pixels + i)) - expected(kernel, f, plane, i % width));
      if (plane === 3) alphaError = Math.max(alphaError, error); else if (error > rgbError) {
        rgbError = error; witness = { f, plane, x: i % width, y: Math.floor(i / width), actual: bytes.readUInt16LE(2 * ((f * 4 + plane) * pixels + i)), expected: expected(kernel, f, plane, i % width), alphaA: sourceValue(0, f + 12, 3, i % width), alphaB: sourceValue(1, f + 12, 3, i % width) };
      }
    }
    expect(alphaError).toBe(0); expect(rgbError, JSON.stringify(witness)).toBeLessThanOrEqual(1);
  }, 30_000);
  it("original no-pair ingress matches the independently declared input-transform plane", async () => {
    const { bytes } = await render(project()); let alphaError = 0, rgbError = 0, witness = {};
    for (let f = 0; f < frames; f += 1) for (let plane = 0; plane < 4; plane += 1) for (let i = 0; i < pixels; i += 1) {
      const side = f < 12 ? 0 : 1, x = i % width;
      const want = plane === 3 || sourceValue(side, f + 12, 3, x) > 0 ? workingValue(side, f + 12, plane, x) : 0;
      const actual = bytes.readUInt16LE(2 * ((f * 4 + plane) * pixels + i)), error = Math.abs(actual - want);
      if (plane === 3) alphaError = Math.max(alphaError, error); else if (error > rgbError) { rgbError = error; witness = { f, plane, x, actual, want }; }
    }
    expect(alphaError).toBe(0); expect(rgbError, JSON.stringify(witness)).toBeLessThanOrEqual(1);
  }, 30_000);
  it("refuses handles absent from the actual file even when declared duration allows them", async () => {
    const p = project("dissolve"); p.assets[0].duration = 10; p.tracks[0].clips[0].sourceStart = 35 / fps;
    await expect(render(p)).rejects.toThrow("TIMELINE_TRANSITION_ACTUAL_HANDLE_MISSING");
  }, 30_000);
  it("keeps nominal audio byte-exact while video reads additional source handles", async () => {
    const p = project("dissolve"); for (const clip of p.tracks[0].clips) clip.volume = .3;
    const plain = structuredClone(p); delete plain.timelineTransitions;
    const a = await render(plain), b = await render(p);
    const decode = async (path: string) => (await runColorProcess(ffmpeg, ["-v", "error", "-nostdin", "-threads", "1", "-i", path, "-vn", "-f", "f32le", "-ar", "48000", "-ac", "2", "pipe:1"], 1024 * 1024, 15_000)).stdout;
    const original = await decode(a.output), paired = await decode(b.output); expect(original.length).toBeGreaterThan(0); expect(paired).toEqual(original);
  }, 30_000);
  it("keeps incoming child animation and inherited parent opacity/position on their authored clocks", async () => {
    const p = project("dissolve"), child = p.tracks[0].clips[1];
    child.layer = { enabled: true, blendMode: "normal", parentClipId: "parent" };
    child.keyframes = [0, 12].map(f => ({ id: `child-${f}`, time: f / fps, transform: { ...DEFAULT_TRANSFORM, opacity: .25 + .75 * f / 12 }, color: { ...DEFAULT_COLOR }, easing: "linear" as const }));
    const parent = { ...structuredClone(child), id: "parent", trackId: "parents", timelineStart: 0, sourceStart: 0, duration: frames / fps,
      layer: { enabled: true, blendMode: "normal" as const, role: "controller" as const },
      keyframes: [0, frames].map(f => ({ id: `parent-${f}`, time: f / fps, transform: { ...DEFAULT_TRANSFORM, x: 8 * f / frames, opacity: .5 + .5 * f / frames }, color: { ...DEFAULT_COLOR }, easing: "linear" as const })) };
    p.tracks.push({ ...structuredClone(p.tracks[0]), id: "parents", clips: [parent] });
    const { bytes } = await render(p); let maximum = 0, witness = {};
    for (let f = 0; f < frames; f += 1) for (let i = 0; i < pixels; i += 1) {
      const x = i % width, sourceX = x - Math.trunc(8 * ((f / fps) / (frames / fps)));
      const a = sourceValue(0, f + 12, 3, x), local = Math.max(0, Math.min(12, f - 12));
      const b = sourceX < 0 || sourceX >= width ? 0 : Math.floor(sourceValue(1, f + 12, 3, sourceX) * (.25 + .75 * local / 12) * (.5 + .5 * f / frames) + 1e-9);
      const want = f < 8 ? a : f >= 16 ? b : Math.round(a * (1 - (f - 8) / 8) + b * (f - 8) / 8);
      const actual = bytes.readUInt16LE(2 * ((f * 4 + 3) * pixels + i)), error = Math.abs(actual - want);
      if (error > maximum) { maximum = error; witness = { f, x, actual, want }; }
    }
    expect(maximum, JSON.stringify(witness)).toBeLessThanOrEqual(1);
  }, 30_000);
  it("keeps animated vector mask samples on nominal local time while reading real pre-roll", async () => {
    const p = project("dissolve"), mask = createClipMask("owned-moving-mask", "rectangle");
    mask.feather = 0; mask.expansion = 0; mask.refine.chatterReduction = 0;
    const rectangle = (left: number, right: number) => [{ id: "a", x: left, y: 0 }, { id: "b", x: right, y: 0 }, { id: "c", x: right, y: 1 }, { id: "d", x: left, y: 1 }];
    mask.path = rectangle(0, .5); mask.keyframes = [0, 4].map(f => ({ frame: f, time: f / fps, confidence: 1, status: "manual" as const, points: f === 0 ? rectangle(0, .5) : rectangle(.5, 1) }));
    p.tracks[0].clips[1].masks = [mask];
    const { bytes } = await render(p); let maximum = 0, witness = {};
    for (let f = 0; f < frames; f += 1) for (let i = 0; i < pixels; i += 1) {
      const x = i % width, a = sourceValue(0, f + 12, 3, x), allowed = f - 12 <= 2 ? x <= 32 : x >= 32;
      const b = allowed ? sourceValue(1, f + 12, 3, x) : 0;
      const want = f < 8 ? a : f >= 16 ? b : Math.round(a * (1 - (f - 8) / 8) + b * (f - 8) / 8);
      const actual = bytes.readUInt16LE(2 * ((f * 4 + 3) * pixels + i)), error = Math.abs(actual - want);
      if (error > maximum) { maximum = error; witness = { f, x, actual, want }; }
    }
    expect(maximum, JSON.stringify(witness)).toBe(0);
  }, 30_000);
  it("encodes an ordinary Rec709 MP4 with the full frame clock and linear-light midpoint", async () => {
    const p = project("dissolve"), before = structuredClone(p); p.colorManagement!.mode = "rec709";
    for (const asset of p.assets) { asset.alphaMode = "opaque"; asset.color!.interpretation = "rec709"; }
    const authored = structuredClone(p), output = join(root, `public${sequence++}.mp4`);
    await renderComposite(ffmpeg, ffprobe, output, p, buildRenderPlan(p, uri => uri), undefined, "libx264", 90_000);
    expect(p).toEqual(authored); expect(before.timelineTransitions).toEqual(p.timelineTransitions);
    const bytes = (await runColorProcess(ffmpeg, ["-v", "error", "-nostdin", "-threads", "1", "-i", output, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], frames * pixels * 3, 15_000)).stdout;
    expect(bytes.length).toBe(frames * pixels * 3);
    // Red occupies the third planar source channel. At frame12 u=1/2.
    let actual = 0, want = 0, arithmetic = 0, count = 0;
    for (let y = 8; y < 24; y += 1) for (let x = 16; x < 48; x += 1) {
      const a = sourceValue(0, 24, 2, x) / 65535, b = sourceValue(1, 24, 2, x) / 65535;
      actual += bytes[(12 * pixels + y * width + x) * 3]; want += ((a ** 2.4 + b ** 2.4) / 2) ** (1 / 2.4) * 255; arithmetic += (a + b) * 127.5; count++;
    }
    expect(Math.abs(actual / count - want / count)).toBeLessThanOrEqual(4);
    expect(Math.abs(actual / count - arithmetic / count)).toBeGreaterThan(2);
  }, 30_000);
});
