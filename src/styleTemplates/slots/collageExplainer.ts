import { backOut, clamp01, expoInOut, expoOut, lerp, smootherstep } from "../../motionLibrary/svg/easing";
import { assertMotionText, type MotionFontSelector } from "../../motionLibrary/svg/glyphs";
import { grayOf, halftone, noise1d, noise2d, paperTexture, skyMask, tornMasks, tornPiece, withShadow, type TornMasksV1 } from "./collageKit";
import type { StyleCompositeFrameV1, StyleCompositeHooksV1, StyleCompositeLayersV1, StyleSvgArtV1 } from "./compositeComponent";
import { affine, createRaster, drawImage, gaussianBlur, grain, hexRgb, mixRgb, over, seededRandom, vignette, type MipChainV1, type RasterV1, type Rgb } from "./raster";
import { imagePlacement, svgImageElement, type SlotImageParams } from "./svgImage";
import { fitLine, placeLine, svgFrame } from "./templateType";

/**
 * collageExplainer (S5 vox_collage, from R5; Claude's style frames S5_A / S5_B / S5_A_16x9 / S5_reskin): a Vox-style collage
 * explainer above (portrait) or beside (landscape) the speaker. Owned procedural paper: newsprint greeking, torn paper with
 * fibrous margins, halftone print, paper tooth (collageKit.ts); cut-out photo plates with parallax, a big serif wordmark
 * with a hard ink offset, a torn kicker tag, single-word uppercase captions with a gloss line, and — when step labels are
 * given — a second act: three numbered step plates on an accent band with a hand-drawn dashed arrow.
 *
 * Renderer "svg": every glyph and picture is SVG art rasterized once by the bundled librsvg; the pieces are cut, printed
 * and posed per frame by the template compositor (no per-frame picture documents). Output alpha: with no speaker picture
 * the speaker area stays transparent, so the footage on the track below plays through (the "video slot").
 */

export const COLLAGE_EXPLAINER_REVISION = 1;
export const COLLAGE_IMAGE_SLOTS = ["speaker", "cutout", "plate", "stepPhoto1", "stepPhoto2", "stepPhoto3"] as const;
type ImageSlot = typeof COLLAGE_IMAGE_SLOTS[number];

export interface CollageParams {
  readonly component: "collageExplainer";
  readonly revision: number;
  readonly width: number;
  readonly height: number;
  readonly duration: number;
  readonly palette: { readonly paper: string; readonly bg: string; readonly accent: string };
  readonly text: { readonly wordmark: string; readonly kicker?: string; readonly caption?: string; readonly gloss?: string;
    readonly step1?: string; readonly step2?: string; readonly step3?: string; readonly stepCaption?: string; readonly stepGloss?: string };
  readonly images: Partial<Record<ImageSlot, SlotImageParams>>;
  /** Act B (the steps) and the tear between the acts; null: act A for the whole clip. */
  readonly actB: { readonly at: number; readonly tear: number } | null;
}

const SANS = (weight: number): MotionFontSelector => ({ font: "display", weight });
const SERIF: MotionFontSelector = { font: "serif", weight: 900 };

interface Box { x: number; y: number; w: number; h: number }
interface Layout { s: number; panel: Box; edge: "b" | "r"; speaker: Box; caption: { x: number; y: number }; portrait: boolean }

function layout(p: Pick<CollageParams, "width" | "height">): Layout {
  const { width: W, height: H } = p, portrait = H >= W, s = Math.min(W, H) / 1080;
  if (portrait) return { s, portrait, edge: "b", panel: { x: 0, y: 0, w: W, h: Math.round(1000 * s) }, speaker: { x: 0, y: Math.round(960 * s), w: W, h: H - Math.round(960 * s) }, caption: { x: W / 2, y: 1385 * s } };
  const split = Math.round(W * 0.58);
  return { s, portrait, edge: "r", panel: { x: 0, y: 0, w: split, h: H }, speaker: { x: split - Math.round(40 * s), y: 0, w: W - split + Math.round(40 * s), h: H },
    caption: { x: split + (W - split) / 2 + 10 * s, y: H * 0.8 } };
}

export function collageParams(input: { width: number; height: number; duration: number; palette: CollageParams["palette"]; text: CollageParams["text"]; images: CollageParams["images"] }): CollageParams {
  const steps = [input.text.step1, input.text.step2, input.text.step3].filter(Boolean).length;
  const actB = steps && input.duration >= 3 ? { at: Math.round(input.duration * 0.5 * 1000) / 1000, tear: 0.32 } : null;
  return { component: "collageExplainer", revision: COLLAGE_EXPLAINER_REVISION, width: input.width, height: input.height, duration: input.duration,
    palette: input.palette, text: input.text, images: input.images, actB };
}

// ---------------------------------------------------------------------------
// Piece geometry (panel-relative, as in the style frame)
// ---------------------------------------------------------------------------

function geometry(p: CollageParams) {
  const L = layout(p), P = L.panel, s = L.s;
  const plate = { w: Math.round(P.w * 0.33), h: Math.round(P.h * 0.5), cx: P.w * 0.25, cy: P.h * 0.47, rot: -3.5 };
  const steps = [stepSlot(p, 0), stepSlot(p, 1), stepSlot(p, 2)].filter(Boolean).length;
  const active = Math.max(0, steps - 1);
  const small = [[0.17, 0.5, 0.27, 0.4, -5], [0.43, 0.47, 0.27, 0.4, 3]] as const, big = [0.74, 0.52, 0.4, 0.58, -2] as const;
  const stepSlots = steps <= 1 ? [[0.5, 0.52, 0.46, 0.62, -2]] : steps === 2 ? [[0.27, 0.5, 0.36, 0.5, -4], [0.7, 0.52, 0.42, 0.6, 2]] : [small[0], small[1], big];
  return {
    L, s, P,
    sun: { r: Math.round(250 * s), cx: P.w - 220 * s, cy: 320 * s },
    sky: { w: Math.round(P.w * 0.86), h: Math.round(P.h * 0.5), cx: P.w * 0.5, cy: P.h * 0.4, rot: -1.4 },
    plate, tape: { cx: plate.cx, cy: plate.cy - plate.h / 2 + 4 * s, rot: 4 },
    cutout: { w: Math.round(P.w * 0.5), h: Math.round(P.h * 0.62), cx: P.w * 0.71, cy: P.h * 0.53, rot: 1.8 },
    kicker: { x: 70 * s, y: L.portrait ? Math.max(P.h * 0.17 + 30 * s, 252 * s) : P.h * 0.17 + 30 * s, rot: -2.5 },
    wordmark: { cx: P.w / 2, bottom: P.h * 0.77 },
    band: { w: Math.round(P.w * 1.1), h: Math.round(P.h * 0.3), cx: P.w * 0.5, cy: P.h * 0.58, rot: -6 },
    steps: stepSlots.map(([cx, cy, w, h, rot], index) => ({ cx: P.w * cx, cy: P.h * cy, w: Math.round(P.w * w), h: Math.round(P.h * h), rot, active: index === stepSlots.length - 1 && steps > 1 ? true : steps === 1 })),
    active,
  };
}

