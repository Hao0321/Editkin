import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { PNG } from "pngjs";
import { runAnalysisProcess } from "../../src/application/analysisProcess";
import { probeVolumeSpace } from "../../src/render/renderDiskSpace";
import { fixtureReceiptV1 } from "../../src/application/musicBeats.fixture";
import { canonicalJson } from "../../src/shared/canonicalJson";
import { createBeatReviewContactSheetV1 } from "./beatReviewContactSheetV1";
import { runBeatReviewCliV1 } from "../beat-review-contact-sheet-v1";

vi.mock("../../src/application/analysisProcess", () => ({ runAnalysisProcess: vi.fn() }));
vi.mock("../../src/render/renderDiskSpace", () => ({ probeVolumeSpace: vi.fn() }));
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const run = vi.mocked(runAnalysisProcess), space = vi.mocked(probeVolumeSpace);
let root: string, folder: string, out: string, ffmpeg: string, music: string, cachePath: string;
let request: Record<string, any>, cache: Record<string, any>, rasterHeight = 470;
const png = (width: number, height: number) => PNG.sync.write({ width, height, data: Buffer.alloc(width * height * 4, 255) } as PNG);
async function rewriteCache() { await writeFile(cachePath, JSON.stringify(cache)); request.analysis.sha256 = sha(await readFile(cachePath)); }
async function fakeMedia(_executable: string, args: string[], options: Parameters<typeof runAnalysisProcess>[2]) {
  options.signal?.throwIfAborted();
  if (args.includes("f32le")) return { stdout: Buffer.alloc(Math.round(request.window.durationSeconds * 16000) * 4), stderr: "" };
  if (args.includes("rawvideo")) return { stdout: Buffer.alloc(Number(args[args.indexOf("-frames:v") + 1]) * 320 * 180 * 4, 255), stderr: "" };
  return { stdout: png(1200, rasterHeight), stderr: "" };
}
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "beat-review-test-")); });
afterAll(async () => {
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("beat-review-test-")) throw Error("Unexpected test cleanup root");
  await rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  folder = await mkdtemp(join(root, "case-")); out = join(folder, "new-output"); ffmpeg = join(folder, "ffmpeg.exe"); music = join(folder, "music.wav"); cachePath = join(folder, "cache.json");
  await writeFile(ffmpeg, "pinned mock executable"); await writeFile(music, "0123456789");
  const source = { sha256: sha(await readFile(music)), bytes: 10 }, tool = { sha256: sha(await readFile(ffmpeg)), bytes: (await readFile(ffmpeg)).length };
  const receipt = fixtureReceiptV1(); receipt.sourceSha256 = source.sha256; receipt.ffmpegSha256 = tool.sha256;
  const binding = { schema: "editkin.music-beats-cache-key/v1", source, ffmpeg: tool, ffprobe: tool, core: tool, sourceStartSeconds: 0,
    durationSeconds: 2, priorBpm: null, analysisRecipe: "spectral-flux-autocorrelation-dp-native/v1" };
  cache = { schema: "editkin.music-beats-cache/v1", key: sha(canonicalJson(binding)), binding, receiptSha256: sha(canonicalJson(receipt)), receipt };
  request = { schema: "editkin.beat-review-request/v1", title: "Controlled review", analysis: { path: cachePath, sha256: "a".repeat(64) },
    music: { path: music, sha256: source.sha256 }, window: { sourceStartSeconds: 0, durationSeconds: 2 } };
  await rewriteCache(); rasterHeight = 470; run.mockReset(); run.mockImplementation(fakeMedia);
  space.mockReset(); space.mockResolvedValue({ availableBytes: 128 * 1024 ** 2 } as Awaited<ReturnType<typeof probeVolumeSpace>>);
});

