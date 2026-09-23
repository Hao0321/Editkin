import { assertMotionGraphicV2Contract, MOTION_V2_MAX_SEGMENT_FRAMES, motionGraphicV2UnitCount } from "../domain/motionCompositionV2Contract";
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

export interface MotionGraphicV2LayoutSegment {
  id: string;
  text: string;
  lineIndex: number;
  unitIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MotionGraphicV2LayoutReceipt {
  schema: "hao.motion-layout-receipt/v2";
  receiptId: string;
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
}

const round = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

function receiptIdentity(value: unknown): string {
  const input = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `motion-v2-${hash.toString(16).padStart(8, "0")}`;
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
  const config = graphic.layoutV2!;
  const safeRect = {
    x: config.safeArea.left * project.width,
    y: config.safeArea.top * project.height,
    width: (1 - config.safeArea.left - config.safeArea.right) * project.width,
    height: (1 - config.safeArea.top - config.safeArea.bottom) * project.height,
  };
  const slotWidth = Math.min(graphic.width * project.width, safeRect.width);
  if (slotWidth < 16) throw new Error(`動態圖卡 ${graphic.id} 的 safe-area 可用寬度不足`);
  const slotX = clamp(graphic.x * project.width, safeRect.x, safeRect.x + safeRect.width - slotWidth);
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

function cubicBezier(progress: number, easing: Extract<MotionGraphicV2Easing, { type: "cubic_bezier" }>): number {
  const sample = (time: number, p1: number, p2: number) => {
    const inverse = 1 - time;
    return 3 * inverse * inverse * time * p1 + 3 * inverse * time * time * p2 + time ** 3;
  };
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 16; iteration += 1) {
    const midpoint = (low + high) / 2;
    if (sample(midpoint, easing.x1, easing.x2) < progress) low = midpoint; else high = midpoint;
  }
  return sample((low + high) / 2, easing.y1, easing.y2);
}

function spring(progress: number, easing: Extract<MotionGraphicV2Easing, { type: "spring" }>): number {
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;
  const omega0 = Math.sqrt(easing.stiffness / easing.mass);
  const zeta = easing.damping / (2 * Math.sqrt(easing.stiffness * easing.mass));
  const initialDisplacement = -1;
  if (zeta < 1 - 1e-6) {
    const omegaD = omega0 * Math.sqrt(1 - zeta * zeta);
    const coefficient = (easing.initialVelocity + zeta * omega0 * initialDisplacement) / omegaD;
    const displacement = Math.exp(-zeta * omega0 * progress) * (initialDisplacement * Math.cos(omegaD * progress) + coefficient * Math.sin(omegaD * progress));
    return 1 + displacement;
  }
  if (Math.abs(zeta - 1) <= 1e-6) {
    const coefficient = easing.initialVelocity + omega0 * initialDisplacement;
    return 1 + (initialDisplacement + coefficient * progress) * Math.exp(-omega0 * progress);
  }
  const root = Math.sqrt(zeta * zeta - 1);
  const first = -omega0 * (zeta - root);
  const second = -omega0 * (zeta + root);
  const a = (easing.initialVelocity - second * initialDisplacement) / (first - second);
  const b = initialDisplacement - a;
  return 1 + a * Math.exp(first * progress) + b * Math.exp(second * progress);
}

export function evaluateMotionGraphicV2Easing(progress: number, easing: MotionGraphicV2Easing): number {
  const value = clamp(progress, 0, 1);
  if (easing.type === "linear") return value;
  if (easing.type === "ease_in") return value ** 3;
  if (easing.type === "ease_out") return 1 - (1 - value) ** 3;
  if (easing.type === "ease_in_out") return value < .5 ? 4 * value ** 3 : 1 - ((-2 * value + 2) ** 3) / 2;
  if (easing.type === "cubic_bezier") return cubicBezier(value, easing);
  return spring(value, easing);
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
  if (layout.graphicId !== graphic.id || layout.projectWidth !== project.width || layout.projectHeight !== project.height) throw new Error("v2 layout receipt 與 project/graphic 不一致");
  const startFrame = Math.round(graphic.timelineStart * project.fps);
  const durationFrames = Math.max(1, Math.round(graphic.duration * project.fps));
  const localFrame = timelineFrame - startFrame;
  if (localFrame < 0 || localFrame >= durationFrames) {
    return { schema: "hao.motion-frame-receipt/v2", graphicId: graphic.id, layoutReceiptId: layout.receiptId, timelineFrame, localFrame, visible: false, backgroundOpacity: 0, segments: [] };
  }
  const motion = graphic.motionV2!;
  const entranceRanks = orderedRanks(layout.unitCount, motion.sequence.order);
  const exitRanks = orderedRanks(layout.unitCount, motion.sequence.exitOrder);
  const exitTotalFrames = motion.exit.durationFrames + Math.max(0, layout.unitCount - 1) * motion.sequence.staggerFrames;
  const exitSequenceStart = durationFrames - exitTotalFrames;
  const segments = layout.segments.map((segment): MotionGraphicV2SegmentFrame => {
    const entranceDelay = entranceRanks[segment.unitIndex] * motion.sequence.staggerFrames;
    const exitDelay = exitRanks[segment.unitIndex] * motion.sequence.staggerFrames;
    const entrance = evaluateMotionGraphicV2Easing(phaseProgress(localFrame, entranceDelay, motion.entrance.durationFrames), motion.entrance.easing);
    const exit = evaluateMotionGraphicV2Easing(phaseProgress(localFrame - exitSequenceStart, exitDelay, motion.exit.durationFrames), motion.exit.easing);
    return {
      segmentId: segment.id,
      opacity: round(clamp((motion.entrance.opacity + (1 - motion.entrance.opacity) * entrance) * (1 + (motion.exit.opacity - 1) * exit), 0, 1)),
      scale: round((motion.entrance.scale + (1 - motion.entrance.scale) * entrance) * (1 + (motion.exit.scale - 1) * exit)),
      translateXPixels: round(motion.entrance.offsetXPixels * (1 - entrance) + motion.exit.offsetXPixels * exit),
      translateYPixels: round(motion.entrance.offsetYPixels * (1 - entrance) + motion.exit.offsetYPixels * exit),
    };
  });
  if (segments.length * durationFrames > MOTION_V2_MAX_SEGMENT_FRAMES) throw new Error(`v2 formal event 預算超過 ${MOTION_V2_MAX_SEGMENT_FRAMES}`);
  return {
    schema: "hao.motion-frame-receipt/v2", graphicId: graphic.id, layoutReceiptId: layout.receiptId, timelineFrame, localFrame, visible: true,
    backgroundOpacity: round(Math.max(0, ...segments.map((segment) => segment.opacity))), segments,
  };
}

export function motionGraphicV2FrameAtPlayhead(project: EditProject, graphic: MotionGraphic, playhead: number): MotionGraphicV2FrameReceipt {
  return motionGraphicV2FrameReceipt(project, graphic, Math.round(playhead * project.fps));
}
