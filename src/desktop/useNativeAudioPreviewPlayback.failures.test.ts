import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Controlled hook/effect harness (same shape as the shuttle suite). It checks the
// actual hook handlers, not a mounted WebView or the installed desktop build.
const hooks = vi.hoisted(() => ({ values: [] as any[], cursor: 0, effectCursor: 0,
  effects: [] as Array<{ deps: unknown[]; cleanup?: () => void }>, pending: [] as Array<() => void>,
  resident: { route: "legacy", view: { mode: "idle" } } as any }));
vi.mock("react", () => ({
  useState: (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.values[index], (value: any) => { hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value; }]; },
  useRef: (current: unknown) => { const index = hooks.cursor++; return hooks.values[index] ?? (hooks.values[index] = { current }); },
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => { const index = hooks.effectCursor++, previous = hooks.effects[index];
    if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
    hooks.pending.push(() => { previous?.cleanup?.(); const cleanup = effect(); hooks.effects[index] = { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }; }); },
}));
vi.mock("./useResidentAudioTransport", () => ({ useResidentAudioTransport: () => hooks.resident }));
import { createDemoProject } from "../domain/demo";
import type { ActivePreviewLayer } from "../application/previewMedia";
import type { HaoDesktopApi, NativeAudioPreviewStartResult } from "./types";
import { createPreviewMediaSynchronizer, useNativeAudioPreviewPlayback } from "./useNativeAudioPreviewPlayback";
import { currentPlaybackNotices } from "../ui/playbackNoticeStore";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const settle = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const notice = (key: string) => currentPlaybackNotices().find(item => item.key === key);
let now = 1000, frameId = 0;
let frames: Map<number, (now: number) => void>;
beforeEach(() => {
  hooks.values = []; hooks.effects = []; hooks.pending = []; hooks.resident = { route: "legacy", view: { mode: "idle" } };
  now = 1000; frameId = 0; frames = new Map();
  vi.stubGlobal("window", { clearTimeout, setTimeout, queueMicrotask: (work: () => void) => { void Promise.resolve().then(work); },
    requestAnimationFrame: (work: (time: number) => void) => { frames.set(++frameId, work); return frameId; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); } });
  vi.stubGlobal("performance", { now: () => now });
});
afterEach(async () => { for (const effect of hooks.effects) effect.cleanup?.(); await settle(); vi.unstubAllGlobals(); });
function fixture(api?: HaoDesktopApi) {
  const project = createDemoProject();
  const options = { api, project, layers: [] as ActivePreviewLayer[], audioLayers: [] as ActivePreviewLayer[], mediaRefs: { current: new Map<string, HTMLMediaElement>() },
    playhead: 0, projectDuration: 5, projectFps: 30, playing: true, playbackRate: 1, seekRevision: 0 as number | undefined, externalVideoClock: false,
    onPlayingChange: vi.fn(), onPlayheadChange: vi.fn(),
    onRebuildPreview: undefined as undefined | ((assetId: string, onOutcome?: (rebuilt: boolean) => void) => Promise<void>) };
  const render = () => { hooks.cursor = 0; hooks.effectCursor = 0; hooks.pending = [];
    const result = useNativeAudioPreviewPlayback(options); for (const commit of hooks.pending) commit(); return result; };
  return { project, options, render };
}
function fakeMedia(tagName: "VIDEO" | "AUDIO") {
  const listeners = new Map<string, Set<() => void>>();
  const media = { tagName, currentTime: 0, playbackRate: 1, paused: true, seeking: false, muted: false, volume: 1,
    error: null as null | { code: number; message: string },
    pause: vi.fn(() => { media.paused = true; }), play: vi.fn(async () => { media.paused = false; }), load: vi.fn(),
    addEventListener: vi.fn((type: string, listener: () => void) => { listeners.set(type, (listeners.get(type) ?? new Set()).add(listener)); }),
    removeEventListener: vi.fn((type: string, listener: () => void) => { listeners.get(type)?.delete(listener); }) };
  const fire = (type: string) => { for (const listener of [...listeners.get(type) ?? []]) listener(); };
  return { media, element: media as unknown as HTMLMediaElement, listeners, fire };
}
const named = (name: string, error: Error) => Object.assign(error, { name });
const stageFor = (project: ReturnType<typeof createDemoProject>): NativeAudioPreviewStartResult => ({ native: true, generation: 7,
  playback: { schema: "editkin.native-audio-preview-event/v1", event: "started", timelineStartSeconds: 0, timelineSeconds: 0 },
  stage: { schema: "editkin.native-audio-preview-stage/v2", status: "GREEN", projectId: project.id, projectRevision: project.revision,
    projectUpdatedAt: project.updatedAt, sampleRate: 48000, channels: 2, decoderExecutor: "ffmpeg-source-decode/v1", decodeMode: "independent-source-pcm",
    mixExecutor: "hao-core-native-dag/v1", nativeGraphExecution: true, manifestSha256: "a".repeat(64), manifestBytes: 10,
    audioFingerprintSha256: "c".repeat(64), timelineStartSeconds: 0, voiceClipCount: 1, musicClipCount: 0, sourceIds: ["source"],
    sourcePcm: [{ id: "source", clipId: "clip-demo", assetId: "asset-demo", role: "voice", startFrame: 0, gainDb: 0, gainAutomation: [], bytes: 10, sha256: "b".repeat(64) }],
    clipCount: 1, durationSeconds: 5, claimBoundary: "Source adapter control, not actual native audio" } });

