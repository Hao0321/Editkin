import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { analyzeMusicBeatsV1, type MusicBeatsRuntimeV1 } from "./musicBeats";
import { runAnalysisProcess } from "./analysisProcess";
import { fixtureReceiptV1 } from "./musicBeats.fixture";
import { musicBeatsReceiptSchemaV1 } from "./musicBeatsTypesV1";
import { analyzeMusicBeatEnergySourceV1, musicBeatEnergyDecoderArgsV1 } from "./musicBeatEnergySourceV1";

vi.mock("./analysisProcess", () => ({ runAnalysisProcess: vi.fn() }));
vi.mock("./musicBeats", async original => ({ ...await original<typeof import("./musicBeats")>(), analyzeMusicBeatsV1: vi.fn() }));
const native = vi.mocked(analyzeMusicBeatsV1), run = vi.mocked(runAnalysisProcess), sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
let root: string, folder: string, runtime: MusicBeatsRuntimeV1, input: Record<string, any>, analysis: Awaited<ReturnType<typeof analyzeMusicBeatsV1>>;
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "music-energy-test-")); });
afterAll(async () => {
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("music-energy-test-")) throw Error("Unexpected owned test root");
  await rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  folder = await mkdtemp(join(root, "case-"));
  const sourcePath = join(folder, "source.wav"); await writeFile(sourcePath, "0123456789");
  runtime = { ffmpegPath: join(folder, "ffmpeg.exe"), ffprobePath: join(folder, "ffprobe.exe"), nativeCorePath: join(folder, "hao-core.exe"), cacheRoot: folder };
  for (const path of [runtime.ffmpegPath, runtime.ffprobePath, runtime.nativeCorePath]) await writeFile(path, path);
  const identity = async (path: string) => { const bytes = await readFile(path); return { sha256: sha(bytes), bytes: bytes.length }; };
  const source = await identity(sourcePath), ffmpeg = await identity(runtime.ffmpegPath), ffprobe = await identity(runtime.ffprobePath), core = await identity(runtime.nativeCorePath);
  const raw = fixtureReceiptV1(); raw.sourceSha256 = source.sha256; raw.ffmpegSha256 = ffmpeg.sha256;
  raw.pcmSha256 = sha(Buffer.from(new Float32Array(32000).fill(.25).buffer));
  raw.analysis.beats = [.25, .75, 1.25, 1.75].map(timeSeconds => ({ timeSeconds, confidence: .8, downbeat: false, downbeatConfidence: 0 }));
  analysis = { key: "a".repeat(64), receiptSha256: "b".repeat(64), binding: { schema: "editkin.music-beats-cache-key/v1", source, ffmpeg, ffprobe, core,
    sourceStartSeconds: 0, durationSeconds: 2, priorBpm: null, analysisRecipe: "spectral-flux-autocorrelation-dp-native/v1" },
    receipt: musicBeatsReceiptSchemaV1.parse(raw), cacheHit: false, elapsedMs: 1 };
  input = { sourcePath, sourceStartSeconds: 0, durationSeconds: 2, expectedSourceSha256: source.sha256 };
  native.mockReset(); native.mockResolvedValue(analysis); run.mockReset();
  run.mockImplementation(async (_exe, _args, options) => {
    options.signal?.throwIfAborted(); const samples = new Float32Array(32000).fill(.25), bytes = Buffer.from(samples.buffer);
    options.onStdout!(bytes.subarray(0, 3)); options.onStdout!(bytes.subarray(3)); return { stdout: Buffer.alloc(0), stderr: "" };
  });
});

