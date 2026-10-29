import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyCommand } from "../domain/commands";
import { createEmptyProject } from "../domain/editGraph";
import { plainClip } from "../domain/motionLibraryV1.fixture";
import type { EditProject } from "../domain/types";
import {
  MotionLibraryCacheRootRefusalV1, assertMotionLibraryProjectFilesV1, motionLibraryAddClipCommandV1, motionLibraryTransitionCommandsV1,
  motionLibraryUpdateClipCommandV1, renderMotionLibraryForProjectV1, resolveMotionLibraryCacheRootV1,
} from "./motionLibraryClipsV1";

const environment = { HAO_FFMPEG_PATH: resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"), HAO_FFPROBE_PATH: resolve("vendor/ffmpeg/win32-x64/ffprobe.exe") };
let workspace: string, projectPath: string;
beforeAll(async () => {
  workspace = join(resolve(process.env.TEMP ?? "."), `p3c-service-${process.pid}`);
  projectPath = join(workspace, "service.editkin.json");
  await mkdir(workspace, { recursive: true });
  await writeFile(projectPath, "{}");
});
afterAll(async () => { if (workspace) await rm(workspace, { recursive: true, force: true }); });

function project(): EditProject {
  let p = createEmptyProject("Service", { id: "service", width: 108, height: 192, fps: 30 });
  p = applyCommand(p, { type: "import_asset", asset: { id: "footage", name: "Footage", kind: "video", uri: "footage.mp4", duration: 10, width: 108, height: 192 } });
  p = applyCommand(p, { type: "add_clip", clip: plainClip("a", "footage", "video-main", 0, 1, 2) });
  p = applyCommand(p, { type: "add_clip", clip: plainClip("b", "footage", "video-main", 2, 5, 2) });
  return applyCommand(p, { type: "add_track", track: { id: "overlay", name: "Overlay", kind: "video", locked: false, muted: false, clips: [] } });
}

describe("motion library service layer", () => {
  it("puts the cache inside the workspace beside the project and refuses projects outside it", async () => {
    const root = await resolveMotionLibraryCacheRootV1({ projectPath, workspaceRoot: workspace });
    expect(root).toBe(join(workspace, ".editkin-media-cache"));
    await expect(resolveMotionLibraryCacheRootV1({ projectPath: "E:/elsewhere/p.editkin.json", workspaceRoot: workspace })).rejects.toBeInstanceOf(MotionLibraryCacheRootRefusalV1);
    await expect(resolveMotionLibraryCacheRootV1({ projectPath: "relative.editkin.json", workspaceRoot: workspace })).rejects.toThrow(/MOTION_LIBRARY_CACHE_ROOT_REFUSED/);
  });

  it("renders before dispatch, builds pure commands, reuses cache hits and checks the files before dispatch", async () => {
    const cacheRoot = await resolveMotionLibraryCacheRootV1({ projectPath, workspaceRoot: workspace });
    const base = project(), progress: string[] = [];
    const title = await renderMotionLibraryForProjectV1({ project: base, cacheRoot, itemId: "T01", params: { lines: ["測試"], durationSeconds: 1 },
      onProgress: event => progress.push(event.phase), ffmpegPath: environment.HAO_FFMPEG_PATH, ffprobePath: environment.HAO_FFPROBE_PATH });
    expect(title.result).toMatchObject({ cacheHit: false, frameCount: 30, width: 108, height: 192 });
    expect(progress).toContain("encode");
    expect(title.result.outputs.clip!.path.startsWith(join(cacheRoot, "motionlib", "T01"))).toBe(true);
    const add = motionLibraryAddClipCommandV1(base, title, { clipId: "title", trackId: "overlay", startFrame: 15 });
    const withTitle = applyCommand(base, add);
    expect(await assertMotionLibraryProjectFilesV1(withTitle)).toBe(1);
    const again = await renderMotionLibraryForProjectV1({ project: base, cacheRoot, itemId: "T01", params: { lines: ["測試"], durationSeconds: 1 } });
    expect(again.result).toMatchObject({ cacheHit: true, cacheKey: title.result.cacheKey });

    const longer = await renderMotionLibraryForProjectV1({ project: base, cacheRoot, itemId: "T01", params: { lines: ["改字"], durationSeconds: 0.5 } });
    const clip = withTitle.tracks.find(track => track.id === "overlay")!.clips[0];
    const updated = applyCommand(withTitle, motionLibraryUpdateClipCommandV1(withTitle, clip, longer));
    expect(updated.tracks.find(track => track.id === "overlay")!.clips[0]).toMatchObject({ duration: 0.5, motionLibrary: { cacheKey: longer.result.cacheKey } });

    const wipe = await renderMotionLibraryForProjectV1({ project: base, cacheRoot, itemId: "X01", params: { durationSeconds: 0.4 } });
    const transition = motionLibraryTransitionCommandsV1(updated, wipe, { transitionId: "cut", trackId: "video-main", fromClipId: "a", toClipId: "b", beforeFrames: 6, afterFrames: 6 });
    expect(transition.map(command => command.type)).toEqual(wipe.result.outputs.overlay ? ["import_asset", "import_asset", "set_timeline_transition"] : ["import_asset", "set_timeline_transition"]);
    const cut = applyCommand(updated, { type: "batch", commands: transition });
    expect(cut.timelineTransitions?.[0]).toMatchObject({ kernel: "matte", motionLibrary: { itemId: "X01", cacheKey: wipe.result.cacheKey } });
    // The update left the first title render registered but unreferenced: title + matte (+ overlay).
    expect(await assertMotionLibraryProjectFilesV1(cut)).toBe(wipe.result.outputs.overlay ? 3 : 2);
    // Already registered renders are not imported twice.
    expect(motionLibraryTransitionCommandsV1(cut, wipe, { transitionId: "cut", trackId: "video-main", fromClipId: "a", toClipId: "b", beforeFrames: 6, afterFrames: 6 })
      .map(command => command.type)).toEqual(["set_timeline_transition"]);

    const missing = structuredClone(withTitle);
    missing.assets.find(asset => asset.id === add.asset.id)!.uri = join(cacheRoot, "motionlib", "T01", `${"c".repeat(64)}.mov`);
    await expect(assertMotionLibraryProjectFilesV1(missing)).rejects.toThrow(/MOTION_LIBRARY_ASSET_MISSING/);
  }, 180_000);

  it("cancels a render through the signal and leaves no partial cache entry", async () => {
    const cacheRoot = await resolveMotionLibraryCacheRootV1({ projectPath, workspaceRoot: workspace });
    const controller = new AbortController();
    const pending = renderMotionLibraryForProjectV1({ project: project(), cacheRoot, itemId: "B02", params: { durationSeconds: 2, seed: 7 },
      signal: controller.signal, onProgress: event => { if (event.phase === "generate" && event.completed >= 8) controller.abort(new Error("cancelled by test")); } });
    await expect(pending).rejects.toThrow("cancelled by test");
    const rerun = await renderMotionLibraryForProjectV1({ project: project(), cacheRoot, itemId: "B02", params: { durationSeconds: 0.5, seed: 7 } });
    expect(rerun.result.cacheHit).toBe(false);
  }, 180_000);
});