describe("visible, recoverable preview playback failures (U03)", () => {
  it("pauses a failed resident owner, keeps it visible and wires the notice to the transport retry", () => {
    const f = fixture(), retry = vi.fn(), detail = "原生音訊清理未確認；已停止播放，避免兩份聲音重疊";
    hooks.resident = { route: "resident", retry, view: { mode: "failed", ownerId: 7, error: detail } };
    const state = f.render();
    expect(state.mode).toBe("failed"); expect(f.options.onPlayingChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(state.failure).toMatchObject({ kind: "audio", detail });
    expect(notice("preview-audio")).toMatchObject({ kind: "audio", detail });
    notice("preview-audio")!.retry!(); state.failure!.retry(); expect(retry).toHaveBeenCalledTimes(2);
    f.options.playing = false; f.render(); expect(notice("preview-audio")?.kind).toBe("audio");
    // Play without a retry cannot run on a failed owner: it pauses again.
    f.options.playing = true; f.render(); expect(f.options.onPlayingChange).toHaveBeenCalledTimes(2);
    hooks.resident = { route: "resident", retry, view: { mode: "idle" } }; f.options.playing = false;
    expect(f.render().failure).toBeUndefined(); expect(notice("preview-audio")).toBeUndefined();
  });

  it("a rejected play() stops the compatible clock, pauses and shows the reason until played again", async () => {
    const f = fixture(), layer = { clip: f.project.tracks[0].clips[0], asset: f.project.assets[0], source: "clip.mp4" } as ActivePreviewLayer;
    hooks.resident = { route: "resident", view: { mode: "compatible", playing: false } };
    const video = fakeMedia("VIDEO"), denied = deferred<void>();
    video.media.play.mockReturnValueOnce(denied.promise.then(() => { throw Object.assign(new Error("play() failed because the user didn't interact"), { name: "NotAllowedError" }); }));
    f.options.layers = [layer]; f.options.mediaRefs.current.set(layer.clip.id, video.element);
    expect(f.render().mode).toBe("compatible"); expect(video.media.play).toHaveBeenCalledTimes(1); expect(frames.size).toBe(1);
    denied.resolve(); await settle();
    expect(f.options.onPlayingChange).toHaveBeenCalledExactlyOnceWith(false); expect(video.media.pause).toHaveBeenCalled();
    const [id, tick] = frames.entries().next().value!; frames.delete(id); now += 500; tick(now);
    expect(f.options.onPlayheadChange).not.toHaveBeenCalled(); expect(frames.size).toBe(0);
    f.options.playing = false; const paused = f.render();
    expect(paused.failure).toMatchObject({ kind: "play", step: "play", detail: `${f.project.assets[0].name}：play() failed because the user didn't interact` });
    expect(notice("preview-audio")).toMatchObject({ kind: "play", step: "play" });
    paused.failure!.retry(); expect(f.options.onPlayingChange).toHaveBeenLastCalledWith(true);
    expect(f.render().failure).toBeUndefined(); expect(notice("preview-audio")).toBeUndefined();
  });

  it("reports only real play() rejections, not interruptions or element errors", async () => {
    const rejected = vi.fn(), sync = createPreviewMediaSynchronizer(rejected), project = createDemoProject();
    const layer = { clip: project.tracks[0].clips[0] } as ActivePreviewLayer, video = fakeMedia("VIDEO");
    const attempt = async (reason: unknown) => {
      video.media.paused = true; video.media.play.mockReturnValueOnce(Promise.reject(reason));
      sync.sync(video.element, layer, 1, true, "compatible", 1, 30); await settle();
    };
    await attempt(Object.assign(new Error("interrupted by pause()"), { name: "AbortError" }));
    video.media.error = { code: 4, message: "unsupported" }; await attempt(Object.assign(new Error("no source"), { name: "NotSupportedError" }));
    expect(rejected).not.toHaveBeenCalled();
    video.media.error = null; const denied = Object.assign(new Error("denied"), { name: "NotAllowedError" }); await attempt(denied);
    expect(rejected).toHaveBeenCalledExactlyOnceWith(video.element, denied);
  });

  it("a failed legacy rate-retirement stop says what happened and a retry re-admits variable speed", async () => {
    const start = deferred<NativeAudioPreviewStartResult>();
    const stop = vi.fn(async (_generation?: number) => ({ active: true, stopped: false }));
    const api = { nativeAudioPreviewPushEvents: true, startNativeAudioPreview: vi.fn(() => start.promise), stopNativeAudioPreview: stop } as unknown as HaoDesktopApi;
    const f = fixture(api); f.render(); start.resolve(stageFor(f.project)); await settle();
    expect(f.render().mode).toBe("native");
    f.options.playbackRate = 2; f.options.seekRevision = 1; f.render(); await settle();
    expect(stop).toHaveBeenCalledWith(7); expect(f.options.onPlayingChange).toHaveBeenCalledExactlyOnceWith(false);
    f.options.playing = false; const blocked = f.render();
    expect(blocked.failure).toMatchObject({ kind: "audio", detail: "原生音訊停止尚未確認；變速播放已阻擋" });
    expect(notice("preview-audio")).toMatchObject({ kind: "audio", detail: "原生音訊停止尚未確認；變速播放已阻擋" });
    // Without recovery the block is permanent; it pauses again and stays visible.
    f.options.playing = true; f.render(); await settle(); expect(f.options.onPlayingChange).toHaveBeenCalledTimes(2);
    f.options.playing = false; f.render(); await settle();
    stop.mockResolvedValue({ active: false, stopped: true });
    await notice("preview-audio")!.retry!(); await settle();
    expect(stop.mock.calls.at(-1)).toEqual([7]); expect(f.render().failure).toBeUndefined(); expect(notice("preview-audio")).toBeUndefined();
    // The confirmed stop resumes the playback the failure had paused.
    expect(f.options.onPlayingChange).toHaveBeenCalledTimes(3); expect(f.options.onPlayingChange).toHaveBeenLastCalledWith(true);
    f.options.playing = true; f.render(); await settle();
    expect(f.render().mode).toBe("compatible"); expect(f.options.onPlayingChange).toHaveBeenCalledTimes(3);
    expect(api.startNativeAudioPreview).toHaveBeenCalledTimes(1);
  });

  it("a confirmed resident retry resumes only playback the failure paused", async () => {
    const f = fixture(), retry = vi.fn(async () => false), detail = "原生音訊清理未確認；已停止播放，避免兩份聲音重疊";
    hooks.resident = { route: "resident", retry, view: { mode: "failed", ownerId: 7, error: detail } };
    f.render(); expect(f.options.onPlayingChange).toHaveBeenCalledExactlyOnceWith(false);
    f.options.playing = false; f.render();
    // Still unconfirmed: nothing resumes and the notice stays.
    await notice("preview-audio")!.retry!(); expect(f.options.onPlayingChange).toHaveBeenCalledTimes(1); expect(notice("preview-audio")?.kind).toBe("audio");
    retry.mockResolvedValueOnce(true);
    await notice("preview-audio")!.retry!(); expect(f.options.onPlayingChange).toHaveBeenLastCalledWith(true);
  });

  it("a close that failed while already paused is retried without starting playback", async () => {
    const f = fixture(), retry = vi.fn(async () => true);
    f.options.playing = false;
    hooks.resident = { route: "resident", retry, view: { mode: "failed", ownerId: 8, error: "原生音訊清理未確認；已停止播放，避免兩份聲音重疊" } };
    f.render(); await notice("preview-audio")!.retry!();
    expect(retry).toHaveBeenCalledTimes(1); expect(f.options.onPlayingChange).not.toHaveBeenCalled();
  });

  it("a repeated play() rejection offers reload and then rebuild, never the same endless retry", async () => {
    const f = fixture(), layer = { clip: f.project.tracks[0].clips[0], asset: f.project.assets[0], source: "clip.mp4" } as ActivePreviewLayer;
    // A rebuild that commits its preview reports it (as useMediaPreviewRepair does).
    const rebuild = vi.fn(async (_assetId: string, onOutcome?: (rebuilt: boolean) => void) => { onOutcome?.(true); });
    f.options.onRebuildPreview = rebuild;
    hooks.resident = { route: "resident", view: { mode: "compatible", playing: false } };
    const video = fakeMedia("VIDEO");
    f.options.layers = [layer]; f.options.mediaRefs.current.set(layer.clip.id, video.element);
    const rejectThenPause = async (reason: Error) => {
      video.media.paused = true; video.media.play.mockRejectedValueOnce(reason);
      f.options.playing = true; f.render(); await settle();
      f.options.playing = false; return f.render().failure!;
    };
    let failure = await rejectThenPause(named("NotAllowedError", new Error("denied")));
    expect(failure.step).toBe("play"); failure.retry(); expect(f.options.onPlayingChange).toHaveBeenLastCalledWith(true);
    failure = await rejectThenPause(named("NotAllowedError", new Error("denied again")));
    expect(failure.step).toBe("reload"); expect(notice("preview-audio")).toMatchObject({ kind: "play", step: "reload" });
    const reloaded = failure.retry() as Promise<void>; expect(video.media.load).toHaveBeenCalledTimes(1);
    video.fire("loadeddata"); await reloaded; expect(f.options.onPlayingChange).toHaveBeenLastCalledWith(true);
    failure = await rejectThenPause(named("NotAllowedError", new Error("still denied")));
    expect(failure.step).toBe("rebuild");
    await failure.retry(); expect(rebuild).toHaveBeenCalledExactlyOnceWith(f.project.assets[0].id, expect.any(Function));
    expect(f.render().failure).toBeUndefined();
    // A play that works resets the ladder; an unsupported source skips straight to reload.
    video.media.paused = true; f.options.playing = true; f.render(); await settle(); f.options.playing = false; f.render();
    failure = await rejectThenPause(named("NotSupportedError", new Error("no supported source")));
    expect(failure.step).toBe("reload");
  });

  it("compatible audio at 1× is published as a status for the readout, never at other speeds", () => {
    const f = fixture();
    hooks.resident = { route: "resident", view: { mode: "compatible", playing: false, error: "原生音訊預覽 staging 失敗" } };
    f.render(); expect(notice("preview-audio")).toMatchObject({ kind: "audio-fallback", detail: "原生音訊預覽 staging 失敗" });
    f.options.playbackRate = 2; f.options.seekRevision = 1; f.render(); expect(notice("preview-audio")).toBeUndefined();
  });

  it("8× forward preview is muted; 0.5×–4× keep the clip's sound", () => {
    const sync = createPreviewMediaSynchronizer(), project = createDemoProject();
    const layer = { clip: project.tracks[0].clips[0] } as ActivePreviewLayer, video = fakeMedia("VIDEO");
    for (const [rate, muted] of [[8, true], [4, false], [2, false], [0.5, false], [1, false]] as const) {
      sync.sync(video.element, layer, 1, true, "compatible", rate, 30); expect(video.media.muted).toBe(muted);
    }
  });

  it("an <audio> track error pauses its sound, names the clip and reloads; native audio is not blocked", async () => {
    const f = fixture(), clip = { ...f.project.tracks[0].clips[0], id: "music-clip" };
    const layer = { clip, asset: { ...f.project.assets[0], name: "music.m4a" }, source: "music.m4a" } as ActivePreviewLayer;
    const audio = fakeMedia("AUDIO");
    f.options.audioLayers = [layer]; f.options.mediaRefs.current.set("music-clip", audio.element);
    hooks.resident = { route: "resident", view: { mode: "native", playing: true, ownerId: 3, generation: 1 } };
    f.render(); audio.media.error = { code: 4, message: "Format error" }; audio.fire("error"); f.render();
    expect(f.options.onPlayingChange).not.toHaveBeenCalled(); expect(notice("audio-sources")).toBeUndefined();
    hooks.resident = { route: "resident", view: { mode: "compatible", playing: false } }; f.render();
    expect(notice("audio-sources")).toMatchObject({ kind: "audio-source", names: ["music.m4a"], detail: "music.m4a：解碼錯誤 4：Format error" });
    audio.fire("error"); expect(f.options.onPlayingChange).toHaveBeenCalledExactlyOnceWith(false);
    // The reload settles when the element loads (or fails again), so the button stays busy until then.
    const reloaded = notice("audio-sources")!.retry!() as Promise<unknown>; expect(audio.media.load).toHaveBeenCalledTimes(1);
    audio.media.error = null; audio.fire("loadeddata"); f.render(); await reloaded;
    expect(notice("audio-sources")).toBeUndefined();
    f.options.audioLayers = []; f.render(); expect(audio.media.removeEventListener).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("several broken audio sources become one notice with one reload for all of them", async () => {
    const f = fixture(), sources = ["music.m4a", "sfx.wav"].map((name, index) => {
      const clip = { ...f.project.tracks[0].clips[0], id: `clip-${index}` }, audio = fakeMedia("AUDIO");
      f.options.mediaRefs.current.set(clip.id, audio.element);
      return { layer: { clip, asset: { ...f.project.assets[0], name }, source: name } as ActivePreviewLayer, audio };
    });
    f.options.audioLayers = sources.map(source => source.layer); f.options.playing = false;
    hooks.resident = { route: "resident", view: { mode: "compatible", playing: false } };
    f.render();
    for (const { audio } of sources) { audio.media.error = { code: 4, message: "Format error" }; audio.fire("error"); }
    f.render();
    expect(currentPlaybackNotices().filter(item => item.kind === "audio-source")).toHaveLength(1);
    expect(notice("audio-sources")).toMatchObject({ names: ["music.m4a", "sfx.wav"] });
    const reloaded = notice("audio-sources")!.retry!() as Promise<unknown>;
    for (const { audio } of sources) { expect(audio.media.load).toHaveBeenCalledTimes(1); audio.media.error = null; audio.fire("loadeddata"); }
    await reloaded; f.render(); expect(notice("audio-sources")).toBeUndefined();
  });
});
