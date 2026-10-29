import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { createMotionGraphic } from "./composition";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareGlyphRun } from "../typography/preparedGlyphRun";
import { motionGraphicV2FrameReceipt, motionGraphicV2PhysicalLayoutReceipt, prepareMotionGraphicV2FrameLayout } from "./compositionV2";
import type { MotionGlyphPathCommand } from "./motionGlyphPaths";

const faceId = "EditkinFace-bebas-neue-400";
const fileBytes = readFile(resolve("public/fonts", bundledFontFaceSpec(faceId).fontFile));
function graphic(text: string) {
  const preset = findMotionGraphicPreset("v2-word-cascade");
  const result = createMotionGraphic("physical-title", "title", text, 0, 3, undefined, preset.seed);
  result.fontFamily = "Bebas Neue"; result.fontWeight = 400; result.fontSize = 60;
  result.layoutV2 = { ...result.layoutV2!, widthMode: "fit_content", align: "left", minFontSize: 60 };
  return result;
}
const project = createEmptyProject("Physical type", { width: 1080, height: 1920, fps: 30 });
async function run(text: string) { return prepareGlyphRun(faceId, text, new Uint8Array(await fileBytes)); }

// A numeric consumer walks complete contours, including each glyph's counters.
function serializeNumeric(commands: readonly MotionGlyphPathCommand[]) {
  const svg: string[] = [], ass: string[] = [];
  let start: { x: number; y: number } | undefined;
  for (const command of commands) {
    if (command.type === "Z") {
      if (!start) throw new Error("Numeric contour has no start");
      svg.push("Z"); ass.push(`l ${start.x} ${start.y}`); start = undefined;
      continue;
    }
    if (command.type === "M") {
      if (start) throw new Error("Numeric contour was not closed");
      start = command;
    } else if (!start) throw new Error("Numeric drawing has no contour");
    const values = command.type === "C" ? [command.x1, command.y1, command.x2, command.y2, command.x, command.y]
      : [command.x, command.y];
    expect(values.every(Number.isFinite)).toBe(true);
    svg.push(`${command.type} ${values.join(" ")}`);
    ass.push(`${command.type === "C" ? "b" : command.type.toLowerCase()} ${values.join(" ")}`);
  }
  if (start) throw new Error("Numeric contour was not closed");
  return { svg: svg.join(" "), ass: ass.join(" ") };
}

