import { circle, createSvgDocument, ellipse, fe, fmt, g, line, path, rect, roundRect, transform, tf } from "../../motionLibrary/svg/document";
import { clamp01, curve, lerp } from "../../motionLibrary/svg/easing";
import { layoutLine, translatePathD, type MotionFontSelector } from "../../motionLibrary/svg/glyphs";
import { mixHex, shade, tint } from "../../motionLibrary/svg/color";
import { createSeededRng } from "../../motionLibrary/svg/random";
import { blurFilter, dropShadow } from "../svgFx";
import { insertOutline, tornPolygon } from "./insertLayouts";
import type { StageProp } from "../types";

/**
 * C6 illustration stage (R2's paper desk, R5's collage), all original:
 * - stageTextureSvg: the backdrop (a kraft desk with a sheet of paper, or a charcoal collage with torn cream
 *   paper and halftone dots), procedural and seeded. It is rendered ONCE to an owned PNG (librsvg pays for the
 *   noise filters once) and used as a still clip under the props;
 * - stagePropsFrame: original props drawn as flat paper/clay shapes (bulb, note, storyboard, video card, chart,
 *   phone, clock) popping in staggered with overshoot, a gentle hold sway, blurred foreground leaves for depth
 *   and an optional stage caption in the template's ochre.
 * Everything is drawn inside `rect` (the full frame, or the top half of a split).
 */

export const STAGE_REVISION = 1;

export interface StageColors {
  readonly desk: string; readonly paper: string; readonly ink: string; readonly accent: string; readonly accent2: string;
  readonly highlight: string; readonly leaf: string; readonly shadow: string; readonly caption: string;
}

