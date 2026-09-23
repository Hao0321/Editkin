import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./residentGpuEngineVideoPresenter", () => ({ validateResidentEngineVideoFrame: vi.fn() }));
import { validateResidentEngineVideoFrame } from "./residentGpuEngineVideoPresenter";
import { ResidentGpuPlayback } from "./residentGpuPlayback";
import type { GpuPreviewApi, NativeGpuPlaybackEvent } from "./gpuPreviewApiTypes";
import type { GpuEngineVideoPreviewGraph } from "../render/gpuCompositor";
const preview = { graph: { timebase: { numerator: 1, denominator: 30 } } } as GpuEngineVideoPreviewGraph;
const event = (frame: number, generation = 1, state: NativeGpuPlaybackEvent["state"] = "playing"): NativeGpuPlaybackEvent => ({
  schema: "editkin.native-preview-playback/v1", owner: "owner", generation, sessionId: "video", state,
  timelineFrame: frame, timelineSeconds: frame / 30, presentedFrames: frame + 1, droppedFrames: 0, sequence: frame + 1, clock: "native-monotonic",
});
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
function fixture() {
  const playback = new ResidentGpuPlayback();
  const callbacks = { onClock: vi.fn(), onActive: vi.fn(), onEnded: vi.fn(), onError: vi.fn() };
  let receive!: (value: NativeGpuPlaybackEvent) => void | Promise<void>;
  let latest = event(0);
  const api = {
    startGpuPreviewPlayback: vi.fn(async (_session, _range, callback) => { receive = callback!; return event(0); }),
    stopGpuPreviewPlayback: vi.fn(async () => ({ stopped: true })),
    inspectGpuPreviewPlayback: vi.fn(async () => ({ ...latest, frameReceipt: { sessionId: "video", timelineFrame: latest.timelineFrame } })),
    presentGpuEngineVideoPreviewFrame: vi.fn(),
  } as unknown as GpuPreviewApi;
  const start = (key = "first") => playback.start(playback.reserve(key), api, "video", { startFrame: 0, endFrame: 180 }, preview, callbacks);
  const send = async (frame: number, state?: NativeGpuPlaybackEvent["state"]) => { latest = event(frame, 1, state); await receive(latest); };
  return { playback, callbacks, api, start, send, receive: () => receive };
}
beforeEach(() => vi.clearAllMocks());
describe("native playback frontend control (mock transport, not rendered-pixel evidence)", () => {
  it("sends one start and samples diagnostics at most once per video second; never issues frame renders", async () => {
    const f = fixture(); await f.start();
    for (let frame = 0; frame < 120; frame++) await f.send(frame);
    expect(f.api.startGpuPreviewPlayback).toHaveBeenCalledTimes(1);
    expect(f.api.presentGpuEngineVideoPreviewFrame).not.toHaveBeenCalled();
    expect(f.api.inspectGpuPreviewPlayback).toHaveBeenCalledTimes(4);
    expect(validateResidentEngineVideoFrame).toHaveBeenCalledTimes(4);
    expect(f.callbacks.onClock).toHaveBeenLastCalledWith(119 / 30);
  });
  it("stops an abandoned pending start by exact returned generation", async () => {
    const f = fixture(), pending = deferred<NativeGpuPlaybackEvent>();
    vi.mocked(f.api.startGpuPreviewPlayback!).mockReturnValueOnce(pending.promise);
    const running = f.start(); f.playback.invalidate(); pending.resolve(event(0, 27)); await running;
    expect(f.api.stopGpuPreviewPlayback).toHaveBeenCalledWith(27);
    expect(f.callbacks.onActive).not.toHaveBeenCalled();
  });
  it("pause adopts the frozen native frame instead of seeking backwards to a stale UI clock", async () => {
    const f=fixture();await f.start();
    vi.mocked(f.api.inspectGpuPreviewPlayback!).mockResolvedValueOnce({...event(47,1,"stopped"),frameReceipt:{sessionId:"video",timelineFrame:47} as never});
    expect(await f.playback.pause()).toEqual({frame:47,time:47/30});
    expect(f.api.stopGpuPreviewPlayback).toHaveBeenCalledWith(1);expect(f.playback.matches("first")).toBe(false);
    expect(f.api.presentGpuEngineVideoPreviewFrame).not.toHaveBeenCalled();
  });
  it("old callbacks and a pending old diagnostic cannot move or stop the successor", async () => {
    const f = fixture(); await f.start(); const oldReceive = f.receive();
    const diagnostic = deferred<Awaited<ReturnType<NonNullable<GpuPreviewApi["inspectGpuPreviewPlayback"]>>>>();
    vi.mocked(f.api.inspectGpuPreviewPlayback!).mockReturnValueOnce(diagnostic.promise);
    const old = f.send(0); await f.start("new");
    diagnostic.resolve({ ...event(0), frameReceipt: { sessionId: "wrong" } as never }); await old; await oldReceive(event(12, 1, "failed"));
    expect(f.callbacks.onError).not.toHaveBeenCalled(); expect(f.callbacks.onClock).not.toHaveBeenCalled();
    expect(f.playback.matches("new")).toBe(true);
  });
  it("fails once on mismatched or rejected diagnostic receipts without inventing progress", async () => {
    const f = fixture(); await f.start();
    vi.mocked(f.api.inspectGpuPreviewPlayback!).mockResolvedValueOnce({ ...event(0), frameReceipt: { sessionId: "other", timelineFrame: 0 } as never });
    await f.send(0); await f.send(10);
    expect(f.callbacks.onError).toHaveBeenCalledTimes(1); expect(f.callbacks.onClock).not.toHaveBeenCalled();
    expect(f.api.stopGpuPreviewPlayback).toHaveBeenCalledWith(1);
    expect(f.playback.matches("first")).toBe(false);
  });
  it("retains full feature validation failures and terminal events", async () => {
    const f = fixture(); await f.start();
    vi.mocked(validateResidentEngineVideoFrame).mockImplementationOnce(() => { throw new Error("color contract"); });
    await f.send(0); expect(f.callbacks.onError).toHaveBeenCalledWith("color contract");
    await f.start("next"); await f.send(60, "ended"); await f.send(60, "ended");
    expect(f.callbacks.onEnded).toHaveBeenCalledTimes(1); expect(f.api.startGpuPreviewPlayback).toHaveBeenCalledTimes(2);
  });
});
