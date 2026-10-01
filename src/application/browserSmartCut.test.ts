import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeBrowserSmartCut } from "./browserSmartCut";

const request = { sourceUrl: "blob:fixture", sourceDuration: 4, sourceStart: 1, duration: 2, fps: 30 };

function decoder(pcm: Float32Array, sampleRate = 1000) {
  const decodeAudioData = vi.fn(async () => ({ duration: pcm.length / sampleRate, length: pcm.length, sampleRate, numberOfChannels: 1, getChannelData: () => pcm }));
  vi.stubGlobal("OfflineAudioContext", class { decodeAudioData = decodeAudioData; });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, blob: async () => new Blob(["fixture"]) })));
  return decodeAudioData;
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("browser Smart Cut analysis", () => {
  it("analyzes only the trimmed source interval and returns relative frame ranges", async () => {
    const pcm = new Float32Array(4000).fill(1);
    pcm.fill(0, 0, 1000);
    pcm.fill(0, 1500, 2500);
    decoder(pcm);
    const result = await analyzeBrowserSmartCut({ ...request, options: { padding: 0, minSilence: 0.35, minKeep: 0.25 } });
    expect(result.ranges).toEqual([{ startFrame: 0, endFrame: 15 }, { startFrame: 45, endFrame: 60 }]);
    expect(result.removedFrames).toBe(30);
    expect(result.silenceCount).toBe(1);
  });

  it("refuses a cut that would erase the entire selected interval", async () => {
    decoder(new Float32Array(4000));
    await expect(analyzeBrowserSmartCut(request)).rejects.toThrow("移除整個片段");
  });

  it("keeps continuous audio intact", async () => {
    decoder(new Float32Array(4000).fill(1));
    const result = await analyzeBrowserSmartCut(request);
    expect(result.ranges).toEqual([{ startFrame: 0, endFrame: 60 }]);
    expect(result.removedFrames).toBe(0);
  });

  it("accepts frame-rounded source ends without fabricating silent tail samples", async () => {
    const pcm = new Float32Array(1985).fill(1);
    pcm.fill(0, 500, 1500);
    decoder(pcm);
    const result = await analyzeBrowserSmartCut({
      ...request, sourceDuration: 1.985, sourceStart: 0, duration: 2,
      options: { padding: 0, minSilence: 0.35, minKeep: 0.25 },
    });
    expect(result.ranges).toEqual([{ startFrame: 0, endFrame: 15 }, { startFrame: 45, endFrame: 60 }]);
    expect(result.removedFrames).toBe(30);
  });

  it("rejects over-limit encoded files before allocating decoder buffers", async () => {
    const decode = decoder(new Float32Array(4000));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, blob: async () => ({ size: 32 * 1024 * 1024 + 1 }) })));
    await expect(analyzeBrowserSmartCut(request)).rejects.toThrow("32 MiB");
    expect(decode).not.toHaveBeenCalled();
  });

  it("rejects long sources and non-imported URLs without fetching them", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(analyzeBrowserSmartCut({ ...request, sourceDuration: 301 })).rejects.toThrow("5 分鐘");
    for (const sourceUrl of [undefined, "local://fixture", "https://example.invalid/media.wav"]) {
      await expect(analyzeBrowserSmartCut({ ...request, sourceUrl })).rejects.toThrow("重新匯入");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not infer silence from missing or truncated decoded audio", async () => {
    decoder(new Float32Array(2000).fill(1));
    await expect(analyzeBrowserSmartCut(request)).rejects.toThrow("未涵蓋");
  });

  it("checks the decoded duration even when container metadata is inaccurate", async () => {
    // 301 samples at 1 Hz represent 301 seconds, exceeding the metadata duration.
    decoder(new Float32Array(301), 1);
    await expect(analyzeBrowserSmartCut(request)).rejects.toThrow("5 分鐘");
  });

  it("times out a stalled local source read and aborts the fetch", async () => {
    vi.useFakeTimers(); decoder(new Float32Array(4000));
    let signal: AbortSignal | undefined, failure: unknown;
    vi.stubGlobal("fetch", vi.fn((_url: string, options: RequestInit) => {
      signal = options?.signal ?? undefined;
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal!.reason)));
    }));
    const work = analyzeBrowserSmartCut(request).catch(error => { failure = error; });
    await vi.advanceTimersByTimeAsync(30_001);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/逾時/);
    expect(signal?.aborted).toBe(true); await work;
  });

  it("discards canceled decoding and prevents concurrent native decoders until it settles", async () => {
    const decode = decoder(new Float32Array(4000).fill(1));
    let finish!: (value: Awaited<ReturnType<typeof decode>>) => void;
    decode.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const controller = new AbortController(); let failure: unknown;
    const work = analyzeBrowserSmartCut({ ...request, signal: controller.signal }).catch(error => { failure = error; });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    controller.abort(new Error("取消分析"));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect((failure as Error)?.message).toContain("取消分析"); await work;
    await expect(analyzeBrowserSmartCut(request)).rejects.toThrow(/上一次/);
    finish({ duration: 4, length: 4000, sampleRate: 1000, numberOfChannels: 1, getChannelData: () => new Float32Array(4000).fill(1) });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect((await analyzeBrowserSmartCut(request)).removedFrames).toBe(0);
  });
});
