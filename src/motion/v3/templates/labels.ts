import { beat, clamp01, easeInOutCubic, easeOutBack, easeOutExpo, frames, lerp, phase } from "../easing";
import { circlePath, ellipsePath, pathBounds, pinPath, polylineLength, ringPath, roundRectPath, roundRectRingPath, strokePolylinePath, truncatePolyline } from "../geometry";
import { dim, expand, panelShadow, placeBlock, revealLine, SANS, scrim, setText, shape, textShadow } from "../kit";
import { measureText, type V3Font } from "../textMetrics";
import { defineTemplate, type V3Context, type V3Op, type V3Paint, type V3Rect } from "../types";

/** A soft ring that leaves the dot every ~1.2 s while the label holds ("live" signal). */
function pulse(id: string, layer: number, f: number, start: number, end: number, fps: number, cx: number, cy: number, radius: number, fill: V3Paint, ops: V3Op[]): void {
  const period = frames(36, fps), life = frames(26, fps);
  if (f < start || f >= end) return;
  const t = ((f - start) % period) / life;
  if (t >= 1) return;
  const grow = easeOutExpo(t);
  ops.push(shape(id, layer, ringPath(cx, cy, radius * lerp(1, 2.7, grow), Math.max(1, radius * .26 * (1 - grow * .6))), fill, .55 * (1 - t)));
}

interface PillData { font: V3Font; pill: V3Rect; radius: number; dot: { x: number; y: number; r: number }; textX: number; textY: number; textWidth: number; filled: boolean }

/** Rounded tag with a live dot: an accent pill on bare footage, a quiet chip on a surface colour. */
export const tagPill = defineTemplate<PillData>({
  id: "tag_pill",
  align: "left",
  faces: graphic => [{ family: graphic.fontFamily ?? SANS, weight: graphic.fontWeight ?? 700 }],
  layout(context) {
    const { graphic, lines, palette } = context;
    const size = graphic.fontSize;
    const font: V3Font = { family: graphic.fontFamily ?? SANS, weight: graphic.fontWeight ?? 700, size, letterSpacing: graphic.letterSpacing ?? size * .04, lineHeight: size * 1.3 };
    const padX = size * .64, padY = size * .26, dotR = size * .17, dotGap = size * .4;
    const textWidth = measureText(lines[0], font);
    const height = font.lineHeight + padY * 2;
    const box = placeBlock(context, padX * 2 + dotR * 2 + dotGap + textWidth, height, "left");
    return {
      box,
      data: {
        font, pill: box, radius: height / 2, dot: { x: box.x + padX + dotR, y: box.y + height / 2, r: dotR },
        textX: box.x + padX + dotR * 2 + dotGap, textY: box.y + padY, textWidth, filled: palette.surface.alpha <= .02,
      },
    };
  },
  frame(context, layout, f) {
    const { font, pill, radius, dot, textX, textY, textWidth, filled } = layout.data;
    const { durationFrames: total, fps, palette, canvas } = context;
    const u = canvas.unit, ops: V3Op[] = [];
    const body = filled ? palette.accent : palette.surface;
    const ink = filled ? palette.onAccent : palette.text;
    const dotPaint = filled ? palette.onAccent : palette.accent;
    const b = beat(f, total, fps, { enter: 18, exit: 10, exitLead: 2 });
    const open = { ...pill, width: Math.max(pill.height, pill.width * b.enter) * (1 - b.exit) };
    const path = roundRectPath(pill.x, pill.y, pill.width, pill.height, radius);
    const clip = expand(open, 0, 2 * u);
    ops.push(panelShadow("pill:shadow", 0, path, u, Math.min(1, b.enter * 1.5) * (1 - b.exit), .6));
    ops.push(shape("pill", 1, path, body, Math.min(1, b.enter * 3), { clip }));
    if (!filled) ops.push(shape("pill:edge", 2, roundRectRingPath(pill.x, pill.y, pill.width, pill.height, radius, Math.max(1, u)), { color: "#FFFFFF", alpha: .12 }, Math.min(1, b.enter * 3), { clip }));
    const pop = beat(f, total, fps, { delay: 4, enter: 14, exit: 8, exitLead: 4 });
    ops.push(shape("dot", 4, circlePath(dot.x, dot.y, dot.r * easeOutBack(pop.enterRaw, 2.6) * (1 - pop.exit)), dotPaint));
    pulse("dot:pulse", 3, f, frames(16, fps), total - frames(18, fps), fps, dot.x, dot.y, dot.r, dotPaint, ops);
    const tb = beat(f, total, fps, { delay: 6, enter: 18, exit: 9, exitLead: 3 });
    const textClip: V3Rect = { x: textX - font.size * .1, y: pill.y, width: textWidth + font.size * .3, height: pill.height };
    ops.push(revealLine(setText("label", 5, font, context.lines[0], textX, textY, ink), tb.enter, tb.exit, textClip, font.lineHeight * .8));
    return ops;
  },
});

