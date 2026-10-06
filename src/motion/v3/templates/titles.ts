import { beat, easeOutBack, easeOutExpo, lerp } from "../easing";
import { rectPath, roundRectRingPath, scalePath } from "../geometry";
import { availableWidth, expand, panelShadow, placeBlock, revealLine, rounded, SANS, scrim, SERIF, shape, text, textShadow } from "../kit";
import { measureText, wrapText, type V3Font } from "../textMetrics";
import { defineTemplate, type V3Op, type V3Rect } from "../types";

interface RevealData {
  title: V3Font; kicker: V3Font; kickerText: string; lines: string[]; widths: number[];
  rule: { width: number; height: number }; gap: number; kickerBlock: number;
  origin: { x: number; y: number }; panel: boolean;
}

/** Kicker rule + label, then a headline whose lines rise into their own masks. */
export const titleReveal = defineTemplate<RevealData>({
  id: "title_reveal",
  align: "left",
  faces: graphic => [{ family: graphic.fontFamily ?? SANS, weight: graphic.fontWeight ?? 900 }, { family: SANS, weight: 700 }],
  layout(context) {
    const { graphic, canvas, lines, palette } = context;
    const u = canvas.unit, size = graphic.fontSize;
    const title: V3Font = { family: graphic.fontFamily ?? SANS, weight: graphic.fontWeight ?? 900, size, letterSpacing: graphic.letterSpacing ?? 0, lineHeight: size * 1.16 };
    const kickerSize = Math.max(22 * u, size * .3);
    const kicker: V3Font = { family: SANS, weight: 700, size: kickerSize, letterSpacing: kickerSize * .16, lineHeight: kickerSize * 1.5 };
    const kickerText = lines[1] ?? "";
    const panel = palette.surface.alpha > .02;
    const pad = panel ? { x: size * .55, y: size * .44 } : { x: 0, y: 0 };
    // A headline reads best within ~13 em; longer copy breaks between phrases.
    const wrapped = wrapText(lines[0], title, Math.min(availableWidth(context, "left") - pad.x * 2, size * (canvas.portrait ? 11 : 13)), 3);
    const widths = wrapped.map(line => measureText(line, title));
    const rule = { width: 30 * u, height: Math.max(2, 3 * u) }, gap = 12 * u;
    const kickerBlock = kickerText ? kicker.lineHeight + size * .2 : 0;
    const width = Math.max(kickerText ? rule.width + gap + measureText(kickerText, kicker) : 0, ...widths);
    const box = placeBlock(context, width + pad.x * 2, kickerBlock + wrapped.length * title.lineHeight + pad.y * 2, "left");
    return { box, data: { title, kicker, kickerText, lines: wrapped, widths, rule, gap, kickerBlock, origin: { x: box.x + pad.x, y: box.y + pad.y }, panel } };
  },
  frame(context, layout, f) {
    const { title, kicker, kickerText, lines, widths, rule, gap, kickerBlock, origin, panel } = layout.data;
    const { durationFrames: total, fps, palette, canvas } = context;
    const u = canvas.unit, ops: V3Op[] = [];
    if (panel) {
      const b = beat(f, total, fps, { enter: 18, exit: 12, exitLead: 0 });
      const path = rounded(layout.box, title.size * .16);
      const reveal: V3Rect = { ...layout.box, width: layout.box.width * b.enter * (1 - b.exit) };
      ops.push(panelShadow("panel:shadow", 0, path, u, b.enter * (1 - b.exit)));
      ops.push(shape("panel", 1, path, palette.surface, 1, { clip: expand(reveal, 0, 4 * u) }));
      ops.push(shape("panel:edge", 2, roundRectRingPath(layout.box.x, layout.box.y, layout.box.width, layout.box.height, title.size * .16, Math.max(1, u)), { color: "#FFFFFF", alpha: .1 }, 1, { clip: expand(reveal, 0, 4 * u) }));
    } else {
      const b = beat(f, total, fps, { enter: 16, exit: 12 });
      ops.push(scrim("scrim", layout.box, context, b.enter * (1 - b.exit)));
    }
    if (kickerText) {
      const b = beat(f, total, fps, { delay: 2, enter: 16, exit: 10 });
      const ruleY = origin.y + (kicker.lineHeight - rule.height) / 2;
      const ruleWidth = rule.width * b.enter * (1 - b.exit);
      ops.push(shape("rule", 4, rectPath(origin.x + rule.width * b.exit, ruleY, ruleWidth, rule.height), palette.accent));
      const label = text("kicker", 4, { text: kickerText, x: origin.x + rule.width + gap + lerp(-14 * u, 0, b.enter), y: origin.y, lineHeight: kicker.lineHeight, fontFamily: kicker.family, fontWeight: kicker.weight, fontSize: kicker.size, letterSpacing: kicker.letterSpacing, color: palette.accent.color, opacity: palette.accent.alpha * Math.min(1, b.enter * 1.6) * (1 - b.exit) });
      ops.push(label);
    }
    lines.forEach((line, index) => {
      const b = beat(f, total, fps, { delay: 6 + index * 4, enter: 22, exit: 11, exitLead: 2 + index * 2 });
      const top = origin.y + kickerBlock + index * title.lineHeight;
      const clip: V3Rect = { x: origin.x - title.size * .2, y: top - title.size * .06, width: widths[index] + title.size * .4, height: title.lineHeight + title.size * .12 };
      const op = revealLine(text(`line:${index}`, 6, { text: line, x: origin.x, y: top, lineHeight: title.lineHeight, fontFamily: title.family, fontWeight: title.weight, fontSize: title.size, letterSpacing: title.letterSpacing, color: palette.text.color, opacity: palette.text.alpha }), b.enter, b.exit, clip);
      if (!panel) ops.push({ ...textShadow(op, .55), clip: expand(clip, title.size * .2) });
      ops.push(op);
    });
    return ops;
  },
});

