import { describe, expect, it } from "vitest";
import { applyCommand } from "../domain/commands";
import { createEmptyProject } from "../domain/editGraph";
import { buildImportCaptionsCommand, CaptionFileError, parseCaptionFile, serializeCaptions } from "./captionFiles";

const cue = (id: string, text: string, start: number, duration: number) => ({ id, text, start, duration });

describe("caption files", () => {
  it("writes SRT and WebVTT with hour-scale timestamps, ordered cues and no blank lines inside a cue", () => {
    const captions = [cue("b", "第二句\n\n  換行  ", 3661.0005, 2), cue("a", "First", 0, 1.5), cue("skip", " \n ", 9, 1)];
    expect(serializeCaptions(captions, "srt")).toBe(
      "1\n00:00:00,000 --> 00:00:01,500\nFirst\n\n2\n01:01:01,001 --> 01:01:03,001\n第二句\n  換行\n",
    );
    expect(serializeCaptions(captions, "vtt")).toBe(
      "WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nFirst\n\n01:01:01.001 --> 01:01:03.001\n第二句\n  換行\n",
    );
    expect(serializeCaptions([], "srt")).toBe("");
    expect(serializeCaptions([], "vtt")).toBe("WEBVTT\n\n");
  });

  it("never emits a zero-length cue after rounding", () => {
    expect(serializeCaptions([cue("a", "x", 1, 0.0001)], "srt")).toContain("00:00:01,000 --> 00:00:01,001");
  });

  it("escapes WebVTT markup characters so text survives a round trip", () => {
    const vtt = serializeCaptions([cue("a", "a <b> & c --> d", 0, 1)], "vtt");
    expect(vtt).toContain("a &lt;b&gt; &amp; c --&gt; d");
    expect(parseCaptionFile(vtt)).toEqual([{ start: 0, end: 1, text: "a <b> & c --> d" }]);
  });

  it("round-trips SRT text, multi-line cues and timing to the millisecond", () => {
    const captions = [cue("a", "你好\n世界", 0.25, 1.125), cue("b", "x", 7200, 0.5)];
    expect(parseCaptionFile(serializeCaptions(captions, "srt"))).toEqual([
      { start: 0.25, end: 1.375, text: "你好\n世界" },
      { start: 7200, end: 7200.5, text: "x" },
    ]);
  });

  it("reads real-world SRT: BOM, CRLF, missing ids, dot separators, tags and ASS overrides", () => {
    const srt = "\uFEFF1\r\n00:00:01.5 --> 00:00:02,25\r\n<i>Hi</i> {\\an8}there\r\n\r\n00:00:03,000 --> 00:00:04,000\r\nno id\r\n";
    expect(parseCaptionFile(srt)).toEqual([{ start: 1.5, end: 2.25, text: "Hi there" }, { start: 3, end: 4, text: "no id" }]);
  });

  it("reads WebVTT: header, NOTE/STYLE blocks, cue ids, short timestamps, settings, voice tags and entities", () => {
    const vtt = "WEBVTT - title\n\nNOTE a comment\n\nSTYLE\n::cue { color: red }\n\nintro\n00:01.000 --> 00:02.000 align:start position:0%\n<v Bob>Tom &amp; Jerry</v> <00:01.500>ok\n";
    expect(parseCaptionFile(vtt)).toEqual([{ start: 1, end: 2, text: "Tom & Jerry ok" }]);
  });

  it("keeps a lone less-than sign as text instead of swallowing following words", () => {
    expect(parseCaptionFile("1\n00:00:00,000 --> 00:00:01,000\n3 < 5 and 7 > 2\n")).toEqual([{ start: 0, end: 1, text: "3 < 5 and 7 > 2" }]);
  });

  it.each([
    ["no timing line", "1\nhello\n"],
    ["end before start", "1\n00:00:02,000 --> 00:00:01,000\nx\n"],
    ["minutes out of range", "1\n00:61:00,000 --> 00:62:00,000\nx\n"],
    ["garbage timing", "1\n00:00:00,000 --> soon\nx\n"],
    ["nothing importable", "1\n00:00:00,000 --> 00:00:01,000\n<b></b>\n"],
    ["empty file", ""],
  ])("rejects %s without partial import", (_name, input) => {
    expect(() => parseCaptionFile(input)).toThrow(CaptionFileError);
  });

  it("imports as frame-aligned undoable captions with unique ids", () => {
    const project = createEmptyProject();
    let next = 0;
    const command = buildImportCaptionsCommand(project, [{ start: 0.51, end: 1.5, text: "a" }, { start: 2, end: 2.001, text: "b" }], () => `c${next++}`);
    const result = applyCommand(project, command);
    expect(result.captions.map((item) => item.id)).toEqual(["c0", "c1"]);
    expect(result.captions[0].start).toBeCloseTo(Math.round(0.51 * project.fps) / project.fps);
    expect(result.captions[1].duration).toBeGreaterThanOrEqual(1 / project.fps - 1e-9);
  });
});
