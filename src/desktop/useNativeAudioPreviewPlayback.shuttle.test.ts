import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({ values: [] as any[], cursor: 0, effectCursor: 0,
  effects: [] as Array<{ deps: unknown[]; cleanup?: () => void }>, pending: [] as Array<() => void>,
  resident: { route: "legacy", view: { mode: "idle" } } as any, residentOptions: undefined as any }));
vi.mock("react", () => ({
  useState: (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.values[index], (value: any) => { hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value; }]; },
  useRef: (current: unknown) => { const index = hooks.cursor++; return hooks.values[index] ?? (hooks.values[index] = { current }); },
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => { const index = hooks.effectCursor++, previous = hooks.effects[index];
    if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
    hooks.pending.push(() => { previous?.cleanup?.(); const cleanup = effect(); hooks.effects[index] = { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }; }); },
}));
vi.mock("./useResidentAudioTransport", () => ({ useResidentAudioTransport: (options: unknown) => { hooks.residentOptions = options; return hooks.resident; } }));
import { createDemoProject } from "../domain/demo";
import type { ActivePreviewLayer } from "../application/previewMedia";
import type { HaoDesktopApi, NativeAudioPreviewStartResult, NativeAudioPreviewStatus } from "./types";
import { createPreviewMediaSynchronizer, useNativeAudioPreviewPlayback } from "./useNativeAudioPreviewPlayback";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const settle = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
let now = 1000, frameId = 0;
let frames: Map<number, (now: number) => void>, history: Map<number, (now: number) => void>;
let cancelledFrames: number[];
beforeEach(() => {
  hooks.values = []; hooks.effects = []; hooks.pending = []; hooks.resident = { route: "legacy", view: { mode: "idle" } };
  hooks.residentOptions = undefined; now = 1000; frameId = 0; frames = new Map(); history = new Map(); cancelledFrames = [];
  const browserWindow = {
    clearTimeout, setTimeout, queueMicrotask: (work: () => void) => { void Promise.resolve().then(work); },
    requestAnimationFrame: function (this: unknown, work: (time: number) => void): number {
      if (this !== browserWindow) throw new TypeError("Illegal invocation: requestAnimationFrame receiver");
      frames.set(++frameId, work); history.set(frameId, work); return frameId;
    },
    cancelAnimationFrame: function (this: unknown, id: number): void {
      if (this !== browserWindow) throw new TypeError("Illegal invocation: cancelAnimationFrame receiver");
      cancelledFrames.push(id); frames.delete(id);
    },
  };
  vi.stubGlobal("window", browserWindow);
  vi.stubGlobal("performance", { now: () => now });
  vi.stubGlobal("requestAnimationFrame", browserWindow.requestAnimationFrame);
  vi.stubGlobal("cancelAnimationFrame", browserWindow.cancelAnimationFrame);
});
afterEach(async () => { for (const effect of hooks.effects) effect.cleanup?.(); await settle(); vi.unstubAllGlobals(); });
function fixture(api?: HaoDesktopApi) {
  const project = createDemoProject();
  const options = { api, project, layers: [] as ActivePreviewLayer[], audioLayers: [] as ActivePreviewLayer[], mediaRefs: { current: new Map<string, HTMLMediaElement>() },
    playhead: 0, projectDuration: 5, projectFps: 30, playing: true, playbackRate: 1, seekRevision: 0 as number | undefined, externalVideoClock: false,
    onPlayingChange: vi.fn(), onPlayheadChange: vi.fn() };
  const render = () => { hooks.cursor = 0; hooks.effectCursor = 0; hooks.pending = [];
    const result = useNativeAudioPreviewPlayback(options); for (const commit of hooks.pending) commit(); return result; };
  return { project, options, render };
}