interface ImpactData { font: V3Font; lines: string[]; widths: number[]; padX: number; padY: number; rows: V3Rect[] }

/** Hook headline set on solid accent slabs that slam in, one slab per line. */
export const titleImpact = defineTemplate<ImpactData>({
  id: "title_impact",
  align: "left",
  faces: graphic => [{ family: graphic.fontFamily ?? SANS, weight: graphic.fontWeight ?? 900 }],
  layout(context) {
    const { graphic, lines } = context;
    const size = graphic.fontSize;
    const font: V3Font = { family: graphic.fontFamily ?? SANS, weight: graphic.fontWeight ?? 900, size, letterSpacing: graphic.letterSpacing ?? 0, lineHeight: size * 1.18 };
    const padX = size * .34, padY = size * .1, step = font.lineHeight + padY * 2 + size * .08;
    const max = availableWidth(context, "left") - padX * 2;
    const copy = lines.flatMap(line => wrapText(line, font, max, 2)).slice(0, 3);
    const widths = copy.map(line => measureText(line, font));
    const box = placeBlock(context, Math.max(...widths) + padX * 2, copy.length * step - size * .08, "left");
    const rows = copy.map((_, index) => ({ x: box.x, y: box.y + index * step, width: widths[index] + padX * 2, height: font.lineHeight + padY * 2 }));
    return { box, data: { font, lines: copy, widths, padX, padY, rows } };
  },
  frame(context, layout, f) {
    const { font, lines, padX, padY, rows } = layout.data;
    const { durationFrames: total, fps, palette, canvas } = context;
    const ops: V3Op[] = [];
    lines.forEach((line, index) => {
      const row = rows[index], b = beat(f, total, fps, { delay: index * 5, enter: 16, exit: 9, exitLead: (lines.length - 1 - index) * 2 });
      const slab = rectPath(row.x, row.y, row.width, row.height);
      const grow = easeOutExpo(Math.min(1, b.enterRaw * 1.25));
      const collapse = b.exit;
      const visible: V3Rect = { x: row.x + row.width * collapse, y: row.y - 2, width: row.width * grow * (1 - collapse), height: row.height + 4 };
      ops.push(panelShadow(`slab:${index}:shadow`, index * 3, slab, canvas.unit, Math.min(1, b.enter) * (1 - collapse), .8));
      const punch = lerp(1.06, 1, easeOutBack(b.enterRaw, 2.2));
      ops.push(shape(`slab:${index}`, index * 3 + 1, scalePath(slab, punch, punch, row.x, row.y + row.height / 2), palette.accent, 1, { clip: visible }));
      const textIn = beat(f, total, fps, { delay: index * 5 + 4, enter: 14, exit: 9, exitLead: (lines.length - 1 - index) * 2 });
      const clip: V3Rect = { x: row.x, y: row.y, width: row.width * grow * (1 - collapse), height: row.height };
      ops.push(revealLine(text(`line:${index}`, index * 3 + 2, { text: line, x: row.x + padX, y: row.y + padY, lineHeight: font.lineHeight, fontFamily: font.family, fontWeight: font.weight, fontSize: font.size, letterSpacing: font.letterSpacing, color: palette.onAccent.color, opacity: 1 }), textIn.enter, textIn.exit, clip, font.lineHeight * .7));
    });
    return ops;
  },
});

