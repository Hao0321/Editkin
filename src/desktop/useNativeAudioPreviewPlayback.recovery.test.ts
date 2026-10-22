import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Controlled hook/effect harness (same shape as the failures suite). It checks the
// actual hook handlers and the shared notice store, not a mounted WebView.
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
import { useNativeAudioPreviewPlayback } from "./useNativeAudioPreviewPlayback";
import { currentPlaybackNotices, dismissPlaybackNotice, resetPlaybackNotices, retryPlaybackNotice } from "../ui/playbackNoticeStore";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const settle = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const notice = (key: string) => currentPlaybackNotices().find(item => item.key === key);
const named = (name: string, error: Error) => Object.assign(error, { name });
let frames: Map<number, (now: number) => void>, timeouts: Map<number, () => void>;
let frameId = 0, timeoutId = 0;
beforeEach(() => {
  resetPlaybackNotices();
  hooks.values = []; hooks.effects = []; hooks.pending = []; hooks.resident = { route: "legacy", view: { mode: "idle" } };
  frameId = 0; timeoutId = 0; frames = new Map(); timeouts = new Map();
  // Timeouts are held so the 10 s reload limit can be reached without waiting.
  vi.stubGlobal("window", { clearTimeout: (id: number) => { timeouts.delete(id); },
    setTimeout: (work: () => void) => { timeouts.set(++timeoutId, work); return timeoutId; },
    queueMicrotask: (work: () => void) => { void Promise.resolve().then(work); },
    requestAnimationFrame: (work: (time: number) => void) => { frames.set(++frameId, work); return frameId; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); } });
  vi.stubGlobal("performance", { now: () => 1000 });
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
  return { media, element: media as unknown as HTMLMediaElement, fire };
}
/** A compatible-route video clip whose play() can be rejected on demand. */
function videoClip(f: ReturnType<typeof fixture>) {
  const layer = { clip: f.project.tracks[0].clips[0], asset: f.project.assets[0], source: "clip.mp4" } as ActivePreviewLayer;
  hooks.resident = { route: "resident", view: { mode: "compatible", playing: false } };
  const video = fakeMedia("VIDEO");
  f.options.layers = [layer]; f.options.mediaRefs.current.set(layer.clip.id, video.element);
  const rejectThenPause = async (reason = named("NotAllowedError", new Error("denied"))) => {
    video.media.paused = true; video.media.play.mockRejectedValueOnce(reason);
    f.options.playing = true; f.render(); await settle();
    f.options.playing = false; return f.render().failure!;
  };
  return { layer, video, rejectThenPause };
}
const stageFor = (project: ReturnType<typeof createDemoProject>, generation: number): NativeAudioPreviewStartResult => ({ native: true, generation,
  playback: { schema: "editkin.native-audio-preview-event/v1", event: "started", timelineStartSeconds: 0, timelineSeconds: 0 },
  stage: { schema: "editkin.native-audio-preview-stage/v2", status: "GREEN", projectId: project.id, projectRevision: project.revision,
    projectUpdatedAt: project.updatedAt, sampleRate: 48000, channels: 2, decoderExecutor: "ffmpeg-source-decode/v1", decodeMode: "independent-source-pcm",
    mixExecutor: "hao-core-native-dag/v1", nativeGraphExecution: true, manifestSha256: "a".repeat(64), manifestBytes: 10,
    audioFingerprintSha256: "c".repeat(64), timelineStartSeconds: 0, voiceClipCount: 1, musicClipCount: 0, sourceIds: ["source"],
    sourcePcm: [{ id: "source", clipId: "clip-demo", assetId: "asset-demo", role: "voice", startFrame: 0, gainDb: 0, gainAutomation: [], bytes: 10, sha256: "b".repeat(64) }],
    clipCount: 1, durationSeconds: 5, claimBoundary: "Source adapter control, not actual native audio" } });
