import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { createDemoProject } from "../domain/demo";
const control = vi.hoisted(() => ({ probe: vi.fn(), render: vi.fn(), implementation: vi.fn(), audio: 0 }));
vi.mock("./mediaProcess", async () => ({ ...await vi.importActual<typeof import("./mediaProcess")>("./mediaProcess"), runProcess: control.probe }));
vi.mock("./timeRemapCacheIdentityV1", async () => ({ ...await vi.importActual<typeof import("./timeRemapCacheIdentityV1")>("./timeRemapCacheIdentityV1"), timeRemapCacheImplementationV1: control.implementation }));
vi.mock("./timeRemapSourceRenderV1", () => ({ renderTimeRemapSourceProjectV1: control.render,
  SOURCE_CLOCK_RENDER_POLICY_V1: "controlled-video-policy", SOURCE_CLOCK_SHARED_PHASE_PCM_POLICY_V3: "controlled-phase-policy" }));
import { getTimeRemapRenderCacheV1, retireTimeRemapRenderCacheV1, type TimeRemapCacheRuntimeV1 } from "./timeRemapCacheServiceV1";
import { TIME_REMAP_CACHE_POLICY_V1 } from "./timeRemapCacheContractV1";
import { timeRemapCacheRootV1 } from "./timeRemapCacheStoreV1";
import { ownedTreeBytesV2 } from "./longRenderGuardV2";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const temp = resolve(process.env.TEMP!); let root: string, runtime: TimeRemapCacheRuntimeV1, input: Parameters<typeof getTimeRemapRenderCacheV1>[0];
beforeEach(async () => {
  vi.clearAllMocks(); control.audio = 0; control.implementation.mockResolvedValue("f".repeat(64));
  root = await mkdtemp(join(temp, "tm-cache-service-"));
  const source = join(root, "source.mkv"), tools = [join(root, "ffmpeg.exe"), join(root, "ffprobe.exe")];
  await writeFile(source, "controlled-source-contract"); for (const p of tools) await writeFile(p, "controlled-tool");
  const p = createDemoProject(); p.width = 64; p.height = 40; p.fps = 8; p.assets[0].uri = source; p.assets[0].duration = 4; p.assets[0].width = 64; p.assets[0].height = 40;
  p.tracks[0].clips[0].duration = 2; p.tracks[0].clips[0].speed = 1;
  input = { project: p, clipId: "clip-demo", projectRoot: root, expectedSourceSha256: sha(await readFile(source)) };
  runtime = { policy: TIME_REMAP_CACHE_POLICY_V1, ffmpegPath: tools[0], ffprobePath: tools[1], helperTemporaryRoot: temp, maximumStoredBytes: 16 * 1024 ** 2, timeoutMs: 5000 };
  control.probe.mockImplementation(async () => ({ stdout: JSON.stringify({ streams: [{ codec_type: "video", width: 64, height: 40, sample_aspect_ratio: "1:1", pix_fmt: "bgra", color_transfer: "bt709", color_primaries: "bt709" }, ...Array.from({ length: control.audio }, () => ({ codec_type: "audio" }))] }), stderr: "" }));
  // Controlled producer contract, not a codec/quality measurement. Actual FFmpeg runs are separate.
  control.render.mockImplementation(async (stage, path, options) => {
    const sourceBytes = await readFile(stage.assets[0].uri);
    if (sha(sourceBytes) !== options.expectedSourceSha256) throw Error("CURVE_RENDER_SOURCE_SHA_MISMATCH");
    const payload = Buffer.from(JSON.stringify(stage.tracks[0].clips[0])), frames = Math.round(stage.fps * stage.tracks[0].clips[0].duration);
    await writeFile(path, payload, { flag: "wx" }); await options.onOwnedPath?.(path, "file");
    await options.onFrame?.({ index: 0, bytes: Buffer.alloc(64 * 40 * 4) }); options.signal?.throwIfAborted();
    const pixels = sha(Buffer.alloc(frames * 64 * 40 * 4)), audio = options.policy === "controlled-phase-policy" ? "shared_phase_constant_pcm_f32_candidate" : control.audio ? "explicitly_muted" : "absent";
    return { schema: "editkin.source-clock-render/v1", outputPath: path, outputSha256: sha(payload), bytes: payload.length,
      frames, duration: stage.tracks[0].clips[0].duration, sampledPixelSha256: pixels, outputPixels: { sha256: pixels, bytes: frames * 64 * 40 * 4, frames, complete: true }, originalAudio: audio,
      rawMoviePixelsStaged: 0, sceneLinearHdrReady: false, ordinaryEditorPreviewReady: false, wholePixelQualityCertified: false, audioQualityCertified: false };
  });
});
afterEach(async () => { if (!root.startsWith(temp + sep)) throw Error("test cleanup outside owned root"); await rm(root, { recursive: true }); });
describe("cache lifecycle with a controlled source-render contract", () => {
  it("publishes once, reuses without another encode, pins consumers and retires only after release", async () => {
    const before = structuredClone(input.project), a = await getTimeRemapRenderCacheV1(input, runtime), b = await getTimeRemapRenderCacheV1(input, runtime);
    expect(a.cacheHit).toBe(false); expect(b.cacheHit).toBe(true); expect(control.render).toHaveBeenCalledTimes(1); expect(input.project).toEqual(before);
    await expect(retireTimeRemapRenderCacheV1(root, temp, a.receipt.key)).rejects.toThrow("PINNED");
    await a.release(); await expect(retireTimeRemapRenderCacheV1(root, temp, a.receipt.key)).rejects.toThrow("PINNED"); await b.release();
    expect(await retireTimeRemapRenderCacheV1(root, temp, a.receipt.key)).toMatchObject({ retired: true, bytes: a.receipt.media.bytes });
    const names = await readdir(a.root); expect(names.some(n => n.startsWith(".build-") || n.includes(".pin-") || n.endsWith(".jsonl") || n === ".producer.lock")).toBe(false);
  });
  it.each(["source", "media", "partial", "receipt"])("refuses %s drift instead of silently rebuilding or serving it", async kind => {
    const a = await getTimeRemapRenderCacheV1(input, runtime); await a.release();
    if (kind === "source") await writeFile(input.project.assets[0].uri, "controlled-source-modified-longer");
    if (kind === "media") await writeFile(a.mediaPath, "changed-media");
    if (kind === "partial") await unlink(join(a.root, a.receipt.key, "receipt.json"));
    if (kind === "receipt") { const path = join(a.root, a.receipt.key, "receipt.json"), value = JSON.parse(await readFile(path, "utf8")); value.ordinaryEditorPreviewReady = true; await writeFile(path, JSON.stringify(value)); }
    await expect(getTimeRemapRenderCacheV1(input, runtime)).rejects.toThrow(); expect(control.render).toHaveBeenCalledTimes(1);
  });
  it.each(["code", "tool", "window", "fps"])("does not reuse a cache across %s changes", async kind => {
    const a = await getTimeRemapRenderCacheV1(input, runtime); await a.release();
    if (kind === "code") control.implementation.mockResolvedValue("e".repeat(64));
    if (kind === "tool") await writeFile(runtime.ffmpegPath, "changed-longer-tool");
    if (kind === "window") input.project.tracks[0].clips[0].sourceStart = .25;
    if (kind === "fps") input.project.fps = 4;
    const b = await getTimeRemapRenderCacheV1(input, runtime); expect(b.cacheHit).toBe(false); expect(b.receipt.key).not.toBe(a.receipt.key); await b.release();
  });
  it("uses the existing shared-phase PCM contract for constant audio without changing user volume", async () => {
    control.audio = 1; const clip = input.project.tracks[0].clips[0]; clip.speed = 2; clip.volume = .6;
    const a = await getTimeRemapRenderCacheV1(input, runtime);
    expect(a.receipt.audio).toBe("shared_phase_constant_pcm_f32_candidate"); expect(a.receipt.audioQualityCertified).toBe(false);
    expect(control.render.mock.calls[0][0].tracks[0].clips[0].volume).toBe(1); expect(clip.volume).toBe(.6); await a.release();
  });
  it("refuses nonlinear follow-audio instead of muting it", async () => {
    control.audio = 1; const c = input.project.tracks[0].clips[0]; c.timeRemap = { schema: "editkin.clip-time-remap/v1", direction: "forward", interpolation: "frame_blending", audioMode: "follow_speed",
      segments: [{ from: { time: 0, speed: 1 }, control1: { time: 1 / 3, speed: .25 }, control2: { time: 2 / 3, speed: .25 }, to: { time: 1, speed: 1 } }] };
    await expect(getTimeRemapRenderCacheV1(input, runtime)).rejects.toThrow("FOLLOW_AUDIO_REQUIRES_DSP"); expect(control.render).not.toHaveBeenCalled();
  });
  it("stops before a producer on an unknown/short volume", async () => {
    await expect(getTimeRemapRenderCacheV1(input, { ...runtime, volumeProbe: async () => undefined })).rejects.toMatchObject({ code: "LONG_RENDER_VOLUME_UNKNOWN" });
    expect(control.render).not.toHaveBeenCalled();
    await expect(getTimeRemapRenderCacheV1(input, { ...runtime, volumeProbe: async () => ({ key: "short", root, availableBytes: 100 }) })).rejects.toMatchObject({ code: "LONG_RENDER_SPACE_SHORT" });
    expect(control.render).not.toHaveBeenCalled();
  });
  it("respects a full project quota without deleting unknown user content", async () => {
    const cache = await timeRemapCacheRootV1(root, temp), path = join(cache, "keep-user-file"); await writeFile(path, Buffer.alloc(2 * 1024 ** 2, 7));
    await expect(getTimeRemapRenderCacheV1(input, { ...runtime, maximumStoredBytes: 1024 ** 2 })).rejects.toThrow("QUOTA_FULL");
    expect(control.render).not.toHaveBeenCalled(); expect((await readFile(path))[0]).toBe(7);
  });
  it("retains completed unpinned caches under a full quota when the eviction policy is omitted", async () => {
    const old = await getTimeRemapRenderCacheV1(input, runtime); await old.release(); const used = await ownedTreeBytesV2([old.root]);
    input.project.tracks[0].clips[0].sourceStart = .25;
    await expect(getTimeRemapRenderCacheV1(input, { ...runtime, maximumStoredBytes: used + 2 * 1024 ** 2 })).rejects.toThrow("QUOTA_FULL");
    expect((await readFile(old.mediaPath)).length).toBe(old.receipt.media.bytes); expect(control.render).toHaveBeenCalledTimes(1);
  });
  it("refuses unknown eviction policy before creating a cache or launching a tool", async () => {
    await expect(getTimeRemapRenderCacheV1(input, { ...runtime, cacheEvictionPolicy: "unknown" as TimeRemapCacheRuntimeV1["cacheEvictionPolicy"] })).rejects.toThrow("EVICTION_POLICY_INVALID");
    expect(control.probe).not.toHaveBeenCalled(); expect(control.render).not.toHaveBeenCalled(); expect((await readdir(root)).includes(".editkin")).toBe(false);
  });
  it("keeps the actual capacity receipt if a host observer fails after successful reclamation", async () => {
    const old = await getTimeRemapRenderCacheV1(input, runtime); await old.release(); const used = await ownedTreeBytesV2([old.root]);
    input.project.tracks[0].clips[0].sourceStart = .25; const project = structuredClone(input.project);
    let failure: unknown;
    try { await getTimeRemapRenderCacheV1(input, { ...runtime, maximumStoredBytes: used + 2 * 1024 ** 2, cacheEvictionPolicy: "owned-oldest/v1", onCacheCapacity: () => { throw Error("host observer failed"); } }); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ message: "TIME_REMAP_CACHE_CAPACITY_OBSERVER_FAILED", receipt: { state: "complete", retired: [{ key: old.receipt.key, bytes: expect.any(Number) }] } });
    expect(await readFile(old.mediaPath).catch(() => undefined)).toBeUndefined(); expect(control.render).toHaveBeenCalledTimes(1); expect(input.project).toEqual(project);
  });
  it.each(["cancel", "stale", "observer"])("does not publish after %s and cleans its exact partial work", async kind => {
    const abort = new AbortController(), cache = await timeRemapCacheRootV1(root, temp);
    await expect(getTimeRemapRenderCacheV1(input, { ...runtime, signal: abort.signal, onFrame: () => {
      if (kind === "cancel") abort.abort(); if (kind === "stale") input.project.name = "changed during work"; if (kind === "observer") throw Error("observer failed");
    } })).rejects.toThrow();
    const names = await readdir(cache); expect(names.some(n => /^[a-f0-9]{64}$/.test(n) || n.startsWith(".build-") || n.includes(".pin-") || n.endsWith(".jsonl") || n === ".producer.lock")).toBe(false);
  });
});
