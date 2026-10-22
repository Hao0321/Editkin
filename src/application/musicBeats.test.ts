import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTempRoots } from "../test/tempRoot.mjs";
import { analyzeMusicBeatsV1 } from "./musicBeats";
import { fixtureReceiptV1 } from "./musicBeats.fixture";
const mock = vi.hoisted(() => ({ run: vi.fn(), probe: vi.fn(async () => ({ hasAudio: true, duration: 20 })), space: vi.fn(async () => ({ key: "owned", availableBytes: 10 * 1024 ** 3 })) }));
vi.mock("./analysisProcess", () => ({ runAnalysisProcess: mock.run }));
vi.mock("../render/mediaProcess", () => ({ probeMedia: mock.probe }));
vi.mock("../render/renderDiskSpace", () => ({ probeVolumeSpace: mock.space }));
const temp = useTempRoots();
async function setup() {
  const root = await temp.create("editkin-music-cache-control-");
  for (const name of ["source.wav", "ffmpeg.exe", "ffprobe.exe", "core.exe"]) await writeFile(join(root, name), name);
  return { root, request: { sourcePath: join(root, "source.wav"), sourceStartSeconds: 0, durationSeconds: 2, priorBpm: 120 },
    runtime: { ffmpegPath: join(root, "ffmpeg.exe"), ffprobePath: join(root, "ffprobe.exe"), nativeCorePath: join(root, "core.exe"), cacheRoot: join(root, "cache") } };
}
beforeEach(() => {
  mock.run.mockReset(); mock.probe.mockClear(); mock.space.mockClear();
  mock.run.mockImplementation(async (_exe: string, args: string[]) => {
    const request = JSON.parse(await readFile(args[1], "utf8")), result = fixtureReceiptV1(request.durationSeconds, request.sourceStartSeconds);
    result.sourceSha256 = request.sourceSha256; result.sourceBytes = request.sourceBytes; result.ffmpegSha256 = request.ffmpegSha256;
    const bytes = Buffer.from(JSON.stringify(result)); await writeFile(request.outputPath, bytes, { flag: "wx" });
    return { stdout: Buffer.from(JSON.stringify({ schema: "editkin.music-beats-command/v1", outputPath: request.outputPath, outputBytes: bytes.length,
      decoderTreeClosed: true, pcmStagedBytes: 0, decodedSamples: result.analysis.decodedSamples })), stderr: "" };
  });
});
describe("music analysis immutable source/options/runtime cache (controlled native boundary)", () => {
  it("reuses a validated result and removes its owned scratch folder", async () => {
    const f = await setup(), before = await readFile(f.request.sourcePath);
    const first = await analyzeMusicBeatsV1(f.request, f.runtime), second = await analyzeMusicBeatsV1(f.request, f.runtime);
    expect(first.cacheHit).toBe(false); expect(second.cacheHit).toBe(true); expect(mock.run).toHaveBeenCalledTimes(1);
    expect(second.receiptSha256).toBe(first.receiptSha256); expect(await readFile(f.request.sourcePath)).toEqual(before);
    expect((await readdir(join(f.runtime.cacheRoot, "music-beats-v1"))).filter(x => x.startsWith("owned-analysis-"))).toEqual([]);
  });
  it("source, native binary and prior changes produce distinct cache keys", async () => {
    const f = await setup(), first = await analyzeMusicBeatsV1(f.request, f.runtime);
    await writeFile(f.request.sourcePath, "changed source"); const source = await analyzeMusicBeatsV1(f.request, f.runtime);
    await writeFile(f.runtime.nativeCorePath, "new core"); const core = await analyzeMusicBeatsV1(f.request, f.runtime);
    const prior = await analyzeMusicBeatsV1({ ...f.request, priorBpm: 90 }, f.runtime);
    expect(new Set([first.key, source.key, core.key, prior.key]).size).toBe(4); expect(mock.run).toHaveBeenCalledTimes(4);
  });
  it("does not trust a rehashed cache with substituted source identity", async () => {
    const f = await setup(), first = await analyzeMusicBeatsV1(f.request, f.runtime), path = join(f.runtime.cacheRoot, "music-beats-v1", `${first.key}.json`);
    const cached = JSON.parse(await readFile(path, "utf8")); cached.receipt.sourceSha256 = "f".repeat(64);
    // Match canonical digest ordering used by the product, so only semantic validation can reject this forgery.
    const { canonicalJson } = await import("../shared/canonicalJson"); cached.receiptSha256 = createHash("sha256").update(canonicalJson(cached.receipt)).digest("hex");
    await writeFile(path, JSON.stringify(cached)); const recovered = await analyzeMusicBeatsV1(f.request, f.runtime);
    expect(recovered.cacheHit).toBe(false); expect(mock.run).toHaveBeenCalledTimes(2);
  });
  it("pre-cancellation starts no child and unknown space admits no native analysis", async () => {
    const f = await setup(), controller = new AbortController(); controller.abort(Error("human cancel"));
    await expect(analyzeMusicBeatsV1(f.request, { ...f.runtime, signal: controller.signal })).rejects.toThrow("human cancel"); expect(mock.run).not.toHaveBeenCalled();
    mock.space.mockResolvedValueOnce(null as never);
    await expect(analyzeMusicBeatsV1(f.request, f.runtime)).rejects.toThrow("SPACE_SHORT_OR_UNKNOWN"); expect(mock.run).not.toHaveBeenCalled();
  });
  it("native failure preserves source bytes and removes only the owned work", async () => {
    const f = await setup(), before = await readFile(f.request.sourcePath); mock.run.mockRejectedValueOnce(Error("codec failed"));
    await expect(analyzeMusicBeatsV1(f.request, f.runtime)).rejects.toThrow("codec failed"); expect(await readFile(f.request.sourcePath)).toEqual(before);
    expect((await readdir(join(f.runtime.cacheRoot, "music-beats-v1"))).filter(x => x.startsWith("owned-analysis-"))).toEqual([]);
  });
});
