import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ renders: [] as Array<Record<string, unknown>> }));
vi.mock("../application/motionLibraryClipsV1", () => ({
  renderMotionLibraryForProjectV1: async (options: Record<string, unknown> & { onProgress?: (p: unknown) => void; signal?: AbortSignal }) => {
    calls.renders.push(options);
    options.onProgress?.({ phase: "generate", completed: 2, total: 4, fraction: 0.5 });
    options.onProgress?.({ phase: "done", completed: 1, total: 1, fraction: 1 });
    options.signal?.throwIfAborted();
    return { item: { id: "X01", kind: "transition" }, result: { itemId: "X01", kind: "transition", itemRevision: 2, engineVersion: "editkin.motion-library-engine/1.3.0",
      cacheKey: "a".repeat(64), cacheHit: false, params: { durationSeconds: 0.5 }, width: 1080, height: 1920, fps: "30/1", frameCount: 15, durationSeconds: 0.5,
      outputs: { matte: { path: "m" }, overlay: { path: "o" } } } };
  },
  motionLibraryAssetRecordV1: (_render: unknown, role: string) => ({ id: `asset-${role}`, name: role, kind: "video", uri: `cache/motionlib/X01/${role}.mov`, duration: 0.5, width: 1080, height: 1920 }),
}));
import { dispatchEngineTaskV1 } from "./engineTaskRegistryV1";

const temp = resolve(process.env.TEMP!);
let folder: string;
beforeEach(async () => { calls.renders = []; folder = await mkdtemp(join(temp, "engine-task-motionlib-")); });
afterEach(async () => { if (!folder.startsWith(temp + sep)) throw Error("cleanup outside owned root"); await rm(folder, { recursive: true }); });

describe("engine task motion_library_render_v1 (service side)", () => {
  it("renders into the host-chosen cache root and replies with the asset records the GUI dispatches", async () => {
    const cacheRoot = join(folder, "cache"), projectCache = join(folder, "project", ".editkin-media-cache");
    await mkdir(cacheRoot, { recursive: true }); await mkdir(projectCache, { recursive: true });
    const runtime = { assetBase: folder, cacheRoot, ffmpeg: join(folder, "ffmpeg.exe"), ffprobe: join(folder, "ffprobe.exe") };
    const input = { operationId: "motion-library-unit-1", itemId: "X01", params: { energy: "hype" }, width: 1080, height: 1920, fps: 30 };
    const progress: unknown[] = [];
    const reply = await dispatchEngineTaskV1({ schema: "editkin.engine-task/v1", kind: "motion_library_render_v1", input, hostInput: { cacheRoot: projectCache } },
      runtime, { onProgress: event => progress.push(event) });
    expect(calls.renders[0]).toMatchObject({ cacheRoot: projectCache, itemId: "X01", params: { energy: "hype" }, project: { width: 1080, height: 1920, fps: 30 } });
    expect(reply).toMatchObject({ schema: "editkin.engine-task-reply/v1", kind: "motion_library_render_v1", operationId: input.operationId,
      result: { schema: "editkin.motion-library-render-reply/v1", request: input, itemId: "X01", frameCount: 15, assets: { matte: { id: "asset-matte" }, overlay: { id: "asset-overlay" } } } });
    expect(progress.at(-1)).toMatchObject({ kind: "motion_library_render_v1", progress: { stage: "done", completed: 1, total: 1 } });
  });

  it("refuses a renderer-supplied path, an unknown item id and a relative host cache root", async () => {
    const runtime = { assetBase: folder, cacheRoot: folder, ffmpeg: join(folder, "ffmpeg.exe"), ffprobe: join(folder, "ffprobe.exe") };
    const input = { operationId: "motion-library-unit-2", itemId: "T01", params: {}, width: 1080, height: 1920, fps: 30 };
    await expect(dispatchEngineTaskV1({ schema: "editkin.engine-task/v1", kind: "motion_library_render_v1", input: { ...input, cacheRoot: "C:/x" } }, runtime)).rejects.toThrow();
    await expect(dispatchEngineTaskV1({ schema: "editkin.engine-task/v1", kind: "motion_library_render_v1", input: { ...input, itemId: "Z99" } }, runtime)).rejects.toThrow();
    await expect(dispatchEngineTaskV1({ schema: "editkin.engine-task/v1", kind: "motion_library_render_v1", input, hostInput: { cacheRoot: "relative/cache" } }, runtime)).rejects.toThrow();
    expect(calls.renders).toEqual([]);
  });
});
