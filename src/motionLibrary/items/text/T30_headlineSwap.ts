import { relativeLuminance } from "../../svg/color";
import { g, path, rect, transform, tf } from "../../svg/document";
import { clamp01, expoIn, expoInOut, expoOut } from "../../svg/easing";
import { layoutLine, type GlyphBox, type LineLayout } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  createTextDocument, displayTracking, heroTextBox, itemTiming, readableColor, secondaryTone, textBackdrop, textFace, textOnBackground, titleSafeBox,
} from "../shared";

/**
 * T30 Headline Swap (見出し切替), SWITCH: a news bar. Line 1 is the label (快報),
 * set in a block; every further line is a headline (正式發表) on a cream band with
 * accent rules above and below it (ART_DIRECTION §0). The block is the reference's
 * ink block wherever ink reads against the backdrop (accent or cream plates) and
 * the accent on the dark card, where ink would vanish; the band turns dark on a
 * cream plate. In: the rules draw out left to right (expoOut, 0.4 s), the band wipes
 * in behind them, the label block comes in with the band, and the first headline
 * slides up into the band. Headlines swap by sliding up through the band (the old
 * one leaves upwards as the new one rises in, 0.45 s, expoInOut), evenly spaced
 * through the clip (the default label and three headlines in 4.5 s swap about every
 * 1.2 s; longer clips space them out). Out: the headline slides up away,
 * then the band and its rules wipe off to the right. A landscape frame sets the
 * label block inline at the band's left end; portrait and square frames stand it on
 * the band as a tab, so the headline gets the full width. A single line is a
 * headline with no label. Times are standard-energy seconds, scaled by energy and
 * squeezed into short clips.
 */

const ID = "T30";
/** Art revision (part of the clip cache key): 1 = first render. */
const REVISION = 1;
const RULES_IN = 0.4, BAND_DELAY = 0.04, BAND_IN = 0.42, LABEL_DELAY = 0.1, HEADLINE_DELAY = 0.26, HEADLINE_IN = 0.42;
const SWAP = 0.45, MIN_HOLD = 0.9, HEADLINE_OUT = 0.26, BAND_OUT = 0.32, TAIL = 0.08;
/** Geometry in headline font sizes: label size, band height, paddings, rule thickness and gap, tab height. */
const LABEL_RATIO = 0.72, BAND = 1.5, LABEL_PAD = 0.34, HEADLINE_PAD = 0.5, RULE = 0.075, RULE_GAP = 0.06, TAB = 1.2;

export interface HeadlineSwapLayout {
  readonly mode: "inline" | "tab";
  readonly headlineSize: number;
  readonly label?: { readonly layout: LineLayout; readonly x: number; readonly y: number; readonly block: GlyphBox };
  readonly headlines: ReadonlyArray<{ readonly layout: LineLayout; readonly x: number; readonly y: number }>;
  /** The cream band and its rules (frame px). */
  readonly band: GlyphBox;
  readonly ruleTop: GlyphBox;
  readonly ruleBottom: GlyphBox;
  /** Clip seconds: headline k is up from swaps[k − 1] (or its entrance) until swaps[k]; swaps[last] is the exit. */
  readonly swaps: readonly number[];
  readonly timeScale: number;
  /** Everything at the hold (frame px). */
  readonly box: GlyphBox;
}

