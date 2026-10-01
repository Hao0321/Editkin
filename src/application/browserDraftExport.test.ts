import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { renderBrowserDraft } from "./browserDraftExport";

vi.mock("../render/browserDraftCanvas", () => ({
  drawBrowserDraftFrame: vi.fn(), loadBrowserDraftFonts: vi.fn(async () => {}),
}));

// Controlled browser API failures exercise the real recorder lifecycle. These
// tests do not replace actual browser/decoded-output verification.
function browser() {
  const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
  type Track = typeof tracks[number];
  const nodes: Array<{ disconnect: ReturnType<typeof vi.fn> }> = [];
  const elements: Media[] = [];
  const audioContexts: Audio[] = [];
  const recorders: Recorder[] = [];
  let ready = true, stopEvent = true;
  let stopThrows = false;
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  class Stream {
    constructor(public tracks: Track[]) {}
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks; }
    addTrack(track: Track) { this.tracks.push(track); }
  }
  class Media extends EventTarget {
    static HAVE_CURRENT_DATA = 2;
    readyState = ready ? 2 : 0;
    duration = 12; currentTime = 0; seeking = false; src = "";
    videoWidth = 960; videoHeight = 540;
    pause = vi.fn(); load = vi.fn();
    removeAttribute = vi.fn();
    play = vi.fn(async () => {});
    constructor() { super(); elements.push(this); }
  }
  class Image extends EventTarget {}
  class Canvas {
    width = 0; height = 0;
    getContext() { return { canvas: this, filter: "none" }; }
    captureStream() { return new Stream([tracks[0]]); }
  }
  const node = () => {
    const result = { connect: vi.fn(), disconnect: vi.fn(), gain: { value: 0 }, stream: new Stream([tracks[1]]) };
    nodes.push(result); return result;
  };
  class Audio extends EventTarget {
    state = "running"; currentTime = 0;
    resume = vi.fn(async () => {});
    close = vi.fn(async () => { this.state = "closed"; });
    createMediaStreamDestination = vi.fn(node);
    createMediaElementSource = vi.fn(node);
    createGain = vi.fn(node);
    constructor() { super(); audioContexts.push(this); }
  }
  class Recorder {
    static isTypeSupported = () => true;
    state = "inactive"; mimeType = "video/mp4";
    ondataavailable?: (event: { data: Blob }) => void;
    onstop?: () => void; onerror?: () => void;
    start = vi.fn(() => { this.state = "recording"; });
    stop = vi.fn(() => {
      if (stopThrows) throw new Error("stop failed");
      this.state = "inactive";
      if (stopEvent) queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob(["encoded fixture"]) }); this.onstop?.();
      });
    });
    constructor() { recorders.push(this); }
  }
  const document = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    createElement: (kind: string) => kind === "canvas" ? new Canvas() : new Media(),
  });
  for (const [name, value] of Object.entries({
    document, window: new EventTarget(), HTMLCanvasElement: Canvas,
    HTMLMediaElement: Media, HTMLVideoElement: Media, HTMLImageElement: Image,
    Image, AudioContext: Audio, MediaRecorder: Recorder,
    requestAnimationFrame: (callback: FrameRequestCallback) => { callbacks.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: (id: number) => callbacks.delete(id),
    fetch: vi.fn(async () => ({ ok: true, blob: async () => new Blob(["source fixture"]) })),
  })) vi.stubGlobal(name, value);
  const project = createDemoProject();
  project.tracks[0].clips[0].duration = 0.1;
  const controller = new AbortController();
  const start = () => renderBrowserDraft(project, { "asset-demo": "blob:fixture" }, { signal: controller.signal });
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const step = (time: number) => {
    audioContexts.at(-1)!.currentTime = time;
    elements.forEach(element => { element.currentTime = time; });
    const pending = [...callbacks.values()]; callbacks.clear(); pending.forEach(callback => callback(time * 1000));
  };
  return { tracks, nodes, elements, audioContexts, recorders, document, controller, start, flush, step,
    notReady: () => { ready = false; }, missingStop: () => { stopEvent = false; }, throwingStop: () => { stopThrows = true; },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("browser draft recorder lifecycle", () => {
  it("releases the destination audio track when canceled before canvas capture", async () => {
    const f = browser(); f.notReady();
    const work = f.start(); const result = expect(work).rejects.toThrow(/取消/);
    await f.flush(); f.controller.abort(new Error("取消")); await result;
    expect(f.recorders).toHaveLength(0);
    expect(f.tracks[1].stop).toHaveBeenCalledOnce();
    expect(f.elements[0].removeAttribute).toHaveBeenCalledWith("src");
    expect(f.audioContexts[0].close).toHaveBeenCalledOnce();
  });
  it("stops foreground recording and releases every resource on real visibility events", async () => {
    const f = browser(); const work = f.start(); const result = expect(work).rejects.toThrow(/背景/);
    await f.flush(); expect(f.recorders).toHaveLength(1);
    f.document.visibilityState = "hidden"; f.document.dispatchEvent(new Event("visibilitychange"));
    await result;
    f.tracks.forEach(track => expect(track.stop).toHaveBeenCalledOnce());
    f.nodes.forEach(node => expect(node.disconnect).toHaveBeenCalledOnce());
  });
  it("settles a recorder that never emits stop, so the caller can retry", async () => {
    const f = browser(); f.missingStop();
    let failure: unknown;
    const work = f.start().catch(error => { failure = error; });
    await f.flush(); f.step(0.2); await f.flush();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/逾時/);
    f.controller.abort(); await work;
    f.tracks.forEach(track => expect(track.stop).toHaveBeenCalledOnce());
  });
  it("aborts a stalled frame loop without waiting for requestAnimationFrame to resume", async () => {
    const f = browser(); let failure: unknown;
    const work = f.start().catch(error => { failure = error; }); await f.flush();
    await vi.advanceTimersByTimeAsync(1250);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/時鐘/);
    f.controller.abort(); await work;
  });
  it("still cleans tracks, media and audio when recorder.stop throws", async () => {
    const f = browser(); f.throwingStop();
    const work = f.start(); const result = expect(work).rejects.toThrow(); await f.flush();
    expect(() => f.recorders[0].onerror?.()).not.toThrow(); await result;
    f.tracks.forEach(track => expect(track.stop).toHaveBeenCalledOnce());
    expect(f.audioContexts[0].close).toHaveBeenCalledOnce();
  });
  it("returns the final encoded chunk and permits an independent second run", async () => {
    const f = browser(); const first = f.start(); await f.flush(); f.step(0.2);
    expect((await first).blob.size).toBeGreaterThan(0);
    const second = f.start(); await f.flush(); f.step(0.4); expect((await second).blob.size).toBeGreaterThan(0);
    expect(f.recorders).toHaveLength(2);
  });
  it("rejects oversized imported files before media decoding or recording", async () => {
    const f = browser();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, blob: async () => ({ size: 128 * 1024 * 1024 + 1 }) })));
    await expect(f.start()).rejects.toThrow(/來源.*128 MiB/);
    expect(f.elements).toHaveLength(0); expect(f.recorders).toHaveLength(0);
    expect(f.tracks[1].stop).toHaveBeenCalledOnce();
  });
  it("checks actual decoded dimensions instead of trusting project metadata", async () => {
    const f = browser(); f.notReady(); const work = f.start(); const result = expect(work).rejects.toThrow(/尺寸/);
    await f.flush();
    f.elements[0].videoWidth = 20_000; f.elements[0].readyState = 2;
    f.elements[0].dispatchEvent(new Event("loadeddata")); await result;
    expect(f.recorders).toHaveLength(0); expect(f.tracks[1].stop).toHaveBeenCalledOnce();
  });
  it("rejects a failed local source read and detaches lifecycle listeners", async () => {
    const f = browser(); vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
    await expect(f.start()).rejects.toThrow(/重新匯入/);
    f.document.visibilityState = "hidden"; f.document.dispatchEvent(new Event("visibilitychange"));
    expect(f.tracks[1].stop).toHaveBeenCalledOnce();
  });
  it("does not let an audio-close failure hide cancellation or prevent cleanup", async () => {
    const f = browser(); const work = f.start(); const result = expect(work).rejects.toThrow(/取消/);
    await f.flush(); f.audioContexts[0].close.mockRejectedValueOnce(new Error("close failed"));
    f.controller.abort(new Error("取消")); await result;
    f.tracks.forEach(track => expect(track.stop).toHaveBeenCalledOnce());
  });
  it("aborts an unfinished source read after its deadline", async () => {
    const f = browser(); let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string, options: RequestInit) => {
      signal = options.signal ?? undefined;
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal!.reason)));
    }));
    const work = f.start(); const result = expect(work).rejects.toThrow(/讀取逾時/);
    await f.flush(); await vi.advanceTimersByTimeAsync(15_001); await result;
    expect(signal?.aborted).toBe(true); expect(f.tracks[1].stop).toHaveBeenCalledOnce();
  });
  it("aborts when leaving the page, without producing a partial result", async () => {
    const f = browser(); const work = f.start(); const result = expect(work).rejects.toThrow(/離開/);
    await f.flush(); window.dispatchEvent(new Event("pagehide")); await result;
    f.tracks.forEach(track => expect(track.stop).toHaveBeenCalledOnce());
  });
});
