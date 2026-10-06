import { beat, easeOutBack, lerp } from "../easing";
import { circlePath, rectPath, roundRectPath, roundRectRingPath } from "../geometry";
import { expand, panelShadow, placeBlock, revealLine, SANS, scrim, shape, text, textShadow } from "../kit";
import { measureText, type V3Font } from "../textMetrics";
import { defineTemplate, type V3Op, type V3Rect } from "../types";

interface NameRole { name: V3Font; role: V3Font; roleText: string; nameWidth: number; roleWidth: number }

function nameRoleFonts(graphic: { fontFamily?: string; fontWeight?: number; fontSize: number; letterSpacing?: number }, roleText: string, nameText: string): NameRole {
  const size = graphic.fontSize, roleSize = size * .56;
  const name: V3Font = { family: graphic.fontFamily ?? SANS, weight: graphic.fontWeight ?? 800, size, letterSpacing: graphic.letterSpacing ?? 0, lineHeight: size * 1.24 };
  const role: V3Font = { family: SANS, weight: 500, size: roleSize, letterSpacing: roleSize * .04, lineHeight: roleSize * 1.45 };
  return { name, role, roleText, nameWidth: measureText(nameText, name), roleWidth: roleText ? measureText(roleText, role) : 0 };
}

interface BarData extends NameRole { panel: boolean; bar: V3Rect; textX: number; nameY: number; roleY: number; panelRect: V3Rect }

/** Accent bar grows, a panel wipes open beside it and name / role rise into place. */
export const lowerThirdBar = defineTemplate<BarData>({
  id: "lower_third_bar",
  align: "left",
  faces: graphic => [{ family: graphic.fontFamily ?? SANS, weight: graphic.fontWeight ?? 800 }, { family: SANS, weight: 500 }],
  layout(context) {
    const { graphic, lines, palette, canvas } = context;
    const fonts = nameRoleFonts(graphic, lines[1] ?? "", lines[0]);
    const size = graphic.fontSize, u = canvas.unit;
    const panel = palette.surface.alpha > .02;
    const barWidth = Math.max(4 * u, size * .11), gap = size * .42, padX = panel ? size * .5 : 0, padY = panel ? size * .28 : 0;
    const textHeight = fonts.name.lineHeight + (fonts.roleText ? fonts.role.lineHeight : 0);
    const width = barWidth + gap + Math.max(fonts.nameWidth, fonts.roleWidth) + padX;
    const box = placeBlock(context, width, textHeight + padY * 2, "left");
    const bar = { x: box.x, y: box.y, width: barWidth, height: box.height };
    const textX = box.x + barWidth + gap;
    return { box, data: { ...fonts, panel, bar, textX, nameY: box.y + padY, roleY: box.y + padY + fonts.name.lineHeight, panelRect: { x: box.x + barWidth, y: box.y, width: box.width - barWidth, height: box.height } } };
  },
  frame(context, layout, f) {
    const { name, role, roleText, nameWidth, roleWidth, panel, bar, textX, nameY, roleY, panelRect } = layout.data;
    const { durationFrames: total, fps, palette, canvas, lines } = context;
    const ops: V3Op[] = [];
    const barBeat = beat(f, total, fps, { enter: 14, exit: 10, exitLead: 0 });
    const barHeight = bar.height * barBeat.enter * (1 - barBeat.exit);
    ops.push(shape("bar", 4, rectPath(bar.x, bar.y + bar.height * barBeat.exit, bar.width, barHeight), palette.accent));
    if (panel) {
      const b = beat(f, total, fps, { delay: 3, enter: 18, exit: 10, exitLead: 2 });
      const path = roundRectPath(panelRect.x, panelRect.y, panelRect.width, panelRect.height, [0, name.size * .14, name.size * .14, 0]);
      const visible = { ...panelRect, width: panelRect.width * b.enter * (1 - b.exit) };
      ops.push(panelShadow("panel:shadow", 0, path, canvas.unit, b.enter * (1 - b.exit), .8));
      ops.push(shape("panel", 1, path, palette.surface, 1, { clip: expand(visible, 0, 2) }));
    } else {
      ops.push(scrim("scrim", layout.box, context, barBeat.enter * (1 - barBeat.exit)));
    }
    const rows: Array<[string, string, V3Font, number, number, number]> = [["name", lines[0], name, nameY, nameWidth, 6]];
    if (roleText) rows.push(["role", roleText, role, roleY, roleWidth, 10]);
    rows.forEach(([id, copy, font, y, width, delay], index) => {
      const b = beat(f, total, fps, { delay, enter: 20, exit: 10, exitLead: 4 + (rows.length - 1 - index) * 2 });
      const clip: V3Rect = { x: textX - font.size * .2, y: y - font.size * .04, width: width + font.size * .4, height: font.lineHeight + font.size * .08 };
      const color = id === "role" ? { color: palette.text.color, alpha: palette.text.alpha * .74 } : palette.text;
      const op = revealLine(text(id, 6, { text: copy, x: textX, y, lineHeight: font.lineHeight, fontFamily: font.family, fontWeight: font.weight, fontSize: font.size, letterSpacing: font.letterSpacing, color: color.color, opacity: color.alpha }), b.enter, b.exit, clip);
      if (!panel) ops.push({ ...textShadow(op, .55), clip: expand(clip, font.size * .25) });
      ops.push(op);
    });
    return ops;
  },
});