/** Bar geometry and the swap schedule (shared by the generator and its tests). */
export function headlineSwapLayout(params: TextMotionParams, size: MotionFrameSize): HeadlineSwapLayout {
  const labelText = params.lines.length > 1 ? params.lines[0].trim() : "";
  const headlineTexts = (params.lines.length > 1 ? params.lines.slice(1) : params.lines).map(line => line.trim());
  const count = headlineTexts.length;
  const motion = HEADLINE_DELAY + HEADLINE_IN + SWAP * (count - 1) + HEADLINE_OUT + BAND_OUT + TAIL;
  const { timeScale } = itemTiming(params.energy, params.durationSeconds, motion + MIN_HOLD * count);
  const hold = Math.max(0, (params.durationSeconds - motion * timeScale) / count);
  const swaps: number[] = [];
  let clock = (HEADLINE_DELAY + HEADLINE_IN) * timeScale;
  for (let index = 0; index < count; index += 1) {
    clock += hold;
    swaps.push(clock);
    clock += SWAP * timeScale;
  }
  const face = textFace(params.font, 900);
  const tracking = displayTracking(headlineTexts);
  const head100 = headlineTexts.map(text => layoutLine(text, { ...face, size: 100, tracking }));
  const label100 = labelText ? layoutLine(labelText, { ...face, size: 100 * LABEL_RATIO, tracking: displayTracking([labelText]) }) : undefined;
  const inkWidth = (line: LineLayout | undefined) => (line?.inkBox ? line.inkBox.x1 - line.inkBox.x0 : 0);
  const headlineArea = Math.max(...head100.map(inkWidth)) + 2 * HEADLINE_PAD * 100;
  const labelBlock = label100 ? inkWidth(label100) + 2 * LABEL_PAD * 100 : 0;
  const barHeight = (BAND + 2 * (RULE + RULE_GAP)) * 100;
  const hero = heroTextBox(size);
  const inlineScale = Math.min(hero.maxWidth / (labelBlock + headlineArea), hero.maxHeight / barHeight);
  const tabScale = label100 ? Math.min(hero.maxWidth / Math.max(headlineArea, labelBlock), hero.maxHeight / (barHeight + TAB * LABEL_RATIO * 100)) : 0;
  // Portrait and square frames stand the label on the band as a tab when that sets the headline larger.
  const mode: "inline" | "tab" = size.height >= size.width && tabScale > inlineScale ? "tab" : "inline";
  const k = mode === "tab" ? tabScale : inlineScale;
  const headlineSize = Number((100 * k).toFixed(3)), s = headlineSize;
  const safe = titleSafeBox(size);
  const label = labelText ? layoutLine(labelText, { ...face, size: Number((s * LABEL_RATIO).toFixed(3)), tracking: displayTracking([labelText]) }) : undefined;
  const heads = headlineTexts.map(text => layoutLine(text, { ...face, size: s, tracking }));
  const blockWidth = label ? inkWidth(label) + 2 * LABEL_PAD * s : 0;
  const areaWidth = Math.max(...heads.map(inkWidth)) + 2 * HEADLINE_PAD * s;
  const bandHeight = BAND * s, rule = RULE * s, ruleGap = RULE_GAP * s, tab = mode === "tab" ? TAB * LABEL_RATIO * s : 0;
  const totalWidth = mode === "inline" ? blockWidth + areaWidth : Math.max(areaWidth, blockWidth);
  const totalHeight = tab + bandHeight + 2 * (rule + ruleGap);
  const left = safe.cx - totalWidth / 2, top = safe.cy - totalHeight / 2;
  const bandTop = top + tab + rule + ruleGap;
  const band = { x0: left, y0: bandTop, x1: left + totalWidth, y1: bandTop + bandHeight };
  const ruleTop = { x0: left, y0: bandTop - ruleGap - rule, x1: left + totalWidth, y1: bandTop - ruleGap };
  const ruleBottom = { x0: left, y0: band.y1 + ruleGap, x1: left + totalWidth, y1: band.y1 + ruleGap + rule };
  const areaLeft = mode === "inline" ? left + blockWidth : left;
  const midY = (band.y0 + band.y1) / 2;
  const centreOn = (line: LineLayout, x: number, cy: number) => {
    const ink = line.inkBox ?? { x0: 0, y0: -line.size, x1: line.width, y1: 0 };
    return { layout: line, x: x - ink.x0, y: cy - (ink.y0 + ink.y1) / 2 };
  };
  const headlines = heads.map(line => centreOn(line, areaLeft + HEADLINE_PAD * s, midY));
  let labelPlace: HeadlineSwapLayout["label"];
  if (label) {
    const block = mode === "inline" ? { x0: left, y0: band.y0, x1: left + blockWidth, y1: band.y1 } : { x0: left, y0: top, x1: left + blockWidth, y1: ruleTop.y0 };
    labelPlace = { ...centreOn(label, block.x0 + LABEL_PAD * s, (block.y0 + block.y1) / 2), block };
  }
  return {
    mode, headlineSize, label: labelPlace, headlines, band, ruleTop, ruleBottom, swaps, timeScale,
    box: { x0: left, y0: top, x1: left + totalWidth, y1: ruleBottom.y1 },
  };
}