interface PinData { name: V3Font; detail: V3Font; detailText: string; pin: { cx: number; cy: number; r: number; tip: number }; textX: number; nameY: number; detailY: number; nameWidth: number; card?: V3Rect }

/** A map pin drops in with a contact shadow, then the place name wipes on beside it. */
export const locationPin = defineTemplate<PinData>({
  id: "location_pin",
  align: "left",
  faces: graphic => [{ family: graphic.fontFamily ?? SANS, weight: graphic.fontWeight ?? 800 }, { family: SANS, weight: 500 }],
  layout(context) {
    const { graphic, lines, palette } = context;
    const size = graphic.fontSize;
    const name: V3Font = { family: graphic.fontFamily ?? SANS, weight: graphic.fontWeight ?? 800, size, letterSpacing: graphic.letterSpacing ?? 0, lineHeight: size * 1.22 };
    const detailSize = size * .5;
    const detail: V3Font = { family: SANS, weight: 500, size: detailSize, letterSpacing: detailSize * .08, lineHeight: detailSize * 1.5 };
    const detailText = lines[1] ?? "";
    const card = palette.surface.alpha > .02;
    const pad = card ? { x: size * .5, y: size * .36 } : { x: 0, y: 0 };
    const r = size * .34, pinHeight = size * 1.16, gap = size * .42;
    const nameWidth = measureText(lines[0], name);
    const textHeight = name.lineHeight + (detailText ? detail.lineHeight : 0);
    const contentHeight = Math.max(textHeight, pinHeight + size * .1);
    const width = pad.x * 2 + r * 2 + gap + Math.max(nameWidth, detailText ? measureText(detailText, detail) : 0);
    const box = placeBlock(context, width, contentHeight + pad.y * 2, "left");
    const top = box.y + pad.y + (contentHeight - textHeight) / 2;
    const pinTop = top + name.lineHeight / 2 - r * 1.15;
    return {
      box,
      data: {
        name, detail, detailText, pin: { cx: box.x + pad.x + r, cy: pinTop + r, r, tip: pinTop + pinHeight }, textX: box.x + pad.x + r * 2 + gap,
        nameY: top, detailY: top + name.lineHeight, nameWidth, card: card ? box : undefined,
      },
    };
  },
  frame(context, layout, f) {
    const { name, detail, detailText, pin, textX, nameY, detailY, nameWidth, card } = layout.data;
    const { durationFrames: total, fps, palette, canvas } = context;
    const u = canvas.unit, ops: V3Op[] = [];
    if (card) {
      const b = beat(f, total, fps, { enter: 18, exit: 11 });
      const radius = Math.min(card.height / 2, name.size * .32), lift = lerp(10 * u, 0, b.enter);
      const path = roundRectPath(card.x, card.y + lift, card.width, card.height, radius);
      const presence = Math.min(1, b.enter * 1.5) * (1 - b.exit);
      ops.push(panelShadow("card:shadow", 0, path, u, presence));
      ops.push(shape("card", 1, path, palette.surface, presence));
      ops.push(shape("card:edge", 2, roundRectRingPath(card.x, card.y + lift, card.width, card.height, radius, Math.max(1, u)), { color: "#FFFFFF", alpha: .12 }, presence));
    } else {
      const b = beat(f, total, fps, { delay: 4, enter: 16, exit: 12 });
      ops.push(scrim("scrim", { x: textX, y: nameY, width: Math.max(nameWidth, detailText ? measureText(detailText, detail) : 0), height: detailText ? detailY + detail.lineHeight - nameY : name.lineHeight }, context, b.enter * (1 - b.exit)));
    }
    const drop = beat(f, total, fps, { delay: 2, enter: 20, exit: 10, exitLead: 4, enterEase: t => easeOutBack(t, 1.4) });
    const dy = lerp(-pin.r * 3.2, 0, drop.enter) - pin.r * 1.4 * drop.exit, alpha = clamp01(drop.enterRaw * 3) * (1 - drop.exit);
    const landed = clamp01(drop.enter);
    ops.push(shape("pin:shadow", 3, ellipsePath(pin.cx, pin.tip, pin.r * .9 * lerp(.35, 1, landed), pin.r * .26 * lerp(.35, 1, landed)), { color: "#000000", alpha: 1 }, .45 * alpha, { blur: Math.max(1.5, pin.r * .16) }));
    ops.push(shape("pin", 4, pinPath(pin.cx, pin.cy + dy, pin.r, pin.tip + dy, pin.r * .38), palette.accent, alpha));
    const wipe = easeOutExpo(phase(f, frames(9, fps), frames(22, fps)));
    const tb = beat(f, total, fps, { delay: 9, enter: 22, exit: 10, exitLead: 2 });
    const nameClip: V3Rect = { x: textX - name.size * .1, y: nameY - name.size * .12, width: (nameWidth + name.size * .4) * wipe * (1 - tb.exit), height: name.lineHeight + name.size * .24 };
    const nameOp = setText("place", 6, name, context.lines[0], textX + lerp(-14 * u, 0, tb.enter), nameY, palette.text, Math.min(1, tb.enter * 2) * (1 - tb.exit * tb.exit));
    if (!card) ops.push({ ...textShadow(nameOp, .55), clip: expand(nameClip, name.size * .2) });
    ops.push({ ...nameOp, clip: nameClip });
    if (detailText) {
      const b = beat(f, total, fps, { delay: 15, enter: 18, exit: 9 });
      const op = setText("detail", 6, detail, detailText, textX, detailY + lerp(8 * u, 0, b.enter), dim(palette.text, .72), b.enter * (1 - b.exit));
      if (!card) ops.push(textShadow(op, .55));
      ops.push(op);
    }
    return ops;
  },
});

