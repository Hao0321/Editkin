import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeAutomaticCaptionTranscript, parseWhisperRecognition, AutomaticCaptionParseError, PINNED_WHISPER_MODEL } from "./automaticCaptions";
import { compactMaterialContext, MATERIAL_INTELLIGENCE_SCHEMA, prepareMaterialIntelligence } from "./materialIntelligence";

vi.mock("./automaticCaptions", async (importOriginal) => ({ ...await importOriginal<typeof import("./automaticCaptions")>(), analyzeAutomaticCaptionTranscript: vi.fn() }));
vi.mock("./inspectMedia", () => ({ inspectMedia: vi.fn(async () => ({ duration: 3, hasAudio: true, hasVideo: false })) }));
// Each case performs real cache writes and cleanup; parallel decode suites can
// exceed Vitest's 5 s default before these serial fixture steps finish.
vi.setConfig({ testTimeout: 30_000 });
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
beforeEach(() => vi.mocked(analyzeAutomaticCaptionTranscript).mockReset());
const sha = (input: string) => createHash("sha256").update(input).digest("hex");

async function fixture(raw = "") {
  const root = await mkdtemp(join(tmpdir(), "editkin-material-transcript-"));
  roots.push(root);
  const sourcePath = join(root, "fixture.wav");
  await writeFile(sourcePath, "memory-asr-fixture");
  const request = { assetId: "asset", clipId: "clip", sourcePath, sourceSha256: sha("memory-asr-fixture"), sourceStart: 0, duration: 3, fps: 30, kind: "audio" as const };
  const runtime = { ffmpegPath: process.execPath, modelRoot: root, cacheRoot: root };
  vi.mocked(analyzeAutomaticCaptionTranscript).mockResolvedValue({
    ...parseWhisperRecognition(raw, 3), engine: "fixture-successful-asr", modelId: PINNED_WHISPER_MODEL.id, modelSha256: PINNED_WHISPER_MODEL.sha256,
    language: "auto", analyzedSeconds: 3, elapsedMs: 1, modelDownloaded: false, cacheHit: false, acceleration: "cpu",
  });
  return { root, request, runtime };
}

