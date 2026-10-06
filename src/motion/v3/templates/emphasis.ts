import { beat, clamp01, easeInOutCubic, easeOutBack, easeOutExpo, frames, lerp, phase } from "../easing";
import { circlePath, polygonPath, rectPath, ringPath, roundRectPath, roundRectRingPath, scalePath, strokePolylinePath, truncatePolyline, polylineLength } from "../geometry";
import { availableWidth, dim, expand, opticalTop, panelShadow, placeBlock, revealLine, rounded, SANS, scrim, SERIF, setText, shape, textShadow } from "../kit";
import { measureText, wrapText, type V3Font } from "../textMetrics";
import { defineTemplate, type V3Op, type V3Rect } from "../types";

interface SweepData { font: V3Font; lines: string[]; widths: number[]; tops: number[]; left: number; padX: number }

/** Headline lines get a marker sweep; the ink flips to a readable colour where the marker passes. */
export const highlightSweep = defineTemplate<SweepData>({
  id: "highlight_sweep",
  align: "left",
  faces: graphic => [{ family: graphic.fontFamily ?? SANS, weight: graphic.fontWeight ?? 900 }],
  layout(context) {
    const { graphic, lines, canvas } = context;
    const size = graphic.fontSize;
    const font: V3Font = { family: graphic.fontFamily ?? SANS, weight: graphic.fontWeight ?? 900, size, letterSpacing: graphic.letterSpacing ?? 0, lineHeight: size * 1.24 };
    const padX = size * .2, max = Math.min(availableWidth(context, "left") - padX * 2, size * (canvas.portrait ? 11 : 15));
    const copy = lines.flatMap(line => wrapText(line, font, max, 2)).slice(0, 3);
    const widths = copy.map(line => measureText(line, font));
    const step = font.lineHeight + size * .14;
    const box = placeBlock(context, Math.max(...widths) + padX * 2, copy.length * step - size * .14, "left");
    return { box, data: { font, lines: copy, widths, tops: copy.map((_, index) => box.y + index * step), left: box.x + padX, padX } };
  },
  frame(context, layout, f) {
    const { font, lines, widths, tops, left, padX } = layout.data;
    const { durationFrames: total, fps, palette } = context;
    const ops: V3Op[] = [];
    lines.forEach((line, index) => {
      const top = tops[index], width = widths[index];
      const tb = beat(f, total, fps, { delay: index * 6, enter: 18, exit: 10, exitLead: (lines.length - 1 - index) * 2 });
      const sweep = easeInOutCubic(phase(f, frames(10 + index * 8, fps), frames(16, fps)));
      const retreat = beat(f, total, fps, { exit: 12, exitLead: 4 + (lines.length - 1 - index) * 2 }).exit;
      const band: V3Rect = { x: left - padX, y: top + font.lineHeight * .06, width: width + padX * 2, height: font.lineHeight * .9 };
      const from = band.x + band.width * retreat, to = band.x + band.width * sweep;
      const lineBox: V3Rect = { x: left - font.size * .2, y: top - font.size * .1, width: width + font.size * .4, height: font.lineHeight + font.size * .2 };
      if (to > from) ops.push(shape(`marker:${index}`, index * 4 + 1, roundRectPath(band.x, band.y, band.width, band.height, font.size * .06), palette.accent, 1, { clip: { x: from, y: band.y - 2, width: to - from, height: band.height + 4 } }));
      const base = setText(`line:${index}`, index * 4 + 2, font, line, left, top, palette.text);
      const risen = revealLine(base, tb.enter, tb.exit, lineBox, font.lineHeight * .8);
      // Ink right of the marker stays light; inside the marker it flips to the accent's readable ink.
      const outside: V3Rect = { x: Math.max(lineBox.x, to), y: lineBox.y, width: lineBox.x + lineBox.width - Math.max(lineBox.x, to), height: lineBox.height };
      const before: V3Rect = { x: lineBox.x, y: lineBox.y, width: Math.max(0, from - lineBox.x), height: lineBox.height };
      // The opaque marker sits above the shadow, so one shadow serves every state.
      ops.push({ ...textShadow(risen, .5), layer: index * 4, clip: expand(lineBox, font.size * .2) });
      ops.push({ ...risen, clip: outside });
      if (before.width > 0) ops.push({ ...risen, id: `line:${index}:after`, clip: before });
      if (to > from) ops.push({ ...risen, id: `line:${index}:ink`, layer: index * 4 + 3, color: palette.onAccent.color, opacity: risen.opacity, clip: { x: from, y: lineBox.y, width: to - from, height: lineBox.height } });
    });
    return ops;
  },
});

