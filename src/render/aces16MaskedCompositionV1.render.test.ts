import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPhoneProjectV1 } from "../application/phoneProjectV1";
import { runColorProcess } from "../application/materialColorSamplingRuntime";
import { createClipMask } from "../domain/masks";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type TrackMatteMode } from "../domain/types";
import { renderComposite } from "./ffmpegComposite";
import { buildRenderPlan } from "./planner";

const ffmpeg = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobe = resolve("vendor/ffmpeg/win32-x64/ffprobe.exe");
const width = 64, height = 32, pixels = width * height, frames = 7, levels = [0, 1, 128, 16384, 32768, 49151, 65535];
let root: string, source: string, sequence = 0;
const plains = new Map<boolean, Promise<Buffer>>();
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "editkin-mask-composite16-test-")); source = join(root, "source.mkv");
  const frame = Buffer.alloc(pixels * 8);
  for (let plane = 0; plane < 4; plane += 1) for (let i = 0; i < pixels; i += 1) frame.writeUInt16LE(plane === 3 ? levels[i % levels.length] : 32768 + plane * 128 + i % width, 2 * (plane * pixels + i));
  const raw = join(root, "source.raw"); await writeFile(raw, Buffer.concat(Array.from({ length: frames }, () => frame)));
  await runColorProcess(ffmpeg, ["-v", "error", "-nostdin", "-threads", "1", "-f", "rawvideo", "-pixel_format", "gbrap16le", "-video_size", `${width}x${height}`, "-framerate", "30", "-i", raw,
    "-frames:v", String(frames), "-c:v", "ffv1", "-level", "3", "-pix_fmt", "gbrap16le", "-color_range", "pc", source], 4096, 15_000);
});
afterAll(async () => {
  if (!root) return;
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), "editkin-mask-composite16-test-"))) throw Error("Composition test cleanup escaped its owned fixture");
  await rm(root, { recursive: true, force: true });
});
function project(opaque = false): EditProject {
  const p = createPhoneProjectV1("Owned complete16-bit mask fixture", { width, height, fps: 30 }); p.colorManagement!.mode = "aces2";
  p.assets = [{ id: "source", name: "Owned coded source", uri: source, kind: "video", duration: frames / 30, width, height, alphaMode: opaque ? "opaque" : "straight", color: { interpretation: "acescct", range: "pc" } }];
  p.tracks[0].clips = [{ id: "target", assetId: "source", trackId: p.tracks[0].id, timelineStart: 0, sourceStart: 0, duration: frames / 30, volume: 0,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }];
  return p;
}
async function render(p: EditProject): Promise<Buffer> {
  const before = structuredClone(p), output = join(root, String(sequence++) + ".mkv");
  await renderComposite(ffmpeg, ffprobe, output, p, buildRenderPlan(p, uri => uri), undefined, "ffv1", 90_000, undefined, resolve("public/color/aces2"), undefined, undefined, true);
  expect(p).toEqual(before);
  const bytes = (await runColorProcess(ffmpeg, ["-v", "error", "-nostdin", "-threads", "1", "-i", output, "-frames:v", String(frames), "-f", "rawvideo", "-pix_fmt", "gbrap16le", "pipe:1"], pixels * 8 * frames, 15_000)).stdout;
  expect(bytes.length).toBe(pixels * 8 * frames); return bytes;
}
const plain = (opaque = false) => {
  if (!plains.has(opaque)) plains.set(opaque, render(project(opaque)));
  return plains.get(opaque)!;
};
function matte(p: EditProject, mode: TrackMatteMode, opaque: boolean, spatial = false) {
  p.assets.push({ ...p.assets[0], id: "matte", alphaMode: opaque ? "opaque" : "straight" });
  const target = p.tracks[0].clips[0]; target.layer = { enabled: true, blendMode: "normal", trackMatte: { sourceClipId: "provider", mode } };
  const provider = { ...structuredClone(target), id: "provider", assetId: "matte", trackId: "matte-track", layer: { enabled: true, blendMode: "normal" as const },
    ...(spatial ? { timelineStart: 2 / 30, duration: 3 / 30, transform: { ...DEFAULT_TRANSFORM, scale: .5 } } : {}) };
  p.tracks.push({ ...structuredClone(p.tracks[0]), id: "matte-track", name: "Owned hidden matte", hidden: true, clips: [provider] });
}
function assertPlanes(bytes: Buffer, baseline: Buffer, coverage: (f: number, x: number, y: number, a: number) => number) {
  for (let f = 0; f < frames; f += 1) for (let i = 0; i < pixels; i += 1) {
    const expected = coverage(f, i % width, Math.floor(i / width), levels[i % levels.length]);
    expect(bytes.readUInt16LE(2 * ((f * 4 + 3) * pixels + i))).toBe(expected);
    for (let plane = 0; plane < 3; plane += 1) {
      const offset = 2 * ((f * 4 + plane) * pixels + i);
      expect(bytes.readUInt16LE(offset)).toBe(expected === 0 ? 0 : baseline.readUInt16LE(offset));
    }
  }
}

describe("complete16-bit masked compositor output", () => {
  it.each([false, true])("full-white vector mask is byte-exact identity for declared opaque=%s", async opaque => {
    const p = project(opaque), mask = createClipMask("full", "rectangle"); mask.feather = 0; mask.expansion = 0; mask.refine.edgeShift = 0;
    mask.path = [{ id: "p1", x: 0, y: 0 }, { id: "p2", x: 1, y: 0 }, { id: "p3", x: 1, y: 1 }, { id: "p4", x: 0, y: 1 }]; p.tracks[0].clips[0].masks = [mask];
    const baseline = await plain(opaque), bytes = await render(p); expect(bytes).toEqual(baseline);
    assertPlanes(bytes, baseline, (_f, _x, _y, a) => opaque ? 65535 : a);
  }, 30_000);
  it.each(["alpha", "alpha_inverted"] as const)("opaque %s matte preserves every code or removes all coverage", async mode => {
    const p = project(); matte(p, mode, true); assertPlanes(await render(p), await plain(), (_f, _x, _y, a) => mode === "alpha" ? a : 0);
  }, 30_000);
  it.each(["alpha", "alpha_inverted"] as const)("straight %s matte matches independent per-pixel coverage", async mode => {
    const p = project(); matte(p, mode, false); assertPlanes(await render(p), await plain(), (_f, _x, _y, a) => Math.floor(a * (mode === "alpha" ? a : 65535 - a) / 65535));
  }, 30_000);
  it.each(["alpha", "alpha_inverted"] as const)("spatial %s matte has exact gap, padding, placement and EOF coverage", async mode => {
    const p = project(); matte(p, mode, true, true); assertPlanes(await render(p), await plain(), (f, x, y, a) => {
      const covered = f >= 2 && f < 5 && x >= 16 && x < 48 && y >= 8 && y < 24;
      return (mode === "alpha" ? covered : !covered) ? a : 0;
    });
  }, 30_000);
});