describe("material transcript outcome integration (memory ASR/probe, real cache)", () => {
  it("required job analysis rejects failure without publishing a blocked cache, then can retry", async () => {
    const { request, runtime } = await fixture("1\n00:00:00,000 --> 00:00:01,000\nRecovered");
    vi.mocked(analyzeAutomaticCaptionTranscript).mockRejectedValueOnce(Error("window timeout"));
    const required = { ...runtime, requireTranscriptCompletion: true };
    await expect(prepareMaterialIntelligence(request, required)).rejects.toThrow("window timeout");
    const recovered = await prepareMaterialIntelligence(request, required);
    expect(recovered.cacheHit).toBe(false);
    expect(recovered.packet.analysis.transcript.state).toBe("ready");
    expect(recovered.packet.cache?.identity.transcriptPolicy).toBe("required");
    expect((await prepareMaterialIntelligence(request, required)).cacheHit).toBe(true);
    expect(analyzeAutomaticCaptionTranscript).toHaveBeenCalledTimes(2);
  });

  it("does not publish a truncated 2001-cue transcript as ready", async () => {
    const { request, runtime } = await fixture();
    const raw = Array.from({ length: 2001 }, (_, index) => `${index + 1}\n00:00:00,000 --> 00:00:01,000\nWord`).join("\n\n");
    vi.mocked(analyzeAutomaticCaptionTranscript).mockResolvedValue({
      ...parseWhisperRecognition(raw, 3), modelId: PINNED_WHISPER_MODEL.id, modelSha256: PINNED_WHISPER_MODEL.sha256,
      language: "auto", engine: "test-only", analyzedSeconds: 3, elapsedMs: 1, modelDownloaded: false, cacheHit: false, acceleration: "cpu",
    });
    await expect(prepareMaterialIntelligence(request, { ...runtime, requireTranscriptCompletion: true })).rejects.toThrow("超過 2000");
  });

  it.each(["configured", "installed", "binary-replaced", "library-replaced", "model-repaired"])("recovers blocked speech after dependency repair: %s", async (change) => {
    const { root, request, runtime } = await fixture("1\n00:00:00,000 --> 00:00:01,000\n對戰開始");
    const cli = join(root, "whisper-cli.exe"), library = join(root, "whisper.dll"), model = join(root, "model.bin");
    if (change !== "installed") await writeFile(cli, "old-cli");
    await writeFile(library, "old-lib");
    await writeFile(model, "old-model");
    const before = { ...runtime, whisperCliPath: change === "configured" ? undefined : cli, modelPath: model };
    vi.mocked(analyzeAutomaticCaptionTranscript).mockRejectedValueOnce(new Error("speech dependency unavailable"));
    const blocked = await prepareMaterialIntelligence(request, before);
    const manifest = join(root, "material-intelligence", blocked.packet.materialId, "manifest.json");
    const oldBytes = await readFile(manifest, "utf8");
    expect(blocked.packet.analysis.transcript.state).toBe("blocked");
    expect((await prepareMaterialIntelligence(request, before)).cacheHit).toBe(true);
    expect(analyzeAutomaticCaptionTranscript).toHaveBeenCalledTimes(1);
    if (change === "installed" || change === "binary-replaced") await writeFile(cli, "new-cli");
    if (change === "library-replaced") await writeFile(library, "new-lib");
    if (change === "model-repaired") await writeFile(model, "new-model");
    const after = { ...before, whisperCliPath: cli };
    const recovered = await prepareMaterialIntelligence(request, after);
    expect(recovered.cacheHit).toBe(false);
    expect(recovered.packet.materialId).not.toBe(blocked.packet.materialId);
    expect(recovered.packet.analysis.transcript).toMatchObject({ state: "ready", cueCount: 1 });
    expect(analyzeAutomaticCaptionTranscript).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ whisperCliPath: cli }));
    expect((await prepareMaterialIntelligence(request, after)).cacheHit).toBe(true);
    expect(analyzeAutomaticCaptionTranscript).toHaveBeenCalledTimes(2);
    expect(await readFile(manifest, "utf8")).toBe(oldBytes);
  });

  it("does not inspect or run speech dependencies when transcription is disabled", async () => {
    const { root, request, runtime } = await fixture();
    const unused = { ...runtime, whisperCliPath: root, modelPath: root };
    const first = await prepareMaterialIntelligence({ ...request, includeTranscript: false }, unused);
    expect(first.packet.analysis.transcript.state).toBe("not_applicable");
    expect(analyzeAutomaticCaptionTranscript).not.toHaveBeenCalled();
    expect((await prepareMaterialIntelligence({ ...request, includeTranscript: false }, runtime)).cacheHit).toBe(true);
  });

  it("is ready with empty recognition, retains raw evidence and a bounded honest context", async () => {
    const raw = "\uFEFF\r\n";
    const { request, runtime } = await fixture(raw);
    const first = await prepareMaterialIntelligence(request, runtime);
    expect(first.cacheHit).toBe(false);
    expect(first.packet.analysis.transcript).toMatchObject({ state: "ready", cueCount: 0, cues: [], recognition: { status: "empty", audioContent: "unverified" }, rawTranscript: { text: raw, sha256: sha(raw) } });
    const context = compactMaterialContext(first.packet, 0, 3, 10);
    expect(context.transcript.reason).toContain("不代表素材沒有語音");
    expect(context.transcript.rawTranscriptSha256).toBe(sha(raw));
    expect(context.transcript).not.toHaveProperty("rawTranscript");
    expect(compactMaterialContext(first.packet, 0, 3, 10, { maxTokens: 200 }).budget.estimatedTokens).toBeLessThanOrEqual(200);
    const warm = await prepareMaterialIntelligence(request, runtime);
    expect(warm.cacheHit).toBe(true);
    expect(warm.packet).toEqual(first.packet);
    expect(analyzeAutomaticCaptionTranscript).toHaveBeenCalledTimes(1);
  });

  it("preserves recognized Korean/music descriptions while leaving their audio semantics unverified", async () => {
    const { request, runtime } = await fixture("1\n00:00:00,000 --> 00:00:01,000\n안녕하세요\n\n2\n00:00:01,000 --> 00:00:02,000\n(upbeat music)");
    const { packet } = await prepareMaterialIntelligence(request, runtime);
    expect(packet.analysis.transcript.cues.map((cue) => cue.text)).toEqual(["안녕하세요", "(upbeat music)"]);
    expect(packet.analysis.transcript.recognition).toEqual({ status: "usable-cues", audioContent: "unverified" });
  });

  it("keeps valid transcript evidence when visual runtime is unavailable, without claiming usable images", async () => {
    const { request, runtime } = await fixture("1\n00:00:00,000 --> 00:00:01,000\n真實辨識內容");
    // Memory ASR/probe only. process.execPath is intentionally not an FFmpeg runtime.
    const { packet } = await prepareMaterialIntelligence({ ...request, kind: "video" }, runtime);
    expect(packet.analysis.transcript.state).toBe("ready");
    expect(packet.analysis.transcript.cues[0].text).toBe("真實辨識內容");
    expect(packet.analysis.keyframes?.state).toBe("blocked");
    expect(packet.analysis.keyframes?.omitted.length).toBeGreaterThan(0);
    expect(packet.keyframes).toEqual([]);
  });

  it.each([new Error("model SHA-256 mismatch"), new Error("decode failed"), new Error("process exit 1"), new Error("output ENOENT"), new AutomaticCaptionParseError(1)])("keeps true recognition errors blocked: %s", async (error) => {
    const { request, runtime } = await fixture();
    vi.mocked(analyzeAutomaticCaptionTranscript).mockRejectedValueOnce(error);
    const { packet } = await prepareMaterialIntelligence(request, runtime);
    expect(packet.analysis.transcript).toEqual({ state: "blocked", cueCount: 0, cues: [], reason: error.message });
  });

  it("invalidates revision-1 blocked material without changing its old manifest", async () => {
    const { root, request, runtime } = await fixture();
    const identity = { schema: MATERIAL_INTELLIGENCE_SCHEMA, sourceSha256: request.sourceSha256, sourceStart: 0, duration: 3, fps: 30, kind: "audio", language: "auto", includeTranscript: true, maxKeyframes: 8, engineRevision: 1 };
    const oldId = sha(JSON.stringify(identity));
    const oldPath = join(root, "material-intelligence", oldId, "manifest.json");
    await mkdir(join(root, "material-intelligence", oldId), { recursive: true });
    const oldBytes = JSON.stringify({ schema: MATERIAL_INTELLIGENCE_SCHEMA, materialId: oldId, source: { sourceSha256: request.sourceSha256 }, analysis: { transcript: { state: "blocked", cueCount: 0, cues: [], reason: "old empty error" } }, keyframes: [] });
    await writeFile(oldPath, oldBytes);
    const result = await prepareMaterialIntelligence(request, runtime);
    expect(result.cacheHit).toBe(false);
    expect(result.packet.cache?.identity.engineRevision).toBe(4);
    expect(result.packet.materialId).toBe(sha(JSON.stringify(result.packet.cache?.identity)));
    expect(result.packet.materialId).not.toBe(oldId);
    expect(result.packet.analysis.transcript.state).toBe("ready");
    expect(await readFile(oldPath, "utf8")).toBe(oldBytes);
  });
});
