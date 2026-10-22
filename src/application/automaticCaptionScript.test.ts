import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Fake recognizer: every analysis process is answered in-process. whisper-cli writes
 * the SRT chosen by the test; no FFmpeg, whisper.cpp or model download runs. */
const fake = vi.hoisted(() => ({ srt: "", whisperRuns: 0 }));
vi.mock("./analysisProcess", () => ({
  runAnalysisProcess: vi.fn(async (_executable: string, args: string[]) => {
    if (args.includes("-filters")) return { stdout: Buffer.from(" ... anull A->A Pass the source unchanged.\n"), stderr: "" };
    if (args.includes("--help")) return { stdout: Buffer.from("  -l LANG, --language LANG\n  -osrt, --output-srt\n  -tr, --translate\n"), stderr: "" };
    const prefix = args.indexOf("-of");
    if (prefix >= 0) {
      fake.whisperRuns += 1;
      const { writeFile: write } = await import("node:fs/promises");
      await write(`${args[prefix + 1]}.srt`, fake.srt, "utf8");
    }
    return { stdout: Buffer.alloc(0), stderr: "" };
  }),
}));
vi.mock("./whisperPinnedDownloadV1", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./whisperPinnedDownloadV1")>()),
  ensurePinnedModelFileV1: vi.fn(async (runtime: { modelRoot: string; modelPath?: string }) => ({ path: runtime.modelPath ?? `${runtime.modelRoot}/fake-medium.bin`, downloaded: false })),
}));

import { AUTOMATIC_CAPTION_CACHE_SCHEMA, analyzeAutomaticCaptionTranscript, transcribeAutomaticCaptions, type AutomaticCaptionRequest } from "./automaticCaptions";
import { captionScriptTarget, convertCaptionCuesScript, convertCaptionTextToTaiwan, isChineseCaptionLanguage, looksLikeChineseCaptionText } from "./captionScriptConversion";

const sha = (input: string) => createHash("sha256").update(input, "utf8").digest("hex");
const srt = (...lines: string[]) => lines.map((text, index) => `${index + 1}\n00:00:0${index},000 --> 00:00:0${index},900\n${text}\n`).join("\n");
const cue = (text: string, start = 0) => ({ start, end: start + 1, text });