export interface StageRect { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

export interface StageTextureParams {
  readonly scene: "paperDesk" | "collage";
  /** The output canvas (the project frame); the scene is drawn inside `rect` (default: the whole canvas), transparent elsewhere. */
  readonly width: number;
  readonly height: number;
  readonly rect?: StageRect;
  /** Outline of the stage inside `rect`: a plain rect, a rounded card (radius px) or torn paper (seeded edge). */
  readonly shape?: { readonly layout: "full" | "split" | "pip" | "tornPaper"; readonly radius: number; readonly seed: number };
  readonly colors: StageColors;
  readonly seed: number;
}

export interface StagePropsParams {
  readonly component: "stage";
  readonly revision: number;
  readonly width: number;
  readonly height: number;
  readonly rect: StageRect;
  readonly scene: "paperDesk" | "collage";
  readonly props: readonly StageProp[];
  readonly colors: StageColors;
  readonly duration: number;
  readonly seed: number;
  readonly label?: { readonly text: string; readonly font: MotionFontSelector; readonly size: number };
}

// ---------------------------------------------------------------------------
// Texture (rendered once)
// ---------------------------------------------------------------------------

export function stageTextureSvg(params: StageTextureParams): string {
  const { colors } = params;
  const area = params.rect ?? { x: 0, y: 0, w: params.width, h: params.height };
  // Scene coordinates: (0, 0)–(W, H) inside the rect.
  const W = area.w, H = area.h;
  const doc = createSvgDocument({ width: params.width, height: params.height }, { idPrefix: "tx" });
  const short = Math.min(W, H);
  const parts: string[] = [];
  if (params.scene === "paperDesk") {
    parts.push(rect(0, 0, W, H, { fill: colors.desk }));
    // Desk grain: stretched fractal noise, tinted toward the desk shade, low opacity.
    const grain = doc.filter([
      fe.turbulence({ type: "fractalNoise", baseFrequency: [0.0025, 0.06], numOctaves: 3, seed: params.seed % 1000, result: "n" }),
      fe.colorMatrix({ in: "n", type: "matrix", values: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0, 0, -0.32], result: "a" }),
      fe.flood({ color: shade(colors.desk, 0.45), result: "c" }),
      fe.composite({ in: "c", in2: "a", operator: "in" }),
    ], { x: 0, y: 0, width: W, height: H });
    parts.push(rect(0, 0, W, H, { fill: "#000000", filter: grain }));
    // The sheet: slightly rotated, soft shadow, fibre noise, warm edges.
    const pw = W * 0.88, ph = H * 0.84, px = (W - pw) / 2, py = (H - ph) / 2;
    const fibre = doc.filter([
      fe.turbulence({ type: "fractalNoise", baseFrequency: 0.85, numOctaves: 1, seed: (params.seed + 7) % 1000, result: "n" }),
      fe.colorMatrix({ in: "n", type: "matrix", values: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.55, -0.18], result: "a" }),
      fe.flood({ color: shade(colors.paper, 0.18), result: "c" }),
      fe.composite({ in: "c", in2: "a", operator: "in", result: "f" }),
      fe.composite({ in: "f", in2: "SourceGraphic", operator: "in", result: "fc" }),
      fe.merge(["SourceGraphic", "fc"]),
    ], { x: px - 20, y: py - 20, width: pw + 40, height: ph + 40 });
    const edge = doc.radialGradient({ cx: 0.5, cy: 0.5, r: 0.72, units: "objectBoundingBox", stops: [
      { offset: 0.6, color: colors.paper, opacity: 0 }, { offset: 1, color: shade(colors.paper, 0.22), opacity: 0.55 }] });
    parts.push(g({ transform: `rotate(-1.6 ${fmt(W / 2, 1)} ${fmt(H / 2, 1)})` },
      g({ filter: dropShadow(doc, { box: { x0: px, y0: py, x1: px + pw, y1: py + ph }, sigma: short * 0.018, dy: short * 0.01, color: colors.shadow, opacity: 0.45 }) },
        g({ filter: fibre }, rect(px, py, pw, ph, { fill: colors.paper }))),
      rect(px, py, pw, ph, { fill: edge })));
  } else {
    parts.push(rect(0, 0, W, H, { fill: colors.desk }));
    const rng = createSeededRng("stageCollage", params.seed, "pieces");
    for (let i = 0; i < 3; i += 1) {
      const pw = W * rng.range(0.42, 0.7), ph = H * rng.range(0.24, 0.42);
      const px = rng.range(-0.08, 0.6) * W, py = rng.range(-0.05, 0.75) * H;
      const torn = tornPolygon(pw, ph, params.seed + i * 31, short * 0.012);
      parts.push(g({ transform: `rotate(${fmt(rng.range(-8, 8), 2)} ${fmt(px + pw / 2, 1)} ${fmt(py + ph / 2, 1)})`,
        filter: dropShadow(doc, { box: { x0: px, y0: py, x1: px + pw, y1: py + ph }, sigma: short * 0.012, dy: short * 0.006, color: "#000000", opacity: 0.5 }) },
      path(`M${torn.map(([x, y]) => `${fmt(x + px, 1)} ${fmt(y + py, 1)}`).join("L")}Z`, { fill: i === 1 ? tint(colors.paper, 0.0) : mixHex(colors.paper, colors.desk, 0.08) })));
    }
    // Halftone dots in one path (fast): a diagonal band of shrinking dots.
    let dots = "";
    const pitch = short * 0.03;
    for (let y = 0; y < H; y += pitch) for (let x = 0; x < W; x += pitch) {
      const band = clamp01(1 - Math.abs((x / W) - (y / H) - 0.1) * 3);
      const r = pitch * 0.38 * band;
      if (r > 0.6) dots += `M${fmt(x - r, 1)} ${fmt(y, 1)}a${fmt(r, 1)} ${fmt(r, 1)} 0 1 0 ${fmt(2 * r, 1)} 0a${fmt(r, 1)} ${fmt(r, 1)} 0 1 0 ${fmt(-2 * r, 1)} 0Z`;
    }
    parts.push(path(dots, { fill: colors.accent, opacity: 0.28 }));
  }
  // A soft vignette to seat the props.
  const vignette = doc.radialGradient({ cx: 0.5, cy: 0.48, r: 0.75, units: "objectBoundingBox", stops: [
    { offset: 0.55, color: "#000000", opacity: 0 }, { offset: 1, color: "#000000", opacity: 0.28 }] });
  parts.push(rect(0, 0, W, H, { fill: vignette }));
  // The same outline the insert clip's mask cuts (insertOutline), so a stage card and a footage card look alike.
  const shape = params.shape ?? { layout: "full" as const, radius: 0, seed: 0 };
  const outline = insertOutline(shape.layout === "split" ? "full" : shape.layout, W, H, shape.radius, shape.seed);
  const clip = doc.clipPath(path(`M${outline.map(([x, y]) => `${fmt(x, 1)} ${fmt(y, 1)}`).join("L")}Z`));
  return doc.render(g({ transform: area.x || area.y ? `translate(${fmt(area.x, 2)} ${fmt(area.y, 2)})` : undefined }, g({ "clip-path": clip }, parts)));
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type PropDrawer = (c: StageColors, s: number, t: number) => string;