describe("shuttle preview ownership and media state", () => {
  it("preserves Window RAF receivers through initial recursive scheduling cancellation and stale delivery", () => {
    expect(window.requestAnimationFrame).toBe(globalThis.requestAnimationFrame);
    expect(window.cancelAnimationFrame).toBe(globalThis.cancelAnimationFrame);
    expect(() => window.requestAnimationFrame.call({}, () => {})).toThrow(/Illegal invocation/);
    expect(() => window.cancelAnimationFrame.call({}, 0)).toThrow(/Illegal invocation/);
    expect(frames.size).toBe(0); expect(cancelledFrames).toEqual([]);

    const f = fixture(); f.options.playhead = 1;
    hooks.resident = { route: "resident", view: { mode: "compatible", playing: false } };
    expect(f.render().mode).toBe("compatible"); expect(frames.size).toBe(1); expect(frameId).toBe(1);
    const initial = frames.entries().next().value!;
    frames.delete(initial[0]); now += 100; initial[1](now);
    expect(f.options.onPlayheadChange).toHaveBeenLastCalledWith(1.1);
    expect(frames.size).toBe(1); expect(frameId).toBe(2);

    const pending = frames.entries().next().value!;
    f.options.playing = false; f.options.seekRevision = 1; f.render();
    expect(cancelledFrames).toEqual([pending[0]]); expect(frames.size).toBe(0);
    const publishedCount = f.options.onPlayheadChange.mock.calls.length;
    now += 100; history.get(pending[0])!(now);
    expect(f.options.onPlayheadChange).toHaveBeenCalledTimes(publishedCount);
    expect(frames.size).toBe(0); expect(frameId).toBe(2); expect(f.options.onPlayingChange).not.toHaveBeenCalled();
  });

  it("uses positive HTML rate and silent reverse latest-frame seeks with real clip source offsets and gaps", () => {
    const project = createDemoProject(), clip = { ...project.tracks[0].clips[0], timelineStart: 4, sourceStart: 3, duration: 2, volume: 0.6 };
    const layer = { clip } as ActivePreviewLayer, listeners = new Set<() => void>();
    const media = { currentTime: 0, playbackRate: 1, paused: true, seeking: false, muted: false, volume: 1, tagName: "VIDEO",
      pause: vi.fn(() => { media.paused = true; }), play: vi.fn(async () => { media.paused = false; }),
      addEventListener: vi.fn((_event: string, listener: () => void) => listeners.add(listener)),
      removeEventListener: vi.fn((_event: string, listener: () => void) => listeners.delete(listener)) };
    const synchronizer = createPreviewMediaSynchronizer(), element = media as unknown as HTMLMediaElement;
    synchronizer.sync(element, layer, 5, true, "compatible", 2, 30);
    expect(media).toMatchObject({ playbackRate: 2, currentTime: 4, muted: false, volume: 0.6 }); expect(media.play).toHaveBeenCalledTimes(1);
    synchronizer.sync(element, layer, 6, true, "compatible", -2, 30);
    expect(media).toMatchObject({ playbackRate: 2, currentTime: 5, muted: true, paused: true });
    media.seeking = true;
    synchronizer.sync(element, layer, 5.75, true, "compatible", -2, 30);
    synchronizer.sync(element, layer, 5.5, true, "compatible", -2, 30);
    expect(media.currentTime).toBe(5); expect(listeners.size).toBe(1);
    media.seeking = false; for (const listener of [...listeners]) listener();
    expect(media.currentTime).toBe(4.5); expect(listeners.size).toBe(0);
    media.seeking = true; synchronizer.sync(element, layer, 5, true, "compatible", -2, 30);
    synchronizer.sync(element, layer, 5.5, false, "idle", 1, 30);
    expect(listeners.size).toBe(0); expect(media.playbackRate).toBe(1);
    media.seeking = false; media.currentTime = 4.5;
    synchronizer.sync(element, layer, 5.5 + 1 / 30, false, "idle", 1, 30);
    expect(media.currentTime).toBeCloseTo(4.5 + 1 / 30);
    synchronizer.sync(element, undefined, 7, true, "compatible", 4, 30);
    expect(media.paused).toBe(true); expect(media.muted).toBe(true);
    media.seeking = true; synchronizer.sync(element, layer, 5, true, "compatible", -1, 30);
    expect(listeners.size).toBe(1); synchronizer.retain(new Set()); expect(listeners.size).toBe(0);
    synchronizer.dispose(); expect(listeners.size).toBe(0);
  });

  it("waits exact legacy generation retirement and rejects old native and RAF clocks after a rate seek", async () => {
    const start = deferred<NativeAudioPreviewStartResult>(), stop = deferred<{ active: boolean; stopped: boolean }>();
    let status!: (value: NativeAudioPreviewStatus) => void;
    const api = { nativeAudioPreviewPushEvents: true, startNativeAudioPreview: vi.fn((_project: unknown, _origin: number, listener: typeof status) => { status = listener; return start.promise; }),
      stopNativeAudioPreview: vi.fn(() => stop.promise) } as unknown as HaoDesktopApi;
    const f = fixture(api); f.render();
    start.resolve({ native: true, generation: 7, playback: { schema: "editkin.native-audio-preview-event/v1", event: "started", timelineStartSeconds: 0, timelineSeconds: 0 },
      stage: { schema: "editkin.native-audio-preview-stage/v2", status: "GREEN", projectId: f.project.id, projectRevision: f.project.revision,
        projectUpdatedAt: f.project.updatedAt, sampleRate: 48000, channels: 2, decoderExecutor: "ffmpeg-source-decode/v1", decodeMode: "independent-source-pcm",
        mixExecutor: "hao-core-native-dag/v1", nativeGraphExecution: true, manifestSha256: "a".repeat(64), manifestBytes: 10,
        audioFingerprintSha256: "c".repeat(64), timelineStartSeconds: 0, voiceClipCount: 1, musicClipCount: 0, sourceIds: ["source"],
        sourcePcm: [{ id: "source", clipId: "clip-demo", assetId: "asset-demo", role: "voice", startFrame: 0, gainDb: 0, gainAutomation: [], bytes: 10, sha256: "b".repeat(64) }],
        clipCount: 1, durationSeconds: 5, claimBoundary: "Source adapter control, not actual native audio" } });
    await settle(); expect(f.render().mode).toBe("native"); f.options.onPlayheadChange.mockClear();
    f.options.playbackRate = 2; f.options.playhead = 2; f.options.seekRevision = 1;
    expect(f.render().mode).toBe("starting"); expect(api.stopNativeAudioPreview).toHaveBeenCalledWith(7); expect(frames.size).toBe(0);
    status({ generation: 7, active: true, playback: { schema: "editkin.native-audio-preview-event/v1", event: "progress", timelineStartSeconds: 0, timelineSeconds: 4 } });
    await settle(); expect(f.options.onPlayheadChange).not.toHaveBeenCalled();
    stop.resolve({ active: false, stopped: true }); await settle();
    const compatible = f.render();
    expect(compatible).toEqual({ mode: "compatible", error: undefined, transportSeekRevision: 1 });
    expect(compatible).not.toHaveProperty("generation"); expect(compatible).not.toHaveProperty("stage"); expect(compatible).not.toHaveProperty("ownerId");
    const retiredFrame = frameId;
    f.options.playbackRate = -1; f.options.playhead = 3; f.options.seekRevision = 2; f.render(); await settle(); f.render();
    history.get(retiredFrame)?.(2000); expect(f.options.onPlayheadChange).not.toHaveBeenCalled();
    now += 100; const current = frames.entries().next().value!; frames.delete(current[0]); current[1](now);
    expect(f.options.onPlayheadChange).toHaveBeenLastCalledWith(2.9);
    expect(api.startNativeAudioPreview).toHaveBeenCalledTimes(1); expect(api.stopNativeAudioPreview).toHaveBeenCalledTimes(1);
  });

  it("requires resident pause acknowledgement before shuttle and drops its retained stale clock", () => {
    const f = fixture(); hooks.resident = { route: "resident", view: { mode: "native", playing: true, ownerId: 23, generation: 4 } };
    expect(f.render().mode).toBe("native"); const retiredClock = hooks.residentOptions.onClock;
    f.options.playbackRate = -4; f.options.playhead = 3; f.options.seekRevision = 1;
    expect(f.render().mode).toBe("starting"); expect(hooks.residentOptions.playing).toBe(false); expect(frames.size).toBe(0);
    retiredClock(5, true); expect(f.options.onPlayheadChange).not.toHaveBeenCalled(); expect(f.options.onPlayingChange).not.toHaveBeenCalled();
    hooks.resident.view = { mode: "native", playing: false, ownerId: 23, generation: 4 };
    expect(f.render()).toEqual({ mode: "compatible", error: undefined, transportSeekRevision: 1 });
    const pending = frameId; f.options.playing = false; f.options.seekRevision = 2; f.render();
    history.get(pending)?.(2000); expect(f.options.onPlayheadChange).not.toHaveBeenCalled();
    expect(f.render().mode).toBe("idle");
    // A caller without an explicit revision must replace the retained native key on return to 1x.
    f.options.seekRevision = undefined; f.options.playbackRate = -2; f.options.playhead = 2; f.options.playing = true;
    f.render(); const reverseKey = hooks.residentOptions.seekRevision;
    f.options.playbackRate = 1; f.options.playhead = 1.5; f.render();
    expect(hooks.residentOptions.seekRevision).toBeGreaterThan(reverseKey);
    expect(hooks.residentOptions.playhead.current).toBe(1.5); expect(hooks.residentOptions.playing).toBe(true);
    const resumedKey = hooks.residentOptions.seekRevision;
    f.options.playbackRate = -0.5; f.render();
    expect(hooks.residentOptions.seekRevision).toBeGreaterThan(resumedKey); expect(hooks.residentOptions.playing).toBe(false);
  });
});
