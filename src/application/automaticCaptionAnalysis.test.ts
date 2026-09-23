import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeAutomaticCaptionTranscript, transcribeAutomaticCaptions, parseWhisperRecognition,
  AutomaticCaptionParseError, EmptyAutomaticCaptionError, PINNED_WHISPER_MODEL,
  automaticCaptionRuntimeSha256,
  whisperCaptionSegmentation,
  type AutomaticCaptionAnalysisResult,
} from "./automaticCaptions";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const sha = (input: string) => createHash("sha256").update(input).digest("hex");
const korean = "1\n00:00:00,000 --> 00:00:01,000\n안녕하세요\n\n2\n00:00:01,000 --> 00:00:02,000\n(upbeat music)\n";

async function cachedFixture(raw = "\uFEFF\r\n", mutate?: (record: { schemaVersion: number; result: AutomaticCaptionAnalysisResult }) => void) {
  const root = await mkdtemp(join(tmpdir(), "editkin-empty-asr-cache-"));
  roots.push(root);
  const sourcePath = join(root, "source.wav");
  await writeFile(sourcePath, "cache-fixture-not-an-audio-inference");
  const request = { sourcePath, sourceSha256: sha("cache-fixture-not-an-audio-inference"), sourceStart: 0, duration: 3, language: "auto" };
  const runtime = { ffmpegPath: process.execPath, modelRoot: join(root, "models"), cacheRoot: root };
  const result: AutomaticCaptionAnalysisResult = {
    ...parseWhisperRecognition(raw, 3), engine: `whisper-cli-${PINNED_WHISPER_MODEL.id}`,
    modelId: PINNED_WHISPER_MODEL.id, modelSha256: PINNED_WHISPER_MODEL.sha256,
    language: "auto", analyzedSeconds: 3, elapsedMs: 1, modelDownloaded: false, cacheHit: false, acceleration: "cpu",
  };
  const identity = { schemaVersion: 6, segmentationPolicy: whisperCaptionSegmentation("auto"), source: request.sourceSha256, sourceStart: 0, duration: 3, language: "auto", translationTarget: undefined, modelSha256: PINNED_WHISPER_MODEL.sha256, runtimeSha256: await automaticCaptionRuntimeSha256(runtime) };
  const directory = join(root, "automatic-captions");
  await mkdir(directory);
  const record = { schemaVersion: 6, result };
  mutate?.(record);
  await writeFile(join(directory, `${sha(JSON.stringify(identity))}.json`), JSON.stringify(record));
  return { request, runtime, raw };
}

