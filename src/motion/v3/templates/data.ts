import { beat, easeInOutCubic, easeOutCubic, easeOutExpo, frames, lerp, phase } from "../easing";
import { rectPath, roundRectPath } from "../geometry";
import { availableWidth, DISPLAY, expand, mixedRuns, placeBlock, revealLine, SANS, scrim, shape, text, textShadow } from "../kit";
import { baselineOffset, measureText, type V3Font } from "../textMetrics";
import { defineTemplate, type V3Op, type V3Rect } from "../types";

export interface ParsedValue { prefix: string; value: number; decimals: number; grouped: boolean; suffix: string }

/** "NT$1,280" → prefix "NT$", 1280, suffix ""; text without a number counts nothing. */
export function parseValue(copy: string): ParsedValue | undefined {
  const match = /^(.*?)(\d[\d,]*(?:\.\d+)?)(.*)$/u.exec(copy.trim());
  if (!match) return undefined;
  const digits = match[2].replaceAll(",", "");
  const value = Number(digits);
  if (!Number.isFinite(value)) return undefined;
  return { prefix: match[1], value, decimals: digits.includes(".") ? digits.split(".")[1].length : 0, grouped: match[2].includes(","), suffix: match[3] };
}

export function formatValue(parsed: ParsedValue, value: number): string {
  const fixed = value.toFixed(parsed.decimals);
  if (!parsed.grouped) return fixed;
  const [whole, fraction] = fixed.split(".");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction ? `.${fraction}` : "");
}

interface CounterData { parsed?: ParsedValue; number: V3Font; cjk: V3Font; label: V3Font; finalWidth: number; underline: V3Rect; labelY: number; top: number; left: number }

/** A figure that counts up to its value with an accent underline and a tracked label. */
export const statCounter = defineTemplate<CounterData>({
  id: "stat_counter",
  align: "left",
  faces: graphic => [{ family: graphic.fontFamily ?? DISPLAY, weight: graphic.fontWeight ?? 400 }, { family: SANS, weight: 800 }, { family: SANS, weight: 600 }],
  layout(context) {
    const { graphic, lines, canvas } = context;
    const size = graphic.fontSize, u = canvas.unit;
    const number: V3Font = { family: graphic.fontFamily ?? DISPLAY, weight: graphic.fontWeight ?? 400, size, letterSpacing: graphic.letterSpacing ?? size * .01, lineHeight: size * 1.02 };
    const cjk: V3Font = { family: SANS, weight: 800, size: size * .36, letterSpacing: 0, lineHeight: size * .36 * 1.2 };
    const labelSize = Math.max(16 * u, size * .19);
    const label: V3Font = { family: SANS, weight: 600, size: labelSize, letterSpacing: labelSize * .12, lineHeight: labelSize * 1.5 };
    const finalWidth = mixedRuns(lines[0], number, cjk).reduce((sum, run) => sum + run.width, 0);
    const labelWidth = lines[1] ? measureText(lines[1], label) : 0;
    const underlineHeight = Math.max(3 * u, size * .045), gap = size * .16;
    const height = number.lineHeight + gap + underlineHeight + (lines[1] ? gap + label.lineHeight : 0);
    const box = placeBlock(context, Math.max(finalWidth, labelWidth), height, "left");
    const underline = { x: box.x, y: box.y + number.lineHeight + gap, width: finalWidth, height: underlineHeight };
    return { box, data: { parsed: parseValue(lines[0]), number, cjk, label, finalWidth, underline, labelY: underline.y + underlineHeight + gap, top: box.y, left: box.x } };
  },
  frame(context, layout, f) {
    const { parsed, number, cjk, label, finalWidth, underline, labelY, top, left } = layout.data;
    const { durationFrames: total, fps, palette, lines } = context;
    const ops: V3Op[] = [];
    const presence = beat(f, total, fps, { enter: 14, exit: 12 });
    ops.push(scrim("scrim", layout.box, context, presence.enter * (1 - presence.exit)));
    const count = easeOutCubic(phase(f, frames(2, fps), frames(30, fps)));
    const copy = parsed ? `${parsed.prefix}${formatValue(parsed, parsed.value * count)}${parsed.suffix}` : lines[0];
    const b = beat(f, total, fps, { enter: 18, exit: 10, exitLead: 4 });
    const clip: V3Rect = { x: left - number.size * .1, y: top - number.size * .05, width: finalWidth + number.size * .6, height: number.lineHeight + number.size * .1 };
    let x = left;
    mixedRuns(copy, number, cjk).forEach((run, index) => {
      const y = top + baselineOffset(number) - baselineOffset(run.font);
      const op = revealLine(text(`value:${index}`, 4, { text: run.text, x, y, lineHeight: run.font.lineHeight, fontFamily: run.font.family, fontWeight: run.font.weight, fontSize: run.font.size, letterSpacing: run.font.letterSpacing, color: palette.text.color, opacity: palette.text.alpha }), b.enter, b.exit, clip, number.lineHeight * .9);
      ops.push({ ...textShadow(op, .45), clip: expand(clip, number.size * .15) }, op);
      x += run.width;
    });
    const line = beat(f, total, fps, { delay: 6, enter: 20, exit: 10, exitLead: 2 });
    ops.push(shape("underline", 2, rectPath(underline.x + underline.width * line.exit, underline.y, underline.width * line.enter * (1 - line.exit), underline.height), palette.accent));
    if (lines[1]) {
      const lb = beat(f, total, fps, { delay: 10, enter: 18, exit: 9 });
      const op = text("label", 4, { text: lines[1], x: left, y: labelY + lerp(10, 0, lb.enter), lineHeight: label.lineHeight, fontFamily: label.family, fontWeight: label.weight, fontSize: label.size, letterSpacing: label.letterSpacing, color: palette.text.color, opacity: palette.text.alpha * .84 * Math.min(1, lb.enter * 1.5) * (1 - lb.exit) });
      ops.push(textShadow(op, .5), op);
    }
    return ops;
  },
});

