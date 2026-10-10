import { assertMotionGraphicV2Contract, MOTION_V2_MAX_SEGMENT_FRAMES, motionGraphicV2HasPoseEffects, motionGraphicV2UnitCount, motionGraphicV2ExitStaggerFrames } from "../domain/motionCompositionV2Contract";
import { assertContinuityVectorLayout } from "../domain/motionContinuityContract";
import { canonicalJson } from "../shared/canonicalJson";
import { assertPreparedGlyphRun, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { resolveBundledFontFace } from "../typography/fontFaces";
import { motionGlyphPath, type MotionGlyphPath, type MotionGlyphPathCommand } from "./motionGlyphPaths";
import { evaluateMotionGraphicV2Easing } from "./motionEasing";

export { evaluateMotionGraphicV2Easing };
import type { EditProject, MotionGraphic, MotionGraphicV2Easing, MotionGraphicV2SequenceOrder } from "../domain/types";

interface Glyph {
  text: string;
  width: number;
  unitIndex: number;
  whitespace: boolean;
  newline: boolean;
}

interface PositionedGlyph extends Glyph {
  lineIndex: number;
  x: number;
  y: number;
  height: number;
}

export interface MotionPhysicalFontIdentity {
  schema: "editkin.motion-physical-layout/v1";
  faceId: string;
  fontSha256: string;
  manifestSha256: string;
  parserVersion: "opentype.js@1.3.4";
}

export interface MotionGraphicV2LayoutSegment {
  id: string;
  text: string;
  lineIndex: number;
  unitIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Baseline-relative, shared outlines; never re-shaped strings. */
  outline?: MotionGlyphPath;
  baselinePixels?: number;
}

export interface MotionGraphicV2LayoutReceipt {
  schema: "hao.motion-layout-receipt/v2";
  receiptId: string;
  sourceSignature: string;
  physicalFont?: MotionPhysicalFontIdentity;
  graphicId: string;
  projectWidth: number;
  projectHeight: number;
  safeRect: { x: number; y: number; width: number; height: number };
  box: { x: number; y: number; width: number; height: number };
  fontSize: number;
  lineHeight: number;
  padding: number;
  lineCount: number;
  unitCount: number;
  segments: MotionGraphicV2LayoutSegment[];
}

export interface MotionGraphicV2SegmentFrame {
  segmentId: string;
  opacity: number;
  scale: number;
  translateXPixels: number;
  translateYPixels: number;
  /** Present only when the motion declares rotation/blur (Motion Language);
   * historical receipts keep exactly the four pose fields above. */
  rotationDegrees?: number;
  blurPixels?: number;
}

export interface MotionGraphicV2FrameReceipt {
  schema: "hao.motion-frame-receipt/v2";
  graphicId: string;
  layoutReceiptId: string;
  timelineFrame: number;
  localFrame: number;
  visible: boolean;
  backgroundOpacity: number;
  segments: MotionGraphicV2SegmentFrame[];
  vectorState?: MotionGraphicV2SegmentFrame;
}

const round = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

export const MOTION_V2_MAX_TEXT_FONT_SIZE = 4096;
const preparedFrameLayouts = new WeakMap<MotionGraphicV2LayoutReceipt, { receiptId: string; styleSignature: string }>();

/** A decrementing auto-fit loop must start in a finite, progressing range.
 * Vector geometry does not consume this unused typography field. */
function assertBoundedTextFontSize(graphic: MotionGraphic): void {
  if (graphic.vectorV2) return;
  const minimum = graphic.layoutV2?.minFontSize;
  if (!Number.isFinite(graphic.fontSize) || graphic.fontSize <= 0 || graphic.fontSize > MOTION_V2_MAX_TEXT_FONT_SIZE
    || minimum === undefined || !Number.isFinite(minimum) || minimum < 8 || minimum > MOTION_V2_MAX_TEXT_FONT_SIZE
    || minimum > graphic.fontSize) throw new Error("v2 text font size exceeds the bounded auto-fit range");
}

function frameLayoutStyleSignature(graphic: MotionGraphic): string {
  return JSON.stringify({ kind: graphic.kind, textColor: graphic.textColor, backgroundColor: graphic.backgroundColor,
    accentColor: graphic.accentColor, outlineWidth: graphic.outlineWidth, shadowDepth: graphic.shadowDepth,
    cornerRadius: graphic.cornerRadius, visualStyle: graphic.visualStyle, paintV1: graphic.paintV1, compositeLayer: graphic.compositeLayer });
}

function freezeOwnedLayout(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const child of Object.values(value)) freezeOwnedLayout(child);
  Object.freeze(value);
}