interface EditorialData { title: V3Font; label: V3Font; labelText: string; lines: string[]; widths: number[]; width: number; ruleGap: number; ruleHeight: number; top: number; centerX: number }

/** Serif headline between hairline rules that draw outward from the centre. */
export const titleEditorial = defineTemplate<EditorialData>({
  id: "title_editorial",
  align: "center",
  faces: graphic => [{ family: graphic.fontFamily ?? SERIF, weight: graphic.fontWeight ?? 700 }, { family: SANS, weight: 700 }],
  layout(context) {
    const { graphic, lines, canvas } = context;
    const size = graphic.fontSize, u = canvas.unit;
    const title: V3Font = { family: graphic.fontFamily ?? SERIF, weight: graphic.fontWeight ?? 700, size, letterSpacing: graphic.letterSpacing ?? size * .02, lineHeight: size * 1.24 };
    const labelSize = Math.max(22 * u, size * .3);
    const label: V3Font = { family: SANS, weight: 700, size: labelSize, letterSpacing: labelSize * .28, lineHeight: labelSize * 1.6 };
    const wrapped = wrapText(lines[0], title, Math.min(availableWidth(context, "center"), size * (canvas.portrait ? 11 : 14)), 3);
    const widths = wrapped.map(line => measureText(line, title));
    const labelText = lines[1] ?? "";
    const ruleGap = size * .42, ruleHeight = Math.max(1, 1.6 * u);
    const width = Math.max(...widths, labelText ? measureText(labelText, label) : 0, size * 4);
    const height = (labelText ? label.lineHeight + ruleGap : 0) + ruleGap * 2 + ruleHeight * 2 + wrapped.length * title.lineHeight;
    const box = placeBlock(context, width, height, "center");
    return { box, data: { title, label, labelText, lines: wrapped, widths, width, ruleGap, ruleHeight, top: box.y, centerX: box.x + width / 2 } };
  },
  frame(context, layout, f) {
    const { title, label, labelText, lines, widths, width, ruleGap, ruleHeight, top, centerX } = layout.data;
    const { durationFrames: total, fps, palette } = context;
    const ops: V3Op[] = [];
    const presence = beat(f, total, fps, { enter: 16, exit: 12 });
    ops.push(scrim("scrim", layout.box, context, presence.enter * (1 - presence.exit)));
    let y = top;
    if (labelText) {
      const b = beat(f, total, fps, { delay: 10, enter: 18, exit: 10 });
      const labelWidth = measureText(labelText, label);
      ops.push(text("label", 3, { text: labelText, x: centerX - labelWidth / 2, y: y + lerp(6, 0, b.enter), lineHeight: label.lineHeight, fontFamily: label.family, fontWeight: label.weight, fontSize: label.size, letterSpacing: label.letterSpacing, color: palette.accent.color, opacity: palette.accent.alpha * b.enter * (1 - b.exit) }));
      y += label.lineHeight + ruleGap;
    }
    const rules = beat(f, total, fps, { enter: 22, exit: 12, exitLead: 0 });
    const ruleWidth = width * rules.enter * (1 - rules.exit);
    const topRule = y, bottomRule = y + ruleHeight + ruleGap * 2 + lines.length * title.lineHeight;
    for (const [id, ruleY] of [["rule:top", topRule], ["rule:bottom", bottomRule]] as const) {
      ops.push(shape(id, 2, rectPath(centerX - ruleWidth / 2, ruleY, ruleWidth, ruleHeight), palette.text, .55));
    }
    lines.forEach((line, index) => {
      const b = beat(f, total, fps, { delay: 6 + index * 4, enter: 24, exit: 11, exitLead: 2 + index * 2 });
      const lineTop = topRule + ruleHeight + ruleGap + index * title.lineHeight;
      const x = centerX - widths[index] / 2;
      const clip: V3Rect = { x: x - title.size * .2, y: lineTop - title.size * .1, width: widths[index] + title.size * .4, height: title.lineHeight + title.size * .2 };
      const op = revealLine(text(`line:${index}`, 5, { text: line, x, y: lineTop, lineHeight: title.lineHeight, fontFamily: title.family, fontWeight: title.weight, fontSize: title.size, letterSpacing: title.letterSpacing, color: palette.text.color, opacity: palette.text.alpha }), b.enter, b.exit, clip, title.lineHeight * .55);
      ops.push({ ...textShadow(op, .5), clip: expand(clip, title.size * .2) }, op);
    });
    return ops;
  },
});