interface ProgressData { label: V3Font; value: V3Font; parsed?: ParsedValue; track: V3Rect; labelY: number; valueRight: number; radius: number }

/** Label and percentage above a track that fills to the value. */
export const progressBar = defineTemplate<ProgressData>({
  id: "progress_bar",
  align: "left",
  faces: graphic => [{ family: graphic.fontFamily ?? SANS, weight: graphic.fontWeight ?? 700 }, { family: DISPLAY, weight: 400 }],
  layout(context) {
    const { graphic, lines, canvas } = context;
    const size = graphic.fontSize, u = canvas.unit;
    const label: V3Font = { family: graphic.fontFamily ?? SANS, weight: graphic.fontWeight ?? 700, size, letterSpacing: graphic.letterSpacing ?? 0, lineHeight: size * 1.3 };
    const value: V3Font = { family: DISPLAY, weight: 400, size: size * 1.35, letterSpacing: size * .02, lineHeight: size * 1.35 };
    const width = Math.max(availableWidth(context, "left") * .62, measureText(lines[0], label) + measureText(lines[1] ?? "", value) + size);
    const trackHeight = Math.max(6 * u, size * .26);
    const box = placeBlock(context, Math.min(width, availableWidth(context, "left")), value.lineHeight + size * .3 + trackHeight, "left");
    const track = { x: box.x, y: box.y + value.lineHeight + size * .3, width: box.width, height: trackHeight };
    return { box, data: { label, value, parsed: parseValue(lines[1] ?? ""), track, labelY: box.y + value.lineHeight - label.lineHeight, valueRight: box.x + box.width, radius: trackHeight / 2 } };
  },
  frame(context, layout, f) {
    const { label, value, parsed, track, labelY, valueRight, radius } = layout.data;
    const { durationFrames: total, fps, palette, lines } = context;
    const ops: V3Op[] = [];
    const b = beat(f, total, fps, { enter: 18, exit: 10 });
    ops.push(scrim("scrim", layout.box, context, b.enter * (1 - b.exit)));
    const fill = easeInOutCubic(phase(f, frames(8, fps), frames(34, fps)));
    const ratio = parsed ? Math.max(0, Math.min(1, parsed.value / 100)) : 1;
    const trackPath = roundRectPath(track.x, track.y, track.width * b.enter, track.height, radius);
    ops.push(shape("track", 1, trackPath, palette.text, .18 * (1 - b.exit)));
    ops.push(shape("fill", 2, roundRectPath(track.x, track.y, Math.max(track.height, track.width * ratio * fill), track.height, radius), palette.accent, Math.min(1, fill * 4) * (1 - b.exit)));
    const lb = beat(f, total, fps, { delay: 3, enter: 18, exit: 9, exitLead: 2 });
    const labelOp = text("label", 3, { text: lines[0], x: track.x + lerp(-12, 0, lb.enter), y: labelY, lineHeight: label.lineHeight, fontFamily: label.family, fontWeight: label.weight, fontSize: label.size, letterSpacing: label.letterSpacing, color: palette.text.color, opacity: palette.text.alpha * lb.enter * (1 - lb.exit) });
    ops.push(textShadow(labelOp, .5), labelOp);
    const shown = parsed ? `${parsed.prefix}${formatValue(parsed, parsed.value * fill)}${parsed.suffix}` : lines[1] ?? "";
    const valueOp = text("value", 3, { text: shown, x: valueRight - measureText(shown, value), y: labelY + label.lineHeight - value.lineHeight, lineHeight: value.lineHeight, fontFamily: value.family, fontWeight: value.weight, fontSize: value.size, letterSpacing: value.letterSpacing, color: palette.accent.color, opacity: palette.accent.alpha * lb.enter * (1 - lb.exit) });
    ops.push(textShadow(valueOp, .4), valueOp);
    return ops;
  },
});