function receiptIdentity(value: unknown): string {
  const input = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `motion-v2-${hash.toString(16).padStart(8, "0")}`;
}

/** Frozen authored inputs; never retain a mutable reference to the EditGraph. */
function layoutSourceSignature(project: EditProject, graphic: MotionGraphic, physicalFont?: MotionPhysicalFontIdentity): string {
  const layout = graphic.layoutV2!;
  return JSON.stringify({
    projectWidth: project.width, projectHeight: project.height, graphicId: graphic.id,
    text: graphic.text, x: graphic.x, y: graphic.y, width: graphic.width,
    fontSize: graphic.fontSize, fontFamily: graphic.fontFamily ?? "Noto Sans TC",
    fontWeight: graphic.fontWeight ?? 700, letterSpacing: graphic.letterSpacing ?? 0,
    sequenceUnit: graphic.motionV2!.sequence.unit,
    ...(physicalFont ? { physicalFont } : {}),
    // Schema parsing reorders object keys on reopen. Identity binds semantic
    // geometry, not insertion order, so the same saved scene keeps its receipt.
    vector: graphic.vectorV2?.kind === "spring_panel" ? JSON.parse(canonicalJson(graphic.vectorV2))
      : graphic.vectorV2 ? Object.fromEntries(Object.entries(graphic.vectorV2).sort(([a], [b]) => a.localeCompare(b))) : undefined,
    layout: {safeArea: {top: layout.safeArea.top, right: layout.safeArea.right,
      bottom: layout.safeArea.bottom, left: layout.safeArea.left},
      maxLines: layout.maxLines, minFontSize: layout.minFontSize,
      lineGap: layout.lineGap, align: layout.align, widthMode: layout.widthMode ?? "fixed"},
  });
}

