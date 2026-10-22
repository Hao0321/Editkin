import { describe, expect, it } from "vitest";
import * as z from "zod/v4";
import { bundledFontFaceSpecs } from "../typography/bundledFontCatalog";
import { PreparedGlyphRunError, prepareGlyphRun } from "../typography/preparedGlyphRun";
import {
  TEMPLATE_SHORT_BRIEF_MAX_BYTES, TEMPLATE_SHORT_START_MAX_BYTES, TemplateShortBlockError, assertBriefBytes, assertBriefNumbers, assertCopySlots,
  assertGlyphs, assertSeenCoverage, chineseNumeralValue, numberTokens, parseCreatorFactRef, parseTemplateShortBrief, parseTemplateShortStart,
  resolveTemplateShortWindow, templateShortBriefSchema, templateShortGlyphSupported, templateShortStartSchema, templateShortTopic, verifyNumbers,
  type TemplateShortCopy, type TemplateShortLook,
} from "./templateShortBrief";

// The design's own examples (§3.1, §3.2).
const START = { schema: "editkin.template-short-start/v1", source: { path: "videos/_INBOX/直式-vertical-Shorts-Reels/6/IMG_4022.MOV", in: 0, out: 11 }, genre: "travel" };
const BRIEF = { schema: "editkin.template-short-brief/v1", shortId: "ts-20261009-batcave-3f9a1c",
  seen: [{ kf: "kf-1", note: "仰拍洞頂，樹根藤蔓垂落滴水，洞底遊客很小" }, { kf: "kf-2", note: "洞頂滴水連成水簾，陽光照亮植物與濕亮木棧道" },
    { kf: "kf-3", note: "洞口全景，一位遊客在欄杆旁；畫面沒有蝙蝠" }],
  copy: { hook: "來看蝙蝠", payoff: "其實是來看水簾", accent: "水簾", proof: "名字叫蝙蝠洞，但現在已經沒有蝙蝠", place: "桃園復興｜三民蝙蝠洞", tag: "天然大岩洞" },
  focus: { x: 0, y: 0.12, w: 1, h: 0.62 } };
const blocked = (run: () => unknown) => {
  try { run(); } catch (error) { if (error instanceof TemplateShortBlockError) return error; throw error; }
  throw new Error("expected a TemplateShortBlockError");
};
const withCopy = (copy: Record<string, unknown>) => ({ ...BRIEF, copy: { ...BRIEF.copy, ...copy } });

