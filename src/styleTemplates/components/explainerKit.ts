import { circle, createSvgDocument, fmt, g, path, rect, roundRect, transform, tf, type SvgDocument } from "../../motionLibrary/svg/document";
import { clamp01, curve, lerp } from "../../motionLibrary/svg/easing";
import { layoutLine, translatePathD, type MotionFontSelector } from "../../motionLibrary/svg/glyphs";
import { createSeededRng } from "../../motionLibrary/svg/random";
import { mixHex } from "../../motionLibrary/svg/color";
import { dropShadow } from "../svgFx";

/**
 * C3 explainer kit (S1, R1's product-tutorial vocabulary), original drawings:
 * - steps: chips 01/02/03…, the active one in the accent, the others dark, with a progress connector;
 * - pill: an accent pill button that a cursor glides to and clicks (press + ripple);
 * - prompt: a chat-style prompt box that types its text with a caret and pops its send button;
 * - cards: UI skeleton cards that pop in staggered and float (over a blurred, darkened backdrop
 *   the compiler adds with the existing studio_backdrop_soft effect).
 * All text comes from the plan (spoken words or editorial text). Params are resolved by the compiler; a frame is a
 * pure function of (params, t). `em` is the widget's unit in px.
 */

export const EXPLAINER_REVISION = 1;

export type ExplainerWidget = "steps" | "pill" | "prompt" | "cards";

export interface ExplainerColors {
  readonly plate: string; readonly text: string;
  readonly accent: string; readonly accentText: string;
  readonly idle: string; readonly idleText: string;
  readonly cursorFill: string; readonly cursorOutline: string;
  readonly shadow: string;
  readonly cardPlate: string; readonly cardLine: string;
}

export interface ExplainerParams {
  readonly component: "explainer";
  readonly revision: number;
  readonly width: number;
  readonly height: number;
  readonly widget: ExplainerWidget;
  readonly duration: number;
  /** Widget box in frame px (top-left + size at scale 1) and scale from the placement solver. */
  readonly box: { readonly x: number; readonly y: number; readonly scale: number };
  readonly em: number;
  readonly font: MotionFontSelector;
  readonly textFont: MotionFontSelector;
  readonly colors: ExplainerColors;
  readonly steps?: { readonly count: number; readonly labels?: readonly string[]; readonly activeAt: readonly number[] };
  readonly text?: string;
  /** pill: local time of the click (s). */
  readonly clickAt?: number;
  /** prompt: local time each character appears (from the spoken words' timing); default an even typing pace. */
  readonly typeTimes?: readonly number[];
  readonly cards?: { readonly count: number };
  readonly seed: number;
}

const EXIT = 0.24;

// ---------------------------------------------------------------------------
// Measuring (the compiler places the widget box with these sizes)
// ---------------------------------------------------------------------------

function textWidth(text: string, font: MotionFontSelector, size: number, tracking = 0): number {
  const line = layoutLine(text, { ...font, size, tracking });
  return line.inkBox ? line.inkBox.x1 - line.inkBox.x0 : line.width;
}