const PROP_DRAWERS: Readonly<Record<StageProp, PropDrawer>> = {
  bulb: (c, s, t) => {
    const r = s * 0.3, cy = -s * 0.12;
    const glass = `M${fmt(-r * 0.55, 1)} ${fmt(cy + r * 0.82, 1)}C${fmt(-r * 1.25, 1)} ${fmt(cy + r * 0.2, 1)} ${fmt(-r, 1)} ${fmt(cy - r, 1)} 0 ${fmt(cy - r, 1)}`
      + `C${fmt(r, 1)} ${fmt(cy - r, 1)} ${fmt(r * 1.25, 1)} ${fmt(cy + r * 0.2, 1)} ${fmt(r * 0.55, 1)} ${fmt(cy + r * 0.82, 1)}Z`;
    const pulse = 0.75 + 0.25 * Math.sin(t * 5);
    const rays = Array.from({ length: 7 }, (_, i) => {
      const a = -Math.PI / 2 + (i - 3) * 0.42, r0 = r * 1.3, r1 = r * (1.62 + 0.08 * pulse);
      return line(Math.cos(a) * r0, cy + Math.sin(a) * r0, Math.cos(a) * r1, cy + Math.sin(a) * r1, { stroke: c.highlight, "stroke-width": Number(fmt(s * 0.035, 2)), "stroke-linecap": "round" });
    }).join("");
    return rays + path(glass, { fill: c.highlight }) + ellipse(-r * 0.35, cy - r * 0.35, r * 0.18, r * 0.3, { fill: "#FFFFFF", opacity: 0.55 })
      + path(`M${fmt(-r * 0.3, 1)} ${fmt(cy + r * 0.5, 1)}Q${fmt(-r * 0.1, 1)} ${fmt(cy - r * 0.2, 1)} 0 ${fmt(cy + r * 0.3, 1)}Q${fmt(r * 0.1, 1)} ${fmt(cy - r * 0.2, 1)} ${fmt(r * 0.3, 1)} ${fmt(cy + r * 0.5, 1)}`,
        { fill: "none", stroke: c.accent2, "stroke-width": Number(fmt(s * 0.02, 2)), "stroke-linecap": "round" })
      + [0, 1, 2].map(i => roundRect(-r * 0.58, cy + r * 0.85 + i * s * 0.065, r * 1.16, s * 0.055, s * 0.02, { fill: i % 2 ? "#8E8C88" : "#B3B0AA" })).join("");
  },
  note: (c, s) => {
    const w = s * 0.72;
    return g({ transform: `rotate(5)` },
      rect(-w / 2, -w / 2, w, w, { fill: c.highlight }),
      path(`M${fmt(w / 2 - w * 0.2, 1)} ${fmt(w / 2, 1)}L${fmt(w / 2, 1)} ${fmt(w / 2 - w * 0.2, 1)}L${fmt(w / 2, 1)} ${fmt(w / 2, 1)}Z`, { fill: shade(c.highlight, 0.25) }),
      rect(-w * 0.2, -w / 2 - w * 0.06, w * 0.4, w * 0.13, { fill: "#FFFFFF", opacity: 0.6 }),
      ...[0, 1, 2].map(i => line(-w * 0.32, -w * 0.12 + i * w * 0.17, w * (i === 2 ? 0.05 : 0.3), -w * 0.12 + i * w * 0.17,
        { stroke: c.ink, "stroke-width": Number(fmt(s * 0.022, 2)), "stroke-linecap": "round", opacity: 0.6 })));
  },
  storyboard: (c, s) => {
    const w = s * 1.0, h = s * 0.62;
    const frames = [0, 1, 2].map(i => {
      const fw = w * 0.28, fx = -w / 2 + w * 0.05 + i * (fw + w * 0.04), fy = -h * 0.18;
      return roundRect(fx, fy, fw, h * 0.52, s * 0.02, { fill: tint(c.accent, 0.82, "#FFFFFF"), stroke: c.ink, "stroke-width": Number(fmt(s * 0.012, 2)) })
        + path(`M${fmt(fx + fw * 0.1, 1)} ${fmt(fy + h * 0.45, 1)}L${fmt(fx + fw * 0.4, 1)} ${fmt(fy + h * 0.22, 1)}L${fmt(fx + fw * 0.6, 1)} ${fmt(fy + h * 0.36, 1)}L${fmt(fx + fw * 0.9, 1)} ${fmt(fy + h * 0.16, 1)}`,
          { fill: "none", stroke: c.accent2, "stroke-width": Number(fmt(s * 0.016, 2)), "stroke-linejoin": "round", "stroke-linecap": "round" })
        + circle(fx + fw * 0.75, fy + h * 0.1, s * 0.025, { fill: c.accent });
    }).join("");
    return roundRect(-w / 2, -h / 2, w, h, s * 0.04, { fill: "#FFFFFF" }) + frames
      + roundRect(-w * 0.12, -h / 2 - s * 0.04, w * 0.24, s * 0.08, s * 0.03, { fill: "#9A9792" })
      + [0, 1, 2].map(i => line(-w / 2 + w * 0.05 + i * w * 0.32, h * 0.32, -w / 2 + w * 0.05 + i * w * 0.32 + w * 0.22, h * 0.32,
        { stroke: c.ink, "stroke-width": Number(fmt(s * 0.014, 2)), opacity: 0.45, "stroke-linecap": "round" })).join("");
  },
  videoCard: (c, s, t) => {
    const w = s * 0.92, h = s * 0.58;
    const progress = 0.3 + 0.25 * clamp01(t / 3);
    return roundRect(-w / 2, -h / 2, w, h, s * 0.06, { fill: c.ink })
      + circle(0, -h * 0.06, s * 0.14, { fill: c.accent })
      + path(`M${fmt(-s * 0.045, 1)} ${fmt(-h * 0.06 - s * 0.07, 1)}L${fmt(s * 0.075, 1)} ${fmt(-h * 0.06, 1)}L${fmt(-s * 0.045, 1)} ${fmt(-h * 0.06 + s * 0.07, 1)}Z`, { fill: "#FFFFFF" })
      + roundRect(-w * 0.4, h * 0.3, w * 0.8, s * 0.03, s * 0.015, { fill: "#FFFFFF", opacity: 0.25 })
      + roundRect(-w * 0.4, h * 0.3, w * 0.8 * progress, s * 0.03, s * 0.015, { fill: c.accent });
  },
  chart: (c, s, t) => {
    const w = s * 0.86, h = s * 0.7;
    const bars = [0.45, 0.7, 0.55, 0.92].map((value, i) => {
      const grow = curve("backOutSoft", clamp01((t - 0.35 - i * 0.08) / 0.45));
      const bh = h * 0.62 * value * grow, bw = w * 0.13, bx = -w * 0.33 + i * w * 0.2;
      return roundRect(bx, h * 0.32 - bh, bw, bh, s * 0.015, { fill: i % 2 ? c.accent2 : c.accent });
    }).join("");
    return roundRect(-w / 2, -h / 2, w, h, s * 0.04, { fill: "#FFFFFF" }) + bars
      + line(-w * 0.4, h * 0.32, w * 0.4, h * 0.32, { stroke: c.ink, "stroke-width": Number(fmt(s * 0.015, 2)), "stroke-linecap": "round" });
  },
  phone: (c, s) => {
    const w = s * 0.46, h = s * 0.86;
    const tiles = [0, 1, 2, 3].map(i => roundRect(-w * 0.3 + (i % 2) * w * 0.33, -h * 0.18 + Math.floor(i / 2) * w * 0.33, w * 0.26, w * 0.26, s * 0.02,
      { fill: [c.accent, c.accent2, c.highlight, tint(c.accent, 0.5, "#FFFFFF")][i] })).join("");
    return roundRect(-w / 2, -h / 2, w, h, s * 0.07, { fill: c.ink })
      + roundRect(-w / 2 + s * 0.025, -h / 2 + s * 0.025, w - s * 0.05, h - s * 0.05, s * 0.05, { fill: tint(c.accent, 0.85, "#FFFFFF") })
      + roundRect(-w * 0.15, -h / 2 + s * 0.035, w * 0.3, s * 0.03, s * 0.015, { fill: c.ink }) + tiles;
  },
  clock: (c, s, t) => {
    const r = s * 0.38;
    const ticks = Array.from({ length: 12 }, (_, i) => {
      const a = (i / 12) * Math.PI * 2, r0 = r * (i % 3 ? 0.84 : 0.76);
      return line(Math.cos(a) * r0, Math.sin(a) * r0, Math.cos(a) * r * 0.9, Math.sin(a) * r * 0.9, { stroke: c.ink, "stroke-width": Number(fmt(s * (i % 3 ? 0.012 : 0.022), 2)), "stroke-linecap": "round" });
    }).join("");
    const minute = -90 + t * 120, hour = -90 + 50 + t * 10;
    const hand = (deg: number, len: number, width: number, colour: string) => {
      const a = deg * Math.PI / 180;
      return line(0, 0, Math.cos(a) * len, Math.sin(a) * len, { stroke: colour, "stroke-width": Number(fmt(width, 2)), "stroke-linecap": "round" });
    };
    return circle(0, 0, r, { fill: "#FFFFFF", stroke: c.accent2, "stroke-width": Number(fmt(s * 0.05, 2)) }) + ticks
      + hand(hour, r * 0.5, s * 0.035, c.ink) + hand(minute, r * 0.72, s * 0.022, c.ink) + circle(0, 0, s * 0.03, { fill: c.accent });
  },
};