describe("template short brief: byte caps and schema", () => {
  it("measures the design's examples on canonical UTF-8 JSON (155 B and 593 B, 748 B in total)", () => {
    expect(assertBriefBytes(START, TEMPLATE_SHORT_START_MAX_BYTES)).toBe(155);
    expect(assertBriefBytes(BRIEF, TEMPLATE_SHORT_BRIEF_MAX_BYTES)).toBe(593);
    expect(parseTemplateShortStart(START).genre).toBe("travel");
    expect(parseTemplateShortBrief(BRIEF).copy?.tag).toBe("天然大岩洞");
  });

  it("blocks a start over 512 B and a brief over 1,024 B before reading the schema", () => {
    const longStart = { ...START, source: { ...START.source, path: `videos/${"長".repeat(150)}.MOV` } };
    expect(blocked(() => parseTemplateShortStart(longStart))).toMatchObject({ code: "BLOCK_START" });
    expect(blocked(() => parseTemplateShortStart(longStart)).detail).toMatch(/上限 512 bytes/);
    const longBrief = { ...BRIEF, topic: "洞".repeat(120), facts: [{ text: "門票".repeat(20), ref: `creator:notes/${"票".repeat(40)}.md#a` }] };
    expect(blocked(() => parseTemplateShortBrief(longBrief))).toMatchObject({ code: "BLOCK_BRIEF" });
  });

  it("accepts a frame-page continuation that creates nothing, and nothing mixed", () => {
    expect(parseTemplateShortStart({ schema: START.schema, shortId: BRIEF.shortId, framePage: 2 })).toEqual({ schema: START.schema, shortId: BRIEF.shortId, framePage: 2 });
    expect(blocked(() => parseTemplateShortStart({ ...START, framePage: 2 })).detail).toBe("續看畫面只接受 shortId 與 framePage");
    expect(blocked(() => parseTemplateShortStart({ schema: START.schema, genre: "travel" })).detail).toBe("start 需要 source 與 genre");
    expect(blocked(() => parseTemplateShortStart({ ...START, genre: "cooking" })).field).toBe("genre");
    expect(blocked(() => parseTemplateShortStart({ ...START, source: { path: "a.mov", in: 5, out: 4 } })).field).toBe("source.out");
  });

  it.each([
    [{ hook: "來".repeat(25) }, "copy.hook 最多 24 字"],
    [{ payoff: "實".repeat(33) }, "copy.payoff 最多 32 字"],
    [{ payoff: undefined }, "copy.payoff 必填"],
    [{ proof: "名".repeat(41) }, "copy.proof 最多 40 字"],
    [{ place: "桃".repeat(25) }, "copy.place 最多 24 字"],
    [{ accent: "水".repeat(13) }, "copy.accent 最多 12 字"],
    [{ hook: "   " }, "copy.hook 不可空白"],
    [{ hook: undefined, points: [{ label: "只有一點" }] }, "copy.points 至少 2 項"],
    [{ hook: undefined, points: Array.from({ length: 5 }, (_, index) => ({ label: `第${index}點` })) }, "copy.points 最多 4 項"],
    [{ hook: undefined, points: [{ label: "步".repeat(25) }, { label: "二" }] }, "copy.points[0].label 最多 24 字"],
    [{ hook: undefined, points: [{ label: "一", detail: "細".repeat(41) }, { label: "二" }] }, "copy.points[0].detail 最多 40 字"],
  ])("enforces the template field limit %o", (copy, detail) => {
    expect(blocked(() => parseTemplateShortBrief(withCopy(copy)))).toMatchObject({ code: "BLOCK_BRIEF", detail });
  });

  it("limits seen notes, frames and topic, and keeps the tag to 8 code points", () => {
    expect(blocked(() => parseTemplateShortBrief({ ...BRIEF, seen: [{ kf: "kf-1", note: "看".repeat(49) }] })).detail).toBe("seen[0].note 最多 48 字");
    expect(blocked(() => parseTemplateShortBrief({ ...BRIEF, seen: Array.from({ length: 5 }, (_, index) => ({ kf: `kf-${index + 1}`, note: "看" })) })).detail).toBe("seen 最多 4 項");
    expect(blocked(() => parseTemplateShortBrief({ ...BRIEF, topic: "題".repeat(121) })).detail).toBe("topic 最多 120 字");
    expect(blocked(() => parseTemplateShortBrief(withCopy({ tag: "天然大岩洞洞頂水簾" }))).detail).toBe("copy.tag 最多 8 字");
    expect(parseTemplateShortBrief(withCopy({ tag: "天然大岩洞洞頂水" })).copy?.tag).toHaveLength(8);
  });

  it("cannot carry a textRegion, an unknown family or an outside fact file", () => {
    expect(blocked(() => parseTemplateShortBrief({ ...BRIEF, textRegion: { x: 0, y: 0, width: 1, height: .2 } })).detail).toBe("brief 不接受欄位：textRegion");
    expect(blocked(() => parseTemplateShortBrief({ ...BRIEF, family: "level_bridge" })).field).toBe("family");
    expect(blocked(() => parseTemplateShortBrief({ ...BRIEF, focus: { x: .5, y: 0, w: .6, h: 1 } })).detail).toBe("focus 超出畫面");
    for (const ref of ["creator:../outside.md#a", "creator:C:/notes.md#a", "creator:/abs.md#a", "creator:notes.md", "material:abc#a"]) {
      expect(parseCreatorFactRef(ref)).toBeUndefined();
      expect(blocked(() => parseTemplateShortBrief({ ...BRIEF, facts: [{ text: "門票50元", ref }] })).field).toBe("facts[0].ref");
    }
    expect(parseCreatorFactRef("creator:videos/_planning/Shorts文案.md#06-三民蝙蝠洞")).toEqual({ path: "videos/_planning/Shorts文案.md", anchor: "06-三民蝙蝠洞" });
  });

  it("defaults the topic to the payoff plus the first seen note, within 120 characters", () => {
    expect(templateShortTopic({ ...BRIEF, topic: "自訂主題" })).toBe("自訂主題");
    expect(templateShortTopic(BRIEF)).toBe("其實是來看水簾：仰拍洞頂，樹根藤蔓垂落滴水，洞底遊客很小");
    expect(templateShortTopic({ copy: { payoff: "水".repeat(32) }, seen: [{ note: "看".repeat(48) }, { note: "x" }] })).toHaveLength(81);
    expect(templateShortTopic({ copy: { payoff: "水".repeat(32) }, seen: [{ note: "🌊".repeat(48) }] }).length).toBeLessThanOrEqual(120);
    expect(parseTemplateShortBrief({ ...BRIEF, shortId: `ts-20261009-${"a".repeat(45)}-3f9a1c` }).shortId).toHaveLength(64);
    expect(blocked(() => parseTemplateShortBrief({ ...BRIEF, shortId: `ts-20261009-${"a".repeat(46)}-3f9a1c` })).field).toBe("shortId");
  });

  it("resume carries only the shortId; a full brief needs seen and copy", () => {
    expect(parseTemplateShortBrief({ schema: BRIEF.schema, shortId: BRIEF.shortId, resume: true }).resume).toBe(true);
    expect(blocked(() => parseTemplateShortBrief({ ...BRIEF, resume: true })).detail).toMatch(/resume 只接受/);
    expect(blocked(() => parseTemplateShortBrief({ schema: BRIEF.schema, shortId: BRIEF.shortId, copy: BRIEF.copy })).field).toBe("seen");
  });

  it("stays a portable MCP input schema (no tuples, no empty prefixItems, SDK conversion works)", () => {
    for (const schema of [templateShortStartSchema, templateShortBriefSchema]) {
      expect(JSON.stringify(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }))).not.toContain("prefixItems");
      expect(() => (schema as unknown as { "~standard": { jsonSchema: { input: (options: { target: string }) => unknown } } })["~standard"].jsonSchema.input({ target: "draft-2020-12" })).not.toThrow();
    }
  });
});

