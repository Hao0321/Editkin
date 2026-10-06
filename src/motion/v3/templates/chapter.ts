import { beat, easeOutExpo, frames, lerp, phase } from "../easing";
import { rectPath, roundRectRingPath } from "../geometry";
import { availableWidth, dim, DISPLAY, expand, mixedRuns, panelShadow, placeBlock, revealLine, rounded, SANS, scrim, setText, shape, textShadow } from "../kit";
import { baselineOffset, measureText, wrapText, type V3Font } from "../textMetrics";
import { defineTemplate, type V3Op, type V3Rect } from "../types";

interface ChapterData {
  number: V3Font; numberRuns: Array<{ text: string; font: V3Font; width: number }>; numberWidth: number; numberTop: number;
  title: V3Font; titleLines: string[]; titleWidths: number[]; titleTop: number;
  sub: V3Font; subText: string; subTop: number;
  divider: V3Rect; textX: number; left: number; panel: boolean;
}

/** Oversized chapter figure, a divider that draws down, and the chapter title beside it. */
export const chapterNumber = defineTemplate<ChapterData>({
  id: "chapter_number",
  align: "left",
  faces: graphic => [{ family: DISPLAY, weight: 400 }, { family: SANS, weight: 800 }, { family: graphic.fontFamily ?? SANS, weight: graphic.fontWeight ?? 800 }, { family: SANS, weight: 500 }],
  layout(context) {
    const { graphic, lines, canvas, palette } = context;
    const size = graphic.fontSize, u = canvas.unit;
    const panel = palette.surface.alpha > .02;
    const pad = panel ? size * .55 : 0;
    const number: V3Font = { family: DISPLAY, weight: 400, size: size * 2.6, letterSpacing: size * .03, lineHeight: size * 2.6 };
    const numberFallback: V3Font = { family: SANS, weight: 800, size: number.size * .74, letterSpacing: 0, lineHeight: number.size * .74 * 1.2 };
    const numberRuns = mixedRuns(lines[0], number, numberFallback);
    const numberWidth = numberRuns.reduce((sum, run) => sum + run.width, 0);
    const title: V3Font = { family: graphic.fontFamily ?? SANS, weight: graphic.fontWeight ?? 800, size, letterSpacing: graphic.letterSpacing ?? 0, lineHeight: size * 1.22 };
    const subSize = Math.max(18 * u, size * .5);
    const sub: V3Font = { family: SANS, weight: 500, size: subSize, letterSpacing: subSize * .06, lineHeight: subSize * 1.5 };
    const gap = size * .46, dividerWidth = Math.max(2 * u, size * .045);
    const textOffset = numberWidth + gap * 2 + dividerWidth;
    const titleLines = wrapText(lines[1], title, Math.min(size * 14, availableWidth(context, "left") - textOffset - pad * 2), 2);
    const titleWidths = titleLines.map(line => measureText(line, title));
    const subText = lines[2] ?? "";
    const textHeight = titleLines.length * title.lineHeight + (subText ? size * .12 + sub.lineHeight : 0);
    // Figures stand on the baseline at ~0.7 em cap height; centre the text block on them.
    const capHeight = number.size * .7, capTop = baselineOffset(number) - capHeight;
    const blockTop = Math.min(capTop, capTop + (capHeight - textHeight) / 2);
    const blockBottom = Math.max(capTop + capHeight, capTop + (capHeight + textHeight) / 2);
    const width = textOffset + Math.max(...titleWidths, subText ? measureText(subText, sub) : 0);
    const box = placeBlock(context, width + pad * 2, blockBottom - blockTop + pad * 2, "left");
    const shift = box.y + pad - blockTop, left = box.x + pad;
    const textTop = shift + capTop + (capHeight - textHeight) / 2;
    return {
      box,
      data: {
        number, numberRuns, numberWidth, numberTop: shift,
        title, titleLines, titleWidths, titleTop: textTop,
        sub, subText, subTop: textTop + titleLines.length * title.lineHeight + size * .12,
        divider: { x: left + numberWidth + gap, y: shift + capTop, width: dividerWidth, height: capHeight },
        textX: left + textOffset, left, panel,
      },
    };
  },
  frame(context, layout, f) {
    const d = layout.data;
    const { durationFrames: total, fps, palette, canvas } = context;
    const u = canvas.unit, ops: V3Op[] = [];
    if (d.panel) {
      const b = beat(f, total, fps, { enter: 18, exit: 12 });
      const radius = d.title.size * .18, path = rounded(layout.box, radius);
      const clip = expand({ ...layout.box, width: layout.box.width * b.enter * (1 - b.exit) }, 0, 4 * u);
      ops.push(panelShadow("panel:shadow", 0, path, u, b.enter * (1 - b.exit)));
      ops.push(shape("panel", 1, path, palette.surface, 1, { clip }));
      ops.push(shape("panel:edge", 2, roundRectRingPath(layout.box.x, layout.box.y, layout.box.width, layout.box.height, radius, Math.max(1, u)), { color: "#FFFFFF", alpha: .1 }, 1, { clip }));
    } else {
      const b = beat(f, total, fps, { enter: 16, exit: 12 });
      ops.push(scrim("scrim", layout.box, context, b.enter * (1 - b.exit)));
    }
    const nb = beat(f, total, fps, { delay: 2, enter: 24, exit: 11, exitLead: 4 });
    const numberClip: V3Rect = { x: d.left - d.number.size * .1, y: d.divider.y - d.number.size * .08, width: d.numberWidth + d.number.size * .2, height: d.divider.height + d.number.size * .16 };
    let x = d.left;
    d.numberRuns.forEach((run, index) => {
      const y = d.numberTop + baselineOffset(d.number) - baselineOffset(run.font);
      ops.push(revealLine(setText(`number:${index}`, 4, run.font, run.text, x, y, palette.accent), nb.enter, nb.exit, numberClip, d.divider.height * 1.1));
      x += run.width;
    });
    const db = beat(f, total, fps, { delay: 8, enter: 18, exit: 10, exitLead: 2 });
    const dividerHeight = d.divider.height * db.enter * (1 - db.exit);
    ops.push(shape("divider", 3, rectPath(d.divider.x, d.divider.y + d.divider.height * db.exit, d.divider.width, dividerHeight), palette.text, .85));
    d.titleLines.forEach((line, index) => {
      const b = beat(f, total, fps, { delay: 11 + index * 3, enter: 22, exit: 10, exitLead: 1 });
      const top = d.titleTop + index * d.title.lineHeight;
      const reveal = easeOutExpo(phase(f, frames(11 + index * 3, fps), frames(22, fps)));
      const clip: V3Rect = { x: d.textX - d.title.size * .1, y: top - d.title.size * .1, width: (d.titleWidths[index] + d.title.size * .3) * reveal, height: d.title.lineHeight + d.title.size * .2 };
      const op = setText(`title:${index}`, 5, d.title, line, d.textX + lerp(-18 * u, 0, b.enter) - 24 * u * b.exit, top, palette.text, Math.min(1, b.enter * 2) * (1 - b.exit));
      if (!d.panel) ops.push({ ...textShadow(op, .5), clip: expand(clip, d.title.size * .2) });
      ops.push({ ...op, clip });
    });
    if (d.subText) {
      const b = beat(f, total, fps, { delay: 17, enter: 18, exit: 9 });
      const op = setText("subtitle", 5, d.sub, d.subText, d.textX, d.subTop + lerp(10 * u, 0, b.enter), dim(palette.text, .74), b.enter * (1 - b.exit));
      if (!d.panel) ops.push(textShadow(op, .5));
      ops.push(op);
    }
    return ops;
  },
});