export const T30_headlineSwap = defineTextMotion(ID, (params, t, size) => {
  const layout = headlineSwapLayout(params, size);
  const doc = createTextDocument(size, params);
  const palette = params.palette;
  const backdrop = textBackdrop(params);
  const bandColor = readableColor(backdrop, [palette.paper, palette.bg], 1.6);
  const headlineColor = textOnBackground(palette, bandColor);
  // The label block is the band's opposite (an ink block on the cream band, as in the reference) where that reads against
  // the backdrop; on the dark card ink would vanish, so the block takes the accent there.
  const opposite = relativeLuminance(bandColor) > 0.2 ? palette.ink : palette.paper;
  const blockColor = readableColor(backdrop, [opposite, palette.accent, palette.accent2], 1.6);
  const labelColor = textOnBackground(palette, blockColor);
  const ruleColor = readableColor(backdrop, [palette.accent, secondaryTone(palette, backdrop), headlineColor], 1.6);
  const ts = layout.timeScale, { band, ruleTop, ruleBottom } = layout;
  const width = band.x1 - band.x0;
  const exitAt = layout.swaps[layout.swaps.length - 1];
  const bandOutAt = exitAt + HEADLINE_OUT * ts;
  if (t >= bandOutAt + BAND_OUT * ts) return doc.render();
  // Wipe window of the bar: grows from the left on the way in, shrinks to the right on the way out.
  const inFor = (delay: number, seconds: number) => expoOut(clamp01((t - delay * ts) / (seconds * ts)));
  const out = t >= bandOutAt ? expoIn(clamp01((t - bandOutAt) / (BAND_OUT * ts))) : 0;
  const rulesReach = inFor(0, RULES_IN), bandReach = inFor(BAND_DELAY, BAND_IN);
  const wipe = (reach: number, box: GlyphBox, fill: string) => {
    const x0 = box.x0 + width * out, x1 = box.x0 + width * reach;
    return x1 - x0 > 0.01 ? rect(x0, box.y0, x1 - x0, box.y1 - box.y0, { fill }) : "";
  };
  const parts: string[] = [wipe(bandReach, band, bandColor)];
  // Headlines slide up through the band, clipped to it.
  const clip = doc.clipPath(rect(band.x0, band.y0, width, band.y1 - band.y0));
  const travel = 0.95 * (band.y1 - band.y0);
  const slides: string[] = [];
  layout.headlines.forEach((headline, index) => {
    const enterAt = index === 0 ? HEADLINE_DELAY * ts : layout.swaps[index - 1];
    const enterSeconds = (index === 0 ? HEADLINE_IN : SWAP) * ts;
    const leaveAt = layout.swaps[index], leaveSeconds = (index === layout.headlines.length - 1 ? HEADLINE_OUT : SWAP) * ts;
    if (t < enterAt || t >= leaveAt + leaveSeconds) return;
    let dy = 0;
    if (t < enterAt + enterSeconds) {
      const p = (t - enterAt) / enterSeconds;
      dy = travel * (1 - (index === 0 ? expoOut(p) : expoInOut(p)));
    } else if (t >= leaveAt) {
      const q = (t - leaveAt) / leaveSeconds;
      dy = -travel * (index === layout.headlines.length - 1 ? expoIn(q) : expoInOut(q));
    }
    slides.push(path(headline.layout.pathD, { fill: headlineColor, transform: tf.translate(headline.x, headline.y + dy) }));
  });
  if (slides.length) parts.push(g({ "clip-path": clip }, slides));
  if (layout.label) {
    const { block } = layout.label;
    if (layout.mode === "inline") {
      // Inline: the block is part of the band and arrives with its wipe.
      const reach = inFor(LABEL_DELAY, BAND_IN);
      const x0 = Math.max(block.x0, band.x0 + width * out), x1 = Math.min(block.x1, block.x0 + width * reach);
      if (x1 - x0 > 0.01) {
        const blockClip = doc.clipPath(rect(x0, block.y0, x1 - x0, block.y1 - block.y0));
        parts.push(g({ "clip-path": blockClip }, rect(block.x0, block.y0, block.x1 - block.x0, block.y1 - block.y0, { fill: blockColor }),
          path(layout.label.layout.pathD, { fill: labelColor, transform: tf.translate(layout.label.x, layout.label.y) })));
      }
    } else {
      // Tab: it rises out of the top rule.
      const rise = inFor(LABEL_DELAY + 0.06, 0.34), sink = t >= bandOutAt ? expoIn(clamp01((t - bandOutAt) / (0.6 * BAND_OUT * ts))) : 0;
      const shown = rise * (1 - sink);
      if (shown > 0.01) {
        const height = block.y1 - block.y0, tabClip = doc.clipPath(rect(block.x0, block.y0 - height, block.x1 - block.x0, 2 * height));
        const dy = height * (1 - shown);
        parts.push(g({ "clip-path": tabClip }, g({ transform: transform(tf.translate(0, dy)) },
          rect(block.x0, block.y0, block.x1 - block.x0, height, { fill: blockColor }),
          path(layout.label.layout.pathD, { fill: labelColor, transform: tf.translate(layout.label.x, layout.label.y) }))));
      }
    }
  }
  parts.push(wipe(rulesReach, ruleTop, ruleColor), wipe(rulesReach, ruleBottom, ruleColor));
  return doc.render(parts);
}, { revision: REVISION });