describe("template short brief: slot table", () => {
  const strike: TemplateShortCopy = BRIEF.copy, context: TemplateShortCopy = { payoff: "越走越懸空", accent: "懸空", place: "桃園復興｜小烏來",
    points: [{ label: "先走樹林步道" }, { label: "站上和平橋", detail: "往下看瀑布" }] };
  it("accepts each family's own slots", () => {
    expect(() => assertCopySlots("strike_reframe", strike)).not.toThrow();
    expect(() => assertCopySlots("context_stack", context)).not.toThrow();
  });
  it("blocks a missing required slot, a slot the family rejects, and an accent outside the payoff", () => {
    expect(blocked(() => assertCopySlots("strike_reframe", { payoff: "其實是來看水簾" }))).toMatchObject({ code: "BLOCK_BRIEF", field: "copy.hook" });
    expect(blocked(() => assertCopySlots("strike_reframe", { ...strike, points: context.points }))).toMatchObject({ field: "copy.points" });
    expect(blocked(() => assertCopySlots("context_stack", { ...context, tag: "步道" }))).toMatchObject({ field: "copy.tag" });
    expect(blocked(() => assertCopySlots("context_stack", { ...context, proof: "補充" }))).toMatchObject({ field: "copy.proof" });
    expect(blocked(() => assertCopySlots("strike_reframe", { ...strike, accent: "蝙蝠" }))).toMatchObject({ code: "BLOCK_BRIEF", field: "copy.accent",
      detail: "accent「蝙蝠」必須出現在 payoff「其實是來看水簾」裡" });
  });
});

