import { circle, createSvgDocument, fe, fmt, g, path, rect, roundRect, transform, tf, type SvgDocument } from "../../motionLibrary/svg/document";
import { clamp01, curve, lerp } from "../../motionLibrary/svg/easing";
import { layoutLine, translatePathD, type MotionFontSelector } from "../../motionLibrary/svg/glyphs";
import { blurFilter, dropShadow, type FxBox } from "../svgFx";
import { alpha255, S1V2 } from "./design";

/**
 * S1 v2 UI-card components (SVG, browser-safe, pure functions of (params, t)), drawn to Claude's style frames:
 * the designed backdrop, the card's chrome (layered shadows under, rim over), the chapter chip, the lower third
 * (subtitle / keyword lockup / step chips), the tool tag pinned to the card, the prompt bubble and the cursor click.
 * Sizes arrive already scaled to the output frame (`s` = output / design); all text is glyph outlines.
 */

export const UI_CARD_REVISION = 1;

/** Cubic ease-in-out (settles after an overshoot; never linear). */
export const easeInOut = (p: number) => { const x = clamp01(p); return x < 0.5 ? 4 * x * x * x : 1 - ((-2 * x + 2) ** 3) / 2; };
const op = (value: number) => (value < 0.999 ? Number(fmt(Math.max(0, value), 3)) : undefined);
const rgb = (c: readonly [number, number, number]) => `#${c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;

interface Glyphs { readonly d: string; readonly w: number; readonly h: number; readonly advance: number }

/** Glyph outlines of one line with its ink box centred at (cx, cy) (align "center"), or ink left edge at cx (align "start"). */
function glyphs(text: string, font: MotionFontSelector, size: number, tracking: number, cx: number, cy: number, align: "center" | "start" = "center"): Glyphs {
  const line = layoutLine(text, { ...font, size, tracking });
  const ink = line.inkBox ?? { x0: 0, y0: -size * 0.8, x1: line.width, y1: 0 };
  const dx = align === "center" ? cx - (ink.x0 + ink.x1) / 2 : cx - ink.x0;
  return { d: translatePathD(line.pathD, dx, cy - (ink.y0 + ink.y1) / 2), w: ink.x1 - ink.x0, h: ink.y1 - ink.y0, advance: line.width };
}

export function measureText(text: string, font: MotionFontSelector, size: number, tracking = 0): { ink: number; advance: number } {
  const line = layoutLine(text, { ...font, size, tracking });
  return { ink: line.inkBox ? line.inkBox.x1 - line.inkBox.x0 : line.width, advance: line.width };
}

/** Size that fits `maxWidth` (never larger than `size`). */
export function fitSize(text: string, font: MotionFontSelector, size: number, tracking: number, maxWidth: number): number {
  const width = measureText(text, font, size, tracking).ink;
  return width > maxWidth ? size * (maxWidth / width) : size;
}

function textShadow(doc: SvgDocument, box: FxBox, s: number, shadow = S1V2.lower.shadow): string {
  return dropShadow(doc, { box, sigma: shadow.blur * s, dy: shadow.dy * s, color: "#000000", opacity: alpha255(shadow.alpha) });
}

// ---------------------------------------------------------------------------
// Backdrop (a still): charcoal, warm key top-left, cool fill bottom-right, vignette, fine grain. Never the footage.
// ---------------------------------------------------------------------------

export interface UiBackdropParams {
  readonly component: "uiBackdrop";
  readonly revision: number;
  readonly width: number;
  readonly height: number;
  readonly seed: number;
}

export function uiBackdropSvg(params: UiBackdropParams): string {
  const { width: W, height: H } = params;
  const s = W / S1V2.frame.width, sy = H / S1V2.frame.height;
  const b = S1V2.backdrop;
  const doc = createSvgDocument({ width: W, height: H }, { idPrefix: "bd" });
  // A Gaussian lobe exp(-(dx/sx)² - (dy/sy)²) as an elliptical radial gradient (radius 3σ), added with plus-lighter.
  const lobe = (spec: { readonly cx: number; readonly cy: number; readonly sx: number; readonly sy: number; readonly rgb: readonly [number, number, number] }) => {
    const stops = Array.from({ length: 13 }, (_, i) => { const u = i / 12; return { offset: u, color: rgb(spec.rgb), opacity: Number(Math.exp(-((3 * u) ** 2)).toFixed(4)) }; });
    const fill = doc.radialGradient({ cx: 0, cy: 0, r: 3, stops, gradientTransform: `translate(${fmt(spec.cx * s, 2)} ${fmt(spec.cy * sy, 2)}) scale(${fmt(spec.sx * s, 2)} ${fmt(spec.sy * sy, 2)})` });
    return rect(0, 0, W, H, { fill, style: "mix-blend-mode:plus-lighter" });
  };
  // Vignette: black at opacity min(1 - floor, strength·r²) over the lit image (= multiply by the clipped falloff).
  const v = b.vignette, rClip = Math.sqrt((1 - v.floor) / v.strength);
  const vStops = Array.from({ length: 13 }, (_, i) => { const r = (i / 12) * rClip; return { offset: i / 12, color: "#000000", opacity: Number(Math.min(1 - v.floor, v.strength * r * r).toFixed(4)) }; });
  const vignette = doc.radialGradient({ cx: 0, cy: 0, r: rClip, stops: vStops, gradientTransform: `translate(${fmt(W / 2, 2)} ${fmt(H / 2, 2)}) scale(${fmt(v.rx * W, 2)} ${fmt(v.ry * H, 2)})` });
  // Grain: one octave of fine fractal noise, grey, added around zero (σ ≈ grain / 255).
  const k = (b.grain / 255) / 0.085;
  const grain = doc.filter([
    fe.turbulence({ type: "fractalNoise", baseFrequency: 0.85 / s, numOctaves: 1, seed: params.seed % 10_000, result: "n" }),
    fe.colorMatrix({ in: "n", type: "matrix", values: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1], result: "grey" }),
    fe.composite({ in: "SourceGraphic", in2: "grey", operator: "arithmetic", k1: 0, k2: 1, k3: Number(k.toFixed(4)), k4: Number((-0.5 * k).toFixed(4)) }),
  ], { x: 0, y: 0, width: W, height: H });
  return doc.render(g({ filter: grain }, rect(0, 0, W, H, { fill: rgb(b.base) }), lobe(b.warm), lobe(b.cool), rect(0, 0, W, H, { fill: vignette })));
}

// ---------------------------------------------------------------------------
// Card chrome (stills, posed with the card): layered shadows under, a thin rim light over.
// ---------------------------------------------------------------------------

export interface CardChromeParams {
  readonly component: "cardChrome";
  readonly revision: number;
  readonly width: number;
  readonly height: number;
  readonly part: "under" | "over";
  readonly rect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  readonly radius: number;
  readonly shadows: ReadonlyArray<{ readonly blur: number; readonly dy: number; readonly alpha: number }>;
  readonly rim: { readonly width: number; readonly alpha: number };
}

export function cardChromeSvg(params: CardChromeParams): string {
  const doc = createSvgDocument({ width: params.width, height: params.height }, { idPrefix: params.part === "under" ? "cu" : "co" });
  const r = params.rect;
  if (params.part === "under") {
    const layers = params.shadows.map(shadow => {
      const box = { x0: r.x, y0: r.y + shadow.dy, x1: r.x + r.w, y1: r.y + r.h + shadow.dy };
      return g({ filter: blurFilter(doc, shadow.blur, box) }, roundRect(r.x, r.y + shadow.dy, r.w, r.h, params.radius, { fill: "#000000", opacity: alpha255(shadow.alpha) }));
    });
    return doc.render(...layers);
  }
  const inset = params.rim.width / 2;
  return doc.render(roundRect(r.x + inset, r.y + inset, r.w - 2 * inset, r.h - 2 * inset, Math.max(0, params.radius - inset),
    { fill: "none", stroke: "#FFFFFF", "stroke-opacity": alpha255(params.rim.alpha), "stroke-width": Number(fmt(params.rim.width, 2)) }));
}

// ---------------------------------------------------------------------------
// Chapter chip: glass pill, yellow number (900) + label (600). Changes only on a section change.
// ---------------------------------------------------------------------------

export interface ChapterChipParams {
  readonly component: "chapterChip";
  readonly revision: number;
  readonly width: number;
  readonly height: number;
  readonly number: string;
  readonly label: string;
  readonly accent: string;
  readonly duration: number;
  /** Local time the chip starts leaving (the next chapter arrives); omit to hold to the end. */
  readonly exitAt?: number;
  /** Grid overrides (px): type scale, pill centre x and top y. Default: the 9:16 style frame. */
  readonly scale?: number;
  readonly cx?: number;
  readonly y?: number;
}

export function chapterChipFrame(params: ChapterChipParams, t: number): string {
  const s = params.scale ?? params.width / S1V2.frame.width, c = S1V2.chip;
  const doc = createSvgDocument({ width: params.width, height: params.height }, { idPrefix: "ch" });
  const chipCx = params.cx ?? params.width / 2;
  const numberFont = { font: "display" as const, weight: c.numberWeight }, labelFont = { font: "display" as const, weight: c.labelWeight };
  const size = c.size * s;
  const wn = measureText(params.number, numberFont, size).advance, wl = measureText(params.label, labelFont, size).advance;
  const w = c.padX * 2 * s + wn + c.gap * s + wl, h = c.height * s;
  const x0 = chipCx - w / 2, y0 = params.y ?? c.y * s, cy = y0 + h / 2 + 4 * s;
  const st = S1V2.motion.stagger;
  const exit = params.exitAt === undefined ? 0 : clamp01((t - params.exitAt) / 0.3);
  const enter = (delay: number) => curve("expoOut", clamp01((t - delay) / 0.45));
  const e0 = enter(0), e1 = enter(st), e2 = enter(2 * st);
  const out = (delay: number) => curve("snapIn", clamp01((exit * 0.3 - delay) / 0.22));
  const pill = g({ opacity: op(e0 * (1 - out(2 * st))), transform: transform(tf.translate(chipCx, y0 + h / 2), tf.scale(lerp(0.94, 1, e0)), tf.translate(-chipCx, -(y0 + h / 2))) },
    roundRect(x0, y0, w, h, c.radius * s, { fill: "#FFFFFF", "fill-opacity": alpha255(c.fillAlpha), stroke: "#FFFFFF", "stroke-opacity": alpha255(c.strokeAlpha), "stroke-width": Number(fmt(c.strokeWidth * s, 2)) }));
  const number = glyphs(params.number, numberFont, size, 0, x0 + c.padX * s, cy, "start");
  const label = glyphs(params.label, labelFont, size, 0, x0 + c.padX * s + wn + c.gap * s, cy, "start");
  const rise = 10 * s;
  return doc.render(pill,
    g({ opacity: op(e1 * (1 - out(0))), transform: tf.translate(0, (1 - e1) * rise - out(0) * rise) }, path(number.d, { fill: params.accent })),
    g({ opacity: op(e2 * (1 - out(st))), transform: tf.translate(0, (1 - e2) * rise - out(st) * rise) }, path(label.d, { fill: c.label })));
}

// ---------------------------------------------------------------------------
// Lower third: subtitle (always on), keyword lockup (replaces the subtitle on key beats), or step chips.
// ---------------------------------------------------------------------------

export interface LowerThirdParams {
  readonly component: "lowerThird";
  readonly revision: number;
  readonly width: number;
  readonly height: number;
  readonly duration: number;
  /** Local time the element starts leaving. */
  readonly exitAt: number;
  readonly accent: string;
  readonly ink: string;
  readonly content:
    | { readonly mode: "subtitle"; readonly text: string; readonly size: number;
        /** A narrow column (16:9) wraps the phrase into balanced lines; default one line. */
        readonly lines?: readonly string[] }
    | { readonly mode: "lockup"; readonly lead: string; readonly leadSize: number; readonly keyword: string; readonly keywordSize: number; readonly keywordAt: number;
        /** A short connector after the keyword (3 characters or fewer), set small and white on the keyword's line. */
        readonly tail?: string }
    | { readonly mode: "steps"; readonly items: ReadonlyArray<{ readonly number: string; readonly label: string; readonly at: number }>; readonly scale: number };
  /** Grid overrides (px): type scale and the centres of each line. Default: the 9:16 style frame. */
  readonly scale?: number;
  readonly at?: { readonly subtitleCx: number; readonly subtitleY: number; readonly lockupCx: number; readonly leadY: number; readonly keywordY: number; readonly stepsY: number };
}

export function lowerThirdFrame(params: LowerThirdParams, t: number): string {
  const s = params.scale ?? params.width / S1V2.frame.width, L = S1V2.lower, m = S1V2.motion;
  const doc = createSvgDocument({ width: params.width, height: params.height }, { idPrefix: "lt" });
  const at = params.at ?? { subtitleCx: params.width / 2, subtitleY: L.subtitleCenterY * s, lockupCx: params.width / 2, leadY: L.leadCenterY * s, keywordY: L.keywordCenterY * s, stepsY: L.steps.centerY * s };
  let cx = at.subtitleCx;
  const out = (delay = 0) => curve("snapIn", clamp01((t - params.exitAt - delay) / m.subtitleOut));
  const font = (weight: number) => ({ font: "display" as const, weight });
  const content = params.content;
  if (content.mode === "subtitle") {
    const e = curve("quintOut", clamp01(t / m.subtitleIn)), o = out();
    const lines = content.lines?.length ? content.lines : [content.text];
    const pitch = content.size * 1.32;
    const shapes = lines.map((line, i) => glyphs(line, font(L.subtitle.weight), content.size, L.subtitle.tracking, cx, at.subtitleY + (i - (lines.length - 1) / 2) * pitch));
    const wMax = Math.max(...shapes.map(shape => shape.w)), hAll = (lines.length - 1) * pitch + content.size;
    const box = { x0: cx - wMax / 2, y0: at.subtitleY - hAll / 2, x1: cx + wMax / 2, y1: at.subtitleY + hAll / 2 };
    return doc.render(g({ opacity: op(e * (1 - o)), transform: tf.translate(0, (1 - e) * m.subtitleRise * s - o * 6 * s), filter: textShadow(doc, box, s) },
      ...shapes.map(shape => path(shape.d, { fill: L.subtitle.color }))));
  }
  if (content.mode === "lockup") {
    // The lead lands first; the keyword pops on its spoken word with a slight overshoot (≤ 1.06) out of a short blur.
    cx = at.lockupCx;
    const eLead = curve("quintOut", clamp01(t / m.subtitleIn)), oLead = out();
    const lead = glyphs(content.lead, font(L.lead.weight), content.leadSize, L.lead.tracking, cx, at.leadY);
    const leadBox = { x0: cx - lead.w / 2, y0: at.leadY - lead.h / 2, x1: cx + lead.w / 2, y1: at.leadY + lead.h / 2 };
    const parts: string[] = [];
    if (content.lead) parts.push(g({ opacity: op(eLead * (1 - oLead)), transform: tf.translate(0, (1 - eLead) * m.subtitleRise * s - oLead * 6 * s), filter: textShadow(doc, leadBox, s) },
      path(lead.d, { fill: L.lead.color })));
    const k = t - content.keywordAt;
    if (k >= 0) {
      const p = clamp01(k / m.keywordPop), oKey = out(m.stagger);
      // 0.86 → 1.06 (at 45%) → 1.0: an eased overshoot, never a linear pop.
      const scale = p < 0.45 ? lerp(0.86, m.keywordOvershoot, curve("quintOut", p / 0.45)) : lerp(m.keywordOvershoot, 1, easeInOut((p - 0.45) / 0.55));
      const blur = (1 - curve("quintOut", clamp01(k / 0.2))) * 10 * s;
      const kcy = at.keywordY;
      // Keyword (+ small tail) centred as one line.
      const tailSize = content.leadSize, gap = tailSize * 0.18;
      const tailInk = content.tail ? measureText(content.tail, font(L.lead.weight), tailSize, L.lead.tracking).ink : 0;
      const tailWidth = content.tail ? tailInk + gap : 0;
      const keywordInk = measureText(content.keyword, font(L.keyword.weight), content.keywordSize, L.keyword.tracking).ink;
      const kcx = cx - tailWidth / 2;
      const keyword = glyphs(content.keyword, font(L.keyword.weight), content.keywordSize, L.keyword.tracking, kcx, kcy);
      const box = { x0: kcx - keyword.w / 2, y0: kcy - keyword.h / 2, x1: kcx + keyword.w / 2 + tailWidth, y1: kcy + keyword.h / 2 };
      let tailPath = "";
      if (content.tail) {
        const tail = glyphs(content.tail, font(L.lead.weight), tailSize, L.lead.tracking, kcx + keywordInk / 2 + gap + tailInk / 2, 0);
        // Sit the tail on the keyword's ink bottom.
        tailPath = path(translatePathD(tail.d, 0, kcy + keyword.h / 2 - tail.h / 2), { fill: L.lead.color });
      }
      const fill = path(keyword.d, { fill: params.accent }) + tailPath;
      const inner = blur > 0.3 ? g({ filter: blurFilter(doc, blur, box) }, fill) : fill;
      parts.push(g({ opacity: op(Math.min(1, k / 0.1) * (1 - oKey)), transform: transform(tf.translate(kcx, kcy + (1 - curve("quintOut", p)) * 18 * s + oKey * 8 * s), tf.scale(scale), tf.translate(-kcx, -kcy)),
        filter: textShadow(doc, box, s) }, inner));
    }
    return doc.render(...parts);
  }
  // Steps: chips build up as each item is spoken; the newest is the accent, the earlier ones glass.
  const S = L.steps, sc = content.scale * s;
  const numberFont = font(900), labelFont = font(600);
  const widths = content.items.map(item => S.padX * 2 * sc + measureText(item.number, numberFont, S.numberSize * sc).advance + 14 * sc + measureText(item.label, labelFont, S.size * sc).advance);
  const total = widths.reduce((sum, w) => sum + w, 0) + S.gap * sc * (widths.length - 1);
  let x = cx - total / 2;
  const cy = at.stepsY, h = S.height * sc;
  const active = content.items.reduce((index, item, i) => (t >= item.at ? i : index), -1);
  const parts: string[] = [];
  content.items.forEach((item, i) => {
    const w = widths[i], x0 = x;
    x += w + S.gap * sc;
    const k = t - item.at;
    if (k < 0) return;
    const p = clamp01(k / 0.38), o = out(i * m.stagger * 0.6);
    const scale = p < 0.5 ? lerp(0.82, 1.05, curve("quintOut", p / 0.5)) : lerp(1.05, 1, easeInOut((p - 0.5) / 0.5));
    const isActive = i === active;
    const mcx = x0 + w / 2;
    const number = glyphs(item.number, numberFont, S.numberSize * sc, 0, x0 + S.padX * sc, cy + 2 * sc, "start");
    const label = glyphs(item.label, labelFont, S.size * sc, 0, x0 + S.padX * sc + measureText(item.number, numberFont, S.numberSize * sc).advance + 14 * sc, cy + 2 * sc, "start");
    const box = { x0, y0: cy - h / 2, x1: x0 + w, y1: cy + h / 2 };
    const plate = isActive
      ? roundRect(x0, cy - h / 2, w, h, S.radius * sc, { fill: params.accent })
      : roundRect(x0, cy - h / 2, w, h, S.radius * sc, { fill: "#FFFFFF", "fill-opacity": alpha255(S1V2.chip.fillAlpha + 8), stroke: "#FFFFFF", "stroke-opacity": alpha255(S1V2.chip.strokeAlpha), "stroke-width": Number(fmt(2 * s, 2)) });
    parts.push(g({ opacity: op(Math.min(1, k / 0.1) * (1 - o)), transform: transform(tf.translate(mcx, cy + o * 8 * s), tf.scale(scale), tf.translate(-mcx, -cy)),
      filter: isActive ? dropShadow(doc, { box, sigma: 12 * s, dy: 8 * s, color: "#000000", opacity: 0.45 }) : undefined },
    plate, path(number.d, { fill: isActive ? params.ink : params.accent }), path(label.d, { fill: isActive ? params.ink : "#F2F3F6" })));
  });
  return doc.render(...parts);
}

// ---------------------------------------------------------------------------
// Tool tag: a yellow pill pinned to the card's top-left edge; moves with the card.
// ---------------------------------------------------------------------------

export interface ToolTagParams {
  readonly component: "toolTag";
  readonly revision: number;
  readonly width: number;
  readonly height: number;
  readonly text: string;
  readonly accent: string;
  readonly ink: string;
  /** Pill top-left (px) when the card is at rest. */
  readonly x: number;
  readonly y: number;
  readonly duration: number;
  readonly exitAt: number;
  /** The card's pose over the job (local t, px offset, opacity), linear between keys. */
  readonly follow?: ReadonlyArray<{ readonly t: number; readonly dx: number; readonly dy: number; readonly opacity: number }>;
  readonly scale?: number;
}

export function poseAt(keys: ReadonlyArray<{ readonly t: number; readonly dx: number; readonly dy: number; readonly opacity: number }> | undefined, t: number) {
  if (!keys?.length) return { dx: 0, dy: 0, opacity: 1 };
  if (t <= keys[0].t) return keys[0];
  for (let i = 1; i < keys.length; i += 1) {
    if (t < keys[i].t) {
      const a = keys[i - 1], b = keys[i], u = (t - a.t) / (b.t - a.t);
      return { dx: lerp(a.dx, b.dx, u), dy: lerp(a.dy, b.dy, u), opacity: lerp(a.opacity, b.opacity, u) };
    }
  }
  return keys[keys.length - 1];
}

export function toolTagFrame(params: ToolTagParams, t: number): string {
  const s = params.scale ?? params.width / S1V2.frame.width, T = S1V2.tag;
  const doc = createSvgDocument({ width: params.width, height: params.height }, { idPrefix: "tg" });
  const font = { font: "display" as const, weight: T.weight };
  const size = T.size * s, h = T.height * s;
  const w = measureText(params.text, font, size).advance + T.padX * 2 * s;
  const pose = poseAt(params.follow, t);
  const x0 = params.x + pose.dx, y0 = params.y + pose.dy;
  const p = clamp01(t / 0.4), o = curve("snapIn", clamp01((t - params.exitAt) / 0.2));
  const scale = p < 0.55 ? lerp(0.6, 1.05, curve("quintOut", p / 0.55)) : lerp(1.05, 1, easeInOut((p - 0.55) / 0.45));
  const text = glyphs(params.text, font, size, 0, x0 + w / 2, y0 + h / 2 + T.textDy * s);
  const box = { x0, y0, x1: x0 + w, y1: y0 + h };
  return doc.render(g({ opacity: op(Math.min(1, t / 0.1) * (1 - o) * pose.opacity), transform: transform(tf.translate(x0, y0 + h / 2), tf.scale(scale), tf.translate(-x0, -(y0 + h / 2))),
    filter: dropShadow(doc, { box, sigma: T.shadow.blur * s, dy: T.shadow.dy * s, color: "#000000", opacity: alpha255(T.shadow.alpha) }) },
  roundRect(x0, y0, w, h, T.radius * s, { fill: params.accent }), path(text.d, { fill: params.ink })));
}

// ---------------------------------------------------------------------------
// Prompt bubble: on-screen text re-set large and clean (exact text only, M10).
// ---------------------------------------------------------------------------

export interface PromptBubbleParams {
  readonly component: "promptBubble";
  readonly revision: number;
  readonly width: number;
  readonly height: number;
  readonly label?: string;
  readonly lines: readonly string[];
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly duration: number;
  readonly exitAt: number;
  readonly scale?: number;
}

export function promptBubbleHeight(lines: number, s: number): number {
  const B = S1V2.bubble;
  return (B.padTop + lines * B.lineHeight + B.padBottom) * s;
}

export function promptBubbleFrame(params: PromptBubbleParams, t: number): string {
  const s = params.scale ?? params.width / S1V2.frame.width, B = S1V2.bubble, m = S1V2.motion;
  const doc = createSvgDocument({ width: params.width, height: params.height }, { idPrefix: "pb" });
  const h = promptBubbleHeight(params.lines.length, s);
  const enter = (delay: number) => curve("quintOut", clamp01((t - delay) / 0.4));
  const o = curve("snapIn", clamp01((t - params.exitAt) / 0.25));
  const parts: string[] = [];
  if (params.label) {
    const e = enter(0);
    const label = glyphs(params.label, { font: "display", weight: B.label.weight }, B.label.size * s, 0, params.x + B.label.dx * s, params.y - (B.label.gap + B.label.size / 2) * s, "start");
    parts.push(g({ opacity: op(e * (1 - o)), transform: tf.translate(0, (1 - e) * 10 * s) }, path(label.d, { fill: B.label.color })));
  }
  const eb = enter(m.stagger);
  const box = { x0: params.x, y0: params.y, x1: params.x + params.w, y1: params.y + h };
  const shadows = B.shadows.map(shadow => g({ filter: blurFilter(doc, shadow.blur * s, { ...box, y0: box.y0 + shadow.dy * s, y1: box.y1 + shadow.dy * s }) },
    roundRect(params.x, params.y + shadow.dy * s, params.w, h, B.radius * s, { fill: "#000000", opacity: alpha255(shadow.alpha) })));
  const lines = params.lines.map((line, i) => {
    const e = enter(m.stagger * (2 + i));
    const glyph = glyphs(line, { font: "display", weight: B.weight }, B.size * s, 0, params.x + B.padX * s, params.y + (B.padTop + B.lineHeight * i + B.lineHeight / 2) * s, "start");
    return g({ opacity: op(e), transform: tf.translate(0, (1 - e) * 8 * s) }, path(glyph.d, { fill: B.text }));
  });
  parts.push(g({ opacity: op(eb * (1 - o)), transform: tf.translate(0, (1 - eb) * 24 * s) }, ...shadows, roundRect(params.x, params.y, params.w, h, B.radius * s, { fill: B.fill }), ...lines));
  return doc.render(...parts);
}

// ---------------------------------------------------------------------------
// Cursor + click ripple on an action. The target follows the card content (track in frame px).
// ---------------------------------------------------------------------------

export interface CursorClickParams {
  readonly component: "cursorClick";
  readonly revision: number;
  readonly width: number;
  readonly height: number;
  readonly accent: string;
  readonly ink: string;
  readonly duration: number;
  readonly clickAt: number;
  readonly track: ReadonlyArray<{ readonly t: number; readonly x: number; readonly y: number }>;
  readonly scale?: number;
}

function trackAt(track: CursorClickParams["track"], t: number): { x: number; y: number } {
  if (t <= track[0].t) return track[0];
  for (let i = 1; i < track.length; i += 1) {
    if (t < track[i].t) { const a = track[i - 1], b = track[i], u = (t - a.t) / (b.t - a.t); return { x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u) }; }
  }
  return track[track.length - 1];
}

export function cursorClickFrame(params: CursorClickParams, t: number): string {
  const s = params.scale ?? params.width / S1V2.frame.width, C = S1V2.cursor;
  const doc = createSvgDocument({ width: params.width, height: params.height }, { idPrefix: "cc" });
  const target = trackAt(params.track, t);
  const arrive = curve("expoOut", clamp01((t - 0.05) / Math.max(0.3, params.clickAt - 0.12)));
  const leave = curve("snapIn", clamp01((t - (params.duration - 0.3)) / 0.3));
  const x = lerp(target.x + 150 * s, target.x, arrive), y = lerp(target.y + 170 * s, target.y, arrive);
  const parts: string[] = [];
  const k = t - params.clickAt;
  if (k >= 0) {
    // Two yellow rings: they expand on the click and rest at the style frame's radii, then fade with the cursor.
    C.ripple.forEach((ring, i) => {
      const p = curve("expoOut", clamp01((k - i * 0.06) / 0.5));
      if (p <= 0) return;
      parts.push(circle(target.x, target.y, lerp(0.35, 1, p) * ring.r * s, { fill: "none", stroke: params.accent, "stroke-width": Number(fmt(C.rippleWidth * s, 2)),
        "stroke-opacity": Number((alpha255(ring.alpha) * (1 - leave) * (1 + 1.2 * (1 - p))).toFixed(3)) }));
    });
  }
  const press = k >= 0 ? 1 - 0.12 * Math.sin(Math.PI * clamp01(k / 0.16)) : 1;
  const pts: Array<[number, number]> = [[0, 0], [0, 62], [16, 47], [30, 78], [42, 72], [29, 42], [50, 42]];
  const d = `M${pts.map(([px, py]) => `${fmt(px * s, 2)} ${fmt(py * s, 2)}`).join("L")}Z`;
  const opacity = Math.min(1, t / 0.12) * (1 - leave);
  parts.push(g({ opacity: op(opacity), transform: transform(tf.translate(x, y), press !== 1 ? tf.scale(press) : false),
    filter: dropShadow(doc, { box: { x0: 0, y0: 0, x1: 50 * s, y1: 78 * s }, sigma: C.shadow.blur * s, dx: C.shadow.dx * s, dy: C.shadow.dy * s, color: "#000000", opacity: alpha255(C.shadow.alpha) }) },
  path(d, { fill: "#FFFFFF", stroke: params.ink, "stroke-width": Number(fmt(2 * s, 2)), "stroke-linejoin": "round" })));
  return doc.render(...parts);
}
