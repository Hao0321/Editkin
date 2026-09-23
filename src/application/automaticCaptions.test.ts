import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertAutomaticCaptionRuntime,
  buildWhisperCliArgs,
  ensureWhisperModel,
  ffmpegSupportsWhisperFilter,
  inspectWhisperModel,
  mergeBilingualCues,
  parseWhisperSrt,
  whisperCliSupportsTranscription,
  type WhisperModelDescriptor,
} from "./automaticCaptions";

const temporaryPaths: string[] = [];
afterEach(async () => Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true }))));

describe("automatic captions", () => {
  it("uses recognizer token timing for CJK and auto detection instead of whitespace-only splitting", () => {
    for (const language of ["auto", "zh", "ja"]) {
      const args = buildWhisperCliArgs("model.bin", "speech.wav", "result", language);
      expect(args).not.toContain("-sow");
      expect(args[args.indexOf("-ml") + 1]).toBe("18");
    }
    expect(buildWhisperCliArgs("model.bin", "speech.wav", "result", "en")).toContain("-sow");
  });
  it("detects the whisper filter only from an FFmpeg filter inventory row", () => {
    expect(ffmpegSupportsWhisperFilter(" ... whisper           A->A       Transcribe audio with whisper.cpp."))
      .toBe(true);
    expect(ffmpegSupportsWhisperFilter("FFmpeg was built without the whisper filter"))
      .toBe(false);
  });

  it("fails closed before model work when the packaged FFmpeg lacks whisper", async () => {
    let probes = 0;
    await expect(assertAutomaticCaptionRuntime(
      { ffmpegPath: process.execPath },
      undefined,
      async (_executable, args) => {
        probes += 1;
        expect(args).toEqual(["-hide_banner", "-filters"]);
        return { stdout: " ... anull             A->A       Pass the source unchanged.", stderr: "" };
      },
    )).rejects.toThrow("沒有下載模型或改動專案");
    expect(probes).toBe(1);
  });

  it("selects the bundled whisper-cli fallback when FFmpeg has no whisper filter", async () => {
    const calls: string[][] = [];
    const capability = await assertAutomaticCaptionRuntime(
      { ffmpegPath: process.execPath, whisperCliPath: process.execPath },
      undefined,
      async (_executable, args) => {
        calls.push(args);
        return args.includes("-filters")
          ? { stdout: " ... anull             A->A       Pass audio.", stderr: "" }
          : { stdout: "  -l, --language LANG\n  -osrt, --output-srt\n  -tr, --translate", stderr: "" };
      },
    );
    expect(capability).toEqual({ engine: "whisper-cli", ffmpegWhisperFilter: false, whisperCli: true });
    expect(calls).toEqual([["-hide_banner", "-filters"], ["--help"]]);
  });

  it("keeps the FFmpeg filter as the primary monolingual engine without requiring a CLI", async () => {
    const capability = await assertAutomaticCaptionRuntime(
      { ffmpegPath: process.execPath },
      undefined,
      async () => ({ stdout: " ... whisper           A->A       Transcribe audio.", stderr: "" }),
    );
    expect(capability).toEqual({ engine: "ffmpeg-filter", ffmpegWhisperFilter: true, whisperCli: false });
  });

  it("rejects an executable that lacks the required language/SRT CLI contract", async () => {
    await expect(assertAutomaticCaptionRuntime(
      { ffmpegPath: process.execPath, whisperCliPath: process.execPath },
      undefined,
      async (_executable, args) => args.includes("-filters")
        ? { stdout: " ... anull             A->A", stderr: "" }
        : { stdout: "--language LANG", stderr: "" },
    )).rejects.toThrow("能力不完整");
  });

  it("requires whisper-cli before bilingual caption model work", async () => {
    await expect(assertAutomaticCaptionRuntime(
      { ffmpegPath: process.execPath },
      "en",
      async () => ({ stdout: " ... whisper           A->A       Transcribe audio.", stderr: "" }),
    )).rejects.toThrow("未包含 whisper-cli");
  });

  it("requires translation only for the bilingual CLI pass", () => {
    const help = "  -l, --language LANG\n  -osrt, --output-srt\n  -tr, --translate";
    expect(whisperCliSupportsTranscription(help)).toBe(true);
    expect(whisperCliSupportsTranscription(help, true)).toBe(true);
    expect(whisperCliSupportsTranscription("--language LANG\n--output-srt", true)).toBe(false);
    expect(buildWhisperCliArgs("model.bin", "speech.wav", "result", "auto", false)).not.toContain("-tr");
    expect(buildWhisperCliArgs("model.bin", "speech.wav", "result", "auto", true)).toContain("-tr");
  });

  it("parses multiline SRT and clamps cues to the selected clip", () => {
    expect(parseWhisperSrt(`1\n00:00:00,120 --> 00:00:01,500\n你好\n世界\n\n2\n00:00:01.500 --> 00:00:03.000\n<font>第二句</font>`, 2)).toEqual([
      { start: 0.12, end: 1.5, text: "你好 世界" },
      { start: 1.5, end: 2, text: "第二句" },
    ]);
    expect(parseWhisperSrt("1\n00:00:00,000 --> 00:00:02,000\n[silence]", 2)).toEqual([]);
    expect(parseWhisperSrt("1\n00:00:00,000 --> 00:00:02,000\n<script", 2)).toEqual([
      { start: 0, end: 2, text: "script" },
    ]);
  });

  it("accepts only the pinned size and SHA-256", async () => {
    const root = await mkdtemp(join(tmpdir(), "editkin-model-test-"));
    temporaryPaths.push(root);
    const bytes = Buffer.from("verified tiny model fixture");
    const descriptor: WhisperModelDescriptor = {
      id: "fixture-model", fileName: "fixture.bin", url: "https://example.invalid/fixture.bin",
      bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), license: "MIT",
    };
    const modelPath = join(root, descriptor.fileName);
    await writeFile(modelPath, bytes);
    expect((await inspectWhisperModel(modelPath, descriptor)).valid).toBe(true);
    expect(await ensureWhisperModel({ modelRoot: root }, descriptor)).toEqual({ path: modelPath, downloaded: false });
    await writeFile(modelPath, "corrupt");
    expect((await inspectWhisperModel(modelPath, descriptor)).valid).toBe(false);
    await expect(ensureWhisperModel({ modelRoot: root, modelPath }, descriptor)).rejects.toThrow("SHA-256");
    expect(await readFile(modelPath, "utf8")).toBe("corrupt");
  });

  it("aligns translated English cues to the original timing without replacing the editable source text", () => {
    const merged = mergeBilingualCues(
      [{ start: 0, end: 1.4, text: "大家好" }, { start: 1.4, end: 3, text: "今天來測試" }],
      [{ start: 0.05, end: 1.35, text: "Hello everyone" }, { start: 1.45, end: 3.05, text: "Today we test it" }],
    );
    expect(merged).toEqual([
      { start: 0, end: 1.4, text: "大家好", translation: { text: "Hello everyone", language: "en" } },
      { start: 1.4, end: 3, text: "今天來測試", translation: { text: "Today we test it", language: "en" } },
    ]);
  });
});