describe("template short brief: source window", () => {
  it("snaps to integer frames, uses the first 15 s without an out point and blocks under 5 s", () => {
    expect(resolveTemplateShortWindow({ in: 0, out: 11 }, 11, 30)).toEqual({ sourceStartFrame: 0, durationFrames: 330, clampedToMaximum: false });
    expect(resolveTemplateShortWindow({ in: 0.51, out: 11.49 }, 20, 30)).toEqual({ sourceStartFrame: 15, durationFrames: 330, clampedToMaximum: false });
    expect(resolveTemplateShortWindow({}, 20, 30)).toEqual({ sourceStartFrame: 0, durationFrames: 450, clampedToMaximum: true });
    expect(resolveTemplateShortWindow({ in: 2 }, 9, 30)).toEqual({ sourceStartFrame: 60, durationFrames: 210, clampedToMaximum: false });
    expect(blocked(() => resolveTemplateShortWindow({}, 3.2, 30))).toMatchObject({ code: "BLOCK_START", detail: "素材只有 3.2 秒，模板短片需要 5–15 秒" });
    expect(blocked(() => resolveTemplateShortWindow({ in: 1, out: 4 }, 30, 30)).detail).toBe("選取的片段只有 3.0 秒，模板短片需要 5–15 秒");
    expect(blocked(() => resolveTemplateShortWindow({ in: 2, out: 18 }, 30, 30)).detail).toBe("選取的片段有 16.0 秒，模板短片需要 5–15 秒");
    expect(blocked(() => resolveTemplateShortWindow({ in: 0, out: 12 }, 11, 30)).field).toBe("source.out");
    expect(blocked(() => resolveTemplateShortWindow({ in: 12 }, 11, 30)).field).toBe("source.in");
  });
});

describe("Q1 glyphs", () => {
  it("names the field and the 1-based character", () => {
    expect(blocked(() => assertGlyphs({ ...BRIEF.copy, hook: "來看・蝙蝠" }))).toMatchObject({ code: "BLOCK_COPY_GLYPH", field: "copy.hook", detail: "hook 第 3 字『・』字型不支援" });
    expect(blocked(() => assertGlyphs({ payoff: "越走越懸空", points: [{ label: "樹林" }, { label: "和平橋", detail: "往下看🌊瀑布" }] })).detail)
      .toBe("points[1].detail 第 4 字『🌊』字型不支援");
    expect(() => assertGlyphs(BRIEF.copy)).not.toThrow();
  });

  it("mirrors the prepared-glyph text rule on every BMP code point and sampled astral ones", async () => {
    // With a real catalog face and one dummy byte, prepareGlyphRun applies its text rule and only then fails the font SHA.
    const faceId = bundledFontFaceSpecs()[0].faceId, dummy = new Uint8Array([0]);
    const codePoints = [...Array.from({ length: 0x10000 }, (_, index) => index), 0x10000, 0x1d400, 0x1f600, 0x1f30a, 0x20000, 0x2a6d6, 0xe0001];
    const mismatches: string[] = [];
    for (const codePoint of codePoints) {
      const character = String.fromCodePoint(codePoint);
      let real = true;
      try { await prepareGlyphRun(faceId, character, dummy); }
      catch (error) {
        if (!(error instanceof PreparedGlyphRunError) || !["TEXT", "SHA"].includes(error.reason)) throw error;
        real = error.reason === "SHA";
      }
      if (real !== templateShortGlyphSupported(character)) mismatches.push(codePoint.toString(16));
    }
    expect(mismatches).toEqual([]);
  }, 120_000);
});