describe("native-source beat level orchestration", () => {
  it("measures a bounded original-source stream with no PCM capture or project mutation", async () => {
    const result = await analyzeMusicBeatEnergySourceV1(input, runtime);
    expect(result).toMatchObject({ rmsDecodeCalls: 1, pcmCapturedOrStagedBytes: 0, projectEdits: 0, humanMusicalEnergyCertified: false });
    expect(result.energy.intervals.map(i => i.rms)).toEqual([.25, .25, .25]); expect(result.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(native).toHaveBeenCalledTimes(1); expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][2]).toMatchObject({ captureStdout: false, maximumStdout: 128000 });
    expect(run.mock.calls[0][1]).toContain(input.sourcePath);
    expect(native.mock.calls[0][1].signal).toBe(run.mock.calls[0][2].signal);
    expect(result.binding.sourceFilesRecheckedAfterDecode).toBe(true);
  });
  it("reports native cache reuse while measuring actual PCM, so style changes can reuse this small evidence", async () => {
    native.mockResolvedValue({ ...analysis, cacheHit: true });
    expect((await analyzeMusicBeatEnergySourceV1(input, runtime)).nativeCacheHit).toBe(true);
  });
  it.each(["source", "ffmpegPath", "ffprobePath", "nativeCorePath"]) ("refuses %s changed during decode", async kind => {
    const implementation = run.getMockImplementation()!;
    run.mockImplementation(async (...args) => { const r = await implementation(...args); await appendFile(kind === "source" ? input.sourcePath : runtime[kind as "ffmpegPath"], "changed"); return r; });
    await expect(analyzeMusicBeatEnergySourceV1(input, runtime)).rejects.toThrow(/CHANGED_AFTER_DECODE/);
  });
  it("snapshots request and runtime paths before awaiting native work", async () => {
    const original = runtime.ffmpegPath;
    native.mockImplementation(async () => { runtime.ffmpegPath = join(folder, "unrelated.exe"); input.sourcePath = "different.wav"; return analysis; });
    const result = await analyzeMusicBeatEnergySourceV1(input, runtime);
    expect(run.mock.calls[0][0]).toBe(original); expect(result.binding.request.sourcePath).not.toBe(input.sourcePath);
  });
  it("refuses wrong source SHA, prior cancellation or an overlong window before native work", async () => {
    await expect(analyzeMusicBeatEnergySourceV1({ ...input, expectedSourceSha256: "f".repeat(64) }, runtime)).rejects.toThrow(/SOURCE_SHA/);
    const controller = new AbortController(); controller.abort();
    await expect(analyzeMusicBeatEnergySourceV1(input, { ...runtime, signal: controller.signal })).rejects.toThrow();
    await expect(analyzeMusicBeatEnergySourceV1({ ...input, durationSeconds: 61 }, runtime)).rejects.toThrow();
    expect(native).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  });
  it("refuses partial, excess and unexpectedly captured PCM", async () => {
    run.mockResolvedValueOnce({ stdout: Buffer.alloc(0), stderr: "" }); await expect(analyzeMusicBeatEnergySourceV1(input, runtime)).rejects.toThrow(/INCOMPLETE/);
    run.mockImplementationOnce(async (_a, _b, options) => { options.onStdout!(Buffer.alloc(128001)); return { stdout: Buffer.alloc(0), stderr: "" }; });
    await expect(analyzeMusicBeatEnergySourceV1(input, runtime)).rejects.toThrow(/BYTE_BUDGET/);
    run.mockResolvedValueOnce({ stdout: Buffer.alloc(4), stderr: "" }); await expect(analyzeMusicBeatEnergySourceV1(input, runtime)).rejects.toThrow(/CAPTURE_FORBIDDEN/);
  });
  it("keeps cancellation attached to the captured caller signal", async () => {
    const controller = new AbortController(); runtime.signal = controller.signal;
    run.mockImplementationOnce(async (_a, _b, options) => { runtime.signal = new AbortController().signal; controller.abort(); options.signal?.throwIfAborted(); return { stdout: Buffer.alloc(0), stderr: "" }; });
    await expect(analyzeMusicBeatEnergySourceV1(input, runtime)).rejects.toThrow();
  });
  it("does not silently fall back when explicit refined pulses are absent", async () => {
    await expect(analyzeMusicBeatEnergySourceV1({ ...input, rhythmRefinementV2: true }, runtime)).rejects.toThrow(); expect(run).not.toHaveBeenCalled();
  });
  it("matches the native integer preroll, sample trim and media protocol whitelist", () => {
    const args = musicBeatEnergyDecoderArgsV1({ sourcePath: "D:/source.wav", sourceStartSeconds: 36000.25, durationSeconds: 3.75 });
    expect(args[args.indexOf("-ss") + 1]).toBe("35999");
    expect(args[args.indexOf("-af") + 1]).toBe("aresample=16000,aformat=sample_fmts=flt:channel_layouts=mono,atrim=start_sample=20000:end_sample=80000,asetpts=PTS-STARTPTS");
    expect(args[args.indexOf("-t") + 1]).toBe("3.750000000"); expect(args[args.indexOf("-protocol_whitelist") + 1]).toBe("file,pipe");
    expect(musicBeatEnergyDecoderArgsV1({ sourcePath: "D:/source.wav", sourceStartSeconds: 0, durationSeconds: 2 })).not.toContain("-ss");
  });
  it("rejects a different decoded PCM even with unchanged file bytes and tool identity", async () => {
    run.mockImplementationOnce(async (_a, _b, options) => { options.onStdout!(Buffer.from(new Float32Array(32000).fill(.2).buffer)); return { stdout: Buffer.alloc(0), stderr: "" }; });
    await expect(analyzeMusicBeatEnergySourceV1(input, runtime)).rejects.toThrow(/NATIVE_PCM_MISMATCH/);
  });
  it("keeps evidence identity stable when only pipe chunk boundaries change", async () => {
    const first = await analyzeMusicBeatEnergySourceV1(input, runtime);
    run.mockImplementationOnce(async (_a, _b, options) => {
      const b = Buffer.from(new Float32Array(32000).fill(.25).buffer);
      for (let n = 0; n < b.length; n += 4093) options.onStdout!(b.subarray(n, n + 4093));
      return { stdout: Buffer.alloc(0), stderr: "" };
    });
    const second = await analyzeMusicBeatEnergySourceV1(input, runtime);
    expect(second.energy.inputChunks).not.toBe(first.energy.inputChunks); expect(second.evidenceSha256).toBe(first.evidenceSha256);
  });
});