function stepSlot(p: CollageParams, index: number): string | undefined {
  return [p.text.step1, p.text.step2, p.text.step3][index];
}

// ---------------------------------------------------------------------------
// SVG art: pictures fitted to their windows, glyph masks
// ---------------------------------------------------------------------------

function pictureArt(href: string, image: SlotImageParams, w: number, h: number): StyleSvgArtV1 {
  const placed = imagePlacement(image, { w, h });
  return { width: w, height: h, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${svgImageElement(href, placed.x, placed.y, placed.w, placed.h)}</svg>` };
}

/** A white glyph mask of one line (ink box + pad), its size in px. */
function textArt(text: string, face: MotionFontSelector, size: number, tracking: number): StyleSvgArtV1 {
  const line = placeLine(text, face, size, tracking, 0, 0, "start", "top");
  const pad = Math.ceil(size * 0.06) + 2, w = Math.ceil(line.box.x1 - line.box.x0) + pad * 2, h = Math.ceil(line.box.y1 - line.box.y0) + pad * 2;
  const shifted = placeLine(text, face, size, tracking, pad, pad, "start", "top");
  return { width: Math.max(2, w), height: Math.max(2, h), svg: svgFrame(Math.max(2, w), Math.max(2, h), `<path d="${shifted.d}" fill="#FFFFFF"/>`) };
}

function windows(p: CollageParams): Record<ImageSlot, { w: number; h: number }> {
  const G = geometry(p), sp = G.L.speaker;
  // Step pictures are sized for the largest plate any step count uses (one step: 0.46 x 0.62 of the panel).
  const step = { w: Math.round(G.P.w * 0.46) - Math.round(28 * G.s), h: Math.round(G.P.h * 0.62) - Math.round(28 * G.s) };
  return {
    speaker: { w: Math.round(sp.w * 1.12), h: Math.round(sp.h * 1.12) },
    cutout: { w: G.cutout.w, h: Math.round(G.cutout.h / 0.72) },
    plate: { w: G.plate.w - Math.round(32 * G.s), h: G.plate.h - Math.round(32 * G.s) },
    stepPhoto1: step, stepPhoto2: step, stepPhoto3: step,
  };
}

/** Pixel window a picture slot fills at this output size (the renderer sizes the derivative to cover it). */
export function collageImageWindowV1(frame: { readonly width: number; readonly height: number }, slotId: string): { w: number; h: number } | undefined {
  const full: CollageParams = { component: "collageExplainer", revision: COLLAGE_EXPLAINER_REVISION, width: frame.width, height: frame.height, duration: 4,
    palette: { paper: "#F5EEE0", bg: "#1C1C1A", accent: "#2F6FD6" }, text: { wordmark: "-" }, images: {}, actB: null };
  return (windows(full) as Record<string, { w: number; h: number }>)[slotId];
}

const sizes = (p: CollageParams) => {
  const G = geometry(p), s = G.s, P = G.P;
  const wordmarkMax = P.h * (G.L.portrait ? 0.3 : 0.32);
  return {
    wordmark: fitLine(p.text.wordmark, SERIF, wordmarkMax, 0.02, P.w * 0.88),
    kicker: 40 * s, caption: 104 * s * (G.L.portrait ? 1 : 0.92), gloss: 40 * s * (G.L.portrait ? 1 : 0.95), stepLabelBig: 34 * s, stepLabel: 28 * s, numBig: 64 * s, num: 50 * s,
  };
};

function pieces(params: Record<string, unknown>, images: Readonly<Record<string, string>>): Record<string, StyleSvgArtV1> {
  const p = params as unknown as CollageParams, out: Record<string, StyleSvgArtV1> = {}, win = windows(p), z = sizes(p);
  for (const slot of COLLAGE_IMAGE_SLOTS) {
    const image = p.images[slot], href = images[slot];
    if (image && href) out[`img:${slot}`] = pictureArt(href, image, win[slot].w, win[slot].h);
  }
  out["t:wordmark"] = textArt(p.text.wordmark, SERIF, z.wordmark, 0.02);
  if (p.text.kicker) out["t:kicker"] = textArt(p.text.kicker, SANS(800), z.kicker, 0.02);
  if (p.text.caption) out["t:caption"] = textArt(p.text.caption, SANS(900), z.caption, 0.08);
  if (p.text.gloss) out["t:gloss"] = textArt(p.text.gloss, SANS(700), z.gloss, 0.08);
  if (p.actB) {
    const G = geometry(p);
    G.steps.forEach((step, index) => {
      const label = stepSlot(p, index);
      if (label) out[`t:step${index + 1}`] = textArt(label, SANS(800), step.active ? z.stepLabelBig : z.stepLabel, 0.02);
      out[`t:num${index + 1}`] = textArt(String(index + 1).padStart(2, "0"), SERIF, step.active ? z.numBig : z.num, 0);
    });
    if (p.text.stepCaption) out["t:stepCaption"] = textArt(p.text.stepCaption, SANS(900), z.caption, 0.08);
    if (p.text.stepGloss) out["t:stepGloss"] = textArt(p.text.stepGloss, SANS(700), z.gloss, 0.08);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Refine: torn paper, print, cut-outs, tags (pixel work once per clip)
// ---------------------------------------------------------------------------

type Plane = Float32Array;
const alphaOf = (r: RasterV1): Plane => { const n = r.width * r.height, out = new Float32Array(n); for (let i = 0; i < n; i += 1) out[i] = r.data[i * 4 + 3]; return out; };

function grade(rgb: Float32Array, warm = 1): void {
  for (let i = 0; i < rgb.length; i += 3) {
    rgb[i] = Math.max(0, Math.min(1, (rgb[i] - 0.5) * 1.07 + 0.51)) * (1 + 0.03 * warm);
    rgb[i + 1] = Math.max(0, Math.min(1, (rgb[i + 1] - 0.5) * 1.07 + 0.51));
    rgb[i + 2] = Math.max(0, Math.min(1, (rgb[i + 2] - 0.5) * 1.07 + 0.51)) * (1 - 0.04 * warm);
  }
}

/** RGB (straight) of a premultiplied picture raster. */
function rgbOf(r: RasterV1): Float32Array {
  const n = r.width * r.height, out = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) { const a = Math.max(r.data[i * 4 + 3], 1e-4); out[i * 3] = r.data[i * 4] / a; out[i * 3 + 1] = r.data[i * 4 + 1] / a; out[i * 3 + 2] = r.data[i * 4 + 2] / a; }
  return out;
}

class Paper {
  constructor(readonly texture: Plane, readonly width: number, readonly height: number) {}
  /** Colour × paper tooth at an offset (k: modulation depth). */
  fill(w: number, h: number, color: Rgb, seed: number, k = 0.22): Float32Array {
    const rand = seededRandom(seed), ox = Math.floor(rand() * 900), oy = Math.floor(rand() * 1700), out = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
      const t = this.texture[((y + oy) % this.height) * this.width + ((x + ox) % this.width)], m = 1 + (t - 0.5) * k * 2, o = (y * w + x) * 3;
      out[o] = color[0] * m; out[o + 1] = color[1] * m; out[o + 2] = color[2] * m;
    }
    return out;
  }
}

/** Places a mask plane (mw × mh) into a fill at (x, y) as ink. */
function inkInto(fill: Float32Array, W: number, mask: Plane, mw: number, mh: number, x: number, y: number, ink: Rgb): void {
  const H = fill.length / 3 / W;
  for (let j = 0; j < mh; j += 1) {
    const yy = y + j;
    if (yy < 0 || yy >= H) continue;
    for (let i = 0; i < mw; i += 1) {
      const xx = x + i, a = mask[j * mw + i];
      if (xx < 0 || xx >= W || a <= 0) continue;
      const o = (yy * W + xx) * 3;
      fill[o] += (ink[0] - fill[o]) * a; fill[o + 1] += (ink[1] - fill[o + 1]) * a; fill[o + 2] += (ink[2] - fill[o + 2]) * a;
    }
  }
}

/** Torn paper tag with ink text (and an optional gloss line under it). */
function tag(paper: Paper, text: RasterV1, gloss: RasterV1 | undefined, fillColor: Rgb, ink: Rgb, paperColor: Rgb, seed: number, pad: [number, number], s: number): RasterV1 {
  const tw = text.width, th = text.height, gw = gloss?.width ?? 0, gh = gloss?.height ?? 0, gap = gloss ? Math.round(2 * s) : 0;
  const w = Math.max(tw, gw) + pad[0] * 2, h = th + pad[1] * 2 + (gloss ? gh + gap : 0);
  const masks = tornMasks(w, h, 4 * s, seed, "trbl", 4 * s);
  const fill = paper.fill(masks.width, masks.height, fillColor, seed, 0.12);
  inkInto(fill, masks.width, alphaOf(text), tw, th, masks.margin + Math.round((w - tw) / 2), masks.margin + pad[1], ink);
  if (gloss) inkInto(fill, masks.width, alphaOf(gloss), gw, gh, masks.margin + Math.round((w - gw) / 2), masks.margin + pad[1] + th + gap, ink);
  return tornPiece(masks, fill, paperColor);
}

/** Photo plate: paper frame with a torn edge, the picture inside with a light print halftone. */
function photoPlate(paper: Paper, picture: RasterV1 | undefined, w: number, h: number, paperColor: Rgb, accent: Rgb, seed: number, border: number, desaturate = false): RasterV1 {
  const masks = tornMasks(w, h, 6.5 * (border / 16), seed, "trbl", 5.5 * (border / 16)), W = masks.width;
  const fill = paper.fill(W, masks.height, paperColor, seed);
  const iw = w - border * 2, ih = h - border * 2;
  let rgb: Float32Array;
  if (picture) {
    // The picture covers its window (it was rendered at the largest window; resample to this plate).
    const scaled = resampleRaster(picture, iw, ih);
    rgb = rgbOf(scaled); grade(rgb);
    const ht = halftone(gaussianBlur(grayOf(scaled), iw, ih, 1, 1.5), iw, ih, 6, 45);
    for (let i = 0; i < iw * ih; i += 1) { const k = 1 - ht[i] * 0.1; rgb[i * 3] *= k; rgb[i * 3 + 1] *= k; rgb[i * 3 + 2] *= k; }
    if (desaturate) for (let i = 0; i < iw * ih; i += 1) { const g = (rgb[i * 3] + rgb[i * 3 + 1] + rgb[i * 3 + 2]) / 3; for (let c = 0; c < 3; c += 1) rgb[i * 3 + c] = (rgb[i * 3 + c] * 0.75 + g * 0.25) * 0.92; }
  } else {
    // No picture: a blank accent-tinted print with a halftone gradient (the paper placeholder).
    rgb = new Float32Array(iw * ih * 3);
    const gray = new Float32Array(iw * ih);
    for (let y = 0; y < ih; y += 1) for (let x = 0; x < iw; x += 1) gray[y * iw + x] = 0.35 + 0.6 * (y / ih);
    const ht = halftone(gray, iw, ih, 9, 45), base = mixRgb(accent, paperColor, 0.55);
    for (let i = 0; i < iw * ih; i += 1) for (let c = 0; c < 3; c += 1) rgb[i * 3 + c] = base[c] * (1 - ht[i] * 0.3) + accent[c] * ht[i] * 0.3;
  }
  const x0 = masks.margin + border, y0 = masks.margin + border;
  for (let y = 0; y < ih; y += 1) for (let x = 0; x < iw; x += 1) { const o = ((y0 + y) * W + x0 + x) * 3, s = (y * iw + x) * 3; fill[o] = rgb[s]; fill[o + 1] = rgb[s + 1]; fill[o + 2] = rgb[s + 2]; }
  return tornPiece(masks, fill, paperColor);
}

function resampleRaster(src: RasterV1, w: number, h: number): RasterV1 {
  if (src.width === w && src.height === h) return src;
  // Cover-crop about the centre, then bilinear.
  const scale = Math.max(w / src.width, h / src.height), out = createRaster(w, h, 4);
  drawImage(out, src.width * scale >= src.width * 0.5 ? src : src, affine.place(src.width, src.height, w / 2, h / 2, 0, scale));
  return out;
}

/** The newsprint panel (greeking columns, headline bars, photo boxes, mottling) as an opaque RGB fill. */
function newsprint(w: number, h: number, bg: Rgb, paperColor: Rgb, seed: number, s: number): Float32Array {
  const ss = 2, W = w * ss, H = h * ss, plane = new Float32Array(W * H), rand = seededRandom(seed);
  const rectFill = (x0: number, y0: number, x1: number, y1: number, v: number) => {
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(H, Math.ceil(y1)); y += 1) for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x1)); x += 1) plane[y * W + x] = v;
  };
  const k = s * ss, colW = 330 * k * 0.5, gutter = 40 * k * 0.5;
  for (let x = 40 * k * 0.5; x + colW < W; x += colW + gutter) {
    let y = (40 + rand() * 60) * k * 0.5;
    while (y < H - 40 * k * 0.5) {
      const kind = rand();
      if (kind < 0.06) {
        const lines = 1 + Math.floor(rand() * 2);
        for (let l = 0; l < lines; l += 1) {
          for (let xx = x; xx < x + colW - 40 * k * 0.5;) { const wl = (40 + rand() * 80) * k * 0.5; rectFill(xx, y, Math.min(xx + wl, x + colW), y + 22 * k * 0.5, 170 / 255); xx += wl + 14 * k * 0.5; }
          y += 36 * k * 0.5;
        }
        y += 18 * k * 0.5;
      } else if (kind < 0.1) {
        const hh = (120 + rand() * 140) * k * 0.5; rectFill(x, y, x + colW, y + hh, 60 / 255); y += hh + 24 * k * 0.5;
      } else {
        const lines = 6 + Math.floor(rand() * 10);
        for (let li = 0; li < lines; li += 1) {
          const end = x + colW - (li === lines - 1 ? (40 + rand() * 160) * k * 0.5 : 0);
          for (let xx = x + (li === 0 ? 24 * k * 0.5 : 0); xx < end - 10 * k * 0.5;) { const wl = (14 + rand() * 44) * k * 0.5; rectFill(xx, y, Math.min(xx + wl, end), y + 7 * k * 0.5, 110 / 255); xx += wl + 8 * k * 0.5; }
          y += 17 * k * 0.5;
        }
        y += 17 * k * 0.5;
      }
    }
  }
  const mott = noise2dSmall(h, w, seed + 7, 220 * s), fib = noise2dSmall(h, w, seed + 8, 3 * s), out = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    let g = 0;
    for (let dy = 0; dy < ss; dy += 1) for (let dx = 0; dx < ss; dx += 1) g += plane[(y * ss + dy) * W + x * ss + dx];
    g /= ss * ss;
    const i = y * w + x, news = Math.max(0, Math.min(1, 0.5 + g * 0.5 + mott[i] * 0.08 + fib[i] * 0.05)), o = i * 3;
    for (let c = 0; c < 3; c += 1) out[o + c] = bg[c] * (0.85 + 0.3 * news) + (paperColor[c] - bg[c]) * Math.max(0, Math.min(1, (news - 0.62) * 0.35));
  }
  return out;
}

function noise2dSmall(h: number, w: number, seed: number, scale: number): Float32Array {
  return noise2d(h, w, seed, scale);
}

function halftoneDisc(r: number, color: Rgb, cell: number): RasterV1 {
  const size = Math.ceil(r * 2), gray = new Float32Array(size * size), inside = new Float32Array(size * size);
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const d = Math.hypot(x + 0.5 - r, y + 0.5 - r) / r;
    gray[y * size + x] = Math.max(0, Math.min(1, 0.15 + d * 0.95)); inside[y * size + x] = d < 1 ? 1 : 0;
  }
  const ht = halftone(gray, size, size, cell, 30), out = createRaster(size, size, 4);
  for (let i = 0; i < size * size; i += 1) { const a = ht[i] * inside[i] * 0.9; out.data[i * 4] = color[0] * a; out.data[i * 4 + 1] = color[1] * a; out.data[i * 4 + 2] = color[2] * a; out.data[i * 4 + 3] = a; }
  return out;
}

function refine(params: Record<string, unknown>, art: Readonly<Record<string, RasterV1>>): Record<string, RasterV1> {
  const p = params as unknown as CollageParams, G = geometry(p), s = G.s, P = G.P, L = G.L;
  const paperC = hexRgb(p.palette.paper), bgC = hexRgb(p.palette.bg), accent = hexRgb(p.palette.accent), white: Rgb = [1, 1, 1];
  const tex = new Paper(paperTexture(1080, 1920, 1022), 1080, 1920);
  const out: Record<string, RasterV1> = {};
  const shadow = (piece: RasterV1, layers: ReadonlyArray<readonly [number, number, number]>) => withShadow(piece, layers.map(([b, dy, o]) => [b * s, dy * s, o] as const), Math.ceil(Math.max(...layers.map(([b, dy]) => b * 3 + dy)) * s) + 2);

  // Panel: newsprint behind everything, a torn paper edge (bottom or right) casting onto the speaker.
  const anchor = panelAnchor(p), panelMasks = L.edge === "b" ? tornMasks(P.w + anchor.overscan, P.h, 11 * s, 77, "b", 9 * s) : tornMasks(P.w, P.h + anchor.overscan, 11 * s, 78, "r", 9 * s);
  const news = newsprint(panelMasks.width, panelMasks.height, bgC, paperC, 1022, s);
  out.panel = withShadow(tornPiece(panelMasks, news, paperC), anchor.shadow, anchor.pad);
  // Paper grain over the collage (multiplied per frame).
  const grainPlane = paperTexture(P.w, P.h, 3301), grainRaster = createRaster(P.w, P.h, 4);
  for (let i = 0; i < P.w * P.h; i += 1) grainRaster.data[i * 4 + 3] = grainPlane[i];
  out.paperGrain = grainRaster;

  // Act A.
  out.sun = halftoneDisc(G.sun.r, accent, 11 * s);
  {
    const sky = tornMasks(G.sky.w, G.sky.h, 8 * s, 21, "trbl", 7 * s), W = sky.width, H = sky.height, gray = new Float32Array(W * H), fill = tex.fill(W, H, white, 40, 0.09);
    for (let y = 0; y < H; y += 1) { const t = y / H; for (let x = 0; x < W; x += 1) gray[y * W + x] = Math.max(0, Math.min(1, 0.35 + t * 0.9)); }
    const ht = halftone(gray, W, H, 9 * s, 45);
    for (let y = 0; y < H; y += 1) {
      const t = Math.min(1, (y / H) * 1.2), base = mixRgb(mixRgb(accent, paperC, 0.38), paperC, t);
      for (let x = 0; x < W; x += 1) { const i = y * W + x, o = i * 3; for (let c = 0; c < 3; c += 1) fill[o + c] = base[c] * fill[o + c] * (1 - ht[i] * 0.28) + accent[c] * ht[i] * 0.28; }
    }
    out.sky = shadow(tornPiece(sky, fill, paperC), [[16, 10, 0.45], [4, 3, 0.35]]);
  }
  out.plate = shadow(photoPlate(tex, art["img:plate"], G.plate.w, G.plate.h, paperC, accent, 31, Math.round(16 * s)), [[22, 14, 0.55], [5, 4, 0.4]]);
  {
    const tape = tornMasks(Math.round(150 * s), Math.round(46 * s), 3 * s, 4, "lr", 2 * s), fill = tex.fill(tape.width, tape.height, mixRgb(paperC, white, 0.2), 3, 0.1);
    const piece = tornPiece(tape, fill, paperC);
    for (let i = 0; i < piece.width * piece.height * 4; i += 1) piece.data[i] *= 0.78;
    out.tape = shadow(piece, [[3, 2, 0.25]]);
  }
  out.cutout = shadow(cutout(art["img:cutout"], G.cutout.w, G.cutout.h, paperC, accent, s), [[20, 12, 0.55], [5, 4, 0.4]]);
  if (art["t:kicker"]) out.kicker = shadow(tag(tex, art["t:kicker"], undefined, paperC, bgC, paperC, 12, [Math.round(26 * s), Math.round(14 * s)], s), [[6, 4, 0.45]]);
  {
    // Wordmark: cream glyphs, a hard ink offset (9, 7) and a soft shadow.
    const word = art["t:wordmark"], pad = Math.ceil(30 * s), W = word.width + pad * 2, H = word.height + pad * 2, a = alphaOf(word), piece = createRaster(W, H, 4);
    const ox = Math.round(7 * s), oy = Math.round(9 * s);
    for (let y = 0; y < word.height; y += 1) for (let x = 0; x < word.width; x += 1) {
      const v = a[y * word.width + x];
      if (v <= 0) continue;
      const o = ((y + pad + oy) * W + x + pad + ox) * 4, k = 1 - piece.data[o + 3];
      piece.data[o] += bgC[0] * v * k; piece.data[o + 1] += bgC[1] * v * k; piece.data[o + 2] += bgC[2] * v * k; piece.data[o + 3] += v * k;
    }
    for (let y = 0; y < word.height; y += 1) for (let x = 0; x < word.width; x += 1) {
      const v = a[y * word.width + x];
      if (v <= 0) continue;
      const o = ((y + pad) * W + x + pad) * 4, k = 1 - v;
      piece.data[o] = piece.data[o] * k + paperC[0] * v; piece.data[o + 1] = piece.data[o + 1] * k + paperC[1] * v; piece.data[o + 2] = piece.data[o + 2] * k + paperC[2] * v; piece.data[o + 3] = piece.data[o + 3] * k + v;
    }
    out.wordmark = shadow(piece, [[26, 16, 0.55]]);
  }
  if (art["t:caption"]) out.caption = shadow(tag(tex, art["t:caption"], art["t:gloss"], paperC, bgC, paperC, 88, [Math.round(40 * s), Math.round(16 * s)], s), [[16, 10, 0.55], [4, 3, 0.45]]);
  if (art["img:speaker"]) {
    const sp = art["img:speaker"], rgb = rgbOf(sp); grade(rgb);
    const piece = createRaster(sp.width, sp.height, 4), cx = sp.width / 2, cy = sp.height * 0.45;
    for (let y = 0; y < sp.height; y += 1) for (let x = 0; x < sp.width; x += 1) {
      const i = y * sp.width + x, r = Math.exp(-(((x - cx) / (sp.width * 0.8)) ** 2 + ((y - cy) / (sp.height * 0.7)) ** 2)), k = 0.86 + 0.14 * r;
      piece.data[i * 4] = rgb[i * 3] * k; piece.data[i * 4 + 1] = rgb[i * 3 + 1] * k; piece.data[i * 4 + 2] = rgb[i * 3 + 2] * k; piece.data[i * 4 + 3] = 1;
    }
    out.speaker = piece;
  }

  // Act B.
  if (p.actB) {
    const band = tornMasks(G.band.w, G.band.h, 9 * s, 41, "trbl", 7 * s);
    out.band = shadow(tornPiece(band, tex.fill(band.width, band.height, accent, 3, 0.1), paperC), [[12, 8, 0.4]]);
    G.steps.forEach((step, index) => {
      const picture = art[`img:stepPhoto${index + 1}`];
      out[`step${index + 1}`] = shadow(photoPlate(tex, picture, step.w, step.h, paperC, accent, 50 + index, Math.round(14 * s), !step.active),
        step.active ? [[26, 18, 0.6], [6, 5, 0.45]] : [[14, 9, 0.45], [4, 3, 0.35]]);
      out[`num${index + 1}`] = shadow(tag(tex, art[`t:num${index + 1}`], undefined, step.active ? accent : paperC, step.active ? paperC : bgC, paperC, 60 + index, [Math.round(26 * s), Math.round(14 * s)], s), [[6, 4, 0.5]]);
      if (art[`t:step${index + 1}`]) out[`label${index + 1}`] = shadow(tag(tex, art[`t:step${index + 1}`], undefined, paperC, bgC, paperC, 70 + index, [Math.round(26 * s), Math.round(14 * s)], s), [[5, 3, 0.45]]);
    });
    if (art["t:stepCaption"]) out.stepCaption = shadow(tag(tex, art["t:stepCaption"], art["t:stepGloss"], paperC, bgC, paperC, 89, [Math.round(40 * s), Math.round(16 * s)], s), [[16, 10, 0.55], [4, 3, 0.45]]);
  }
  return out;
}

/** Sticker cut-out: the sky keyed out from the top, a cream sticker border, a torn bottom edge, light print. */
function cutout(picture: RasterV1 | undefined, w: number, h: number, paperC: Rgb, accent: Rgb, s: number): RasterV1 {
  const pad = Math.round(18 * s), W = w + pad * 2, H = h + pad * 2;
  const masks = tornMasks(w, h, 7 * s, 9, "b", 5 * s), tear = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) tear[y * w + x] = masks.print[(y + masks.margin) * masks.width + x + masks.margin];
  let rgb: Float32Array, keep: Plane;
  if (picture) {
    const crop = createRaster(w, h, 4);
    drawImage(crop, picture, affine.translate(0, 0));
    keep = skyMask(crop).map(v => 1 - v);
    rgb = rgbOf(crop);
    const ht = halftone(gaussianBlur(grayOf(crop), w, h, 1, 1.2), w, h, 6 * s, 45);
    for (let i = 0; i < w * h; i += 1) { const k = 1 - ht[i] * 0.08; rgb[i * 3] *= k; rgb[i * 3 + 1] *= k; rgb[i * 3 + 2] *= k; }
    grade(rgb);
  } else {
    // No picture: a paper silhouette of rooftops in the accent tint.
    keep = new Float32Array(w * h); rgb = new Float32Array(w * h * 3);
    const roofs = noise1d(w, 5, 2, 120 * s);
    for (let x = 0; x < w; x += 1) {
      const top = h * (0.25 + 0.12 * roofs[x]) + (Math.floor(x / (70 * s)) % 3) * 30 * s;
      for (let y = 0; y < h; y += 1) { const i = y * w + x; keep[i] = Math.max(0, Math.min(1, y + 0.5 - top)); for (let c = 0; c < 3; c += 1) rgb[i * 3 + c] = mixRgb(accent, paperC, 0.25 + 0.3 * (y / h))[c]; }
    }
  }
  const A = new Float32Array(W * H);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) A[(y + pad) * W + x + pad] = keep[y * w + x] * tear[y * w + x];
  const border = gaussianBlur(A, W, H, 1, 5.5 * s), piece = createRaster(W, H, 4), cream = mixRgb(paperC, [1, 1, 1], 0.4);
  for (let i = 0; i < W * H; i += 1) {
    const b = Math.max(0, Math.min(1, (border[i] - 0.12) * 6)), a = Math.max(b, A[i]);
    piece.data[i * 4 + 3] = a; piece.data[i * 4] = cream[0] * a; piece.data[i * 4 + 1] = cream[1] * a; piece.data[i * 4 + 2] = cream[2] * a;
  }
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const i = (y + pad) * W + x + pad, a = A[i], s3 = (y * w + x) * 3;
    if (a <= 0) continue;
    piece.data[i * 4] += (rgb[s3] - piece.data[i * 4] / Math.max(piece.data[i * 4 + 3], 1e-4)) * a * piece.data[i * 4 + 3];
    piece.data[i * 4 + 1] += (rgb[s3 + 1] - piece.data[i * 4 + 1] / Math.max(piece.data[i * 4 + 3], 1e-4)) * a * piece.data[i * 4 + 3];
    piece.data[i * 4 + 2] += (rgb[s3 + 2] - piece.data[i * 4 + 2] / Math.max(piece.data[i * 4 + 3], 1e-4)) * a * piece.data[i * 4 + 3];
  }
  return piece;
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

function piece(layers: StyleCompositeLayersV1, name: string): MipChainV1 | undefined { return layers.pieces[name]; }

/** Draws a piece centred at (cx, cy) in frame px with rotation, scale and opacity. */
function put(out: RasterV1, chain: MipChainV1 | undefined, cx: number, cy: number, rot = 0, scale = 1, opacity = 1): void {
  if (!chain || opacity <= 0.001 || scale <= 0.001) return;
  const base = chain.levels[0];
  drawImage(out, chain, affine.place(base.width, base.height, cx, cy, rot, scale), opacity);
}

/** Entry helper: 0 → 1 over [start, start + duration]. */
const enter = (t: number, start: number, duration: number) => clamp01((t - start) / duration);

function arrowSvg(p: CollageParams, local: number): string {
  const { width: W, height: H } = p, G = geometry(p), s = G.s, P = G.P;
  if (G.steps.length < 2 || local < 0.45) return svgFrame(W, H, "");
  const a = G.steps[0], b = G.steps[G.steps.length - 1];
  const p0 = [P.x + a.cx + 40 * s, P.y + a.cy - a.h / 2 - 30 * s], p2 = [P.x + b.cx - 30 * s, P.y + b.cy - b.h / 2 - 34 * s], mid = [(p0[0] + p2[0]) / 2, Math.min(p0[1], p2[1]) - 70 * s];
  const d = `M${p0[0].toFixed(1)} ${p0[1].toFixed(1)}Q${mid[0].toFixed(1)} ${(mid[1] - 40 * s).toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  const length = Math.hypot(p2[0] - p0[0], p2[1] - p0[1]) * 1.25, draw = smootherstep(0, 1, enter(local, 0.45, 0.55));
  const color = `rgb(${mixRgb(hexRgb(p.palette.paper), [1, 1, 1], 0.3).map(v => Math.round(v * 255)).join(",")})`;
  const dash = `${(22 * s).toFixed(1)} ${(14 * s).toFixed(1)}`;
  // The dashed curve is revealed by a mask stroke drawn on along the same path; the head lands with the tip.
  const mask = `<mask id="am" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><path d="${d}" fill="none" stroke="#FFFFFF" stroke-width="${(20 * s).toFixed(1)}" stroke-dasharray="${(length * draw).toFixed(1)} ${(length * 2).toFixed(1)}"/></mask>`;
  const tip = p2, back = [p2[0] - (p2[0] - mid[0]) * 0.08, p2[1] - (p2[1] - (mid[1] - 40 * s)) * 0.08], v = [tip[0] - back[0], tip[1] - back[1]], l = Math.hypot(v[0], v[1]) || 1, u = [v[0] / l, v[1] / l], n = [-u[1], u[0]];
  const head = draw > 0.97 ? `<path d="M${(tip[0] - u[0] * 34 * s + n[0] * 22 * s).toFixed(1)} ${(tip[1] - u[1] * 34 * s + n[1] * 22 * s).toFixed(1)}L${tip[0].toFixed(1)} ${tip[1].toFixed(1)}L${(tip[0] - u[0] * 34 * s - n[0] * 22 * s).toFixed(1)} ${(tip[1] - u[1] * 34 * s - n[1] * 22 * s).toFixed(1)}" fill="none" stroke="${color}" stroke-width="${(6 * s).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"/>` : "";
  return svgFrame(W, H, `<g mask="url(#am)"><path d="${d}" fill="none" stroke="${color}" stroke-width="${(6 * s).toFixed(1)}" stroke-linecap="round" stroke-dasharray="${dash}"/></g>${head}`, mask);
}

function frame(params: Record<string, unknown>, t: number): StyleCompositeFrameV1 {
  const p = params as unknown as CollageParams;
  const local = p.actB ? t - p.actB.at : -1;
  return { passes: [], overlays: { arrow: p.actB && local >= 0 ? arrowSvg(p, local) : svgFrame(p.width, p.height, "") } };
}

function drawSpeaker(p: CollageParams, layers: StyleCompositeLayersV1, out: RasterV1, t: number, push: number): void {
  const L = layout(p), sp = L.speaker, chain = piece(layers, "speaker");
  if (!chain) return;
  const base = chain.levels[0], zoom = (1 / 1.12) * (1.02 + 0.06 * push);
  put(out, chain, sp.x + sp.w / 2, sp.y + sp.h / 2, 0, zoom * Math.max(sp.w / (base.width / 1.12), sp.h / (base.height / 1.12)));
}

/** The panel piece's geometry: overscan past the straight edges, the torn margin and the baked shadow's pad. */
function panelAnchor(p: CollageParams): { overscan: number; margin: number; pad: number; shadow: Array<readonly [number, number, number]> } {
  const L = layout(p), s = L.s, overscan = Math.round(60 * s), margin = Math.ceil(11 * s * 3 + 9 * s + 6);
  const shadow: Array<readonly [number, number, number]> = [[18 * s, L.edge === "b" ? 12 * s : 0, 0.6], [4 * s, L.edge === "b" ? 3 * s : 0, 0.45]];
  return { overscan, margin, pad: Math.ceil(Math.max(...shadow.map(([b, dy]) => b * 3 + dy))) + 2, shadow };
}

function drawPanel(p: CollageParams, layers: StyleCompositeLayersV1, out: RasterV1): void {
  const L = layout(p), chain = piece(layers, "panel");
  if (!chain) return;
  // Its print area starts at (margin + pad); the overscan hangs off the frame's straight edges.
  const A = panelAnchor(p), k = A.margin + A.pad;
  drawImage(out, chain, affine.translate(-k - (L.edge === "b" ? A.overscan / 2 : 0), -k - (L.edge === "r" ? A.overscan / 2 : 0)));
}

function paperGrain(p: CollageParams, layers: StyleCompositeLayersV1, out: RasterV1): void {
  const L = layout(p), g = piece(layers, "paperGrain")?.levels[0];
  if (!g) return;
  const W = p.width;
  for (let y = 0; y < Math.min(L.panel.h, p.height); y += 1) for (let x = 0; x < Math.min(L.panel.w, W); x += 1) {
    const k = 1 + (g.data[(y * g.width + x) * 4 + 3] - 0.5) * 0.1, o = (y * W + x) * 4;
    out.data[o] *= k; out.data[o + 1] *= k; out.data[o + 2] *= k;
  }
}

function actA(p: CollageParams, layers: StyleCompositeLayersV1, out: RasterV1, t: number): void {
  const G = geometry(p), s = G.s, P = G.P, L = G.L;
  drawSpeaker(p, layers, out, t, clamp01(t / p.duration));
  drawPanel(p, layers, out);
  const drift = (depth: number) => -depth * 14 * s * smootherstep(0, Math.max(1, p.duration), t);
  // Halftone sun and sky panel settle in first; the plate and the cut-out rise behind the wordmark (parallax by depth).
  const sun = backOut(enter(t, 0.12, 0.45), 1.4);
  put(out, piece(layers, "sun"), P.x + G.sun.cx, P.y + G.sun.cy + drift(0.3), 0, sun, clamp01(sun * 2));
  const sky = backOut(enter(t, 0.05, 0.5), 1.2);
  put(out, piece(layers, "sky"), P.x + G.sky.cx, P.y + G.sky.cy + drift(0.4) + (1 - expoOut(enter(t, 0.05, 0.5))) * 30 * s, lerp(-6, G.sky.rot, sky), lerp(0.92, 1, sky), clamp01(enter(t, 0.05, 0.2)));
  const plate = enter(t, 0.28, 0.5), pe = backOut(plate, 1.3);
  put(out, piece(layers, "plate"), P.x + G.plate.cx, P.y + G.plate.cy + drift(0.7) + (1 - expoOut(plate)) * 90 * s, lerp(-9, G.plate.rot, pe), lerp(0.9, 1, pe), clamp01(plate * 3));
  const tape = enter(t, 0.62, 0.3);
  put(out, piece(layers, "tape"), P.x + G.tape.cx, P.y + G.tape.cy + drift(0.7) - (1 - expoOut(tape)) * 40 * s, G.tape.rot, lerp(1.3, 1, expoOut(tape)), clamp01(tape * 3));
  const cut = enter(t, 0.36, 0.6);
  put(out, piece(layers, "cutout"), P.x + G.cutout.cx, P.y + G.cutout.cy + drift(0.9) + (1 - expoOut(cut)) * 260 * s, G.cutout.rot, lerp(0.96, 1, expoOut(cut)), clamp01(cut * 4));
  const kick = enter(t, 0.78, 0.42), kicker = piece(layers, "kicker");
  if (kicker) put(out, kicker, P.x + G.kicker.x + kicker.levels[0].width / 2 - (1 - expoOut(kick)) * 120 * s, P.y + G.kicker.y + drift(0.5), lerp(-8, G.kicker.rot, backOut(kick, 1.6)), 1, clamp01(kick * 3));
  // Wordmark: pops with an overshoot, its ink offset already baked in.
  const word = piece(layers, "wordmark"), we = enter(t, 0.55, 0.42);
  if (word) {
    // The piece is the ink centred in its offset and shadow padding: place the ink, as in the frame (its centre 0.4 of
    // the ink height above the anchor line).
    const ink = placeLine(p.text.wordmark, SERIF, sizes(p).wordmark, 0.02, 0, 0, "start", "top").box;
    put(out, word, P.x + G.wordmark.cx, P.y + G.wordmark.bottom - (ink.y1 - ink.y0) * 0.4 + drift(1.1), lerp(-3, 0, expoOut(we)), lerp(1.22, 1, backOut(we, 1.6)), clamp01(we * 4));
  }
  paperGrain(p, layers, out);
  const cap = piece(layers, "caption"), ce = enter(t, 0.95, 0.45);
  if (cap) put(out, cap, L.caption.x, L.caption.y + Math.sin(t * 2.2) * 2 * s, -2 + 3 * (1 - backOut(ce, 2)), lerp(0.6, 1, backOut(ce, 1.8)), clamp01(ce * 4));
}

function actB(p: CollageParams, layers: StyleCompositeLayersV1, out: RasterV1, local: number, t: number): void {
  const G = geometry(p), s = G.s, P = G.P, L = G.L;
  drawSpeaker(p, layers, out, t, 0.5 + 0.5 * clamp01(local / Math.max(0.5, p.duration - p.actB!.at)));
  drawPanel(p, layers, out);
  const band = enter(local, 0, 0.45);
  put(out, piece(layers, "band"), P.x + G.band.cx - (1 - expoOut(band)) * P.w, P.y + G.band.cy, G.band.rot, 1, 1);
  const order = G.steps.map((_, index) => index).sort((a, b) => Number(G.steps[a].active) - Number(G.steps[b].active));
  for (const index of order) {
    const step = G.steps[index], e = enter(local, 0.08 + index * 0.12, 0.5), pop = backOut(e, 1.5);
    const cx = P.x + step.cx, cy = P.y + step.cy - (step.active ? 6 : 3) * s * smootherstep(0, 2, local);
    put(out, piece(layers, `step${index + 1}`), cx, cy + (1 - expoOut(e)) * 80 * s, lerp(step.rot + 8, step.rot, pop), lerp(0.85, 1, pop), clamp01(e * 3));
  }
  G.steps.forEach((step, index) => {
    const e = enter(local, 0.3 + index * 0.12, 0.4), cx = P.x + step.cx, cy = P.y + step.cy;
    const num = piece(layers, `num${index + 1}`), label = piece(layers, `label${index + 1}`);
    if (num) put(out, num, cx - step.w / 2 + num.levels[0].width / 2 - 6 * s, cy - step.h / 2 + 10 * s, -4 + index * 3, lerp(0.4, 1, backOut(e, 2)), clamp01(e * 4));
    if (label) put(out, label, cx, cy + step.h / 2 + 10 * s + (1 - expoOut(e)) * 30 * s, step.rot * 0.6, 1, clamp01(e * 3));
  });
  paperGrain(p, layers, out);
  over(out, layers.overlays.arrow);
  const cap = piece(layers, "stepCaption") ?? piece(layers, "caption"), ce = enter(local, 0.55, 0.45);
  if (cap) put(out, cap, L.caption.x, L.caption.y + Math.sin(t * 2.2) * 2 * s, -2 + 3 * (1 - backOut(ce, 2)), lerp(0.6, 1, backOut(ce, 1.8)), clamp01(ce * 4));
}

function composite(params: Record<string, unknown>, t: number, index: number, layers: StyleCompositeLayersV1, out: RasterV1): void {
  const p = params as unknown as CollageParams, W = p.width, H = p.height;
  if (!p.actB || t < p.actB.at) actA(p, layers, out, t);
  else if (t >= p.actB.at + p.actB.tear) actB(p, layers, out, t - p.actB.at, t);
  else {
    // Paper tear: act B slides in from the right under a torn edge that throws a shadow on act A.
    const a = createRaster(W, H, 4), b = createRaster(W, H, 4);
    actA(p, layers, a, t);
    actB(p, layers, b, t - p.actB.at, t);
    const u = expoInOut((t - p.actB.at) / p.actB.tear), edge = W * (1 - u) - 30, wave = noise1d(H, 404, 4, 40);
    for (let y = 0; y < H; y += 1) {
      const x0 = edge + wave[y] * 14 * (W / 1080);
      for (let x = 0; x < W; x += 1) {
        const o = (y * W + x) * 4, cover = clamp01(x - x0 + 0.5), shade = clamp01(1 - (x0 - x) / (40 * (W / 1080))) * 0.45 * (x < x0 ? 1 : 0);
        for (let c = 0; c < 4; c += 1) out.data[o + c] = a.data[o + c] * (1 - cover) * (c < 3 ? 1 - shade : 1) + b.data[o + c] * cover;
        if (Math.abs(x - x0) < 3 * (W / 1080)) { const k = 1 - Math.abs(x - x0) / (3 * (W / 1080)); for (let c = 0; c < 3; c += 1) out.data[o + c] += (out.data[o + 3] - out.data[o + c]) * k * 0.6; }
      }
    }
  }
  vignette(out, 0.16, 0.85, 0.8, 0.7);
  grain(out, 0.014, 5, index);
}

function preflight(params: Record<string, unknown>): void {
  const p = params as unknown as CollageParams, t = p.text;
  assertMotionText(t.wordmark, SERIF);
  if (t.kicker) assertMotionText(t.kicker, SANS(800));
  for (const value of [t.caption, t.stepCaption]) if (value) assertMotionText(value, SANS(900));
  for (const value of [t.gloss, t.stepGloss]) if (value) assertMotionText(value, SANS(700));
  for (const value of [t.step1, t.step2, t.step3]) if (value) assertMotionText(value, SANS(800));
}

export const collageExplainerCompositeV1: StyleCompositeHooksV1 = { pieces, refine, frame: (params, t) => frame(params, t), composite, preflight };
export type { CollageParams as CollageParamsV1, TornMasksV1 };