/** Prop slots (rect-relative centres) for 1..6 props: a loose arrangement that leaves the middle band for a caption. */
function slots(count: number): Array<[number, number]> {
  const all: Array<Array<[number, number]>> = [
    [[0.5, 0.5]],
    [[0.32, 0.48], [0.7, 0.52]],
    [[0.24, 0.42], [0.52, 0.6], [0.78, 0.4]],
    [[0.26, 0.34], [0.72, 0.32], [0.3, 0.68], [0.74, 0.66]],
    [[0.22, 0.32], [0.52, 0.26], [0.8, 0.36], [0.33, 0.68], [0.7, 0.7]],
    [[0.2, 0.3], [0.5, 0.25], [0.8, 0.3], [0.22, 0.7], [0.5, 0.74], [0.8, 0.68]],
  ];
  return all[Math.max(0, Math.min(5, count - 1))];
}

function leafPath(size: number): string {
  const l = size, w = size * 0.42;
  return `M0 0C${fmt(w, 1)} ${fmt(-l * 0.2, 1)} ${fmt(w * 0.9, 1)} ${fmt(-l * 0.75, 1)} 0 ${fmt(-l, 1)}C${fmt(-w * 0.9, 1)} ${fmt(-l * 0.75, 1)} ${fmt(-w, 1)} ${fmt(-l * 0.2, 1)} 0 0Z`;
}

