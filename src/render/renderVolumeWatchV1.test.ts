import { describe, expect, it, vi } from "vitest";
import { createRenderVolumeWatchV1 } from "./renderVolumeWatchV1";

const requirements = [{ path: "output", reserveBytes: 100, initialBytes: 300 }, { path: "work", reserveBytes: 100, initialBytes: 200 }];
describe("continuous output/work space admission", () => {
  it("adds same-volume initial work/output budgets and keeps the reserve after writing starts", async () => {
    let available = 600, work = 0;
    const failed = vi.fn(), monitor = createRenderVolumeWatchV1({ requirements, workRoot: "owned", stagingLimitBytes: 50,
      onFailure: failed, probe: async () => ({ key: "same-volume", root: "D:/", availableBytes: available }), sampleWork: async () => work });
    await monitor.check(); available = 101; work = 40; await monitor.check();
    expect(monitor.receipt.peakWorkBytes).toBe(40);
    available = 99; await expect(monitor.check()).rejects.toThrow("SPACE_SHORT"); expect(failed).toHaveBeenCalledTimes(1);
    await monitor.stop();
  });
  it("refuses an unmeasurable volume and does not skip its requirement", async () => {
    const failed = vi.fn(), monitor = createRenderVolumeWatchV1({ requirements, workRoot: "owned", stagingLimitBytes: 50,
      onFailure: failed, probe: async () => undefined, sampleWork: async () => 0 });
    await expect(monitor.check()).rejects.toThrow("SPACE_UNKNOWN"); expect(failed).toHaveBeenCalledTimes(1); await monitor.stop();
  });
  it("refuses staging growth even when the drive itself still has plenty of space", async () => {
    let bytes = 0;
    const monitor = createRenderVolumeWatchV1({ requirements, workRoot: "owned", stagingLimitBytes: 50, onFailure: vi.fn(),
      probe: async path => ({ key: path, root: "D:/", availableBytes: 10_000 }), sampleWork: async () => bytes });
    await monitor.check(); bytes = 51; await expect(monitor.check()).rejects.toThrow("STAGING_LIMIT"); await monitor.stop();
  });
  it("calibrates startup failure on a budget that no longer fits and rejects missing volume coverage", async () => {
    const monitor = createRenderVolumeWatchV1({ requirements, workRoot: "owned", stagingLimitBytes: 50, onFailure: vi.fn(),
      probe: async () => ({ key: "same-volume", root: "D:/", availableBytes: 599 }), sampleWork: async () => 0 });
    await expect(monitor.check()).rejects.toThrow("SPACE_SHORT"); await monitor.stop();
    expect(() => createRenderVolumeWatchV1({ requirements: [], workRoot: "owned", stagingLimitBytes: 50, onFailure: vi.fn() })).toThrow("REQUIREMENTS_MISSING");
  });
});
