import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runColorProcess } from "../application/materialColorSamplingRuntime";
import { motionLibraryTransitionCommandsV1, renderMotionLibraryForProjectV1, resolveMotionLibraryCacheRootV1 } from "../application/motionLibraryClipsV1";
import { applyCommand } from "../domain/commands";
import { createEmptyProject } from "../domain/editGraph";
import { plainClip } from "../domain/motionLibraryV1.fixture";
import { renderComposite } from "./ffmpegComposite";
import { buildRenderPlan } from "./planner";
import { timelineTransitionMatteMixV1 } from "./timelineTransitionMatteV1";
import type { TransitionRgbaV1 } from "./timelineTransitionMixV1";

/** End to end through the software composite: a real X01 render, a matte transition at a cut, 16-bit FFV1 output. */
const ffmpeg = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobe = resolve("vendor/ffmpeg/win32-x64/ffprobe.exe");
const W = 64, H = 32, N = W * H, FRAMES = 60, START = 23, WINDOW = 15;
let root: string;
beforeAll(async () => {
  root = join(resolve(process.env.TEMP ?? "."), `p3c-matte-composite-${process.pid}`);
  await mkdir(root, { recursive: true });
  for (const [name, colour] of [["a", "0xC83C32"], ["b", "0x2850C8"]]) {
    await runColorProcess(ffmpeg, ["-v", "error", "-nostdin", "-f", "lavfi", "-i", `color=c=${colour}:s=${W}x${H}:r=30:d=4`, "-vf", "format=gbrap16le",
      "-c:v", "ffv1", "-level", "3", "-pix_fmt", "gbrap16le", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "pc",
      join(root, `${name}.mkv`)], 4096, 30_000);
  }
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

const decode = async (path: string, pixFmt: string, frames: number, filter: string[] = []) =>
  (await runColorProcess(ffmpeg, ["-v", "error", "-nostdin", "-i", path, ...filter, "-frames:v", String(frames), "-f", "rawvideo", "-pix_fmt", pixFmt, "pipe:1"], frames * N * 8 + 1, 30_000)).stdout;

describe("matte transition through the software composite", () => {
  it("mixes A and B by the decoded matte inside the window, passes A and B through exactly, and leaves the rest untouched", async () => {
    let project = createEmptyProject("Matte composite", { id: "matte-composite", width: W, height: H, fps: 30 });
    for (const name of ["a", "b"]) project = applyCommand(project, { type: "import_asset", asset: { id: name, name, kind: "video", uri: join(root, `${name}.mkv`), duration: 4, width: W, height: H,
      alphaMode: "opaque", color: { interpretation: "rec709", range: "pc" } } });
    project = applyCommand(project, { type: "add_clip", clip: plainClip("shot-a", "a", "video-main", 0, 1, 1) });
    project = applyCommand(project, { type: "add_clip", clip: plainClip("shot-b", "b", "video-main", 1, 1, 1) });
    const cacheRoot = await resolveMotionLibraryCacheRootV1({ projectPath: join(root, "p.editkin.json"), workspaceRoot: root });
    const wipe = await renderMotionLibraryForProjectV1({ project, cacheRoot, itemId: "X01", params: { durationSeconds: .5 }, ffmpegPath: ffmpeg, ffprobePath: ffprobe });
    project = applyCommand(project, { type: "batch", commands: motionLibraryTransitionCommandsV1(project, wipe,
      { transitionId: "cut", trackId: "video-main", fromClipId: "shot-a", toClipId: "shot-b", beforeFrames: 7, afterFrames: 8 }) });
    const output = join(root, "out.mkv");
    await renderComposite(ffmpeg, ffprobe, output, project, buildRenderPlan(project, uri => uri), undefined, "ffv1", 120_000, undefined, resolve("public/color/aces2"), undefined, undefined, true);
    const out = await decode(output, "gbrap16le", FRAMES), mattes = await decode(wipe.result.outputs.matte!.path, "rgba64le", WINDOW);
    const overlays = wipe.result.outputs.overlay ? await decode(wipe.result.outputs.overlay.path, "rgba64le", WINDOW) : undefined;
    // The output is planar GBRA; the overlay reference is decoded as interleaved RGBA, so read it in G, B, R, A order.
    const GBRA = [1, 2, 0, 3];
    const plane = (frame: number, p: number, i: number) => out.readUInt16LE(2 * ((frame * 4 + p) * N + i));
    const pixel = (frame: number, i: number) => [0, 1, 2, 3].map(p => plane(frame, p, i));
    // The matte decodes as 12-bit alpha shifted to 16 bits; the kernel bit-replicates it, so the reference does too.
    // Before and after the window the composite is pure A and pure B.
    const a = pixel(10, 0), b = pixel(50, 0);
    for (let i = 0; i < N; i += 1) { expect(pixel(10, i)).toEqual(a); expect(pixel(50, i)).toEqual(b); }
    let exactA = 0, exactB = 0, mixed = 0, covered = 0, maxMixedError = 0, maxCoveredError = 0, witness = "";
    for (let k = 0; k < WINDOW; k += 1) for (let i = 0; i < N; i += 1) {
      const raw = mattes.readUInt16LE(8 * (k * N + i) + 6), m = raw + Math.floor(raw / 4096), oa = overlays ? overlays.readUInt16LE(8 * (k * N + i) + 6) : 0;
      const actual = pixel(START + k, i);
      if (oa === 0 && m === 0) { expect(actual).toEqual(a); exactA += 1; continue; }
      if (oa === 0 && m === 65535) { expect(actual).toEqual(b); exactB += 1; continue; }
      const overlay = overlays && oa > 0 ? GBRA.map(c => overlays.readUInt16LE(8 * (k * N + i) + 2 * c) / 65535) as unknown as TransitionRgbaV1 : undefined;
      const want = timelineTransitionMatteMixV1(a.map(v => v / 65535) as unknown as TransitionRgbaV1, b.map(v => v / 65535) as unknown as TransitionRgbaV1, m / 65535, overlay, "rec709_display");
      const error = Math.max(...[0, 1, 2, 3].map(c => Math.abs(actual[c] - Math.round(want[c] * 65535))));
      if (oa === 0) { mixed += 1; maxMixedError = Math.max(maxMixedError, error); }
      else { covered += 1; if (error > maxCoveredError) { maxCoveredError = error; witness = JSON.stringify({ k, i, m, oa, actual, want: want.map(v => Math.round(v * 65535)) }); } }
    }
    expect(exactA).toBeGreaterThan(0); expect(exactB).toBeGreaterThan(0);
    expect(maxMixedError).toBeLessThanOrEqual(1);
    // The overlay reaches the kernel through the ordinary clip styling; measured bit-exact against the CPU reference.
    if (overlays) expect(covered).toBeGreaterThan(0);
    expect(maxCoveredError, witness).toBeLessThanOrEqual(1);
    console.log(JSON.stringify({ exactA, exactB, mixed, maxMixedError, covered, maxCoveredError, overlay: Boolean(overlays) }));
  }, 180_000);
});
