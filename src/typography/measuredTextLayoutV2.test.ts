import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { createMotionGraphic } from "../motion/composition";
import { motionGraphicV2PhysicalLayoutReceipt } from "../motion/compositionV2";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { prepareMotionTextV3 } from "../application/motionTextAuthoringV3";
import { bundledFontFaceSpec } from "./bundledFontCatalog";
import { resolveBundledFontFace } from "./fontFaces";
import { prepareGlyphRun } from "./preparedGlyphRun";
import { layoutMeasuredTextV2, measureGlyphRange } from "./measuredTextLayoutV2";

const faceId = resolveBundledFontFace("Noto Sans TC", 700)!.faceId;
const bytes = readFile(resolve("public/fonts", bundledFontFaceSpec(faceId).fontFile));
const prepare = async (id: string, text: string) => {
  expect(id).toBe(faceId);
  return prepareGlyphRun(id, text, new Uint8Array(await bytes));
};
const run = (text: string) => prepare(faceId, text);
const padding = (size: number) => Math.max(6, Math.ceil(size * .28));
const settings = { slotWidth: 420, fontSize: 90, minFontSize: 40, maxLines: 4 };

describe("opt-in physically measured word layout", () => {
  it("shrinks a title to one physical line before permitting another line", async () => {
    const prepared = await run("Editkin workflow");
    const slotWidth = measureGlyphRange(prepared, 0, prepared.text.length, 68) + padding(68) * 2 + .1;
    const result = layoutMeasuredTextV2(prepared, { ...settings, slotWidth });
    expect(result.lines).toHaveLength(1);
    expect(result.fontSize).toBe(68);
    expect(result.text).toBe(prepared.text);
    expect(result.shrunkBeforeWrapping).toBe(false);
  });

  it("uses punctuation boundaries at the floor and never puts punctuation at line start", async () => {
    const prepared = await run("看清畫面，再開始剪輯");
    const slotWidth = measureGlyphRange(prepared, 0, "看清畫面，".length, 40) + padding(40) * 2 + .1;
    const result = layoutMeasuredTextV2(prepared, { ...settings, slotWidth });
    expect(result.lines.map(line => line.text)).toEqual(["看清畫面，", "再開始剪輯"]);
    expect(result.fontSize).toBe(40);
    expect(result.shrunkBeforeWrapping).toBe(true);
  });

  it("keeps 元件/手遊/天然 whole and rejects 1-2 character orphan rows", async () => {
    const prepared = await run("把天然材質套到元件預覽，手遊角色就能呈現細節");
    const result = layoutMeasuredTextV2(prepared, settings);
    expect(result.lines.length).toBeGreaterThan(1);
    expect(result.text.replaceAll("\n", "")).toBe(prepared.text);
    expect(result.lines.every(line => [...line.text].filter(character => /[\p{L}\p{N}]/u.test(character)).length >= 3)).toBe(true);
    for (const phrase of ["天然", "元件", "手遊"]) expect(result.lines.some(line => line.text.includes(phrase))).toBe(true);
  });

  it("refuses a word wider than the floor instead of splitting it or overflowing", async () => {
    const prepared = await run("Supercalifragilisticexpialidocious");
    expect(() => layoutMeasuredTextV2(prepared, { ...settings, slotWidth: 160 })).toThrow("詞語會保持完整");
  });

  it("protects caller phrases missed by ICU, preserves explicit newlines and allows naturally short labels", async () => {
    const prepared = await run("特製元件設定完成\n請查看預覽畫面");
    const result = layoutMeasuredTextV2(prepared, { ...settings, neverSplit: ["特製元件"] });
    expect(result.lines.some(line => line.text.includes("特製元件"))).toBe(true);
    expect(result.lines[0].text.endsWith("完成")).toBe(true);
    expect(layoutMeasuredTextV2(await run("02"), settings).text).toBe("02");
  });

  it("rejects stale/forged glyph receipts, impossible height and cancellation", async () => {
    const prepared = await run("這段文字需要完整顯示");
    expect(() => layoutMeasuredTextV2(structuredClone(prepared), settings)).toThrow();
    expect(() => layoutMeasuredTextV2(prepared, { ...settings, maxHeight: 12 })).toThrow("高度");
    const controller = new AbortController(); controller.abort();
    expect(() => layoutMeasuredTextV2(prepared, { ...settings, signal: controller.signal })).toThrow("取消");
  });
});

describe("new motion text authoring, all text roles", () => {
  const project = createEmptyProject("Owned text fixture", { width: 1080, height: 1920, fps: 30 });
  function graphic(role: string, text = "把天然材質套到元件預覽，手遊角色就能呈現細節") {
    const preset = findMotionGraphicPreset("v2-word-cascade");
    const item = createMotionGraphic(`new-${role}`, "title", text, 0, 5, undefined, preset.seed);
    item.fontFamily = "Noto Sans TC"; item.fontWeight = 700; item.fontSize = 90; item.width = 420 / 1080;
    item.layoutV2 = { ...item.layoutV2!, minFontSize: 40, maxLines: 4, align: "left", widthMode: "fixed" };
    item.motionV2!.sequence = { ...item.motionV2!.sequence, unit: "all", staggerFrames: 0 };
    return item;
  }

  it.each(["title", "previous", "subtitle", "kicker", "brand", "location", "item-label", "item-detail", "credit", "tag"])(
    "%s uses exact persisted lines that the existing physical renderer reproduces", async role => {
      const input = graphic(role), before = JSON.stringify(input);
      const prepared = await prepareMotionTextV3(project, input, { prepareText: prepare });
      expect(JSON.stringify(input)).toBe(before);
      expect(prepared.graphic.text.replaceAll("\n", "")).toBe(input.text);
      expect(prepared.layout.fontSize).toBe(prepared.authoring.fontSize);
      const actualRows = Array.from({ length: prepared.layout.lineCount }, (_, index) => prepared.layout.segments
        .filter(segment => segment.lineIndex === index).map(segment => segment.text).join(""));
      expect(actualRows).toEqual(prepared.authoring.lines.map(line => line.text));
    });

  it("never mutates the old graphic or changes its old physical receipt", async () => {
    const input = graphic("legacy", "看清畫面，再開始剪輯"), glyphs = await run(input.text);
    const original = JSON.stringify(motionGraphicV2PhysicalLayoutReceipt(project, input, glyphs));
    await prepareMotionTextV3(project, input, { prepareText: prepare });
    expect(JSON.stringify(motionGraphicV2PhysicalLayoutReceipt(project, input, glyphs))).toBe(original);
  });

  it("refuses cancellation while font preparation is outstanding without any authored change", async () => {
    const input = graphic("cancel"), original = JSON.stringify(input), controller = new AbortController();
    await expect(prepareMotionTextV3(project, input, { signal: controller.signal, prepareText: async (id, text) => {
      const prepared = await prepare(id, text); controller.abort(); return prepared;
    } })).rejects.toThrow("取消");
    expect(JSON.stringify(input)).toBe(original);
  });
});
