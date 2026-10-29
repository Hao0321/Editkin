import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertRenderDiskSpace,
  DISK_SAFETY_RESERVE_BYTES,
  estimateEncodedOutputBytes,
  estimateNativeEffectWorkBytes,
  estimatePngSequenceBytes,
  formatDiskBytes,
  probeVolumeSpace,
  RenderDiskSpaceError,
  type DiskSpaceProbe,
} from "./renderDiskSpace";
import type { RenderPlan } from "./planner";

const GB = 1024 ** 3, MB = 1024 ** 2;
function volumes(map: Record<string, { root: string; available: number } | undefined>): DiskSpaceProbe {
  return async path => {
    const drive = path.slice(0, 2).toUpperCase();
    const volume = map[drive];
    return volume ? { key: drive, root: volume.root, availableBytes: volume.available } : undefined;
  };
}

describe("export disk-space precheck", () => {
  it("refuses before rendering with the drive, what it has, what is needed and what is missing", async () => {
    const probe = volumes({ "D:": { root: "D:\\", available: 3 * GB } });
    const error = await assertRenderDiskSpace([
      { path: "D:\\Videos\\film.mp4", bytes: 2 * GB, kind: "output" },
      { path: "D:\\Videos\\.editkin-render-work", bytes: 4 * GB, kind: "work" },
    ], probe).catch(caught => caught);
    expect(error).toBeInstanceOf(RenderDiskSpaceError);
    expect(error.message).toMatch(/^磁碟空間不足，已在開始輸出前停止：D:\\ 只剩 3\.0 GB，這次輸出預估需要 \d+\.\d GB（成片約 2\.0 GB、暫存工作檔約 4\.0 GB、另保留 /);
    expect(error.message).toMatch(/還差 \d+\.\d GB/);
    expect(error.message).toMatch(/先前的輸出檔沒有被更動。$/);
  });

  it("checks the output drive and the work drive separately and names only the short one", async () => {
    const probe = volumes({ "D:": { root: "D:\\", available: 500 * GB }, "C:": { root: "C:\\", available: 1 * GB } });
    await expect(assertRenderDiskSpace([
      { path: "D:\\out.mp4", bytes: 2 * GB, kind: "output" },
      { path: "C:\\Temp\\work", bytes: 3 * GB, kind: "work" },
    ], probe)).rejects.toThrow(/^磁碟空間不足，已在開始輸出前停止：C:\\ 只剩 1\.0 GB，這次輸出預估需要 \d+\.\d GB（暫存工作檔約 3\.0 GB/);
    await expect(assertRenderDiskSpace([
      { path: "D:\\out.mp4", bytes: 2 * GB, kind: "output" },
      { path: "D:\\work", bytes: 3 * GB, kind: "work" },
      { path: "C:\\Temp", bytes: 0, kind: "system-temp" },
    ], probe)).resolves.toBeUndefined();
  });

  it("only needs a small minimum on a separate OS temp drive", async () => {
    const requirements = [{ path: "D:\\out.mp4", bytes: 10 * MB, kind: "output" as const }, { path: "C:\\Temp", bytes: 0, kind: "system-temp" as const }];
    await expect(assertRenderDiskSpace(requirements, volumes({ "D:": { root: "D:\\", available: GB }, "C:": { root: "C:\\", available: 2 * MB } })))
      .rejects.toThrow(/C:\\ 只剩 2 MB.*系統暫存資料夾/);
    await expect(assertRenderDiskSpace(requirements, volumes({ "D:": { root: "D:\\", available: GB }, "C:": { root: "C:\\", available: 64 * MB } }))).resolves.toBeUndefined();
  });

  it("does not refuse when a volume cannot be measured", async () => {
    await expect(assertRenderDiskSpace([{ path: "\\\\server\\share\\out.mp4", bytes: 50 * GB, kind: "output" }], volumes({}))).resolves.toBeUndefined();
  });

  it("measures the real volume of a path that does not exist yet", async () => {
    const space = await probeVolumeSpace(join(tmpdir(), "editkin-not-created-yet", "nested", "film.mp4"));
    expect(space?.availableBytes).toBeGreaterThan(0);
    expect(space?.root.length).toBeGreaterThan(0);
  });

  it("estimates typical-high sizes from duration, resolution and encoder", () => {
    const minute1080p = { width: 1920, height: 1080, fps: 30, durationSeconds: 60 };
    const h264 = estimateEncodedOutputBytes(minute1080p, "h264_nvenc");
    expect(h264).toBeGreaterThan(120 * MB); expect(h264).toBeLessThan(250 * MB);
    expect(estimateEncodedOutputBytes(minute1080p, "prores_ks")).toBeGreaterThan(10 * h264);
    expect(estimatePngSequenceBytes(minute1080p, "rgba8")).toBeGreaterThan(8 * GB);
    expect(estimatePngSequenceBytes(minute1080p, "rgba16_unorm")).toBe(2 * estimatePngSequenceBytes(minute1080p, "rgba8"));
    const plan = { fps: 30, width: 1920, height: 1080, duration: 10, audioClips: [], captions: [], videoLayers: [{ trackId: "v", trackIndex: 0, segments: [
      { kind: "clip", start: 0, duration: 2, assetPath: "a.mp4", clip: { creative: { nativeEffectInstances: [{ enabled: true }] } } },
      { kind: "clip", start: 2, duration: 8, assetPath: "b.mp4", clip: { creative: { nativeEffectInstances: [{ enabled: false }] } } },
    ] }] } as unknown as RenderPlan;
    expect(estimateNativeEffectWorkBytes(plan)).toBe(60 * 1920 * 1080 * 10);
    expect(formatDiskBytes(DISK_SAFETY_RESERVE_BYTES)).toBe("32 MB");
    expect(formatDiskBytes(1.25 * GB)).toBe("1.3 GB");
  });
});