/** Legacy native audio at 1× whose stop is not confirmed when the speed changes: an "audio" failure. */
async function unconfirmedStop() {
  let generation = 7;
  const stop = vi.fn(async (_generation?: number) => ({ active: true, stopped: false }));
  const api = { nativeAudioPreviewPushEvents: true, startNativeAudioPreview: vi.fn(async () => stageFor(f.project, generation)),
    stopNativeAudioPreview: stop } as unknown as HaoDesktopApi;
  const f = fixture(api); f.render(); await settle();
  expect(f.render().mode).toBe("native");
  f.options.playbackRate = 2; f.options.seekRevision = 1; f.render(); await settle();
  expect(f.options.onPlayingChange).toHaveBeenCalledExactlyOnceWith(false);
  f.options.playing = false; f.render(); await settle();
  expect(notice("preview-audio")?.kind).toBe("audio");
  return { f, api, stop, nextGeneration: (value: number) => { generation = value; } };
}

describe("preview playback recovery acts only on real, current outcomes (review 2026-10-09)", () => {
  it("#3 only a rebuild that reports a committed preview clears the notice; a failed or silent one keeps it", async () => {
    const f = fixture(), { rejectThenPause } = videoClip(f);
    let outcome: boolean | undefined = false;
    const rebuild = vi.fn(async (_assetId: string, onOutcome?: (rebuilt: boolean) => void) => { if (outcome !== undefined) onOutcome?.(outcome); });
    f.options.onRebuildPreview = rebuild;
    for (const step of ["play", "reload", "rebuild"]) expect((await rejectThenPause()).step).toBe(step);
    // useMediaPreviewRepair settles for a failed or skipped rebuild too; it reports false.
    retryPlaybackNotice("preview-audio"); await settle(); f.render();
    expect(rebuild).toHaveBeenCalledExactlyOnceWith(f.project.assets[0].id, expect.any(Function));
    expect(f.render().failure).toMatchObject({ kind: "play", step: "rebuild" });
    expect(notice("preview-audio")).toMatchObject({ kind: "play", step: "rebuild", attempts: 1, busy: false });
    // A rebuild that never reports an outcome is not a success either.
    outcome = undefined; retryPlaybackNotice("preview-audio"); await settle(); f.render();
    expect(notice("preview-audio")).toMatchObject({ step: "rebuild", attempts: 2, busy: false });
    outcome = true; retryPlaybackNotice("preview-audio"); await settle();
    expect(f.render().failure).toBeUndefined(); expect(notice("preview-audio")).toBeUndefined();
    // A rebuild never resumes by itself: the element reloads the new preview first.
    expect(f.options.onPlayingChange).toHaveBeenLastCalledWith(false);
  });

  it("#3 a reload that does not decode again (element error, 10 s without data) keeps the notice", async () => {
    const f = fixture(), { video, rejectThenPause } = videoClip(f);
    expect((await rejectThenPause()).step).toBe("play"); expect((await rejectThenPause()).step).toBe("reload");
    const calls = f.options.onPlayingChange.mock.calls.length;
    // OcioGpuMedia / AlphaProcessedPreviewMedia show no load error of their own.
    retryPlaybackNotice("preview-audio"); expect(video.media.load).toHaveBeenCalledTimes(1);
    video.fire("error"); await settle(); f.render();
    expect(notice("preview-audio")).toMatchObject({ kind: "play", step: "reload", attempts: 1, busy: false });
    retryPlaybackNotice("preview-audio"); expect(video.media.load).toHaveBeenCalledTimes(2);
    expect(timeouts.size).toBe(1); [...timeouts.values()][0](); await settle(); f.render();
    expect(notice("preview-audio")).toMatchObject({ kind: "play", step: "reload", attempts: 2, busy: false });
    expect(f.options.onPlayingChange.mock.calls.length).toBe(calls);
    // Decoded again: the notice goes and playback resumes.
    retryPlaybackNotice("preview-audio"); video.fire("loadeddata"); await settle();
    expect(f.render().failure).toBeUndefined(); expect(notice("preview-audio")).toBeUndefined();
    expect(f.options.onPlayingChange).toHaveBeenLastCalledWith(true);
  });

  it("#4 an unconfirmed native stop keeps 1× paused too, as its notice says; the retry then resumes the play that was asked for", async () => {
    const { f, api, stop, nextGeneration } = await unconfirmedStop();
    // Back at 1×, play is pressed: nothing may start under 「為避免重疊已先暫停」.
    nextGeneration(8); f.options.playbackRate = 1; f.options.seekRevision = 2; f.options.playing = true; f.render(); await settle();
    expect(f.options.onPlayingChange).toHaveBeenCalledTimes(2); expect(f.options.onPlayingChange).toHaveBeenLastCalledWith(false);
    expect(api.startNativeAudioPreview).toHaveBeenCalledTimes(1); expect(f.render().mode).toBe("idle");
    expect(notice("preview-audio")?.kind).toBe("audio");
    f.options.playing = false; f.render(); await settle();
    stop.mockResolvedValue({ active: false, stopped: true });
    await notice("preview-audio")!.retry!(); await settle(); f.render();
    expect(notice("preview-audio")).toBeUndefined();
    expect(f.options.onPlayingChange).toHaveBeenCalledTimes(3); expect(f.options.onPlayingChange).toHaveBeenLastCalledWith(true);
    f.options.playing = true; f.render(); await settle();
    expect(api.startNativeAudioPreview).toHaveBeenCalledTimes(2); expect(f.render().mode).toBe("native");
  });

  it("#5 an <audio> source error follows who owns the sound, not pause or seek modes: no flash, no pause, a dismissal sticks", async () => {
    const api = { nativeAudioPreviewPushEvents: true, startNativeAudioPreview: vi.fn(async () => stageFor(f.project, 9)),
      stopNativeAudioPreview: vi.fn(async () => ({ active: false, stopped: true })) } as unknown as HaoDesktopApi;
    const f = fixture(api); f.options.playing = false;
    const clip = { ...f.project.tracks[0].clips[0], id: "music-clip" };
    const audio = fakeMedia("AUDIO");
    f.options.audioLayers = [{ clip, asset: { ...f.project.assets[0], name: "music.aiff" }, source: "music.aiff" } as ActivePreviewLayer];
    f.options.mediaRefs.current.set("music-clip", audio.element);
    f.render(); audio.media.error = { code: 4, message: "Format error" }; audio.fire("error"); f.render();
    // Native audio decodes the file itself at 1×: paused, playing, re-staged by a seek, paused again.
    const seen = [notice("audio-sources")?.kind];
    f.options.playing = true; f.render(); await settle(); expect(f.render().mode).toBe("native"); seen.push(notice("audio-sources")?.kind);
    f.options.seekRevision = 1; f.render(); seen.push(notice("audio-sources")?.kind); await settle(); f.render();
    f.options.playing = false; f.render(); await settle(); f.render(); seen.push(notice("audio-sources")?.kind);
    expect(seen).toEqual([undefined, undefined, undefined, undefined]); expect(f.options.onPlayingChange).not.toHaveBeenCalled();
    // At 2× the element is the sound source: it is shown, and once closed it stays closed.
    f.options.playbackRate = 2; f.options.seekRevision = 2; f.render(); await settle(); f.render();
    expect(notice("audio-sources")).toMatchObject({ kind: "audio-source", names: ["music.aiff"] });
    dismissPlaybackNotice("audio-sources");
    for (const playing of [true, false, true]) {
      f.options.playing = playing; f.options.seekRevision += 1; f.render(); await settle(); f.render();
      expect(notice("audio-sources")).toBeUndefined();
    }
  });

  it("#5 a resident seek re-stage neither pauses on an <audio> error nor flashes it; a compatible fallback shows it", () => {
    const f = fixture(), clip = { ...f.project.tracks[0].clips[0], id: "music-clip" }, audio = fakeMedia("AUDIO");
    f.options.audioLayers = [{ clip, asset: { ...f.project.assets[0], name: "music.m4a" }, source: "music.m4a" } as ActivePreviewLayer];
    f.options.mediaRefs.current.set("music-clip", audio.element);
    hooks.resident = { route: "resident", view: { mode: "native", playing: true, ownerId: 3, generation: 1 } }; f.render();
    hooks.resident = { route: "resident", view: { mode: "preparing", playing: true, ownerId: 3 } }; f.render();
    audio.media.error = { code: 4, message: "Format error" }; audio.fire("error"); f.render();
    expect(f.options.onPlayingChange).not.toHaveBeenCalled(); expect(notice("audio-sources")).toBeUndefined();
    hooks.resident = { route: "resident", view: { mode: "idle", playing: false, ownerId: 3 } }; f.options.playing = false; f.render();
    expect(notice("audio-sources")).toBeUndefined();
    hooks.resident = { route: "resident", view: { mode: "compatible", playing: false, error: "音訊工作階段失敗" } }; f.render();
    expect(notice("audio-sources")).toMatchObject({ kind: "audio-source", names: ["music.m4a"] });
  });

  it("#6 a late reload result neither resumes after the user played and paused meanwhile nor clears anything", async () => {
    const f = fixture(), { video, rejectThenPause } = videoClip(f);
    await rejectThenPause(); expect((await rejectThenPause()).step).toBe("reload");
    retryPlaybackNotice("preview-audio"); expect(video.media.load).toHaveBeenCalledTimes(1);
    // While it reloads, the user plays (it works this time) and then pauses on purpose.
    video.media.paused = true; f.options.playing = true; f.render(); await settle();
    expect(f.render().failure).toBeUndefined();
    f.options.playing = false; f.render();
    const calls = f.options.onPlayingChange.mock.calls.length;
    video.fire("loadeddata"); await settle(); f.render();
    expect(f.options.onPlayingChange.mock.calls.length).toBe(calls);
  });

  it("#6 a late rebuild success keeps a newer failure of the same clip", async () => {
    const f = fixture(), { rejectThenPause } = videoClip(f), rebuilt = deferred<void>();
    let report: (outcome: boolean) => void = () => undefined;
    f.options.onRebuildPreview = vi.fn((_assetId: string, onOutcome?: (rebuilt: boolean) => void) => { report = outcome => onOutcome?.(outcome); return rebuilt.promise; });
    for (const step of ["play", "reload", "rebuild"]) expect((await rejectThenPause()).step).toBe(step);
    retryPlaybackNotice("preview-audio");
    const newer = await rejectThenPause(named("NotAllowedError", new Error("denied after the rebuild started")));
    report(true); rebuilt.resolve(); await settle();
    expect(f.render().failure).toMatchObject({ kind: "play", detail: newer.detail });
    expect(notice("preview-audio")).toMatchObject({ kind: "play", detail: newer.detail });
  });

  it("#6 a play failure is dropped with its clip or its project", async () => {
    const f = fixture(), { layer, video, rejectThenPause } = videoClip(f);
    await rejectThenPause(); expect(notice("preview-audio")?.kind).toBe("play");
    // Removing the clip unmounts its element.
    f.options.mediaRefs.current.delete(layer.clip.id); f.options.layers = []; f.render();
    expect(f.render().failure).toBeUndefined(); expect(notice("preview-audio")).toBeUndefined();
    f.options.layers = [layer]; f.options.mediaRefs.current.set(layer.clip.id, video.element);
    await rejectThenPause(); expect(notice("preview-audio")?.kind).toBe("play");
    f.options.project = { ...f.project, id: "another-project" }; f.render();
    expect(f.render().failure).toBeUndefined(); expect(notice("preview-audio")).toBeUndefined();
  });

  it("#6 a confirmed audio retry after switching project does not start the new project's playback", async () => {
    const { f, stop } = await unconfirmedStop();
    f.options.project = { ...f.project, id: "next-project" }; f.render(); await settle(); f.render();
    expect(notice("preview-audio")?.kind).toBe("audio");
    const calls = f.options.onPlayingChange.mock.calls.length;
    stop.mockResolvedValue({ active: false, stopped: true });
    await notice("preview-audio")!.retry!(); await settle(); f.render();
    expect(notice("preview-audio")).toBeUndefined(); expect(f.options.onPlayingChange.mock.calls.length).toBe(calls);
  });
});
