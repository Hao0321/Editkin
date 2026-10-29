import { mkdir, readFile, rm } from "node:fs/promises";
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
 * Regression (render fixes 2026-10-22): with `nativeCorePath` set, every timeline transition used to throw
 * TIMELINE_TRANSITION_NATIVE_SHADER_NOT_CONNECTED, because the native-core export asked for the unversioned engine graph.
 * Dissolve/dip now compile as the versioned timeline_transition_v1 graph the shipped hao-core accepts; a matte transition
 * (declined by the native engine) renders exactly as the software route.
 */
const ffmpeg = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobe = resolve("vendor/ffmpeg/win32-x64/ffprobe.exe");
const haoCore = resolve("native/bin/win32-x64/hao-core.exe");
const W = 64, H = 32, FPS = 30;
let root: string;
beforeAll(async () => {
  root = join(resolve(process.env.TEMP ?? "."), `render-fix-native-route-${process.pid}`);
  await mkdir(root, { recursive: true });
  for (const [name, colour] of [["a", "0xC83C32"], ["b", "0x2850C8"]]) {
    await runColorProcess(ffmpeg, ["-v", "error", "-nostdin", "-f", "lavfi", "-i", `color=c=${colour}:s=${W}x${H}:r=${FPS}:d=4`,
      "-vf", "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv,format=yuv420p", "-c:v", "libx264", "-crf", "8", "-g", "30",
      "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv", join(root, `${name}.mp4`)], 4096, 60_000);
  }
}, 120_000);
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

function pairProject(): EditProject {
  let project = createEmptyProject("Native route", { id: "native-route", width: W, height: H, fps: FPS });
  for (const name of ["a", "b"]) project = applyCommand(project, { type: "import_asset", asset: { id: name, name, kind: "video", uri: join(root, `${name}.mp4`), duration: 4, width: W, height: H } });
  project = applyCommand(project, { type: "add_clip", clip: plainClip("shot-a", "a", "video-main", 0, 1, 1) });
  return applyCommand(project, { type: "add_clip", clip: plainClip("shot-b", "b", "video-main", 1, 1, 1) });
}
const options = (native: boolean) => ({ ffmpegPath: ffmpeg, ffprobePath: ffprobe, preferGpu: false, fontRoot: resolve("public/fonts"),
  colorRoot: resolve("public/color/aces2"), timeoutMs: 300_000, ...(native ? { nativeCorePath: haoCore } : {}) });
const frames = async (path: string) => (await runColorProcess(ffmpeg, ["-v", "error", "-nostdin", "-i", path, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
  64 * W * H * 3, 60_000)).stdout;

describe("native-core export route with timeline transitions", () => {
  it("renders a dissolve with the native core (versioned pair graph), with the same video as the software route", async () => {
    const project = applyCommand(pairProject(), { type: "set_timeline_transition", transition: { schema: "editkin.timeline-transition/v1", id: "cut", trackId: "video-main",
      fromClipId: "shot-a", toClipId: "shot-b", beforeFrames: 4, afterFrames: 4, kernel: "dissolve" } });
    const native = await renderProject(project, join(root, "dissolve-native.mp4"), options(true));
    const software = await renderProject(project, join(root, "dissolve-software.mp4"), options(false));
    expect(native.planner).toMatch(/^hao-core/);
    expect(software.planner).toBe("typescript-fallback");
    const [nativeFrames, softwareFrames] = await Promise.all([frames(native.outputPath), frames(software.outputPath)]);
    expect(nativeFrames.length).toBe(60 * W * H * 3);
    expect(nativeFrames.equals(softwareFrames)).toBe(true);
  }, 600_000);

  it("renders a matte transition exactly as the software route (the native engine declines it)", async () => {
    let project = pairProject();
    const cacheRoot = await resolveMotionLibraryCacheRootV1({ projectPath: join(root, "p.editkin.json"), workspaceRoot: root });
    const wipe = await renderMotionLibraryForProjectV1({ project, cacheRoot, itemId: "X01", params: { durationSeconds: .5 }, ffmpegPath: ffmpeg, ffprobePath: ffprobe });
    project = applyCommand(project, { type: "batch", commands: motionLibraryTransitionCommandsV1(project, wipe,
      { transitionId: "cut", trackId: "video-main", fromClipId: "shot-a", toClipId: "shot-b", beforeFrames: 7, afterFrames: 8 }) });
    const native = await renderProject(project, join(root, "matte-native.mp4"), options(true));
    const software = await renderProject(project, join(root, "matte-software.mp4"), options(false));
    expect(native.planner).toBe(software.planner);
    expect((await readFile(native.outputPath)).equals(await readFile(software.outputPath))).toBe(true);
  }, 600_000);
});