describe("caption script conversion (OpenCC s2twp)", () => {
  it("converts Simplified Mandarin to Taiwan Traditional phrasing", () => {
    expect(convertCaptionTextToTaiwan("软件")).toBe("軟體");
    expect(convertCaptionTextToTaiwan("视频")).toBe("影片");
    expect(convertCaptionTextToTaiwan("信息")).toBe("資訊");
    expect(convertCaptionTextToTaiwan("这个软件的视频信息很有用")).toBe("這個軟體的影片資訊很有用");
  });

  it("keeps already-Traditional text unchanged, including everyday 台", () => {
    for (const text of ["我們今天去台北吃牛肉麵，軟體也很好用。", "這支影片的資訊很有用，記得按讚、訂閱！", "這台相機在平台上很熱門，電視台也報導了。", "皇后在這裡，頭髮很長。"]) {
      expect(convertCaptionTextToTaiwan(text)).toBe(text);
    }
  });

  it("keeps 台 where s2twp would only write 臺, but keeps phrase conversions such as 颱風", () => {
    expect(convertCaptionTextToTaiwan("台湾的台风")).toBe("台灣的颱風");
    expect(convertCaptionTextToTaiwan("这台电脑的内存")).toBe("這台電腦的記憶體");
  });

  it("does not touch ASCII, punctuation or numbers", () => {
    const text = "Hello World! “quoted” 'x' 1,234.5% ~ (music)";
    expect(convertCaptionTextToTaiwan(text)).toBe(text);
  });

  it("converts requested Chinese and Chinese detected under auto; records s2twp", () => {
    for (const language of ["zh", "zh-tw", "zh-hant", "auto"]) {
      const result = convertCaptionCuesScript([cue("我们用软件剪视频"), cue("信息很多", 1)], language, "zh-TW");
      expect(result.cues.map((item) => item.text)).toEqual(["我們用軟體剪影片", "資訊很多"]);
      expect(result.scriptConversion).toBe("s2twp");
    }
  });

  it("leaves Japanese with kanji and kana unchanged, including kanji-only lines", () => {
    const cues = [cue("日本語のテキストです。"), cue("東京大学", 1), cue("会社に行きます", 2)];
    for (const language of ["auto", "ja"]) {
      const result = convertCaptionCuesScript(cues, language, "zh-TW");
      expect(result.cues).toEqual(cues);
      expect(result.scriptConversion).toBeUndefined();
    }
  });

  it("leaves Korean (with or without hanja) unchanged", () => {
    const cues = [cue("안녕하세요 学校"), cue("감사합니다", 1)];
    for (const language of ["auto", "ko"]) {
      const result = convertCaptionCuesScript(cues, language, "zh-TW");
      expect(result.cues).toEqual(cues);
      expect(result.scriptConversion).toBeUndefined();
    }
  });

  it("never converts a kana/hangul line, even inside a Chinese transcript", () => {
    const result = convertCaptionCuesScript([cue("我们去看视频"), cue("这个软件很好用", 1), cue("我们下次见", 2), cue("ご視聴ありがとうございました", 3)], "auto", "zh-TW");
    expect(result.cues.map((item) => item.text)).toEqual(["我們去看影片", "這個軟體很好用", "我們下次見", "ご視聴ありがとうございました"]);
    expect(result.scriptConversion).toBe("s2twp");
  });

  it("does not convert other languages, or English with a stray Han term under auto", () => {
    const english = [cue("The word 软件 means software in Chinese")];
    expect(convertCaptionCuesScript(english, "auto", "zh-TW")).toEqual({ cues: english });
    expect(convertCaptionCuesScript([cue("软件")], "en", "zh-TW")).toEqual({ cues: [cue("软件")] });
    expect(looksLikeChineseCaptionText(["我們用Claude Code寫Editkin的MCP server"])).toBe(true);
    expect(looksLikeChineseCaptionText(["(upbeat music)"])).toBe(false);
  });

  it("opts out with script original", () => {
    const cues = [cue("软件视频信息")];
    expect(convertCaptionCuesScript(cues, "zh", "original")).toEqual({ cues });
  });

  it("does not touch English translation lines", () => {
    const result = convertCaptionCuesScript([{ ...cue("软件"), translation: { text: "software", language: "en" as const } }], "auto", "zh-TW");
    expect(result.cues).toEqual([{ ...cue("軟體"), translation: { text: "software", language: "en" } }]);
  });

  it("validates the script field and the Chinese language test", () => {
    expect(captionScriptTarget(undefined)).toBe("zh-TW");
    expect(captionScriptTarget("original")).toBe("original");
    expect(() => captionScriptTarget("zh-CN")).toThrow("zh-TW 或 original");
    expect(["zh", "zh-tw", "ZH-Hant", "cmn"].map(isChineseCaptionLanguage)).toEqual([true, true, true, true]);
    expect(["ja", "ko", "en", "auto", "zha"].map(isChineseCaptionLanguage)).toEqual([false, false, false, false, false]);
  });

  it("bumps the caption cache schema to 7", () => {
    expect(AUTOMATIC_CAPTION_CACHE_SCHEMA).toBe(7);
  });
});

