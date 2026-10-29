import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runColorProcess } from "../application/materialColorSamplingRuntime";
import { motionLibraryTransitionCommandsV1, renderMotionLibraryForProjectV1, resolveMotionLibraryCacheRootV1 } from "../application/motionLibraryClipsV1";
import { applyCommand } from "../domain/commands";
import { createEmptyProject } from "../domain/editGraph";
import { plainClip } from "../domain/motionLibraryV1.fixture";
import type { EditProject } from "../domain/types";
import { renderProject } from "./ffmpeg";

/**
 * A matte transition changes only its window: outside it the delivered frames are the footage colours exactly, and the
 * delivery stays limited-range Rec.709 like the dissolve export of the same window (a colour-range constraint inside the
 * matte graph once propagated through FFmpeg's negotiation to the delivery link and made the whole export full range).
 */
const ffmpeg = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobe = resolve("vendor/ffmpeg/win32-x64/ffprobe.exe");
const W = 64, H = 32, FPS = 30, START = 23, END = 38, TOTAL = 60;
let root: string;
beforeAll(async () => {
  root = join(resolve(process.env.TEMP ?? "."), `render-fix-matte-export-${process.pid}`);
  await mkdir(root, { recursive: true });
  for (const [name, colour] of [["a", "0xC83C32"], ["b", "0x2850C8"]]) {
    await runColorProcess(ffmpeg, ["-v", "error", "-nostdin", "-f", "lavfi", "-i", `color=c=${colour}:s=${W}x${H}:r=${FPS}:d=4`,
      "-vf", "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv,format=yuv420p", "-c:v", "libx264", "-crf", "8", "-g", "30",
      "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv", join(root, `${name}.mp4`)], 4096, 60_000);
  }
}, 120_000);
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

const options = { ffmpegPath: ffmpeg, ffprobePath: ffprobe, preferGpu: false, fontRoot: resolve("public/fonts"), colorRoot: resolve("public/color/aces2"), timeoutMs: 300_000 };
const rgb = async (path: string, frames = TOTAL) => (await runColorProcess(ffmpeg, ["-v", "error", "-nostdin", "-i", path, "-map", "0:v:0", "-frames:v", String(frames),
  "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], frames * W * H * 3, 60_000)).stdout;
const range = async (path: string) => (await runColorProcess(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=color_range,color_space,pix_fmt",
  "-of", "csv=p=0", path], 4096, 30_000)).stdout.toString("utf8").trim();

describe("matte transition export outside its window", () => {
  it("delivers the footage colours exactly outside the window, in limited-range Rec.709 like the dissolve export", async () => {
    let project: EditProject = createEmptyProject("Matte export", { id: "matte-export", width: W, height: H, fps: FPS });
    for (const name of ["a", "b"]) project = applyCommand(project, { type: "import_asset", asset: { id: name, name, kind: "video", uri: join(root, `${name}.mp4`), duration: 4, width: W, height: H } });
    project = applyCommand(project, { type: "add_clip", clip: plainClip("shot-a", "a", "video-main", 0, 1, 1) });
    project = applyCommand(project, { type: "add_clip", clip: plainClip("shot-b", "b", "video-main", 1, 1, 1) });
    const dissolve = applyCommand(project, { type: "set_timeline_transition", transition: { schema: "editkin.timeline-transition/v1", id: "cut", trackId: "video-main",
      fromClipId: "shot-a", toClipId: "shot-b", beforeFrames: 7, afterFrames: 8, kernel: "dissolve" } });
    const cacheRoot = await resolveMotionLibraryCacheRootV1({ projectPath: join(root, "p.editkin.json"), workspaceRoot: root });
    const wipe = await renderMotionLibraryForProjectV1({ project, cacheRoot, itemId: "X01", params: { durationSeconds: .5 }, ffmpegPath: ffmpeg, ffprobePath: ffprobe });
    const matte = applyCommand(project, { type: "batch", commands: motionLibraryTransitionCommandsV1(project, wipe,
      { transitionId: "cut", trackId: "video-main", fromClipId: "shot-a", toClipId: "shot-b", beforeFrames: 7, afterFrames: 8 }) });
    const [dissolveOut, matteOut] = [await renderProject(dissolve, join(root, "dissolve.mp4"), options), await renderProject(matte, join(root, "matte.mp4"), options)];
    expect(await range(matteOut.outputPath)).toBe(await range(dissolveOut.outputPath));
    expect(await range(matteOut.outputPath)).toMatch(/^yuv420p,tv,bt709/);
    const [a, b, out] = await Promise.all([rgb(join(root, "a.mp4"), 1), rgb(join(root, "b.mp4"), 1), rgb(matteOut.outputPath)]);
    const frameBytes = W * H * 3;
    expect(out.length).toBe(TOTAL * frameBytes);
    for (let frame = 0; frame < TOTAL; frame += 1) {
      if (frame >= START - 1 && frame < END + 1) continue; // the window, plus one frame of H.264 reference slack on each side
      const want = frame < START ? a : b, actual = out.subarray(frame * frameBytes, (frame + 1) * frameBytes);
      let different = 0; for (let i = 0; i < frameBytes; i += 1) if (actual[i] !== want[i]) different += 1;
      expect({ frame, different }).toEqual({ frame, different: 0 });
    }
  }, 600_000);
});