interface CompareRow { label: string; valueText: string; parsed?: ParsedValue; y: number }
interface CompareData { label: V3Font; value: V3Font; unit: V3Font; rows: [CompareRow, CompareRow]; barX: number; barMax: number; barHeight: number; rowHeight: number; maxValue: number; left: number; winner: number }

/** Two labelled bars on a shared axis that grow to scale, the larger in the accent colour. */
export const compareSplit = defineTemplate<CompareData>({
  id: "compare_split",
  align: "left",
  faces: graphic => [{ family: graphic.fontFamily ?? SANS, weight: graphic.fontWeight ?? 700 }, { family: DISPLAY, weight: 400 }, { family: SANS, weight: 800 }],
  layout(context) {
    const { graphic, lines } = context;
    const size = graphic.fontSize;
    const label: V3Font = { family: graphic.fontFamily ?? SANS, weight: graphic.fontWeight ?? 700, size, letterSpacing: size * .02, lineHeight: size * 1.3 };
    const value: V3Font = { family: DISPLAY, weight: 400, size: size * 1.5, letterSpacing: size * .02, lineHeight: size * 1.5 };
    const unit: V3Font = { family: SANS, weight: 800, size: size * .5, letterSpacing: 0, lineHeight: size * .5 * 1.25 };
    const labelColumn = Math.max(measureText(lines[0], label), measureText(lines[2], label)) + size * .6;
    const valueWidth = Math.max(...[lines[1], lines[3]].map(copy => mixedRuns(copy, value, unit).reduce((sum, run) => sum + run.width, 0)));
    const barMax = Math.max(size * 4, Math.min(size * 11, availableWidth(context, "left") - labelColumn - valueWidth - size * .5));
    const barHeight = size * .62, rowHeight = Math.max(label.lineHeight, value.lineHeight), rowGap = size * .35;
    const box = placeBlock(context, labelColumn + barMax + size * .4 + valueWidth, rowHeight * 2 + rowGap, "left");
    const parsed = [parseValue(lines[1]), parseValue(lines[3])];
    const maxValue = Math.max(parsed[0]?.value ?? 0, parsed[1]?.value ?? 0, 1e-9);
    const rows: [CompareRow, CompareRow] = [
      { label: lines[0], valueText: lines[1], parsed: parsed[0], y: box.y },
      { label: lines[2], valueText: lines[3], parsed: parsed[1], y: box.y + rowHeight + rowGap },
    ];
    const winner = (parsed[0]?.value ?? 0) >= (parsed[1]?.value ?? 0) ? 0 : 1;
    return { box, data: { label, value, unit, rows, barX: box.x + labelColumn, barMax, barHeight, rowHeight, maxValue, left: box.x, winner } };
  },
  frame(context, layout, f) {
    const { label, value, unit, rows, barX, barMax, barHeight, rowHeight, maxValue, left, winner } = layout.data;
    const { durationFrames: total, fps, palette, canvas } = context;
    const u = canvas.unit, ops: V3Op[] = [];
    const axis = beat(f, total, fps, { enter: 16, exit: 10, exitLead: 4 });
    ops.push(scrim("scrim", layout.box, context, axis.enter * (1 - axis.exit)));
    const axisTop = rows[0].y + (rowHeight - barHeight) / 2 - 8 * u, axisHeight = rows[1].y + rowHeight - rows[0].y - (rowHeight - barHeight) + 16 * u;
    ops.push(shape("axis", 1, rectPath(barX - 2 * u, axisTop, Math.max(1.5, 2 * u), axisHeight * axis.enter * (1 - axis.exit)), palette.text, .5));
    rows.forEach((row, index) => {
      const b = beat(f, total, fps, { delay: 3 + index * 6, enter: 18, exit: 10, exitLead: (1 - index) * 2 });
      const grow = easeOutExpo(phase(f, frames(6 + index * 6, fps), frames(28, fps)));
      const ratio = row.parsed ? row.parsed.value / maxValue : 1;
      const barTop = row.y + (rowHeight - barHeight) / 2;
      const width = Math.max(barHeight * .2 * Math.min(1, grow * 4), barMax * ratio * grow) * (1 - b.exit);
      const lead = index === winner;
      ops.push(shape(`track:${index}`, 2, roundRectPath(barX, barTop, barMax * b.enter * (1 - b.exit), barHeight, [2 * u, barHeight / 2, barHeight / 2, 2 * u]), palette.text, .1));
      ops.push(shape(`bar:${index}`, 3, roundRectPath(barX, barTop, width, barHeight, [2 * u, barHeight / 2, barHeight / 2, 2 * u]), lead ? palette.accent : { color: palette.text.color, alpha: palette.text.alpha * .42 }));
      const labelWidth = measureText(row.label, label);
      const labelOp = revealLine(text(`label:${index}`, 4, { text: row.label, x: barX - label.size * .6 - labelWidth, y: row.y + (rowHeight - label.lineHeight) / 2, lineHeight: label.lineHeight, fontFamily: label.family, fontWeight: label.weight, fontSize: label.size, letterSpacing: label.letterSpacing, color: palette.text.color, opacity: palette.text.alpha * (lead ? 1 : .78) }), b.enter, b.exit, { x: left - label.size, y: row.y, width: barX - left + label.size * .4, height: rowHeight });
      ops.push(textShadow(labelOp, .45), labelOp);
      const shown = row.parsed ? `${row.parsed.prefix}${formatValue(row.parsed, row.parsed.value * grow)}${row.parsed.suffix}` : row.valueText;
      let x = barX + width + label.size * .35;
      mixedRuns(shown, value, unit).forEach((run, runIndex) => {
        const y = row.y + (rowHeight - value.lineHeight) / 2 + baselineOffset(value) - baselineOffset(run.font);
        const op = text(`value:${index}:${runIndex}`, 4, { text: run.text, x, y, lineHeight: run.font.lineHeight, fontFamily: run.font.family, fontWeight: run.font.weight, fontSize: run.font.size, letterSpacing: run.font.letterSpacing, color: lead ? palette.accent.color : palette.text.color, opacity: (lead ? palette.accent.alpha : palette.text.alpha * .82) * Math.min(1, b.enter * 1.6) * (1 - b.exit) });
        ops.push(textShadow(op, .4), op);
        x += run.width;
      });
    });
    return ops;
  },
});