export function measureExplainer(widget: ExplainerWidget, options: { em: number; font: MotionFontSelector; textFont: MotionFontSelector;
  count?: number; labels?: readonly string[]; text?: string; maxWidth: number }): { width: number; height: number; textSize: number } {
  const em = options.em;
  switch (widget) {
    case "steps": {
      const count = options.count ?? 3;
      const chipW = 2.6 * em, gap = 0.9 * em;
      const labelW = Math.max(0, ...(options.labels ?? []).map(label => textWidth(label, options.textFont, 0.72 * em)));
      const cell = Math.max(chipW, labelW + 0.3 * em);
      return { width: count * cell + (count - 1) * gap, height: 1.8 * em + (options.labels?.length ? 1.35 * em : 0), textSize: 0.72 * em };
    }
    case "pill": {
      let size = 1.1 * em;
      const w = textWidth(options.text ?? "", options.font, size, -0.02);
      const maxText = options.maxWidth * 0.62;
      if (w > maxText) size *= maxText / w;
      const pillW = textWidth(options.text ?? "", options.font, size, -0.02) + 2.6 * em;
      // Room for the cursor's approach from the lower right.
      return { width: pillW + 2.6 * em, height: 2.3 * em + 2.4 * em, textSize: size };
    }
    case "prompt": {
      let size = 0.9 * em;
      const maxText = options.maxWidth - 5.2 * em;
      const w = textWidth(options.text ?? "", options.textFont, size);
      if (w > maxText) size *= maxText / w;
      const tw = textWidth(options.text ?? "", options.textFont, size);
      return { width: Math.min(options.maxWidth, Math.max(12 * em, tw + 5.2 * em)), height: 2.8 * em, textSize: size };
    }
    case "cards": {
      const count = options.count ?? 3;
      return { width: 7.4 * em + (count - 1) * 5.0 * em + 1.2 * em, height: 9.6 * em + 1.6 * em, textSize: 0.6 * em };
    }
  }
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

function textPath(text: string, font: MotionFontSelector, size: number, cx: number, cy: number, tracking = 0): string {
  const line = layoutLine(text, { ...font, size, tracking });
  const ink = line.inkBox ?? { x0: 0, y0: -size * 0.8, x1: line.width, y1: 0 };
  return translatePathD(line.pathD, cx - (ink.x0 + ink.x1) / 2, cy - (ink.y0 + ink.y1) / 2);
}

/** Classic arrow cursor (original outline), tip at (0, 0), height `size`. */
function cursorPathD(size: number): string {
  const s = size / 22;
  const pts: Array<[number, number]> = [[0, 0], [0, 17], [4.4, 13.2], [7.4, 20], [10.4, 18.7], [7.5, 12], [13, 12]];
  return `M${pts.map(([x, y]) => `${fmt(x * s, 2)} ${fmt(y * s, 2)}`).join("L")}Z`;
}

/** Four-point sparkle (prompt box icon). */
function sparklePathD(cx: number, cy: number, r: number): string {
  const k = r * 0.28;
  return `M${fmt(cx, 2)} ${fmt(cy - r, 2)}Q${fmt(cx + k, 2)} ${fmt(cy - k, 2)} ${fmt(cx + r, 2)} ${fmt(cy, 2)}Q${fmt(cx + k, 2)} ${fmt(cy + k, 2)} ${fmt(cx, 2)} ${fmt(cy + r, 2)}`
    + `Q${fmt(cx - k, 2)} ${fmt(cy + k, 2)} ${fmt(cx - r, 2)} ${fmt(cy, 2)}Q${fmt(cx - k, 2)} ${fmt(cy - k, 2)} ${fmt(cx, 2)} ${fmt(cy - r, 2)}Z`;
}

const op = (value: number) => (value < 0.999 ? Number(fmt(Math.max(0, value), 3)) : undefined);

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

export function explainerFrame(params: ExplainerParams, t: number): string {
  const doc = createSvgDocument({ width: params.width, height: params.height }, { idPrefix: "ex" });
  const exitP = clamp01((t - (params.duration - EXIT)) / EXIT), exitE = curve("snapIn", exitP);
  let body: string;
  switch (params.widget) {
    case "steps": body = stepsWidget(doc, params, t, exitE); break;
    case "pill": body = pillWidget(doc, params, t, exitE); break;
    case "prompt": body = promptWidget(doc, params, t, exitE); break;
    case "cards": body = cardsWidget(doc, params, t); break;
  }
  return doc.render(g({ transform: transform(tf.translate(params.box.x, params.box.y), params.box.scale !== 1 ? tf.scale(params.box.scale) : false) }, body));
}

function stepsWidget(doc: SvgDocument, params: ExplainerParams, t: number, exitE: number): string {
  const { em, colors } = params, steps = params.steps!;
  const size = measureExplainer("steps", { em, font: params.font, textFont: params.textFont, count: steps.count, labels: steps.labels, maxWidth: Infinity });
  const chipW = 2.6 * em, chipH = 1.8 * em, gap = 0.9 * em;
  const labelW = Math.max(0, ...(steps.labels ?? []).map(label => textWidth(label, params.textFont, size.textSize)));
  const cell = Math.max(chipW, labelW + 0.3 * em);
  const activeIndex = steps.activeAt.reduce((index, at, i) => (t >= at ? i : index), -1);
  const parts: string[] = [];
  // Connector: idle line between chips, the done part in the accent.
  const cy = chipH / 2;
  for (let i = 0; i < steps.count - 1; i += 1) {
    const x0 = i * (cell + gap) + cell / 2 + chipW / 2 + 0.15 * em, x1 = (i + 1) * (cell + gap) + cell / 2 - chipW / 2 - 0.15 * em;
    const appear = clamp01((t - 0.1 - i * 0.07) / 0.3);
    const done = activeIndex > i ? curve("expoOut", clamp01((t - steps.activeAt[i + 1]) / 0.3)) : 0;
    parts.push(rect(x0, cy - 0.06 * em, (x1 - x0) * curve("expoOut", appear), 0.12 * em, { fill: colors.idle, opacity: op(0.9 * (1 - exitE)) }));
    if (done > 0) parts.push(rect(x0, cy - 0.06 * em, (x1 - x0) * done, 0.12 * em, { fill: colors.accent, opacity: op(1 - exitE) }));
  }
  for (let i = 0; i < steps.count; i += 1) {
    const local = t - i * 0.07;
    if (local < 0) continue;
    const pop = lerp(0.5, 1, curve("springSnappy", clamp01(local / 0.45)));
    const isActive = i === activeIndex;
    const activeSince = isActive ? t - steps.activeAt[i] : -1;
    const mix = isActive ? curve("expoOut", clamp01(activeSince / 0.15)) : 0;
    const bump = isActive ? 1 + 0.14 * Math.sin(Math.PI * clamp01(activeSince / 0.32)) : 1;
    const cx = i * (cell + gap) + cell / 2;
    const fill = mixHex(colors.idle, colors.accent, mix), textColor = mixHex(colors.idleText, colors.accentText, mix);
    const chip = g({ filter: dropShadow(doc, { box: { x0: cx - chipW / 2, y0: 0, x1: cx + chipW / 2, y1: chipH }, sigma: 0.25 * em, dy: 0.12 * em, color: colors.shadow, opacity: 0.45 }) },
      roundRect(cx - chipW / 2, 0, chipW, chipH, chipH / 2, { fill }),
      path(textPath(String(i + 1).padStart(2, "0"), params.font, 0.95 * em, cx, cy, -0.02), { fill: textColor }));
    let label = "";
    if (steps.labels?.[i]) {
      const lw = textWidth(steps.labels[i], params.textFont, size.textSize), ly = chipH + 0.95 * em;
      label = roundRect(cx - lw / 2 - 0.3 * em, ly - 0.5 * em, lw + 0.6 * em, 1.0 * em, 0.5 * em, { fill: colors.plate, opacity: op(isActive ? 0.95 : 0.8) })
        + path(textPath(steps.labels[i], params.textFont, size.textSize, cx, ly), { fill: colors.text, opacity: op(isActive ? 1 : 0.85) });
    }
    parts.push(g({ transform: transform(tf.translate(cx, cy + exitE * 0.4 * em), tf.scale(pop * bump), tf.translate(-cx, -cy)),
      opacity: op(Math.min(1, local / 0.1) * (1 - exitE)) }, chip, label));
  }
  return parts.join("");
}

function pillWidget(doc: SvgDocument, params: ExplainerParams, t: number, exitE: number): string {
  const { em, colors } = params;
  const size = measureExplainer("pill", { em, font: params.font, textFont: params.textFont, text: params.text, maxWidth: Infinity });
  const pillH = 2.3 * em, pillW = size.width - 2.6 * em;
  const cx = pillW / 2, cy = pillH / 2;
  const clickAt = params.clickAt ?? 0.75;
  const pop = lerp(0.55, 1, curve("springSnappy", clamp01(t / 0.45)));
  const press = t >= clickAt ? 1 - 0.07 * Math.sin(Math.PI * clamp01((t - clickAt) / 0.18)) : 1;
  const flash = t >= clickAt ? Math.max(0, 1 - (t - clickAt) / 0.3) : 0;
  const parts: string[] = [];
  const pill = g({ filter: dropShadow(doc, { box: { x0: 0, y0: 0, x1: pillW, y1: pillH }, sigma: 0.3 * em, dy: 0.16 * em, color: colors.shadow, opacity: 0.5 }) },
    roundRect(0, 0, pillW, pillH, pillH / 2, { fill: mixHex(colors.accent, "#FFFFFF", 0.35 * flash) }),
    path(textPath(params.text ?? "", params.font, size.textSize, cx, cy, -0.02), { fill: colors.accentText }));
  parts.push(g({ transform: transform(tf.translate(cx, cy), tf.scale(pop * press), tf.translate(-cx, -cy)), opacity: op(Math.min(1, t / 0.08) * (1 - exitE)) }, pill));
  // Ripples from the click point.
  const clickX = cx + 0.35 * em, clickY = cy + 0.3 * em;
  for (const delay of [0, 0.1]) {
    const p = clamp01((t - clickAt - delay) / 0.5);
    if (p <= 0 || p >= 1) continue;
    const r = lerp(0.2, 2.4, curve("expoOut", p)) * em;
    parts.push(circle(clickX, clickY, r, { fill: "none", stroke: colors.accent, "stroke-width": Number(fmt(lerp(0.16, 0.02, p) * em, 2)), opacity: op((1 - p) * 0.9 * (1 - exitE)) }));
  }
  // Cursor: glides in from the lower right, presses, then drifts off.
  const startX = pillW + 2.2 * em, startY = pillH + 2.1 * em;
  const arrive = curve("expoOut", clamp01((t - 0.12) / Math.max(0.2, clickAt - 0.2)));
  const leave = curve("snapIn", clamp01((t - clickAt - 0.45) / 0.35));
  const x = lerp(startX, clickX, arrive) + leave * 1.2 * em, y = lerp(startY, clickY, arrive) + leave * 0.8 * em;
  const cursorScale = t >= clickAt ? 1 - 0.14 * Math.sin(Math.PI * clamp01((t - clickAt) / 0.14)) : 1;
  const cursorOpacity = Math.min(1, clamp01((t - 0.12) / 0.12)) * (1 - leave) * (1 - exitE);
  if (cursorOpacity > 0.001) {
    const d = cursorPathD(1.7 * em);
    parts.push(g({ transform: transform(tf.translate(x, y), cursorScale !== 1 ? tf.scale(cursorScale) : false), opacity: op(cursorOpacity),
      filter: dropShadow(doc, { box: { x0: 0, y0: 0, x1: 1.1 * em, y1: 1.7 * em }, sigma: 0.15 * em, dy: 0.08 * em, color: colors.shadow, opacity: 0.5 }) },
      path(d, { fill: colors.cursorFill, stroke: colors.cursorOutline, "stroke-width": Number(fmt(0.09 * em, 2)), "stroke-linejoin": "round" })));
  }
  return parts.join("");
}

function promptWidget(doc: SvgDocument, params: ExplainerParams, t: number, exitE: number): string {
  const { em, colors } = params;
  const size = measureExplainer("prompt", { em, font: params.font, textFont: params.textFont, text: params.text, maxWidth: params.width * 0.86 });
  const w = size.width, h = 2.8 * em, cy = h / 2;
  const appear = curve("expoOut", clamp01(t / 0.32));
  const text = params.text ?? "", chars = [...text];
  const typeStart = 0.3, step = Math.min(0.075, Math.max(0.035, (params.duration - 1.1) / Math.max(1, chars.length)));
  const timed = params.typeTimes && params.typeTimes.length === chars.length ? params.typeTimes : undefined;
  const typed = timed ? timed.filter(at => at <= t).length : Math.max(0, Math.min(chars.length, Math.floor((t - typeStart) / step) + 1));
  const doneAt = timed ? (timed[timed.length - 1] ?? typeStart) + 0.12 : typeStart + chars.length * step;
  const parts: string[] = [];
  parts.push(roundRect(0, 0, w, h, 0.9 * em, { fill: colors.plate, stroke: mixHex(colors.plate, colors.text, 0.28), "stroke-width": Number(fmt(0.07 * em, 2)) }));
  parts.push(path(sparklePathD(1.35 * em, cy, 0.55 * em), { fill: colors.accent }));
  const textX = 2.4 * em;
  let caretX = textX;
  if (typed > 0 && (timed || t >= typeStart)) {
    const shown = chars.slice(0, typed).join("");
    const line = layoutLine(shown, { ...params.textFont, size: size.textSize });
    const full = layoutLine(text, { ...params.textFont, size: size.textSize });
    const ink = full.inkBox ?? { x0: 0, y0: -size.textSize * 0.8, x1: full.width, y1: 0 };
    const baseline = cy - (ink.y0 + ink.y1) / 2;
    parts.push(path(translatePathD(line.pathD, textX, baseline), { fill: colors.text }));
    caretX = textX + line.width + 0.12 * em;
  }
  const blinkOn = t < doneAt || Math.floor((t - doneAt) / 0.45) % 2 === 0;
  if (blinkOn) parts.push(rect(caretX, cy - 0.55 * em, 0.1 * em, 1.1 * em, { fill: colors.accent }));
  // Send button pops when typing completes.
  const sendP = clamp01((t - doneAt) / 0.4);
  const sendScale = t >= doneAt ? lerp(1, 1.18, Math.sin(Math.PI * sendP)) : 1;
  const sx = w - 1.45 * em;
  parts.push(g({ transform: transform(tf.translate(sx, cy), tf.scale(sendScale), tf.translate(-sx, -cy)) },
    circle(sx, cy, 0.85 * em, { fill: t >= doneAt ? colors.accent : mixHex(colors.plate, colors.text, 0.25) }),
    path(`M${fmt(sx, 2)} ${fmt(cy - 0.42 * em, 2)}L${fmt(sx + 0.36 * em, 2)} ${fmt(cy - 0.02 * em, 2)}L${fmt(sx + 0.12 * em, 2)} ${fmt(cy - 0.02 * em, 2)}`
      + `L${fmt(sx + 0.12 * em, 2)} ${fmt(cy + 0.42 * em, 2)}L${fmt(sx - 0.12 * em, 2)} ${fmt(cy + 0.42 * em, 2)}L${fmt(sx - 0.12 * em, 2)} ${fmt(cy - 0.02 * em, 2)}`
      + `L${fmt(sx - 0.36 * em, 2)} ${fmt(cy - 0.02 * em, 2)}Z`, { fill: t >= doneAt ? colors.accentText : colors.text })));
  const cx = w / 2;
  return g({ transform: transform(tf.translate(cx, cy + (1 - appear) * 0.6 * em + exitE * 0.5 * em), tf.scale(lerp(0.94, 1, appear)), tf.translate(-cx, -cy)),
    opacity: op(appear * (1 - exitE)),
    filter: dropShadow(doc, { box: { x0: 0, y0: 0, x1: w, y1: h }, sigma: 0.45 * em, dy: 0.2 * em, color: colors.shadow, opacity: 0.55 }) }, parts);
}

function cardsWidget(doc: SvgDocument, params: ExplainerParams, t: number): string {
  const { em, colors } = params;
  const count = params.cards?.count ?? 3;
  const cardW = 7.4 * em, cardH = 9.6 * em;
  const rng = createSeededRng("explainerCards", params.seed, "lines");
  const widths = Array.from({ length: count * 5 }, () => rng.range(0.45, 0.95));
  const parts: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const local = t - 0.1 - i * 0.12;
    if (local < 0) continue;
    const exitLocal = clamp01((t - (params.duration - EXIT - (count - 1 - i) * 0.05)) / EXIT);
    const e = curve("backOutSoft", clamp01(local / 0.5));
    const centre = count === 1 ? 0 : (i / (count - 1) - 0.5) * 2;
    const rot = centre * 6 * (1 - 0.15 * e) + (1 - e) * 5 * Math.sign(centre || 1);
    const bob = Math.sin(t * 2.1 + i * 1.7) * 0.12 * em;
    const x0 = 0.6 * em + i * 5.0 * em, y0 = 0.6 * em + Math.abs(centre) * 0.55 * em + (1 - e) * 1.6 * em + bob;
    const cx = x0 + cardW / 2, cy = y0 + cardH / 2;
    const lineColor = colors.cardLine;
    const pad = 0.6 * em;
    const content = [
      roundRect(x0, y0, cardW, cardH, 0.7 * em, { fill: colors.cardPlate }),
      circle(x0 + pad + 0.55 * em, y0 + pad + 0.55 * em, 0.55 * em, { fill: colors.accent }),
      roundRect(x0 + pad + 1.4 * em, y0 + pad + 0.22 * em, (cardW - 3.0 * em) * widths[i * 5], 0.32 * em, 0.16 * em, { fill: lineColor, opacity: 0.85 }),
      roundRect(x0 + pad + 1.4 * em, y0 + pad + 0.72 * em, (cardW - 3.0 * em) * widths[i * 5 + 1] * 0.7, 0.24 * em, 0.12 * em, { fill: lineColor, opacity: 0.45 }),
      roundRect(x0 + pad, y0 + 2.0 * em, cardW - 2 * pad, 3.4 * em, 0.4 * em, { fill: mixHex(colors.cardPlate, colors.accent, 0.22) }),
      ...[0, 1, 2].map(row => roundRect(x0 + pad, y0 + 5.9 * em + row * 0.62 * em, (cardW - 2 * pad) * widths[i * 5 + 2 + row], 0.26 * em, 0.13 * em, { fill: lineColor, opacity: 0.5 })),
      roundRect(x0 + pad, y0 + cardH - pad - 1.0 * em, 3.2 * em, 1.0 * em, 0.5 * em, { fill: colors.accent }),
    ];
    parts.push(g({ transform: transform(tf.translate(cx, cy), tf.rotate(rot), tf.scale(lerp(0.85, 1, e) * (1 - 0.08 * exitLocal)), tf.translate(-cx, -cy)),
      opacity: op(Math.min(1, local / 0.12) * (1 - curve("snapIn", exitLocal))),
      filter: dropShadow(doc, { box: { x0, y0, x1: x0 + cardW, y1: y0 + cardH }, sigma: 0.5 * em, dy: 0.3 * em, color: colors.shadow, opacity: 0.55 }) }, content));
  }
  return parts.join("");
}