interface CalloutData {
  label: V3Font; detail: V3Font; detailText: string; dot: { x: number; y: number; r: number };
  points: Array<[number, number]>; length: number; stroke: number; textX: number; labelY: number; detailY: number;
  lineY: number; labelWidth: number; detailWidth: number; toLeft: boolean;
}

function calloutGeometry(context: V3Context, toLeft: boolean, up: boolean) {
  const { graphic, canvas } = context;
  const size = graphic.fontSize;
  const dot = { x: graphic.x * canvas.width, y: graphic.y * canvas.height };
  const run = size * 1.05, sx = toLeft ? -1 : 1, sy = up ? -1 : 1;
  const elbow: [number, number] = [dot.x + sx * run * .72, dot.y + sy * run * .72];
  return { dot, elbow, sx, sy };
}

/** Points at something in frame: a target dot, a leader line that draws out, and its label. */
export const calloutLine = defineTemplate<CalloutData>({
  id: "callout_line",
  align: "left",
  faces: graphic => [{ family: graphic.fontFamily ?? SANS, weight: graphic.fontWeight ?? 700 }, { family: SANS, weight: 500 }],
  layout(context) {
    const { graphic, lines, canvas } = context;
    const size = graphic.fontSize, u = canvas.unit;
    const label: V3Font = { family: graphic.fontFamily ?? SANS, weight: graphic.fontWeight ?? 700, size, letterSpacing: graphic.letterSpacing ?? 0, lineHeight: size * 1.25 };
    const detailSize = size * .52;
    const detail: V3Font = { family: SANS, weight: 500, size: detailSize, letterSpacing: detailSize * .04, lineHeight: detailSize * 1.45 };
    const detailText = lines[1] ?? "";
    const labelWidth = measureText(lines[0], label), detailWidth = detailText ? measureText(detailText, detail) : 0;
    const shelf = Math.max(labelWidth, detailWidth) + size * .3;
    const safe = canvas.safe;
    const fits = (toLeft: boolean, up: boolean) => {
      const { elbow, sx } = calloutGeometry(context, toLeft, up);
      const end = elbow[0] + sx * shelf;
      const top = elbow[1] - label.lineHeight - size * .1, bottom = elbow[1] + (detailText ? detail.lineHeight + size * .1 : 0);
      return Math.min(elbow[0], end) >= safe.x && Math.max(elbow[0], end) <= safe.x + safe.width && top >= safe.y && bottom <= safe.y + safe.height;
    };
    const preferLeft = graphic.x > .6, preferUp = graphic.y > .3;
    const options: Array<[boolean, boolean]> = [[preferLeft, preferUp], [!preferLeft, preferUp], [preferLeft, !preferUp], [!preferLeft, !preferUp]];
    const [toLeft, up] = options.find(([left, upward]) => fits(left, upward)) ?? options[0];
    const { dot, elbow, sx } = calloutGeometry(context, toLeft, up);
    const end: [number, number] = [elbow[0] + sx * shelf, elbow[1]];
    const points: Array<[number, number]> = [[dot.x, dot.y], elbow, end];
    const textX = toLeft ? end[0] + size * .15 : elbow[0] + size * .15;
    const labelY = elbow[1] - size * .14 - label.lineHeight, detailY = elbow[1] + size * .16;
    const stroke = Math.max(2 * u, size * .045);
    const bounds = pathBounds([{ op: "m", points: [dot.x, dot.y] }, { op: "l", points: [end[0], labelY] }, { op: "l", points: [end[0], detailText ? detailY + detail.lineHeight : elbow[1]] }])!;
    return {
      box: bounds,
      data: { label, detail, detailText, dot: { ...dot, r: size * .15 }, points, length: polylineLength(points), stroke, textX, labelY, detailY, lineY: elbow[1], labelWidth, detailWidth, toLeft },
    };
  },
  frame(context, layout, f) {
    const d = layout.data;
    const { durationFrames: total, fps, palette } = context;
    const ops: V3Op[] = [];
    const pop = beat(f, total, fps, { enter: 12, exit: 8, exitLead: 0 });
    ops.push(shape("dot:halo", 1, circlePath(d.dot.x, d.dot.y, d.dot.r * 2.2 * easeOutExpo(pop.enterRaw) * (1 - pop.exit)), palette.accent, .22));
    ops.push(shape("dot", 3, circlePath(d.dot.x, d.dot.y, d.dot.r * easeOutBack(pop.enterRaw, 2.4) * (1 - pop.exit)), palette.accent));
    pulse("dot:pulse", 2, f, frames(12, fps), total - frames(16, fps), fps, d.dot.x, d.dot.y, d.dot.r, palette.accent, ops);
    const draw = easeInOutCubic(phase(f, frames(5, fps), frames(18, fps)));
    const retract = beat(f, total, fps, { exit: 12, exitLead: 2 }).exit;
    const visible = truncatePolyline(d.points, d.length * draw * (1 - retract));
    ops.push(shape("leader:shadow", 1, strokePolylinePath(visible, d.stroke), { color: "#000000", alpha: 1 }, .35, { blur: d.stroke * 1.2 }));
    ops.push(shape("leader", 2, strokePolylinePath(visible, d.stroke), palette.text, .95));
    const lb = beat(f, total, fps, { delay: 15, enter: 18, exit: 9, exitLead: 3 });
    const textBottom = d.detailText ? d.detailY + d.detail.lineHeight : d.lineY;
    ops.push(scrim("scrim", { x: d.textX, y: d.labelY, width: Math.max(d.labelWidth, d.detailWidth), height: textBottom - d.labelY }, context, lb.enter * (1 - lb.exit)));
    const labelClip: V3Rect = { x: d.textX - d.label.size * .2, y: d.labelY - d.label.size * .2, width: d.labelWidth + d.label.size * .5, height: d.lineY - d.labelY + d.label.size * .2 - d.stroke };
    const labelOp = revealLine(setText("label", 5, d.label, context.lines[0], d.textX, d.labelY, palette.text), lb.enter, lb.exit, labelClip, d.label.lineHeight * .9);
    ops.push({ ...textShadow(labelOp, .55), clip: expand(labelClip, d.label.size * .2, 0) }, labelOp);
    if (d.detailText) {
      const db = beat(f, total, fps, { delay: 18, enter: 18, exit: 9, exitLead: 1 });
      const detailClip: V3Rect = { x: d.textX - d.detail.size * .2, y: d.lineY + d.stroke, width: d.detailWidth + d.detail.size * .5, height: d.detail.lineHeight + d.detail.size * .6 };
      const detailOp = revealLine(setText("detail", 5, d.detail, d.detailText, d.textX, d.detailY, dim(palette.text, .78)), db.enter, db.exit, detailClip, -d.detail.lineHeight);
      ops.push({ ...textShadow(detailOp, .55), clip: expand(detailClip, d.detail.size * .2, 0) }, detailOp);
    }
    return ops;
  },
});