interface QuoteData { quote: V3Font; author: V3Font; lines: string[]; widths: number[]; authorText: string; rule: V3Rect; textX: number; top: number; authorY: number; dash: number; panel: boolean }

/** Editorial pull quote: an accent rule draws down and the quote sets line by line. */
export const quoteCard = defineTemplate<QuoteData>({
  id: "quote_card",
  align: "left",
  faces: graphic => [{ family: graphic.fontFamily ?? SERIF, weight: graphic.fontWeight ?? 600 }, { family: SANS, weight: 600 }],
  layout(context) {
    const { graphic, lines, canvas, palette } = context;
    const size = graphic.fontSize, u = canvas.unit;
    const panel = palette.surface.alpha > .02, pad = panel ? { x: size * .8, y: size * .7 } : { x: 0, y: 0 };
    const quote: V3Font = { family: graphic.fontFamily ?? SERIF, weight: graphic.fontWeight ?? 600, size, letterSpacing: graphic.letterSpacing ?? size * .02, lineHeight: size * 1.52 };
    const authorSize = Math.max(20 * u, size * .5);
    const author: V3Font = { family: SANS, weight: 600, size: authorSize, letterSpacing: authorSize * .08, lineHeight: authorSize * 1.5 };
    const ruleWidth = Math.max(3 * u, size * .07), gap = size * .7;
    const max = Math.min(availableWidth(context, "left") - ruleWidth - gap - pad.x * 2, size * (canvas.portrait ? 11 : 17));
    const wrapped = wrapText(lines[0], quote, max, 4);
    const widths = wrapped.map(line => measureText(line, quote));
    // The template draws its own dash, so a typed leading dash is not repeated.
    const authorText = (lines[1] ?? "").replace(/^[—–―－-]+\s*/u, ""), dash = size * .7;
    const authorBlock = authorText ? size * .5 + author.lineHeight : 0;
    const textHeight = wrapped.length * quote.lineHeight + authorBlock;
    const width = ruleWidth + gap + Math.max(...widths, authorText ? dash + size * .3 + measureText(authorText, author) : 0);
    const box = placeBlock(context, width + pad.x * 2, textHeight + pad.y * 2, "left");
    const top = box.y + pad.y;
    return {
      box,
      data: {
        quote, author, lines: wrapped, widths, authorText, rule: { x: box.x + pad.x, y: top + quote.size * .2, width: ruleWidth, height: wrapped.length * quote.lineHeight - quote.size * .4 },
        textX: box.x + pad.x + ruleWidth + gap, top, authorY: top + wrapped.length * quote.lineHeight + size * .5, dash, panel,
      },
    };
  },
  frame(context, layout, f) {
    const d = layout.data;
    const { durationFrames: total, fps, palette, canvas } = context;
    const u = canvas.unit, ops: V3Op[] = [];
    if (d.panel) {
      const b = beat(f, total, fps, { enter: 20, exit: 12 });
      const radius = d.quote.size * .2, lift = lerp(12 * u, 0, b.enter), presence = Math.min(1, b.enter * 1.5) * (1 - b.exit);
      const path = roundRectPath(layout.box.x, layout.box.y + lift, layout.box.width, layout.box.height, radius);
      ops.push(panelShadow("panel:shadow", 0, path, u, presence));
      ops.push(shape("panel", 1, path, palette.surface, presence));
      ops.push(shape("panel:edge", 2, roundRectRingPath(layout.box.x, layout.box.y + lift, layout.box.width, layout.box.height, radius, Math.max(1, u)), { color: "#FFFFFF", alpha: .1 }, presence));
    } else {
      const b = beat(f, total, fps, { enter: 16, exit: 12 });
      ops.push(scrim("scrim", layout.box, context, b.enter * (1 - b.exit)));
    }
    const rb = beat(f, total, fps, { delay: 4, enter: 24, exit: 12, exitLead: 0 });
    ops.push(shape("rule", 3, rectPath(d.rule.x, d.rule.y + d.rule.height * rb.exit, d.rule.width, d.rule.height * rb.enter * (1 - rb.exit)), palette.accent));
    d.lines.forEach((line, index) => {
      const b = beat(f, total, fps, { delay: 8 + index * 5, enter: 24, exit: 10, exitLead: 2 + (d.lines.length - 1 - index) });
      const top = d.top + index * d.quote.lineHeight;
      const clip: V3Rect = { x: d.textX - d.quote.size * .2, y: top, width: d.widths[index] + d.quote.size * .4, height: d.quote.lineHeight };
      const op = revealLine(setText(`line:${index}`, 5, d.quote, line, d.textX, top, palette.text), b.enter, b.exit, clip, d.quote.lineHeight * .6);
      if (!d.panel) ops.push({ ...textShadow(op, .5), clip: expand(clip, d.quote.size * .2) });
      ops.push(op);
    });
    if (d.authorText) {
      const b = beat(f, total, fps, { delay: 12 + d.lines.length * 5, enter: 20, exit: 9 });
      const dashY = d.authorY + d.author.lineHeight / 2 - Math.max(1, 1.5 * u) / 2;
      ops.push(shape("dash", 4, rectPath(d.textX, dashY, d.dash * b.enter * (1 - b.exit), Math.max(1.5, 2 * u)), palette.accent));
      const op = setText("author", 5, d.author, d.authorText, d.textX + d.dash + d.quote.size * .3 + lerp(-12 * u, 0, b.enter), d.authorY, dim(palette.text, .8), b.enter * (1 - b.exit));
      if (!d.panel) ops.push(textShadow(op, .5));
      ops.push(op);
    }
    return ops;
  },
});