describe("Q2 numbers (M10)", () => {
  it("treats CJK numerals as numbers only before a counting unit", () => {
    expect(numberTokens("一道道")).toEqual([]);
    expect(numberTokens("三民蝙蝠洞")).toEqual([]);
    expect(numberTokens("門票50元")).toEqual([{ text: "50", value: 50, offset: 2 }]);
    expect(numberTokens("一百五十元")).toEqual([{ text: "一百五十", value: 150, offset: 0 }]);
    expect(numberTokens("十分好看、十分鐘到")).toEqual([{ text: "十", value: 10, offset: 5 }]);
    expect(numberTokens("走了３．５公里，69%的人、1,500元、２５℃").map(token => token.value)).toEqual([3.5, 69, 1500, 25]);
  });

  it.each([["一百五十", 150], ["一百五", 150], ["三千五", 3500], ["兩萬五", 25000], ["一千零五", 1005], ["十五", 15], ["二十", 20], ["十", 10],
    ["二〇二六", 2026], ["一億五千萬", 150_000_000], ["萬", 10_000]])("normalises %s to %d", (run, value) => {
    expect(chineseNumeralValue(run)).toBe(value);
  });

  it("blocks an agent-written number without a source and names the token", () => {
    expect(blocked(() => verifyNumbers(numberTokens("門票50元"), { copyAuthor: "agent" }, "proof"))).toMatchObject({
      code: "BLOCK_UNSUPPORTED_NUMBER", field: "copy.proof", detail: "proof 的『50』找不到來源" });
    expect(() => assertBriefNumbers({ payoff: "一道道水簾", place: "桃園復興｜三民蝙蝠洞" }, { copyAuthor: "agent" })).not.toThrow();
  });

  it("matches a value in a transcript cue, a creator fact file or a seen note, and keeps the creator's own text", () => {
    const tokens = numberTokens("一百五十元");
    expect(verifyNumbers(tokens, { copyAuthor: "agent", transcript: ["老闆說一份150元"] })[0].basis).toBe("transcript");
    expect(verifyNumbers(tokens, { copyAuthor: "agent", facts: [{ ref: "creator:notes.md#a", content: "價目：150 元" }] })[0]).toMatchObject({ basis: "fact", ref: "creator:notes.md#a" });
    expect(verifyNumbers(tokens, { copyAuthor: "creator" })[0].basis).toBe("creator_declared");
    const frameOnly = assertBriefNumbers({ payoff: "門票50元" }, { copyAuthor: "agent", seen: ["招牌寫著門票 50 元"] });
    expect(frameOnly).toMatchObject({ reviewRequired: true, evidence: [{ field: "payoff", basis: "frame_observed" }] });
    expect(assertBriefNumbers({ payoff: "門票50元" }, { copyAuthor: "agent", transcript: ["門票五十元"], seen: ["招牌寫著50"] }).reviewRequired).toBe(false);
  });
});

describe("M9: look before writing", () => {
  const look: TemplateShortLook = { schema: "editkin.template-short-look/v1", shortId: BRIEF.shortId, materialId: "a".repeat(64),
    frames: ["kf-1", "kf-2", "kf-3"].map((id, index) => ({ id, time: index * 5, sha256: String(index + 1).repeat(64), servedAt: "2026-10-09T06:45:00.000Z", page: 1 })) };
  const current = look.frames.map(({ id, sha256 }) => ({ id, sha256 }));
  it("accepts a brief citing every served frame exactly once", () => {
    expect(() => assertSeenCoverage(BRIEF.seen, look, current, BRIEF.shortId)).not.toThrow();
  });
  it.each([
    [[...BRIEF.seen, { kf: "kf-4" }], "kf-4 沒有提供給這支短片（ts-20261009-batcave-3f9a1c）"],
    [BRIEF.seen.slice(0, 2), "kf-3 已提供但 seen 沒有寫下看到什麼"],
    [[...BRIEF.seen.slice(0, 2), { kf: "kf-2" }], "kf-2 被引用了兩次"],
  ])("blocks an unserved, uncited or repeated frame", (seen, detail) => {
    expect(blocked(() => assertSeenCoverage(seen, look, current))).toMatchObject({ code: "BLOCK_UNVIEWED_FRAME", detail });
  });
  it("blocks a frame whose bytes changed, an empty look and another short's look", () => {
    expect(blocked(() => assertSeenCoverage(BRIEF.seen, look, [...current.slice(0, 2), { id: "kf-3", sha256: "f".repeat(64) }])).detail).toBe("kf-3 的畫面已變更（SHA 不同），請重新取得畫面");
    expect(blocked(() => assertSeenCoverage(BRIEF.seen, { ...look, frames: [] }, current)).code).toBe("BLOCK_UNVIEWED_FRAME");
    expect(blocked(() => assertSeenCoverage(BRIEF.seen, look, current, "ts-20261010-other-000000")).code).toBe("BLOCK_UNVIEWED_FRAME");
  });
});
