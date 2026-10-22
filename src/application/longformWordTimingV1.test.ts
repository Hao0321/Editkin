import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LONGFORM_WORD_TIMING_V1, longformWordTimingRequestV1Schema } from "../domain/longformWordTimingV1";
import { parseLongformWordWindowV1 } from "./longformWordTimingV1";

const window = { index: 0, start: 0, coreStart: 0, coreEnd: 10, duration: 10 };
const t = (text: string, from?: number, to?: number, p = .95) => ({ text, id: 42, p,
  ...(from === undefined ? {} : { offsets: { from, to } }) });
const json = (text: string, tokens: ReturnType<typeof t>[], from = 0, to = 2000) =>
  JSON.stringify({ transcription: [{ text, offsets: { from, to }, tokens }] });

describe("real recognizer word clocks for longform", () => {
  it("joins subword tokens using their actual millisecond ranges, preserving raw evidence", () => {
    const raw = json(" Editkin works.", [t(" Edit", 120, 310), t("kin", 320, 510, .8), t(" works", 680, 930), t(".", 940, 1000)]);
    const value = parseLongformWordWindowV1(raw, window, 10, "en");
    expect(value.words.map(row => [row.text, row.start, row.end, row.confidence])).toEqual([
      ["Editkin", .12, .51, .8], ["works", .68, .93, .95],
    ]);
    expect(value.words[0].tokenIndices).toEqual([0,1]);
    expect(value.rawJsonSha256).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(value.requiresReview).toBe(false);
    expect(value.syntheticTimingUsed).toBe(false);
  });
  it("does not invent an end time when one part of a word is untimed", () => {
    const value = parseLongformWordWindowV1(json(" Editkin works", [t(" Edit", 100, 300), t("kin"), t(" works", 800, 1100)]), window, 10, "en");
    expect(value.words.map(row => row.text)).toEqual(["works"]);
    expect(value.issues).toContainEqual(expect.objectContaining({ code: "UNTIMED_WORD", text: "Editkin" }));
    expect(value.segments[0].text).toBe(" Editkin works");
  });
  it("keeps complete CJK text and applies the real window offset", () => {
    const value = parseLongformWordWindowV1(json("中文測試", [t("中文", 500, 1100), t("測試", 1200, 1800)]),
      { index: 1, start: 28, coreStart: 30, coreEnd: 60, duration: 34 }, 62, "zh");
    expect(value.words).toHaveLength(0); // all real words belong to the previous core
    expect(value.segments[0].start).toBe(28);
    expect(value.segments[0].text).toBe("中文測試");
  });
  it("retains the recognizer's distinct CJK word ranges without dividing them by character count", () => {
    const value = parseLongformWordWindowV1(json("中文測試", [t("中文", 500, 1100), t("測試", 1200, 1800)]), window, 10, "zh");
    expect(value.words.map(row => [row.text,row.start,row.end])).toEqual([["中文",.5,1.1],["測試",1.2,1.8]]);
    expect(value.requiresReview).toBe(false);
  });
  it("assigns a context-boundary word to exactly one core without clipping its acoustic interval", () => {
    const raw = json(" hello", [t(" hello", 1700, 2500)], 1700, 2500);
    const value = parseLongformWordWindowV1(raw, { index: 1, start: 28, coreStart: 30, coreEnd: 60, duration: 34 }, 62, "en");
    expect(value.words.map(row => [row.start,row.end])).toEqual([[29.7,30.5]]);
  });
  it("ignores recognizer control tokens but keeps ordinary untimed speech for review", () => {
    const value = parseLongformWordWindowV1(json(" hello", [t("[_BEG_]"), t(" hello", 100, 400), t("[_TT_1.00]")]), window, 10);
    expect(value.words.map(row => row.text)).toEqual(["hello"]);
    expect(value.issues).toEqual([]);
  });
  it("refuses to map clocks onto text different from the segment's actual transcript", () => {
    const value = parseLongformWordWindowV1(json("original", [t(" substituted", 100, 400)]), window, 10);
    expect(value.words).toEqual([]);
    expect(value.requiresReview).toBe(true);
    expect(value.issues[0].code).toBe("TOKEN_TEXT_MISMATCH");
  });
  it.each([[100,100],[-1,100],[9000,11000]])("flags invalid acoustic range %s:%s rather than clamping it", (from,to) => {
    const value = parseLongformWordWindowV1(json(" hello", [t(" hello",from,to)]), window, 10);
    expect(value.words).toEqual([]);
    expect(value.issues).toContainEqual(expect.objectContaining({ code: "TOKEN_RANGE" }));
  });
  it("reports shared token ranges and overlaps instead of distributing time by text length", () => {
    const value = parseLongformWordWindowV1(json("one two", [t("one two", 100, 900)]), window, 10, "en");
    expect(value.words.map(row => [row.text,row.start,row.end])).toEqual([["one",.1,.9],["two",.1,.9]]);
    expect(value.requiresReview).toBe(true);
    expect(value.issues.some(row => row.code === "SHARED_TOKEN_RANGE")).toBe(true);
    expect(value.issues.some(row => row.code === "OVERLAPPING_WORDS")).toBe(true);
  });
  it("rejects impossible core windows, malformed JSON and non-finite provider clocks", () => {
    expect(() => parseLongformWordWindowV1("{}", { ...window,coreEnd:11 }, 10)).toThrow("WORD_TIMING_WINDOW");
    expect(() => parseLongformWordWindowV1("broken", window,10)).toThrow();
    expect(() => parseLongformWordWindowV1('{"transcription":[{"text":"x","offsets":{"from":0,"to":1e500},"tokens":[]}]}',window,10)).toThrow();
  });
  it("bounds provider JSON before parsing and preserves unapproved model/VA boundaries", () => {
    expect(() => parseLongformWordWindowV1(" ".repeat(LONGFORM_WORD_TIMING_V1.maximumWindowJsonBytes + 1),window,10)).toThrow("WORD_TIMING_JSON_BUDGET");
    expect(LONGFORM_WORD_TIMING_V1.syntheticTimingAllowed).toBe(false);
    expect(LONGFORM_WORD_TIMING_V1.newModelRequired).toBe(false);
  });
  it("validates material and paragraph identities before any source is read", () => {
    const media = { id:"narration",path:"voice.wav",sourceStart:0,duration:10 };
    const value = { schema:"editkin.longform-word-timing-request/v1",narration:media,
      script:{kind:"paragraphs",paragraphs:[{id:"p1",text:"hello"}]},recordings:[],screenshots:[],language:"en" };
    expect(longformWordTimingRequestV1Schema.safeParse(value).success).toBe(true);
    expect(longformWordTimingRequestV1Schema.safeParse({...value,recordings:[media]}).success).toBe(false);
    expect(longformWordTimingRequestV1Schema.safeParse({...value,script:{kind:"paragraphs",paragraphs:[{id:"p1",text:"x"},{id:"p1",text:"y"}]}}).success).toBe(false);
    expect(longformWordTimingRequestV1Schema.safeParse({...value,model:"medium"}).success).toBe(false);
  });
});