describe("successful recognition without usable captions", () => {
  it("retains exact empty bytes/hash and an unverified-audio interpretation", () => {
    const raw = "\uFEFF\r\n  \r\n";
    const result = parseWhisperRecognition(raw, 3);
    expect(result.cues).toEqual([]);
    expect(result.recognition).toEqual({ status: "empty", audioContent: "unverified", reason: "recognition-completed-without-usable-cues" });
    expect(result.rawTranscript).toEqual({ format: "srt", text: raw, sha256: sha(raw) });
  });

  it("preserves Korean and music-description cues without content-based hallucination filtering", () => {
    const result = parseWhisperRecognition(korean, 3);
    expect(result.cues.map((cue) => cue.text)).toEqual(["안녕하세요", "(upbeat music)"]);
    expect(result.recognition).toEqual({ status: "usable-cues", audioContent: "unverified" });
    expect(result.rawTranscript.text).toBe(korean);
  });

  it("retains excluded legacy exact markers as raw evidence, not proof of silence", () => {
    const raw = "1\n00:00:00,000 --> 00:00:01,000\n[silence]\n";
    const result = parseWhisperRecognition(raw, 3);
    expect(result.cues).toEqual([]);
    expect(result.rawTranscript.text).toBe(raw);
    expect(result.recognition.audioContent).toBe("unverified");
  });

  it.each([
    "not an SRT", "{\"transcription\":[]}", "1\n00:00:00,000 --> broken\nhello",
    "1\n00:61:00,000 --> 00:61:01,000\nhello", "1\n00:00:02,000 --> 00:00:01,000\nhello",
    "1\n00:00:00,000 --> 00:00:01,000\n", "1\n00:00:00,000 --> 00:00:01,000\nhello\n\nbroken tail",
    "oops\n00:00:00,000 --> 00:00:01,000\nhello",
  ])("rejects malformed nonempty output rather than certifying empty: %s", (raw) => {
    expect(() => parseWhisperRecognition(raw, 3)).toThrow(AutomaticCaptionParseError);
  });

  it("reads an empty analysis cache but the original caption API still throws a typed visible error", async () => {
    const { request, runtime, raw } = await cachedFixture();
    const result = await analyzeAutomaticCaptionTranscript(request, runtime);
    expect(result.cacheHit).toBe(true);
    expect(result.cues).toEqual([]);
    expect(result.rawTranscript.text).toBe(raw);
    await expect(transcribeAutomaticCaptions(request, runtime)).rejects.toBeInstanceOf(EmptyAutomaticCaptionError);
    await expect(transcribeAutomaticCaptions(request, runtime)).rejects.toMatchObject({ code: "AUTOMATIC_CAPTION_EMPTY", result: { cacheHit: true } });
  });

  it("keeps the original nonempty caption response shape and cues", async () => {
    const { request, runtime } = await cachedFixture(korean);
    const result = await transcribeAutomaticCaptions(request, runtime);
    expect(result.cues.map((cue) => cue.text)).toEqual(["안녕하세요", "(upbeat music)"]);
    expect(result).not.toHaveProperty("rawTranscript");
    expect(result).not.toHaveProperty("recognition");
  });

  it("does not return a valid old transcript after speech runtime configuration changes", async () => {
    const { request, runtime } = await cachedFixture(korean);
    expect((await analyzeAutomaticCaptionTranscript(request, runtime)).cacheHit).toBe(true);
    await expect(analyzeAutomaticCaptionTranscript(request, { ...runtime, whisperCliPath: join(runtime.modelRoot, "new-cli.exe") })).rejects.toThrow("無法確認自動字幕 runtime");
  });

  it.each([
    { sourceSha256: "f".repeat(64) }, { sourceStart: 1 }, { duration: 2 }, { language: "ko" },
  ])("does not reuse an empty cache across source/window/language identity: %j", async (patch) => {
    const { request, runtime } = await cachedFixture();
    await expect(analyzeAutomaticCaptionTranscript({ ...request, ...patch }, runtime)).rejects.toThrow("無法確認自動字幕 runtime");
  });

  it.each<[string, (record: { schemaVersion: number; result: AutomaticCaptionAnalysisResult }) => void]>([
    ["old cache schema", (r) => { r.schemaVersion = 3; }],
    ["missing raw", (r) => { delete (r.result as Partial<AutomaticCaptionAnalysisResult>).rawTranscript; }],
    ["wrong raw hash", (r) => { r.result.rawTranscript.sha256 = "0".repeat(64); }],
    ["malformed raw with matching hash", (r) => { r.result.rawTranscript.text = "not SRT"; r.result.rawTranscript.sha256 = sha("not SRT"); }],
    ["empty falsely labeled usable", (r) => { r.result.recognition = { status: "usable-cues", audioContent: "unverified" }; }],
    ["cues not derived from raw", (r) => { r.result.cues = [{ start: 0, end: 1, text: "invented" }]; }],
    ["missing empty reason", (r) => { delete r.result.recognition.reason; }],
    ["wrong language", (r) => { r.result.language = "zh"; }],
    ["wrong model", (r) => { r.result.modelSha256 = "0".repeat(64); }],
    ["wrong duration", (r) => { r.result.analyzedSeconds = 4; }],
    ["wrong translation target", (r) => { r.result.translationTarget = "en"; }],
    ["unexpected translation", (r) => { r.result.rawTranslation = r.result.rawTranscript; }],
  ])("does not turn an invalid cache into successful empty analysis: %s", async (_label, mutate) => {
    const { request, runtime } = await cachedFixture(undefined, mutate);
    // Node is intentionally not FFmpeg: a cache miss must hit the real runtime
    // capability failure, not download a model or return fake ready/empty.
    await expect(analyzeAutomaticCaptionTranscript(request, runtime)).rejects.toThrow("無法確認自動字幕 runtime");
  });
});
