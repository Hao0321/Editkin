import { mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve, toNamespacedPath } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTempRoots } from "../test/tempRoot.mjs";
import { PendingNativeCloseError } from "../shared/pendingNativeClose";
import { createNativeAudioStageParentCleanupV1, nativeAudioStageWorkSnapshotV1, withNativeAudioStageWorkV1 } from "../application/nativeAudioStageWorkOwnerV1";
import { createRenderWorkDirectory, removeRenderWorkDirectory, renderWorkOwnershipSnapshotV1, runWithRenderWorkRootV1, sweepStaleRenderWorkDirectories } from "./renderWorkspace";

const faults = vi.hoisted(() => ({ paths: new Map<string, Error>(), allocations: 0 }));
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => { const error = faults.paths.get(resolve(String(args[0]))); if (error) throw error; return actual.rm(...args); },
    mkdtemp: async (...args: Parameters<typeof actual.mkdtemp>) => { faults.allocations++; return actual.mkdtemp(...args); },
  };
});
const temp = useTempRoots();
const owned = new Set<string>();
async function create() { const path = await createRenderWorkDirectory("editkin-render-"); owned.add(path); return path; }
async function remove(path: string) { await removeRenderWorkDirectory(path); owned.delete(path); }
afterEach(async () => { faults.paths.clear(); for (const path of owned) await removeRenderWorkDirectory(path); owned.clear(); });

describe("common render workspace retirement", () => {
  it("creates and retires a deep Windows work path while returning the ordinary logical path", async () => {
    let root = await temp.create("render-owner-long-");
    while (root.length < 280) root = join(root, "nested-work-" + "x".repeat(36));
    await mkdir(process.platform === "win32" ? toNamespacedPath(root) : root, { recursive: true });
    await runWithRenderWorkRootV1(root, async () => {
      const path = await create();
      expect(dirname(path)).toBe(root);
      expect(path.startsWith("\\\\?\\")).toBe(false);
      expect((await stat(path)).isDirectory()).toBe(true);
      await remove(path);
      expect(renderWorkOwnershipSnapshotV1().active).toBe(0);
    });
  });

  it("admits four concurrent allocations and refuses a fifth before filesystem allocation", async () => {
    const root = await temp.create("render-owner-four-");
    await runWithRenderWorkRootV1(root, async () => {
      const paths = await Promise.all(Array.from({ length: 4 }, create));
      const before = faults.allocations;
      await expect(createRenderWorkDirectory("editkin-render-")).rejects.toThrow("RENDER_WORK_CLEANUP_BUSY");
      expect(faults.allocations).toBe(before);
      expect(renderWorkOwnershipSnapshotV1().active).toBe(4);
      await Promise.all(paths.map(remove));
      await remove(await create());
      expect(renderWorkOwnershipSnapshotV1().active).toBe(0);
    });
  });

  it("retains a no-audio parent and the exact public error until the close acknowledgement", async () => {
    const root = await temp.create("render-owner-pending-");
    await runWithRenderWorkRootV1(root, async () => {
      const path = await create(); let close!: () => void, retired!: () => void;
      const retirement = new Promise<void>(done => { retired = done; });
      const error = new PendingNativeCloseError("controlled close pending", new Promise<void>(done => { close = done; }), Error("pipe"));
      const cleanup = vi.fn(async () => { await remove(path); retired(); });
      const parent = createNativeAudioStageParentCleanupV1(path, cleanup);
      await expect(parent.run(async () => { throw error; })).rejects.toBe(error);
      expect(cleanup).not.toHaveBeenCalled();
      expect(renderWorkOwnershipSnapshotV1().pendingClose).toBe(1);
      await expect(removeRenderWorkDirectory(path)).rejects.toThrow("RENDER_WORK_CLOSE_PENDING");
      close(); await retirement;
      expect(cleanup).toHaveBeenCalledOnce();
      expect(renderWorkOwnershipSnapshotV1().active).toBe(0);
    });
  });

  it("keeps failed cleanup owned and protects it from stale-directory sweeping", async () => {
    const root = await temp.create("render-owner-failed-");
    await runWithRenderWorkRootV1(root, async () => {
      const path = await create(), error = Object.assign(Error("controlled EBUSY"), { code: "EBUSY" });
      faults.paths.set(resolve(path), error);
      await expect(removeRenderWorkDirectory(path)).rejects.toBe(error);
      expect(renderWorkOwnershipSnapshotV1()).toMatchObject({ active: 1, cleanupFailed: 1 });
      const sweep = await sweepStaleRenderWorkDirectories([root], { now: Date.now() + 40 * 86400000, isProcessAlive: () => false });
      expect(sweep.kept).toContain(path); expect(sweep.failures).toEqual([]);
      faults.paths.delete(resolve(path)); await remove(path);
      expect(renderWorkOwnershipSnapshotV1().cleanupFailed).toBe(0);
    });
  });

  it("preserves an earlier primary error and reports cleanup failure after business success", async () => {
    const root = await temp.create("render-owner-primary-");
    await runWithRenderWorkRootV1(root, async () => {
      const primary = Error("original operation"), cleanupError = Error("cleanup"), first = await create();
      const failed = createNativeAudioStageParentCleanupV1(first, async () => { throw cleanupError; });
      await expect(failed.run(async () => { throw primary; })).rejects.toBe(primary);
      expect(renderWorkOwnershipSnapshotV1().observations).toContain("Error: cleanup"); await remove(first);
      const second = await create();
      const success = createNativeAudioStageParentCleanupV1(second, async () => { throw cleanupError; });
      await expect(success.run(async () => 42)).rejects.toBe(cleanupError); await remove(second);
    });
  });

  it("holds two audio-stage reservations through the parent and retires both after parent cleanup", async () => {
    const root = await temp.create("render-owner-audio-");
    await runWithRenderWorkRootV1(root, async () => {
      const paths = await Promise.all(Array.from({ length: 3 }, create));
      const parents = paths.map(path => createNativeAudioStageParentCleanupV1(path, () => remove(path)));
      let release!: () => void, admitted!: () => void;
      const gate = new Promise<void>(done => { release = done; });
      const ready = new Promise<void>(done => { admitted = done; }); let count = 0;
      const jobs = parents.slice(0, 2).map((parent, index) => parent.run(async () => {
        await withNativeAudioStageWorkV1(paths[index], 1, async work => { work.trackManagedPath(join(work.sessionRoot, "owned.pcm")); }, parent);
        if (++count === 2) admitted(); await gate;
      }));
      await ready;
      expect(nativeAudioStageWorkSnapshotV1()).toMatchObject({ active: 2, pendingClose: 0 });
      await expect(parents[2].run(() => withNativeAudioStageWorkV1(paths[2], 1, async () => undefined, parents[2]))).rejects.toThrow("NATIVE_AUDIO_STAGE_CLEANUP_BUSY");
      owned.delete(paths[2]); release(); await Promise.all(jobs);
      expect(nativeAudioStageWorkSnapshotV1().active).toBe(0);
      expect(renderWorkOwnershipSnapshotV1().active).toBe(0);
    });
  });
});