describe("analyzeAutomaticCaptionTranscript with a fake recognizer", () => {
  const roots: string[] = [];
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

  async function fixture(duration = 3) {
    const root = await mkdtemp(join(tmpdir(), "editkin-caption-script-"));
    roots.push(root);
    const sourcePath = join(root, "source.wav"), ffmpegPath = join(root, "bin", "ffmpeg.exe"), whisperCliPath = join(root, "cli", "whisper-cli.exe");
    await mkdir(join(root, "bin")); await mkdir(join(root, "cli"));
    await writeFile(sourcePath, "fake-audio"); await writeFile(ffmpegPath, "fake-ffmpeg"); await writeFile(whisperCliPath, "fake-cli");
    const request: AutomaticCaptionRequest = { sourcePath, sourceStart: 0, duration, sourceSha256: sha("fake-audio"), language: "auto", whisperModel: "medium" };
    const runtime = { ffmpegPath, whisperCliPath, modelRoot: join(root, "models"), cacheRoot: join(root, "cache"), signal: new AbortController().signal };
    return { root, request, runtime };
  }

  it("converts Simplified cues to Taiwan Traditional, keeps rawTranscript verbatim and caches schema 7", async () => {
    const { root, request, runtime } = await fixture();
    fake.srt = srt("这个软件可以剪视频", "信息都在这里");
    fake.whisperRuns = 0;
    const first = await analyzeAutomaticCaptionTranscript(request, runtime);
    expect(first.cues.map((item) => item.text)).toEqual(["這個軟體可以剪影片", "資訊都在這裡"]);
    expect(first.scriptConversion).toBe("s2twp");
    expect(first.language).toBe("auto");
    expect(first.rawTranscript).toEqual({ format: "srt", text: fake.srt, sha256: sha(fake.srt) });
    expect(first.cacheHit).toBe(false);

    const files = await readdir(join(root, "cache", "automatic-captions"));
    expect(files).toHaveLength(1);
    const record = JSON.parse(await readFile(join(root, "cache", "automatic-captions", files[0]), "utf8"));
    expect(record.schemaVersion).toBe(7);
    expect(record.result.rawTranscript.text).toBe(fake.srt);
    expect(record.result.cues.map((item: { text: string }) => item.text)).toEqual(["這個軟體可以剪影片", "資訊都在這裡"]);

    const second = await analyzeAutomaticCaptionTranscript(request, runtime);
    expect(second.cacheHit).toBe(true);
    expect(second.cues).toEqual(first.cues);
    expect(second.scriptConversion).toBe("s2twp");
    expect(fake.whisperRuns).toBe(1);

    const captions = await transcribeAutomaticCaptions(request, runtime);
    expect(captions.cues.map((item) => item.text)).toEqual(["這個軟體可以剪影片", "資訊都在這裡"]);
    expect(captions.scriptConversion).toBe("s2twp");
    expect(captions).not.toHaveProperty("rawTranscript");
  });

  it("script original opts out and is cached separately", async () => {
    const { request, runtime } = await fixture();
    fake.srt = srt("这个软件可以剪视频");
    fake.whisperRuns = 0;
    const converted = await analyzeAutomaticCaptionTranscript(request, runtime);
    const original = await analyzeAutomaticCaptionTranscript({ ...request, script: "original" }, runtime);
    expect(converted.cues[0].text).toBe("這個軟體可以剪影片");
    expect(original.cues[0].text).toBe("这个软件可以剪视频");
    expect(original).not.toHaveProperty("scriptConversion");
    expect(original.cacheHit).toBe(false);
    expect(fake.whisperRuns).toBe(2);
  });

  it("rejects an unknown script before running the recognizer", async () => {
    const { request, runtime } = await fixture();
    fake.whisperRuns = 0;
    await expect(analyzeAutomaticCaptionTranscript({ ...request, script: "zh-CN" as never }, runtime)).rejects.toThrow("zh-TW 或 original");
    expect(fake.whisperRuns).toBe(0);
  });

  it.each([
    ["Japanese", "auto", ["日本語のテキストです。", "東京大学"]],
    ["Korean", "auto", ["안녕하세요 学校", "감사합니다"]],
    ["Japanese requested", "ja", ["会社に行きます", "東京大学"]],
  ])("leaves %s recognizer text unchanged", async (_label, language, lines) => {
    const { request, runtime } = await fixture();
    fake.srt = srt(...lines);
    const result = await analyzeAutomaticCaptionTranscript({ ...request, language }, runtime);
    expect(result.cues.map((item) => item.text)).toEqual(lines);
    expect(result).not.toHaveProperty("scriptConversion");
  });

  it("converts requested zh-TW and leaves Traditional input unchanged", async () => {
    const { request, runtime } = await fixture();
    fake.srt = srt("我們今天去台北，軟體也很好用。", "后来我们去了公园");
    const result = await analyzeAutomaticCaptionTranscript({ ...request, language: "zh-TW" }, runtime);
    expect(result.cues.map((item) => item.text)).toEqual(["我們今天去台北，軟體也很好用。", "後來我們去了公園"]);
    expect(result.language).toBe("zh-tw");
    expect(result.scriptConversion).toBe("s2twp");
  });

  it("segmented analysis converts the merged transcript once and keeps window raw text", async () => {
    const { request, runtime } = await fixture(70);
    // Every 30 s window reports one cue at window-relative 5–6 s, inside its own core range.
    fake.srt = "1\n00:00:05,000 --> 00:00:06,000\n我们在看视频\n";
    fake.whisperRuns = 0;
    const result = await analyzeAutomaticCaptionTranscript(request, runtime);
    expect(fake.whisperRuns).toBe(3);
    expect(result.cues.map((item) => item.text)).toEqual(["我們在看影片", "我們在看影片", "我們在看影片"]);
    expect(result.scriptConversion).toBe("s2twp");
    expect(result.rawTranscript.text).toContain("我们在看视频");
    expect(result.segmentation?.windows.map((window) => window.rawTranscript.text)).toEqual([fake.srt, fake.srt, fake.srt]);
  });
});