interface StepRow { text: string[]; widths: number[]; top: number; height: number; center: number }
interface StepsData { item: V3Font; badge: V3Font; rows: StepRow[]; badgeX: number; radius: number; textX: number; connector: number; panel: boolean }

/** Numbered steps: badges pop in order, connectors draw between them, each step slides in. */
export const stepsList = defineTemplate<StepsData>({
  id: "steps_list",
  align: "left",
  faces: graphic => [{ family: graphic.fontFamily ?? SANS, weight: graphic.fontWeight ?? 700 }, { family: SANS, weight: 800 }],
  layout(context) {
    const { graphic, lines, canvas, palette } = context;
    const size = graphic.fontSize, u = canvas.unit;
    const panel = palette.surface.alpha > .02, pad = panel ? size * .7 : 0;
    const item: V3Font = { family: graphic.fontFamily ?? SANS, weight: graphic.fontWeight ?? 700, size, letterSpacing: graphic.letterSpacing ?? 0, lineHeight: size * 1.3 };
    const radius = size * .56;
    const badge: V3Font = { family: SANS, weight: 800, size: size * .62, letterSpacing: 0, lineHeight: size * .62 * 1.2 };
    const gap = size * .5, rowGap = size * .5;
    const steps = lines.filter(line => line.trim());
    const max = Math.min(availableWidth(context, "left") - radius * 2 - gap - pad * 2, size * (canvas.portrait ? 11 : 16));
    const wrapped = steps.map(step => wrapText(step, item, max, 2));
    let y = 0;
    const rows: StepRow[] = wrapped.map(text => {
      const height = Math.max(radius * 2, text.length * item.lineHeight);
      const row = { text, widths: text.map(line => measureText(line, item)), top: y, height, center: y + Math.min(height, radius * 2) / 2 };
      y += height + rowGap;
      return row;
    });
    const height = y - rowGap;
    const width = radius * 2 + gap + Math.max(...rows.flatMap(row => row.widths));
    const box = placeBlock(context, width + pad * 2, height + pad * 2, "left");
    const top = box.y + pad;
    for (const row of rows) { row.top += top; row.center += top; }
    return { box, data: { item, badge, rows, badgeX: box.x + pad + radius, radius, textX: box.x + pad + radius * 2 + gap, connector: Math.max(2 * u, size * .05), panel } };
  },
  frame(context, layout, f) {
    const d = layout.data;
    const { durationFrames: total, fps, palette, canvas } = context;
    const u = canvas.unit, ops: V3Op[] = [], count = d.rows.length;
    if (d.panel) {
      const b = beat(f, total, fps, { enter: 18, exit: 12 });
      const radius = d.item.size * .3, presence = Math.min(1, b.enter * 1.5) * (1 - b.exit);
      const path = rounded(layout.box, radius);
      ops.push(panelShadow("panel:shadow", 0, path, u, presence));
      ops.push(shape("panel", 1, path, palette.surface, presence));
      ops.push(shape("panel:edge", 2, roundRectRingPath(layout.box.x, layout.box.y, layout.box.width, layout.box.height, radius, Math.max(1, u)), { color: "#FFFFFF", alpha: .1 }, presence));
    } else {
      const b = beat(f, total, fps, { enter: 16, exit: 12 });
      ops.push(scrim("scrim", layout.box, context, b.enter * (1 - b.exit)));
    }
    d.rows.forEach((row, index) => {
      const lead = count - 1 - index;
      const pop = beat(f, total, fps, { delay: 4 + index * 7, enter: 14, exit: 9, exitLead: lead * 2 });
      const scale = easeOutBack(pop.enterRaw, 2.2) * (1 - pop.exit);
      ops.push(shape(`badge:${index}`, 4, circlePath(d.badgeX, row.center, d.radius * scale), palette.accent));
      const digits = String(index + 1), digitWidth = measureText(digits, d.badge);
      const digitTop = opticalTop(d.badge, row.center);
      ops.push({ ...setText(`badge:${index}:n`, 5, d.badge, digits, d.badgeX - digitWidth / 2, digitTop, palette.onAccent, clamp01(pop.enterRaw * 2 - .4) * (1 - pop.exit)), scale: Math.max(.01, scale), x: d.badgeX - digitWidth / 2 * scale, y: row.center - (row.center - digitTop) * scale });
      if (index < count - 1) {
        const next = d.rows[index + 1];
        const from = row.center + d.radius + 6 * u, to = next.center - d.radius - 6 * u;
        const grow = easeInOutCubic(phase(f, frames(10 + index * 7, fps), frames(10, fps)));
        const shrink = beat(f, total, fps, { exit: 9, exitLead: lead * 2 }).exit;
        if (to > from) ops.push(shape(`connector:${index}`, 3, rectPath(d.badgeX - d.connector / 2, from + (to - from) * shrink, d.connector, (to - from) * grow * (1 - shrink)), palette.text, .38));
      }
      row.text.forEach((line, lineIndex) => {
        const b = beat(f, total, fps, { delay: 7 + index * 7 + lineIndex * 2, enter: 20, exit: 9, exitLead: lead * 2 });
        const top = row.top + (row.height - row.text.length * d.item.lineHeight) / 2 + lineIndex * d.item.lineHeight;
        const clip: V3Rect = { x: d.textX - d.item.size * .1, y: top - d.item.size * .1, width: (row.widths[lineIndex] + d.item.size * .4) * easeOutExpo(b.enterRaw) * (1 - b.exit), height: d.item.lineHeight + d.item.size * .2 };
        const op = setText(`step:${index}:${lineIndex}`, 5, d.item, line, d.textX + lerp(-16 * u, 0, b.enter), top, palette.text, Math.min(1, b.enter * 1.6) * (1 - b.exit * b.exit));
        if (!d.panel) ops.push({ ...textShadow(op, .5), clip: expand(clip, d.item.size * .2) });
        ops.push({ ...op, clip });
      });
    });
    return ops;
  },
});

