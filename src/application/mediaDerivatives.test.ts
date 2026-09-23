import { access, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { generateMediaDerivatives } from "./mediaDerivatives";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("media derivative cache", () => {
  it("atomically creates proxy, thumbnail, waveform and then hits cache", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "hao-derivatives-test-"));
    workspaces.push(cacheRoot);
    const request = {
      sourcePath: resolve(import.meta.dirname, "../../public/benchmarks/layer-base.mp4"),
      kind: "video" as const,
      duration: 4,
      hasAudio: true,
      cacheRoot,
      ffmpegPath: process.env.HAO_FFMPEG_PATH ?? "ffmpeg",
      ffprobePath: process.env.HAO_FFPROBE_PATH ?? "ffprobe",
      timeoutMs: 60_000,
    };
    const competing = await Promise.all([generateMediaDerivatives(request), generateMediaDerivatives(request)]);
    expect(competing.map(result => result.cacheHit).sort()).toEqual([false, true]);
    expect(competing[0].derivatives).toEqual(competing[1].derivatives);
    const first = competing.find(result => !result.cacheHit)!;
    expect(first.cacheHit).toBe(false);
    await Promise.all([first.derivatives.proxyUri!, first.derivatives.overlayProxyUri!, first.derivatives.thumbnailUri!, first.derivatives.waveformUri!].map(access));
    expect(first.derivatives.overlayProxyFrameRateNumerator).toBe(15);
    expect(first.derivatives.overlayProxyFrameRateDenominator).toBe(1);
    expect(first.derivatives.overlayProxyHeight).toBeLessThanOrEqual(216);
    expect(first.derivatives.overlayProxyProfile).toBe("editkin-small-overlay-performance/v1");
    const second = await generateMediaDerivatives(request);
    expect(second.cacheHit).toBe(true);
    expect(second.derivatives).toEqual(first.derivatives);
  }, 90_000);
});