describe("actual glyph run to deterministic motion layout", () => {
  it("uses the authentic font's advance and pair kerning rather than equal uppercase estimates", async () => {
    const wide = motionGraphicV2PhysicalLayoutReceipt(project, graphic("WWWW"), await run("WWWW"));
    const narrow = motionGraphicV2PhysicalLayoutReceipt(project, graphic("IIII"), await run("IIII"));
    expect(wide.box.width).toBeGreaterThan(narrow.box.width * 1.5);
    expect(wide.physicalFont).toMatchObject({ faceId, fontSha256: bundledFontFaceSpec(faceId).sha256 });
    expect(wide.segments[0].outline!.svg).toContain("M");
    expect(wide.segments[0].outline!.ass).toContain("m ");
  });

  it("consumes the actual pair advance and kerning at separate character origins", async () => {
    const item = graphic("AV"), prepared = await run(item.text);
    item.letterSpacing = 0;
    item.motionV2!.sequence.unit = "character";
    const layout = motionGraphicV2PhysicalLayoutReceipt(project, item, prepared);
    expect(layout.segments).toHaveLength(2);
    const expectedDelta = (prepared.glyphs[0].advanceEm + prepared.glyphs[0].kerningAfterEm) * layout.fontSize;
    expect(layout.segments[1].x - layout.segments[0].x).toBeCloseTo(expectedDelta, 5);
    expect(layout.segments.map(segment => segment.unitIndex)).toEqual([0, 1]);
  });

  it("automatically wraps actual advances and keeps original character units without cross-line kerning", async () => {
    const pair = motionGraphicV2PhysicalLayoutReceipt(project, graphic("AV"), await run("AV"));
    const item = graphic("AV AV"), prepared = await run(item.text);
    item.width = (pair.box.width + prepared.glyphs[2].advanceEm * 60 / 2) / project.width;
    item.letterSpacing = 0;
    item.motionV2!.sequence.unit = "character";
    const layout = motionGraphicV2PhysicalLayoutReceipt(project, item, prepared);
    expect(layout.lineCount).toBe(2);
    const first = layout.segments.filter(segment => segment.lineIndex === 0);
    const second = layout.segments.filter(segment => segment.lineIndex === 1);
    expect(first.map(segment => segment.unitIndex)).toEqual([0, 1]);
    expect(second.map(segment => segment.unitIndex)).toEqual([2, 3]);
    expect(second[0].x).toBeCloseTo(first[0].x, 5);
    expect(second[1].x - second[0].x).toBeCloseTo(first[1].x - first[0].x, 5);
    expect(second[0].outline!.svg).toBe(first[0].outline!.svg);
  });

  it("adds spacing only between glyphs, keeps ink inside the fitted box and shares a baseline", async () => {
    const base = graphic("AV"), prepared = await run("AV");
    const zero = motionGraphicV2PhysicalLayoutReceipt(project, { ...base, letterSpacing: 0 }, prepared);
    const spaced = motionGraphicV2PhysicalLayoutReceipt(project, { ...base, letterSpacing: 12 }, prepared);
    expect(spaced.box.width - zero.box.width).toBeCloseTo(12, 5);
    for (const segment of spaced.segments) {
      const ink = segment.outline!.ink!;
      expect(segment.x + ink.xMin).toBeGreaterThanOrEqual(spaced.box.x - .00001);
      expect(segment.x + ink.xMax).toBeLessThanOrEqual(spaced.box.x + spaced.box.width + .00001);
      expect(segment.y + ink.yMin).toBeGreaterThanOrEqual(spaced.box.y - .00001);
      expect(segment.y + ink.yMax).toBeLessThanOrEqual(spaced.box.y + spaced.box.height + .00001);
      expect(segment.baselinePixels).toBeGreaterThan(0);
    }
  });

  it("keeps prepared identity and integer-frame seek deterministic, and rejects stale text/font", async () => {
    const item = graphic("ONE TWO"), prepared = await run(item.text);
    const layout = motionGraphicV2PhysicalLayoutReceipt(project, item, prepared);
    const later = motionGraphicV2FrameReceipt(project, item, 50, layout);
    motionGraphicV2FrameReceipt(project, item, 2, layout);
    expect(motionGraphicV2FrameReceipt(project, item, 50, layout)).toEqual(later);
    expect(() => motionGraphicV2PhysicalLayoutReceipt(project, { ...item, text: "NEW" }, prepared)).toThrow(/文字不一致/);
    expect(() => motionGraphicV2PhysicalLayoutReceipt(project, { ...item, fontFamily: "Fredoka" }, prepared)).toThrow(/字型.*不一致/);
    expect(() => motionGraphicV2PhysicalLayoutReceipt(project, item, structuredClone(prepared))).toThrow();
    const tampered = structuredClone(layout); tampered.segments[0].outline!.svg += " M 1 1";
    expect(() => motionGraphicV2FrameReceipt(project, item, 50, tampered)).toThrow(/layout receipt.*不一致/);
  });

  it("re-wraps without trailing spacing or kerning leaking across an explicit line boundary", async () => {
    const item = graphic("AV\nAV"), prepared = await run(item.text);
    const layout = motionGraphicV2PhysicalLayoutReceipt(project, item, prepared);
    expect(layout.lineCount).toBe(2);
    const first = layout.segments.find(segment => segment.lineIndex === 0)!;
    const second = layout.segments.find(segment => segment.lineIndex === 1)!;
    expect(first.width).toBeCloseTo(second.width, 5);
    expect(first.outline!.svg).toBe(second.outline!.svg);
    expect(second.y - first.y).toBeCloseTo(layout.lineHeight, 5);
    expect(first.unitIndex).not.toBe(second.unitIndex);
  });

  it.each(["all", "word", "character"] as const)("keeps physical multiline %s segments, baselines and clock with numeric contours", async unit => {
    const item = graphic("AV O\nAV O");
    item.motionV2!.sequence.unit = unit;
    item.timelineStart = .5;
    const layout = motionGraphicV2PhysicalLayoutReceipt(project, item, await run(item.text));
    expect(layout.lineCount).toBe(2);
    expect(layout.unitCount).toBe(unit === "all" ? 1 : unit === "word" ? 4 : 6);
    expect(layout.segments).toHaveLength(unit === "all" ? 2 : unit === "word" ? 4 : 6);
    const first = layout.segments.filter(segment => segment.lineIndex === 0);
    const second = layout.segments.filter(segment => segment.lineIndex === 1);
    first.forEach((segment, index) => {
      expect(second[index].x).toBeCloseTo(segment.x, 5);
      expect(second[index].y - segment.y).toBeCloseTo(layout.lineHeight, 5);
      expect(second[index].baselinePixels).toBe(segment.baselinePixels);
      expect(second[index].outline!.commands).toEqual(segment.outline!.commands);
    });
    for (const segment of layout.segments) {
      expect(serializeNumeric(segment.outline!.commands)).toEqual({ svg: segment.outline!.svg, ass: segment.outline!.ass });
      expect(segment.outline!.commands.at(-1)).toEqual({ type: "Z" });
    }
    const owned = prepareMotionGraphicV2FrameLayout(project, item, layout);
    expect(owned.segments.map(segment => segment.outline!.commands)).toEqual(layout.segments.map(segment => segment.outline!.commands));
    expect(owned.segments.every(segment => Object.isFrozen(segment.outline!.commands)
      && segment.outline!.commands.every(Object.isFrozen))).toBe(true);
    expect(motionGraphicV2FrameReceipt(project, item, 14, owned).visible).toBe(false);
    const later = motionGraphicV2FrameReceipt(project, item, 65, owned);
    expect(later.localFrame).toBe(50);
    expect(later.segments.map(segment => segment.segmentId)).toEqual(layout.segments.map(segment => segment.id));
    motionGraphicV2FrameReceipt(project, item, 17, owned);
    expect(motionGraphicV2FrameReceipt(project, item, 65, owned)).toEqual(later);
    expect(motionGraphicV2FrameReceipt(project, item, 105, owned).visible).toBe(false);
  });

  it("keeps the original physical auto-fit geometry when a two-line slot forces a smaller font", async () => {
    const item = graphic("AV\nAV"), prepared = await run(item.text);
    const atThirty = { ...item, fontSize: 30, layoutV2: { ...item.layoutV2!, minFontSize: 30, maxLines: 2 } };
    const expected = motionGraphicV2PhysicalLayoutReceipt(project, atThirty, prepared);
    item.width = (expected.box.width + .00001) / project.width;
    item.layoutV2 = { ...item.layoutV2!, minFontSize: 30, maxLines: 2 };
    const fitted = motionGraphicV2PhysicalLayoutReceipt(project, item, prepared);
    expect(fitted.fontSize).toBe(30);
    expect(fitted.box).toEqual(expected.box);
    expect(fitted.lineHeight).toBe(expected.lineHeight);
    expect(fitted.segments).toEqual(expected.segments);
    fitted.segments.forEach(segment => expect(serializeNumeric(segment.outline!.commands))
      .toEqual({ svg: segment.outline!.svg, ass: segment.outline!.ass }));
  });

  it("binds numeric-only changes to the same receipt body and preserves commands through an owned clone", async () => {
    const item = graphic("O\nAV"), layout = motionGraphicV2PhysicalLayoutReceipt(project, item, await run(item.text));
    const tampered = structuredClone(layout);
    const first = tampered.segments[0].outline!.commands[0];
    if (first.type !== "M") throw new Error("Physical outline did not begin with M");
    tampered.segments[0].outline!.commands = [{ ...first, x: first.x + 1 }, ...tampered.segments[0].outline!.commands.slice(1)];
    expect(tampered.segments[0].outline!.svg).toBe(layout.segments[0].outline!.svg);
    expect(() => prepareMotionGraphicV2FrameLayout(project, item, tampered)).toThrow(/layout receipt.*不一致/);
    expect(() => motionGraphicV2FrameReceipt(project, item, 50, tampered)).toThrow(/layout receipt.*不一致/);
  });

  it("invalidates prepared paint changes while retaining physical geometry and the same frame clock", async () => {
    const item = graphic("AV\nO"), prepared = await run(item.text);
    item.visualStyle = "native_paint"; item.backgroundColor = "#00000000"; item.shadowDepth = 0; item.outlineWidth = 0;
    item.paintV1 = { schema: "editkin.motion-paint/v1", clips: [], fill: { kind: "linear", start: { x: 0, y: 0 },
      end: { x: 1, y: 0 }, stops: [{ at: 0, color: "#ff000080" }, { at: 1, color: "#0000ff" }] } };
    const layout = motionGraphicV2PhysicalLayoutReceipt(project, item, prepared);
    const owned = prepareMotionGraphicV2FrameLayout(project, item, layout);
    const frame = motionGraphicV2FrameReceipt(project, item, 50, owned);
    const changed = { ...item, paintV1: { ...item.paintV1, fill: { kind: "solid" as const, color: "#00ff00" } } };
    expect(() => motionGraphicV2FrameReceipt(project, changed, 50, owned)).toThrow(/style.*不一致/);
    expect(() => prepareMotionGraphicV2FrameLayout(project, changed, owned)).toThrow(/style.*不一致/);
    const fresh = motionGraphicV2PhysicalLayoutReceipt(project, changed, prepared);
    expect(fresh).toEqual(layout);
    expect(motionGraphicV2FrameReceipt(project, changed, 50, prepareMotionGraphicV2FrameLayout(project, changed, fresh))).toEqual(frame);
  });

  it("fails a truly too narrow fixed-size slot instead of substituting an estimated receipt", async () => {
    const item = graphic("W"), prepared = await run(item.text);
    item.width = .03;
    expect(() => motionGraphicV2PhysicalLayoutReceipt(project, item, prepared)).toThrow(/實體 glyph.*auto-fit/);
  });
});