describe("physical beat review inputs and owned output", () => {
  it("publishes exact passive review artifacts with source readback, no analysis or project edits", async () => {
    const result = await createBeatReviewContactSheetV1(request, out, { ffmpegPath: ffmpeg });
    expect(result).toMatchObject({ status: "REVIEW_READY_NOT_APPROVED", analysisCalls: 0, projectEdits: 0, decodedReviewFrames: 0,
      sourceInputsRecheckedAfterMedia: true, quality: { humanQualityCertified: false, fMeasure: "NOT_MEASURED" } });
    expect(run).toHaveBeenCalledTimes(2); expect(run.mock.calls.every(c => c[0] === ffmpeg)).toBe(true);
    for (const f of result.files) expect(sha(await readFile(join(out, f.name)))).toBe(f.sha256);
    const wav = await readFile(join(out, "audition.wav")); expect(wav.length).toBe(44 + 32000 * 2); expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(JSON.parse(await readFile(join(out, "RESULT.json"), "utf8"))).toEqual(result);
  });
  it("handles actual thumbnail encoding from a single bounded serial RGBA decode", async () => {
    const video = join(folder, "montage.mp4"); await writeFile(video, "controlled rendered video");
    request.montage = { path: video, sha256: sha(await readFile(video)), sourceStartSeconds: 3 }; rasterHeight = 700;
    const result = await createBeatReviewContactSheetV1(request, out, { ffmpegPath: ffmpeg });
    expect(result.decodedReviewFrames).toBe(3); expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls[1][1].join(" ")).toContain("select='eq(n,14)+eq(n,15)+eq(n,16)'");
    expect(JSON.parse(await readFile(join(out, "plan.json"), "utf8")).frames[1].requestedVideoSeconds).toBe(3.5);
  });
  it.each(["music", "analysis", "tool"]) ("refuses changed %s bytes before any media or output", async kind => {
    await appendFile(kind === "music" ? music : kind === "analysis" ? cachePath : ffmpeg, "changed");
    await expect(createBeatReviewContactSheetV1(request, out, { ffmpegPath: ffmpeg })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled(); await expect(readFile(join(out, "RESULT.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["key", "receiptSha256"]) ("refuses forged cache %s even with a fresh input-file hash", async field => {
    cache[field] = "f".repeat(64); await rewriteCache();
    await expect(createBeatReviewContactSheetV1(request, out, { ffmpegPath: ffmpeg })).rejects.toThrow(/CACHE_DIGEST/); expect(run).not.toHaveBeenCalled();
  });
  it("refuses source coverage gaps instead of producing an attractive incomplete sheet", async () => {
    request.window = { sourceStartSeconds: 1, durationSeconds: 2 };
    await expect(createBeatReviewContactSheetV1(request, out, { ffmpegPath: ffmpeg })).rejects.toThrow(/NOT_COVERED/); expect(run).not.toHaveBeenCalled();
  });
  it("refuses unknown or insufficient output space", async () => {
    space.mockResolvedValueOnce(undefined as Awaited<ReturnType<typeof probeVolumeSpace>>);
    await expect(createBeatReviewContactSheetV1(request, out, { ffmpegPath: ffmpeg })).rejects.toThrow(/SPACE/);
    space.mockResolvedValueOnce({ availableBytes: 1 } as Awaited<ReturnType<typeof probeVolumeSpace>>);
    await expect(createBeatReviewContactSheetV1(request, out, { ffmpegPath: ffmpeg })).rejects.toThrow(/SPACE/); expect(run).not.toHaveBeenCalled();
  });
  it("preserves an existing output and never overwrites it", async () => {
    await mkdir(out); await writeFile(join(out, "keep.txt"), "keep");
    await expect(createBeatReviewContactSheetV1(request, out, { ffmpegPath: ffmpeg })).rejects.toThrow(/ALREADY_EXISTS/);
    expect(await readFile(join(out, "keep.txt"), "utf8")).toBe("keep"); expect(run).not.toHaveBeenCalled();
  });
  it.each(["music", "tool"]) ("refuses %s changed after media readout and leaves failure evidence", async kind => {
    run.mockImplementationOnce(async (...args) => { const result = await fakeMedia(...args); await appendFile(kind === "music" ? music : ffmpeg, "changed"); return result; });
    await expect(createBeatReviewContactSheetV1(request, out, { ffmpegPath: ffmpeg })).rejects.toThrow(/INPUT_CHANGED/);
    expect(JSON.parse(await readFile(join(out, "FAILURE.json"), "utf8")).status).toBe("FAILED_NOT_REVIEW_READY");
    await expect(readFile(join(out, "RESULT.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("does not publish a successful result for a partial PCM read", async () => {
    run.mockResolvedValueOnce({ stdout: Buffer.alloc(4), stderr: "" });
    await expect(createBeatReviewContactSheetV1(request, out, { ffmpegPath: ffmpeg })).rejects.toThrow(/PCM_SIZE/); expect(run).toHaveBeenCalledTimes(1);
    await expect(readFile(join(out, "RESULT.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("shares caller cancellation and snapshots its signal across asynchronous work", async () => {
    const controller = new AbortController(), runtime = { ffmpegPath: ffmpeg, signal: controller.signal };
    run.mockImplementationOnce(async (...args) => { const result = await fakeMedia(...args); runtime.signal = new AbortController().signal; controller.abort(); return result; });
    await expect(createBeatReviewContactSheetV1(request, out, runtime)).rejects.toThrow();
    await expect(readFile(join(out, "RESULT.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("starts no media for prior cancellation or an unsafe Windows source", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(createBeatReviewContactSheetV1(request, out, { ffmpegPath: ffmpeg, signal: controller.signal })).rejects.toThrow();
    if (process.platform === "win32") {
      request.music.path = "\\\\example.invalid\\share\\music.wav";
      await expect(createBeatReviewContactSheetV1(request, out, { ffmpegPath: ffmpeg })).rejects.toThrow(/網路共用/);
    }
    expect(run).not.toHaveBeenCalled();
  });
  it("catches modified output bytes before writing the final successful receipt", async () => {
    run.mockImplementation(async (...args) => { const result = await fakeMedia(...args);
      if (args[1].includes("image2pipe")) await appendFile(join(out, "review.svg"), "changed"); return result; });
    await expect(createBeatReviewContactSheetV1(request, out, { ffmpegPath: ffmpeg })).rejects.toThrow(/OUTPUT_CHANGED/);
    await expect(readFile(join(out, "RESULT.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("the real CLI reads the bounded request and invokes the same operation", async () => {
    const requestPath = join(folder, "request.json"); await writeFile(requestPath, JSON.stringify(request));
    const result = await runBeatReviewCliV1(["--request", requestPath, "--out", out, "--ffmpeg", ffmpeg]);
    expect(result.status).toBe("REVIEW_READY_NOT_APPROVED"); expect(run).toHaveBeenCalledTimes(2);
  });
});