interface GlassData extends NameRole { card: V3Rect; radius: number; dot: { x: number; y: number; r: number }; textX: number; nameY: number; roleY: number }

/** Frosted card that floats up with a soft shadow, accent dot and stacked name / role. */
export const lowerThirdGlass = defineTemplate<GlassData>({
  id: "lower_third_glass",
  align: "left",
  faces: graphic => [{ family: graphic.fontFamily ?? SANS, weight: graphic.fontWeight ?? 700 }, { family: SANS, weight: 500 }],
  layout(context) {
    const { graphic, lines } = context;
    const fonts = nameRoleFonts({ ...graphic, fontWeight: graphic.fontWeight ?? 700 }, lines[1] ?? "", lines[0]);
    const size = graphic.fontSize;
    const padX = size * .6, padY = size * .42, dotR = size * .15, dotGap = size * .42;
    const textHeight = fonts.name.lineHeight + (fonts.roleText ? fonts.role.lineHeight : 0);
    const width = padX * 2 + dotR * 2 + dotGap + Math.max(fonts.nameWidth, fonts.roleWidth);
    const box = placeBlock(context, width, textHeight + padY * 2, "left");
    const textX = box.x + padX + dotR * 2 + dotGap;
    return { box, data: { ...fonts, card: box, radius: Math.min(box.height / 2, size * .38), dot: { x: box.x + padX + dotR, y: box.y + padY + fonts.name.lineHeight / 2, r: dotR }, textX, nameY: box.y + padY, roleY: box.y + padY + fonts.name.lineHeight } };
  },
  frame(context, layout, f) {
    const { name, role, roleText, nameWidth, roleWidth, card, radius, dot, textX, nameY, roleY } = layout.data;
    const { durationFrames: total, fps, palette, canvas, lines } = context;
    const u = canvas.unit, ops: V3Op[] = [];
    const b = beat(f, total, fps, { enter: 20, exit: 11, exitLead: 0 });
    const lift = lerp(14 * u, 0, b.enter) + 8 * u * b.exit, presence = Math.min(1, b.enter * 1.4) * (1 - b.exit);
    const body = roundRectPath(card.x, card.y + lift, card.width, card.height, radius);
    if (palette.surface.alpha <= .02) ops.push(scrim("scrim", { ...card, y: card.y + lift }, context, presence));
    else ops.push(panelShadow("card:shadow", 0, body, u, presence));
    if (palette.surface.alpha > .02) {
      ops.push(shape("card", 1, body, palette.surface, presence));
      ops.push(shape("card:edge", 2, roundRectRingPath(card.x, card.y + lift, card.width, card.height, radius, Math.max(1, 1.2 * u)), { color: "#FFFFFF", alpha: .14 }, presence));
    }
    const pop = beat(f, total, fps, { delay: 6, enter: 14, exit: 9, exitLead: 4 });
    ops.push(shape("dot", 3, circlePath(dot.x, dot.y + lift, dot.r * easeOutBack(pop.enterRaw, 2.4) * (1 - pop.exit)), palette.accent));
    const rows: Array<[string, string, V3Font, number, number, number]> = [["name", lines[0], name, nameY, nameWidth, 7]];
    if (roleText) rows.push(["role", roleText, role, roleY, roleWidth, 11]);
    rows.forEach(([id, copy, font, y, width, delay], index) => {
      const rb = beat(f, total, fps, { delay, enter: 20, exit: 9, exitLead: 2 + (rows.length - 1 - index) * 2 });
      const clip: V3Rect = { x: textX - font.size * .2, y: y + lift - font.size * .04, width: width + font.size * .4, height: font.lineHeight + font.size * .08 };
      const color = id === "role" ? { color: palette.text.color, alpha: palette.text.alpha * .72 } : palette.text;
      ops.push(revealLine(text(id, 5, { text: copy, x: textX, y: y + lift, lineHeight: font.lineHeight, fontFamily: font.family, fontWeight: font.weight, fontSize: font.size, letterSpacing: font.letterSpacing, color: color.color, opacity: color.alpha * presence }), rb.enter, rb.exit, clip, font.lineHeight * .8));
    });
    return ops;
  },
});