function glyphAdvance(character: string, fontSize: number, letterSpacing: number): number {
  if (/\s/u.test(character)) return fontSize * .34 + letterSpacing;
  const code = character.codePointAt(0) ?? 0;
  if (code >= 0x2e80 || code >= 0x1f000) return fontSize + letterSpacing;
  if (/[ilI1|!.,:;'`]/u.test(character)) return fontSize * .32 + letterSpacing;
  if (/[mwMW@#%&]/u.test(character)) return fontSize * .88 + letterSpacing;
  if (/[A-Z0-9]/u.test(character)) return fontSize * .64 + letterSpacing;
  return fontSize * .56 + letterSpacing;
}

function glyphsFor(graphic: MotionGraphic, fontSize: number): Glyph[] {
  const mode = graphic.motionV2!.sequence.unit;
  const letterSpacing = graphic.letterSpacing ?? 0;
  let characterUnit = -1;
  let wordUnit = -1;
  let insideWord = false;
  return [...graphic.text.replaceAll("\r", "")].map((character) => {
    const newline = character === "\n";
    const whitespace = !newline && /\s/u.test(character);
    let unitIndex = 0;
    if (mode === "character") {
      if (!whitespace && !newline) characterUnit += 1;
      unitIndex = Math.max(0, characterUnit);
    } else if (mode === "word") {
      if (!whitespace && !newline && !insideWord) wordUnit += 1;
      unitIndex = Math.max(0, wordUnit);
      insideWord = !whitespace && !newline;
    }
    if (whitespace || newline) insideWord = false;
    return { text: character, width: newline ? 0 : glyphAdvance(character, fontSize, letterSpacing), unitIndex, whitespace, newline };
  });
}

function trimLine(line: Glyph[]): Glyph[] {
  let start = 0;
  let end = line.length;
  while (start < end && line[start].whitespace) start += 1;
  while (end > start && line[end - 1].whitespace) end -= 1;
  return line.slice(start, end);
}

function wrapGlyphs(glyphs: Glyph[], maxWidth: number, maxLines: number): Glyph[][] | undefined {
  const lines: Glyph[][] = [];
  let current: Glyph[] = [];
  const widthOf = (line: Glyph[]) => line.reduce((sum, glyph) => sum + glyph.width, 0);
  const commit = (line: Glyph[]) => {
    lines.push(trimLine(line));
    return lines.length <= maxLines;
  };
  for (const glyph of glyphs) {
    if (glyph.newline) {
      if (!commit(current)) return undefined;
      current = [];
      continue;
    }
    if (!current.length && glyph.whitespace) continue;
    current.push(glyph);
    while (widthOf(current) > maxWidth) {
      let breakIndex = -1;
      for (let index = current.length - 2; index >= 0; index -= 1) {
        if (current[index].whitespace) { breakIndex = index; break; }
      }
      if (breakIndex >= 0) {
        const remainder = current.slice(breakIndex + 1);
        if (!commit(current.slice(0, breakIndex))) return undefined;
        current = trimLine(remainder);
      } else if (current.length > 1) {
        const overflow = current.pop()!;
        if (!commit(current)) return undefined;
        current = overflow.whitespace ? [] : [overflow];
      } else {
        return undefined;
      }
    }
  }
  if (current.length || lines.length === 0) {
    if (!commit(current)) return undefined;
  }
  return lines;
}

function groupedSegments(graphic: MotionGraphic, lines: Glyph[][], textX: number, textY: number, textWidth: number, fontSize: number, lineHeight: number): MotionGraphicV2LayoutSegment[] {
  const align = graphic.layoutV2!.align;
  const positioned: PositionedGlyph[] = [];
  lines.forEach((line, lineIndex) => {
    const lineWidth = line.reduce((sum, glyph) => sum + glyph.width, 0);
    const alignmentOffset = align === "center" ? (textWidth - lineWidth) / 2 : align === "right" ? textWidth - lineWidth : 0;
    let cursor = textX + alignmentOffset;
    for (const glyph of line) {
      positioned.push({ ...glyph, lineIndex, x: cursor, y: textY + lineIndex * lineHeight, height: lineHeight });
      cursor += glyph.width;
    }
  });
  const segments: MotionGraphicV2LayoutSegment[] = [];
  for (const glyph of positioned) {
    const previous = segments.at(-1);
    if (previous && previous.lineIndex === glyph.lineIndex && previous.unitIndex === glyph.unitIndex) {
      previous.text += glyph.text;
      previous.width = round(previous.width + glyph.width);
      continue;
    }
    segments.push({ id: `${graphic.id}:${glyph.lineIndex}:${glyph.unitIndex}:${segments.length}`, text: glyph.text, lineIndex: glyph.lineIndex, unitIndex: glyph.unitIndex, x: round(glyph.x), y: round(glyph.y), width: round(glyph.width), height: round(glyph.height) });
  }
  return segments.filter((segment) => segment.text.length > 0);
}

export function motionGraphicV2LayoutReceipt(project: EditProject, graphic: MotionGraphic): MotionGraphicV2LayoutReceipt {
  assertMotionGraphicV2Contract(graphic, project.fps);
  if (graphic.schema !== "hao.motion-composition/v2") throw new Error(`動態圖卡 ${graphic.id} 不是 motion-composition/v2`);
  assertBoundedTextFontSize(graphic);
  const config = graphic.layoutV2!;
  assertContinuityVectorLayout(project, graphic);
  const safeRect = {
    x: config.safeArea.left * project.width,
    y: config.safeArea.top * project.height,
    width: (1 - config.safeArea.left - config.safeArea.right) * project.width,
    height: (1 - config.safeArea.top - config.safeArea.bottom) * project.height,
  };
  const slotWidth = Math.min(graphic.width * project.width, safeRect.width);
  if (slotWidth < 16) throw new Error(`動態圖卡 ${graphic.id} 的 safe-area 可用寬度不足`);
  const slotX = clamp(graphic.x * project.width, safeRect.x, safeRect.x + safeRect.width - slotWidth);
  if (graphic.vectorV2) {
    const height = graphic.vectorV2.heightPixels;
    if (height > safeRect.height) throw new Error("向量高度超出 safe-area，請縮小圖形");
    const vector = graphic.vectorV2;
    if (vector.kind === "step_progress" && slotWidth - vector.gapPixels * (vector.steps - 1) < vector.steps) throw new Error("章節進度間隔沒有留下可用寬度");
    if (vector.kind === "dot_grid" && Math.ceil(slotWidth / vector.spacingPixels) * Math.ceil(height / vector.spacingPixels) > 512) throw new Error("點陣超出每層 512 點預算");
    if (vector.kind === "line_grid" && Math.ceil(slotWidth / vector.spacingPixels) + Math.ceil(height / vector.spacingPixels) > 256) throw new Error("網格超出每層 256 線預算");
    const base = {
      schema: "hao.motion-layout-receipt/v2" as const, sourceSignature: layoutSourceSignature(project, graphic),
      graphicId: graphic.id, projectWidth: project.width, projectHeight: project.height,
      safeRect: { x: round(safeRect.x), y: round(safeRect.y), width: round(safeRect.width), height: round(safeRect.height) },
      box: { x: round(slotX), y: round(clamp(graphic.y * project.height, safeRect.y, safeRect.y + safeRect.height - height)), width: round(slotWidth), height },
      fontSize: graphic.fontSize, lineHeight: 0, padding: 0, lineCount: 0, unitCount: 1, segments: [],
    };
    return { ...base, receiptId: receiptIdentity(base) };
  }
  const initialFontSize = Math.floor(graphic.fontSize);
  const minimumFontSize = Math.ceil(config.minFontSize);
  for (let fontSize = initialFontSize; fontSize >= minimumFontSize; fontSize -= 1) {
    const padding = Math.max(6, Math.ceil(fontSize * .28));
    const availableTextWidth = slotWidth - padding * 2;
    if (availableTextWidth <= 1) continue;
    const lines = wrapGlyphs(glyphsFor(graphic, fontSize), availableTextWidth, config.maxLines);
    if (!lines) continue;
    const lineWidth = Math.max(...lines.map(line => line.reduce((width, glyph) => width + glyph.width, 0)));
    const boxWidth = config.widthMode === "fit_content" ? Math.min(slotWidth, lineWidth + padding * 2) : slotWidth;
    const alignment = config.align === "center" ? .5 : config.align === "right" ? 1 : 0;
    const boxX = slotX + (slotWidth - boxWidth) * alignment;
    const textWidth = boxWidth - padding * 2;
    const glyphHeight = fontSize * 1.2;
    const lineHeight = glyphHeight + config.lineGap;
    const boxHeight = lines.length * glyphHeight + Math.max(0, lines.length - 1) * config.lineGap + padding * 2;
    if (boxHeight > safeRect.height) continue;
    const boxY = clamp(graphic.y * project.height, safeRect.y, safeRect.y + safeRect.height - boxHeight);
    const segments = groupedSegments(graphic, lines, boxX + padding, boxY + padding, textWidth, fontSize, lineHeight);
    if (!segments.length) continue;
    const base = {
      schema: "hao.motion-layout-receipt/v2" as const,
      sourceSignature: layoutSourceSignature(project, graphic),
      graphicId: graphic.id,
      projectWidth: project.width,
      projectHeight: project.height,
      safeRect: { x: round(safeRect.x), y: round(safeRect.y), width: round(safeRect.width), height: round(safeRect.height) },
      box: { x: round(boxX), y: round(boxY), width: round(boxWidth), height: round(boxHeight) },
      fontSize, lineHeight: round(lineHeight), padding, lineCount: lines.length,
      unitCount: motionGraphicV2UnitCount(graphic), segments,
    };
    return { ...base, receiptId: receiptIdentity(base) };
  }
  throw new Error(`動態圖卡 ${graphic.id} 無法在 safe-area 與 ${config.maxLines} 行限制內 auto-fit`);
}

/** Pure consumer of a prepared, exact-font run. Legacy estimated receipts remain
 * explicitly legacy; absence of a prepared run never enters this path. */
export function motionGraphicV2PhysicalLayoutReceipt(project: EditProject, graphic: MotionGraphic, run: PreparedGlyphRun): MotionGraphicV2LayoutReceipt {
  assertMotionGraphicV2Contract(graphic, project.fps);
  if (graphic.schema !== "hao.motion-composition/v2" || graphic.vectorV2) throw new Error("實體 glyph 排版只接受 v2 文字層");
  assertBoundedTextFontSize(graphic);
  assertPreparedGlyphRun(run);
  if (run.text !== graphic.text.replaceAll("\r", "")) throw new Error("實體 glyph run 與當前文字不一致");
  const physicalFont: MotionPhysicalFontIdentity = { schema: "editkin.motion-physical-layout/v1", faceId: run.faceId,
    fontSha256: run.fontSha256, manifestSha256: run.manifestSha256, parserVersion: run.parserVersion };
  assertPhysicalFontIdentity(graphic, physicalFont);
  const config = graphic.layoutV2!;
  const safeRect = { x: config.safeArea.left * project.width, y: config.safeArea.top * project.height,
    width: (1 - config.safeArea.left - config.safeArea.right) * project.width,
    height: (1 - config.safeArea.top - config.safeArea.bottom) * project.height };
  const slotWidth = Math.min(graphic.width * project.width, safeRect.width);
  if (slotWidth < 16) throw new Error("實體 glyph safe-area 可用寬度不足");
  const slotX = clamp(graphic.x * project.width, safeRect.x, safeRect.x + safeRect.width - slotWidth);
  let characterUnit = -1, wordUnit = -1, inWord = false;
  const source = run.glyphs.map((glyph, index) => {
    let unitIndex = 0;
    if (glyph.kind === "glyph") {
      if (graphic.motionV2!.sequence.unit === "character") unitIndex = ++characterUnit;
      else if (graphic.motionV2!.sequence.unit === "word") { if (!inWord) wordUnit++; unitIndex = wordUnit; }
      inWord = true;
    } else {
      unitIndex = graphic.motionV2!.sequence.unit === "word" ? Math.max(0, wordUnit)
        : graphic.motionV2!.sequence.unit === "character" ? Math.max(0, characterUnit) : 0;
      inWord = false;
    }
    return { glyph, index, unitIndex };
  });
  type Item = typeof source[number];
  const trimmed = (line: Item[]) => {
    let start = 0, end = line.length;
    while (start < end && line[start].glyph.kind === "space") start++;
    while (end > start && line[end - 1].glyph.kind === "space") end--;
    return line.slice(start, end);
  };
  const measure = (line: Item[], size: number) => {
    let cursor = 0, min = 0, max = 0;
    const placed = line.map((item, index) => {
      const x = cursor, ink = item.glyph.inkEm;
      if (ink) { min = Math.min(min, x + ink.xMin * size); max = Math.max(max, x + ink.xMax * size); }
      cursor += item.glyph.advanceEm * size;
      max = Math.max(max, cursor);
      if (index + 1 < line.length) cursor += (line[index + 1].index === item.index + 1 ? item.glyph.kerningAfterEm * size : 0) + (graphic.letterSpacing ?? 0);
      return { ...item, x };
    });
    return { placed, min, max: Math.max(max, cursor), width: Math.max(max, cursor) - min };
  };
  const wrap = (size: number, width: number): Item[][] | undefined => {
    const lines: Item[][] = [];
    let line: Item[] = [];
    const commit = (next: Item[]) => { lines.push(trimmed(next)); return lines.length <= config.maxLines; };
    for (const item of source) {
      if (item.glyph.kind === "newline") { if (!commit(line)) return undefined; line = []; continue; }
      if (!line.length && item.glyph.kind === "space") continue;
      line.push(item);
      while (measure(line, size).width > width) {
        let split = -1;
        for (let index = line.length - 2; index >= 0; index--) if (line[index].glyph.kind === "space") { split = index; break; }
        if (split >= 0) { if (!commit(line.slice(0, split))) return undefined; line = trimmed(line.slice(split + 1)); }
        else if (line.length > 1) { const overflow = line.pop()!; if (!commit(line)) return undefined; line = overflow.glyph.kind === "space" ? [] : [overflow]; }
        else return undefined;
      }
    }
    if (line.length || !lines.length) if (!commit(line)) return undefined;
    return lines;
  };
  const topEm = Math.min(-run.ascender / run.unitsPerEm, ...run.glyphs.flatMap(glyph => glyph.inkEm ? [glyph.inkEm.yMin] : []));
  const bottomEm = Math.max(-run.descender / run.unitsPerEm, ...run.glyphs.flatMap(glyph => glyph.inkEm ? [glyph.inkEm.yMax] : []));
  if (!Number.isFinite(topEm) || !Number.isFinite(bottomEm) || bottomEm <= topEm) throw new Error("實體 glyph 垂直度量不合法");
  for (let fontSize = Math.floor(graphic.fontSize); fontSize >= Math.ceil(config.minFontSize); fontSize--) {
    const padding = Math.max(6, Math.ceil(fontSize * .28)), available = slotWidth - padding * 2;
    if (available <= 1) continue;
    const lines = wrap(fontSize, available);
    if (!lines) continue;
    const measurements = lines.map(line => measure(line, fontSize));
    const textExtent = Math.max(0, ...measurements.map(item => item.width));
    const boxWidth = config.widthMode === "fit_content" ? Math.min(slotWidth, textExtent + padding * 2) : slotWidth;
    const alignment = config.align === "center" ? .5 : config.align === "right" ? 1 : 0;
    const boxX = slotX + (slotWidth - boxWidth) * alignment;
    const glyphHeight = (bottomEm - topEm) * fontSize, lineHeight = glyphHeight + config.lineGap;
    const boxHeight = lines.length * glyphHeight + Math.max(0, lines.length - 1) * config.lineGap + padding * 2;
    if (boxHeight > safeRect.height) continue;
    const boxY = clamp(graphic.y * project.height, safeRect.y, safeRect.y + safeRect.height - boxHeight);
    const segments: MotionGraphicV2LayoutSegment[] = [];
    const segmentCommands = new Map<string, MotionGlyphPathCommand[]>();
    measurements.forEach((line, lineIndex) => {
      const lineX = boxX + padding + (boxWidth - padding * 2 - line.width) * alignment - line.min;
      const lineY = boxY + padding + lineIndex * lineHeight, baseline = -topEm * fontSize;
      for (const placed of line.placed) {
        let segment = segments.at(-1);
        if (!segment || segment.lineIndex !== lineIndex || segment.unitIndex !== placed.unitIndex) {
          const commands: MotionGlyphPathCommand[] = [];
          segment = { id: `${graphic.id}:${lineIndex}:${placed.unitIndex}:${segments.length}`, text: "", lineIndex,
            unitIndex: placed.unitIndex, x: round(lineX + placed.x), y: round(lineY), width: 0, height: round(glyphHeight),
            baselinePixels: round(baseline), outline: { svg: "", ass: "", ink: null, commands } };
          segments.push(segment);
          segmentCommands.set(segment.id, commands);
        }
        segment.text += placed.glyph.text;
        segment.width = round(lineX + placed.x + placed.glyph.advanceEm * fontSize - segment.x);
        const path = motionGlyphPath(placed.glyph, run.unitsPerEm, fontSize, lineX + placed.x - segment.x, baseline);
        segment.outline!.svg += `${segment.outline!.svg && path.svg ? " " : ""}${path.svg}`;
        segment.outline!.ass += `${segment.outline!.ass && path.ass ? " " : ""}${path.ass}`;
        segmentCommands.get(segment.id)!.push(...path.commands);
        if (path.ink) {
          const prior = segment.outline!.ink;
          segment.outline!.ink = prior ? { xMin: Math.min(prior.xMin, path.ink.xMin), yMin: Math.min(prior.yMin, path.ink.yMin),
            xMax: Math.max(prior.xMax, path.ink.xMax), yMax: Math.max(prior.yMax, path.ink.yMax) } : { ...path.ink };
        }
      }
    });
    for (const commands of segmentCommands.values()) Object.freeze(commands);
    if (!segments.some(segment => segment.outline!.svg)) throw new Error("實體 glyph 文字沒有可見輪廓");
    const base = { schema: "hao.motion-layout-receipt/v2" as const, physicalFont, sourceSignature: layoutSourceSignature(project, graphic, physicalFont),
      graphicId: graphic.id, projectWidth: project.width, projectHeight: project.height,
      safeRect: { x: round(safeRect.x), y: round(safeRect.y), width: round(safeRect.width), height: round(safeRect.height) },
      box: { x: round(boxX), y: round(boxY), width: round(boxWidth), height: round(boxHeight) }, fontSize,
      lineHeight: round(lineHeight), padding, lineCount: lines.length, unitCount: motionGraphicV2UnitCount(graphic), segments };
    return { ...base, receiptId: receiptIdentity(base) };
  }
  throw new Error(`動態文字 ${graphic.id} 的實體 glyph 無法在 safe-area 與 ${config.maxLines} 行內 auto-fit`);
}

function assertPhysicalFontIdentity(graphic: MotionGraphic, identity: MotionPhysicalFontIdentity): void {
  const face = resolveBundledFontFace(graphic.fontFamily ?? "Noto Sans TC", graphic.fontWeight ?? 700);
  if (!face || identity.schema !== "editkin.motion-physical-layout/v1" || identity.parserVersion !== "opentype.js@1.3.4" || face.faceId !== identity.faceId) throw new Error("實體 glyph 字型與當前圖卡不一致");
  const spec = bundledFontFaceSpec(face.faceId);
  if (spec.sha256 !== identity.fontSha256 || spec.manifestSha256 !== identity.manifestSha256) throw new Error("實體 glyph 字型來源已過期");
}

function assertFrameLayoutBinding(project: EditProject, graphic: MotionGraphic, layout: MotionGraphicV2LayoutReceipt): void {
  const prepared = preparedFrameLayouts.get(layout);
  if (layout.graphicId !== graphic.id || layout.projectWidth !== project.width || layout.projectHeight !== project.height
    || layout.sourceSignature !== layoutSourceSignature(project, graphic, layout.physicalFont)) {
    throw new Error("v2 layout receipt 與 project/graphic 不一致");
  }
  if (prepared) {
    if (layout.receiptId !== prepared.receiptId || frameLayoutStyleSignature(graphic) !== prepared.styleSignature) {
      throw new Error("v2 prepared layout receipt 與當前 graphic style 不一致");
    }
  } else {
    const { receiptId, ...layoutBody } = layout;
    if (receiptId !== receiptIdentity(layoutBody)) throw new Error("v2 layout receipt 與 project/graphic 不一致");
  }
  if (layout.physicalFont) assertPhysicalFontIdentity(graphic, layout.physicalFont);
}

/** Check the body once, then own and deeply freeze its clone for frame reuse.
 * FNV is a deterministic body check, not cryptographic authorization. A clone
 * has no private seal and continues through ordinary body validation. */
export function prepareMotionGraphicV2FrameLayout(project: EditProject, graphic: MotionGraphic,
  layout: MotionGraphicV2LayoutReceipt): MotionGraphicV2LayoutReceipt {
  assertMotionGraphicV2Contract(graphic, project.fps);
  if (graphic.schema !== "hao.motion-composition/v2") throw new Error("v2 frame layout preparation requires motion-composition/v2");
  assertBoundedTextFontSize(graphic);
  assertFrameLayoutBinding(project, graphic, layout);
  if (preparedFrameLayouts.has(layout)) return layout;
  const owned = structuredClone(layout);
  // Validate the actual copied values too; never seal a changed clone or keep
  // accessors/references from the caller's input.
  assertFrameLayoutBinding(project, graphic, owned);
  freezeOwnedLayout(owned);
  preparedFrameLayouts.set(owned, Object.freeze({ receiptId: owned.receiptId, styleSignature: frameLayoutStyleSignature(graphic) }));
  return owned;
}


function orderedRanks(count: number, order: MotionGraphicV2SequenceOrder): number[] {
  const indices = Array.from({ length: count }, (_, index) => index);
  if (order === "reverse") indices.reverse();
  if (order === "center_out") indices.sort((left, right) => Math.abs(left - (count - 1) / 2) - Math.abs(right - (count - 1) / 2) || left - right);
  const ranks = Array<number>(count);
  indices.forEach((unit, rank) => { ranks[unit] = rank; });
  return ranks;
}

function phaseProgress(frame: number, delay: number, durationFrames: number): number {
  if (frame < delay) return 0;
  if (durationFrames <= 1) return 1;
  return clamp((frame - delay) / (durationFrames - 1), 0, 1);
}

export function motionGraphicV2FrameReceipt(project: EditProject, graphic: MotionGraphic, timelineFrame: number, layout = motionGraphicV2LayoutReceipt(project, graphic)): MotionGraphicV2FrameReceipt {
  assertMotionGraphicV2Contract(graphic, project.fps);
  if (graphic.schema !== "hao.motion-composition/v2" || !Number.isInteger(timelineFrame)) throw new Error("v2 frame evaluator 只接受整數 timeline frame");
  assertFrameLayoutBinding(project, graphic, layout);
  const startFrame = Math.round(graphic.timelineStart * project.fps);
  const durationFrames = Math.max(1, Math.round(graphic.duration * project.fps));
  const localFrame = timelineFrame - startFrame;
  if (localFrame < 0 || localFrame >= durationFrames) {
    return { schema: "hao.motion-frame-receipt/v2", graphicId: graphic.id, layoutReceiptId: layout.receiptId, timelineFrame, localFrame, visible: false, backgroundOpacity: 0, segments: [] };
  }
  const motion = graphic.motionV2!;
  const entranceRanks = orderedRanks(layout.unitCount, motion.sequence.order);
  const exitRanks = orderedRanks(layout.unitCount, motion.sequence.exitOrder);
  const exitStaggerFrames = motionGraphicV2ExitStaggerFrames(motion);
  const exitTotalFrames = motion.exit.durationFrames + Math.max(0, layout.unitCount - 1) * exitStaggerFrames;
  const exitSequenceStart = durationFrames - exitTotalFrames;
  // Every consumer scales about the segment origin (SVG scale(), ASS \an7,
  // native pose). A centered pivot is therefore pure translation, computed once.
  const centered = motion.sequence.scaleOrigin === "center";
  const poseEffects = motionGraphicV2HasPoseEffects(motion);
  const spreadCenter = (layout.unitCount - 1) / 2, spreadExtent = Math.max(1, spreadCenter);
  const holdScale = motion.sequence.holdScale ?? 1;
  const stateAt = (unitIndex: number, segmentId: string, pivot: { width: number; height: number }): MotionGraphicV2SegmentFrame => {
    const entranceDelay = entranceRanks[unitIndex] * motion.sequence.staggerFrames;
    const exitDelay = exitRanks[unitIndex] * exitStaggerFrames;
    const entrance = evaluateMotionGraphicV2Easing(phaseProgress(localFrame, entranceDelay, motion.entrance.durationFrames), motion.entrance.easing);
    const exit = evaluateMotionGraphicV2Easing(phaseProgress(localFrame - exitSequenceStart, exitDelay, motion.exit.durationFrames), motion.exit.easing);
    let scale = (motion.entrance.scale + (1 - motion.entrance.scale) * entrance) * (1 + (motion.exit.scale - 1) * exit);
    if (holdScale !== 1) {
      // Linear slow push across this unit's readable hold, continuous into the exit.
      const holdStart = entranceDelay + motion.entrance.durationFrames - 1, holdEnd = exitSequenceStart + exitDelay;
      scale *= 1 + (holdScale - 1) * (holdEnd > holdStart ? clamp((localFrame - holdStart) / (holdEnd - holdStart), 0, 1) : 0);
    }
    let translateX = motion.entrance.offsetXPixels * (1 - entrance) + motion.exit.offsetXPixels * exit;
    const translateY = motion.entrance.offsetYPixels * (1 - entrance) + motion.exit.offsetYPixels * exit;
    const spread = (motion.entrance.spreadPixels ?? 0) * (1 - entrance) + (motion.exit.spreadPixels ?? 0) * exit;
    // Bisected curves end at 1 - 1e-10, not 1; never let that noise mint a -0.
    const spreadShift = spread * (unitIndex - spreadCenter) / spreadExtent;
    if (Math.abs(spreadShift) >= 5e-7) translateX += spreadShift;
    const state: MotionGraphicV2SegmentFrame = {
      segmentId,
      opacity: round(clamp((motion.entrance.opacity + (1 - motion.entrance.opacity) * entrance) * (1 + (motion.exit.opacity - 1) * exit), 0, 1)),
      scale: round(scale),
      translateXPixels: round(centered ? translateX + (1 - scale) * pivot.width / 2 : translateX),
      translateYPixels: round(centered ? translateY + (1 - scale) * pivot.height / 2 : translateY),
    };
    if (poseEffects) {
      state.rotationDegrees = round((motion.entrance.rotationDegrees ?? 0) * (1 - entrance) + (motion.exit.rotationDegrees ?? 0) * exit) || 0;
      state.blurPixels = round(Math.max(0, (motion.entrance.blurPixels ?? 0) * (1 - entrance) + (motion.exit.blurPixels ?? 0) * exit)) || 0;
    }
    return state;
  };
  const segments = layout.segments.map(segment => stateAt(segment.unitIndex, segment.id, segment));
  const vectorState = graphic.vectorV2 ? stateAt(0, `${graphic.id}:vector`, layout.box) : undefined;
  if (segments.length * durationFrames > MOTION_V2_MAX_SEGMENT_FRAMES) throw new Error(`v2 formal event 預算超過 ${MOTION_V2_MAX_SEGMENT_FRAMES}`);
  return {
    schema: "hao.motion-frame-receipt/v2", graphicId: graphic.id, layoutReceiptId: layout.receiptId, timelineFrame, localFrame, visible: true,
    backgroundOpacity: round(Math.max(0, vectorState?.opacity ?? 0, ...segments.map((segment) => segment.opacity))), segments,
    ...(vectorState ? { vectorState } : {}),
  };
}

export function motionGraphicV2FrameAtPlayhead(project: EditProject, graphic: MotionGraphic, playhead: number): MotionGraphicV2FrameReceipt {
  return motionGraphicV2FrameReceipt(project, graphic, Math.round(playhead * project.fps));
}