/** The stage backdrop as a job: one still (rendered once to an owned PNG, held for the insert's duration). */
export interface StageTextureJobParams extends StageTextureParams {
  readonly component: "stageTexture";
  readonly revision: number;
}

export function stagePropsFrame(params: StagePropsParams, t: number): string {
  const doc = createSvgDocument({ width: params.width, height: params.height }, { idPrefix: "sp" });
  const { rect: r, colors } = params;
  const short = Math.min(r.w, r.h), size = short * (params.props.length > 4 ? 0.3 : params.props.length > 2 ? 0.34 : 0.4);
  const exitAt = params.duration - 0.3;
  const rng = createSeededRng("stageProps", params.seed, "layout");
  const parts: string[] = [];
  slots(params.props.length).forEach(([sx, sy], index) => {
    const local = t - 0.15 - index * 0.14;
    if (local < 0) return;
    const prop = params.props[index];
    const jitterX = rng.range(-0.03, 0.03) * r.w, jitterY = rng.range(-0.03, 0.03) * r.h, baseRot = rng.range(-9, 9);
    const pop = curve("springPop", clamp01(local / 0.55));
    const out = clamp01((t - exitAt - index * 0.04) / 0.22);
    const scale = lerp(0.2, 1, pop) * (1 - 0.6 * curve("snapIn", out));
    const sway = Math.sin((t + index) * 1.6) * 1.6;
    const cx = r.x + sx * r.w + jitterX, cy = r.y + sy * r.h + jitterY + Math.sin((t + index * 0.7) * 2.2) * short * 0.006;
    const drawn = PROP_DRAWERS[prop](colors, size, Math.max(0, local));
    parts.push(g({ transform: transform(tf.translate(cx, cy), tf.rotate(baseRot * (1 - 0.3 * pop) + sway + (1 - pop) * 14), tf.scale(scale)),
      opacity: Number(fmt(Math.min(1, local / 0.1) * (1 - out), 3)) < 0.999 ? Number(fmt(Math.min(1, local / 0.1) * (1 - out), 3)) : undefined,
      filter: dropShadow(doc, { box: { x0: -size * 0.75, y0: -size * 0.75, x1: size * 0.75, y1: size * 0.75 }, sigma: size * 0.05, dy: size * 0.04, color: colors.shadow, opacity: 0.4 }) }, drawn));
  });
  if (params.label) {
    const appear = clamp01((t - 0.15 - params.props.length * 0.14) / 0.5);
    if (appear > 0) {
      const line0 = layoutLine(params.label.text, { ...params.label.font, size: params.label.size, tracking: -0.02 });
      const ink = line0.inkBox ?? { x0: 0, y0: -params.label.size * 0.8, x1: line0.width, y1: 0 };
      const lx = r.x + r.w / 2 - (ink.x0 + ink.x1) / 2, ly = r.y + r.h * (params.props.length >= 4 ? 0.52 : 0.86) - (ink.y0 + ink.y1) / 2;
      const out = clamp01((t - exitAt) / 0.22);
      const e = curve("expoOut", appear);
      parts.push(g({ transform: transform(tf.translate(0, (1 - e) * params.label.size * 0.4)), opacity: Number(fmt(e * (1 - out), 3)) },
        path(translatePathD(line0.pathD, lx, ly), { fill: colors.caption })));
    }
  }
  // Foreground leaves (depth): large, blurred, drifting slowly at two corners.
  const leafSize = short * 0.55, blur = short * 0.022;
  const drift = Math.sin(t * 0.8) * short * 0.01;
  const leaves = [
    { x: r.x + r.w * 0.02, y: r.y + r.h * 1.02, rot: 38 },
    { x: r.x + r.w * 0.98, y: r.y + r.h * 0.04, rot: -142 },
  ].map(leaf => g({ transform: transform(tf.translate(leaf.x + drift, leaf.y), tf.rotate(leaf.rot)) },
    path(leafPath(leafSize), { fill: colors.leaf }),
    path(`M0 0L0 ${fmt(-leafSize * 0.95, 1)}`, { stroke: shade(colors.leaf, 0.3), "stroke-width": Number(fmt(leafSize * 0.02, 2)) })));
  const leafIn = curve("expoOut", clamp01(t / 0.6)), leafOut = clamp01((t - exitAt) / 0.3);
  parts.push(g({ filter: blurFilter(doc, blur, { x0: r.x - leafSize, y0: r.y - leafSize, x1: r.x + r.w + leafSize, y1: r.y + r.h + leafSize }),
    opacity: Number(fmt(0.92 * leafIn * (1 - leafOut), 3)) }, leaves));
  const clip = doc.clipPath(rect(r.x, r.y, r.w, r.h));
  return doc.render(g({ "clip-path": clip }, parts));
}