interface CtaData { button: V3Font; detail: V3Font; detailText: string; pill: V3Rect; radius: number; icon: { x: number; y: number; size: number }; textX: number; textY: number; detailX: number; detailY: number }

const CURSOR: Array<[number, number]> = [[0, 0], [0, 1], [.27, .76], [.43, 1.1], [.58, 1.03], [.42, .7], [.76, .7]];

/** A call-to-action button: it pops in, a cursor clicks it, the plus turns into a check and a shine sweeps across. */
export const ctaSubscribe = defineTemplate<CtaData>({
  id: "cta_subscribe",
  align: "left",
  faces: graphic => [{ family: graphic.fontFamily ?? SANS, weight: graphic.fontWeight ?? 800 }, { family: SANS, weight: 500 }],
  layout(context) {
    const { graphic, lines, canvas } = context;
    const size = graphic.fontSize, u = canvas.unit;
    const button: V3Font = { family: graphic.fontFamily ?? SANS, weight: graphic.fontWeight ?? 800, size, letterSpacing: graphic.letterSpacing ?? size * .04, lineHeight: size * 1.25 };
    const detailSize = Math.max(20 * u, size * .5);
    const detail: V3Font = { family: SANS, weight: 500, size: detailSize, letterSpacing: detailSize * .04, lineHeight: detailSize * 1.45 };
    const detailText = lines[1] ?? "";
    const padX = size * .7, padY = size * .34, icon = size * .62, iconGap = size * .36;
    const textWidth = measureText(lines[0], button);
    const height = button.lineHeight + padY * 2;
    const pillWidth = padX * 2 + icon + iconGap + textWidth;
    const detailWidth = detailText ? measureText(detailText, detail) : 0;
    const portrait = canvas.portrait;
    const width = portrait ? Math.max(pillWidth, detailWidth) : pillWidth + (detailText ? size * .6 + detailWidth : 0);
    const totalHeight = portrait && detailText ? height + size * .4 + detail.lineHeight : height;
    const box = placeBlock(context, width, totalHeight, "left");
    const pill = { x: box.x, y: box.y, width: pillWidth, height };
    return {
      box,
      data: {
        button, detail, detailText, pill, radius: height / 2, icon: { x: pill.x + padX + icon / 2, y: pill.y + height / 2, size: icon },
        textX: pill.x + padX + icon + iconGap, textY: pill.y + padY,
        detailX: portrait ? box.x : pill.x + pillWidth + size * .6, detailY: portrait ? pill.y + height + size * .4 : pill.y + (height - detail.lineHeight) / 2,
      },
    };
  },
  frame(context, layout, f) {
    const d = layout.data;
    const { durationFrames: total, fps, palette, canvas } = context;
    const u = canvas.unit, ops: V3Op[] = [];
    const appear = beat(f, total, fps, { enter: 16, exit: 10, exitLead: 2, enterEase: t => easeOutBack(t, 1.8) });
    // The click lands ~0.9 s in, earlier on short graphics so it always resolves before the exit.
    const click = Math.min(frames(26, fps), Math.round(total * .42)), press = clamp01(1 - Math.abs(f - click) / frames(4, fps));
    const scale = Math.max(.01, appear.enter * (1 - .06 * press)) * (1 - appear.exit * .3);
    const alpha = clamp01(appear.enterRaw * 3) * (1 - appear.exit);
    const cx = d.pill.x + d.pill.width / 2, cy = d.pill.y + d.pill.height / 2;
    const body = scalePath(roundRectPath(d.pill.x, d.pill.y, d.pill.width, d.pill.height, d.radius), scale, scale, cx, cy);
    ops.push(panelShadow("button:shadow", 0, body, u, alpha, .9));
    ops.push(shape("button", 1, body, palette.accent, alpha));
    // Plus becomes a check on click.
    const turned = easeOutExpo(phase(f, click, frames(10, fps)));
    const ink = palette.onAccent, stroke = Math.max(2 * u, d.icon.size * .16);
    const iconX = cx + (d.icon.x - cx) * scale, iconY = cy + (d.icon.y - cy) * scale, arm = d.icon.size * .5 * scale;
    if (turned < 1) {
      const plus = [rectPath(iconX - arm, iconY - stroke / 2, arm * 2, stroke), rectPath(iconX - stroke / 2, iconY - arm, stroke, arm * 2)].flat();
      ops.push(shape("icon:plus", 3, scalePath(plus, 1 - turned, 1 - turned, iconX, iconY), ink, alpha));
    }
    if (turned > 0) {
      const check: Array<[number, number]> = [[iconX - arm * .8, iconY + arm * .05], [iconX - arm * .2, iconY + arm * .62], [iconX + arm * .9, iconY - arm * .55]];
      ops.push(shape("icon:check", 3, strokePolylinePath(truncatePolyline(check, polylineLength(check) * turned), stroke), ink, alpha));
    }
    const tb = beat(f, total, fps, { delay: 5, enter: 16, exit: 9, exitLead: 3 });
    const textClip: V3Rect = { x: d.pill.x, y: d.pill.y, width: d.pill.width, height: d.pill.height };
    const label = revealLine(setText("label", 3, d.button, context.lines[0], cx + (d.textX - cx) * scale, cy + (d.textY - cy) * scale, ink), tb.enter, tb.exit, textClip, d.button.lineHeight * .7);
    ops.push({ ...label, scale: Math.max(.01, scale) });
    // Click ripple, then a shine that crosses the button.
    const ripple = phase(f, click, frames(18, fps));
    if (ripple > 0 && ripple < 1) ops.push(shape("ripple", 2, ringPath(iconX, iconY, d.pill.height * lerp(.3, 1.6, easeOutExpo(ripple)), Math.max(1.5, 3 * u)), palette.accent, .6 * (1 - ripple) * (1 - appear.exit)));
    const shine = phase(f, click + frames(6, fps), frames(16, fps));
    if (shine > 0 && shine < 1) {
      const sx = d.pill.x - d.pill.height + (d.pill.width + d.pill.height * 2) * easeInOutCubic(shine), w = d.pill.height * .5;
      ops.push(shape("shine", 4, polygonPath([[sx, d.pill.y + d.pill.height], [sx + w, d.pill.y + d.pill.height], [sx + w + d.pill.height * .5, d.pill.y], [sx + d.pill.height * .5, d.pill.y]]), { color: "#FFFFFF", alpha: 1 }, .32 * alpha, { blur: 4 * u, clip: d.pill }));
    }
    // Cursor glides in, presses and leaves.
    const travel = easeOutExpo(phase(f, Math.max(0, click - frames(16, fps)), frames(14, fps))), leave = easeInOutCubic(phase(f, click + frames(10, fps), frames(14, fps)));
    if (travel > 0 && leave < 1) {
      const size = d.button.size * 1.05 * (1 - .12 * press);
      const tipX = lerp(iconX + d.pill.height * 1.6, iconX + d.icon.size * .1, travel) + d.pill.height * 1.2 * leave;
      const tipY = lerp(iconY + d.pill.height * 1.4, iconY + d.icon.size * .1, travel) + d.pill.height * .9 * leave;
      const points = CURSOR.map(([x, y]) => [tipX + x * size * .62, tipY + y * size * .62] as [number, number]);
      const fade = clamp01(travel * 3) * (1 - leave) * (1 - appear.exit);
      ops.push(shape("cursor:shadow", 5, polygonPath(points.map(([x, y]) => [x + 2 * u, y + 4 * u])), { color: "#000000", alpha: 1 }, .4 * fade, { blur: 4 * u }));
      ops.push(shape("cursor:edge", 6, polygonPath(points.map(([x, y]) => [tipX + (x - tipX) * 1.14 - size * .03, tipY + (y - tipY) * 1.12 - size * .05])), { color: "#0E1014", alpha: 1 }, fade));
      ops.push(shape("cursor", 7, polygonPath(points), { color: "#FFFFFF", alpha: 1 }, fade));
    }
    if (d.detailText) {
      const b = beat(f, total, fps, { delay: 12, enter: 18, exit: 9 });
      ops.push(scrim("scrim", { x: d.detailX, y: d.detailY, width: measureText(d.detailText, d.detail), height: d.detail.lineHeight }, context, b.enter * (1 - b.exit), .8));
      const op = setText("detail", 3, d.detail, d.detailText, d.detailX + lerp(-12 * u, 0, b.enter), d.detailY, dim(palette.text, .86), b.enter * (1 - b.exit));
      ops.push(textShadow(op, .55), op);
    }
    return ops;
  },
});
