import { afterEach, describe, expect, it, vi } from "vitest";

const compose = vi.hoisted(() => ({ calls: [] as string[], missing: new Set<string>(), registered: [] as string[] }));
vi.mock("./motionLibraryFramesV1", () => ({
  composeMotionLibraryFrameV1: (request: { itemId: string; t: number }) => {
    compose.calls.push(`${request.itemId}@${request.t}`);
    for (const face of compose.missing) throw new Error(`Motion library font ${face} is not registered in this runtime (call registerMotionLibraryFontBytes first)`);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path d="M0 0" id="${request.itemId}"/></svg>`;
  },
}));
vi.mock("../motionLibrary/svg/glyphs", () => ({
  registerMotionLibraryFontBytes: async (faceId: string) => { compose.registered.push(faceId); compose.missing.delete(faceId); },
}));
import { createMotionLibraryThumbnailServiceV1, MOTION_LIBRARY_PRIORITY_V1 } from "./motionLibraryThumbnailServiceV1";

const request = (itemId: string, t = 0) => ({ itemId, purpose: "card" as const, size: { width: 16, height: 16 }, t });
function manualScheduler() {
  const pending: Array<() => void> = [];
  return { schedule: (callback: () => void) => { pending.push(callback); }, async flush() {
    for (let round = 0; round < 50 && pending.length; round += 1) { pending.splice(0).forEach(callback => callback()); await new Promise(resolve => setTimeout(resolve, 0)); }
  } };
}
afterEach(() => { compose.calls = []; compose.missing.clear(); compose.registered = []; });

describe("Motion Library thumbnail frame budget (main-thread fallback)", () => {
  it("serves the most urgent request first, caches results and hands them over a few per animation frame", async () => {
    const scheduler = manualScheduler();
    const service = createMotionLibraryThumbnailServiceV1({ createWorker: () => undefined, schedule: scheduler.schedule, loadFace: async () => new Uint8Array([1]) });
    const still = service.frame(request("T01"), { priority: MOTION_LIBRARY_PRIORITY_V1.still });
    const preview = service.frame(request("T02"), { priority: MOTION_LIBRARY_PRIORITY_V1.preview });
    await scheduler.flush();
    expect(compose.calls.slice(0, 2)).toEqual(["T02@0", "T01@0"]);
    expect(await preview).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    expect(await still).toContain(encodeURIComponent('id="T01"'));
    expect(service.peek(request("T01"))).toBe(await still);
    await expect(service.frame(request("T01"))).resolves.toBe(await still);
    expect(compose.calls.filter(call => call === "T01@0")).toHaveLength(1);
    expect(service.stats()).toMatchObject({ generated: 2, cached: 2, queued: 0, worker: false });
  });

  it("drops a request whose card left the screen before it started", async () => {
    const scheduler = manualScheduler();
    const service = createMotionLibraryThumbnailServiceV1({ createWorker: () => undefined, schedule: scheduler.schedule });
    const controller = new AbortController();
    const dropped = service.frame(request("T03"), { signal: controller.signal });
    controller.abort();
    await scheduler.flush();
    await expect(dropped).rejects.toMatchObject({ name: "AbortError" });
    expect(compose.calls).toEqual([]);
  });

  it("loads a missing font face once, registers it and retries the frame", async () => {
    const scheduler = manualScheduler();
    const loadFace = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const service = createMotionLibraryThumbnailServiceV1({ createWorker: () => undefined, schedule: scheduler.schedule, loadFace });
    compose.missing.add("EditkinFace-noto-sans-tc-900");
    const frame = service.frame(request("T05"));
    await scheduler.flush();
    await expect(frame).resolves.toMatch(/^data:image\/svg/);
    expect(loadFace).toHaveBeenCalledOnce();
    expect(compose.registered).toEqual(["EditkinFace-noto-sans-tc-900"]);
    expect(service.stats().fonts).toEqual([expect.objectContaining({ faceId: "EditkinFace-noto-sans-tc-900", bytes: 3 })]);
  });
});
