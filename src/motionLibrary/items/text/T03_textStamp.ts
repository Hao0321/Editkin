import { fmt, g, path, pathData, rect, transform, tf, type Point2, type SvgDocument } from "../../svg/document";
import { clamp01, cubicIn, cubicOut } from "../../svg/easing";
import { layoutLine, translatePathD } from "../../svg/glyphs";
import { createSeededRng } from "../../svg/random";
import { roughenPathD } from "../../svg/roughen";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import { createTextDocument, displayTracking, itemTiming, secondaryTone, textBackdrop, textFace, textOnBackground, titleSafeBox } from "../shared";

/**
 * T03 Text Stamp (スタンプ): hanko stamps land one after another and overlap,
 * one stamp per line (確定 / 通過 / 完成 by default). Each stamp is the line inside
 * a rounded-rect border with a baked rough edge (svg/roughen.ts) and an ink
 * texture of seeded voids and dry streaks (a luminance mask: white keeps ink,
 * black voids show what is behind). A stamp presses down from 1.6× and 0 opacity
 * to 1.0 in 0.12 s (accelerating, like a hand stamping), dips to 0.97 on impact
 * and leaves a faint ghost of its border that spreads and fades. Stamps tilt
 * −10°, +5°, −3° (+7° for a fourth) with a small seeded jitter, alternate the
 * secondaryTone and the readable text role (ART_DIRECTION §0: accent2, ink, accent2 on
 * the paper plate when the accent reads below 3:1; accent and paper on a dark card) and
 * are arranged as a zig-zag pile that fits the title-safe box (a stack in portrait,
 * a cascade in landscape). All stamps hold together, then clear by cut 0.1 s
 * before the end. Times are standard-energy seconds, scaled by energy and squeezed
 * into short clips.
 */

const ID = "T03";
/** Art revision (part of the clip cache key): 1 = first render; 2 = self-review fix after the first contact sheet (landscape piles widened so stamps overlap at the corners, not over the text); 3 = ART_DIRECTION §0 (secondaryTone, tight tracking). */
const REVISION = 3;
/** Landing times (standard seconds) by stamp count: two quick stamps, then a beat before the last. */
const LANDS: Readonly<Record<number, readonly number[]>> = { 1: [0.3], 2: [0.3, 0.7], 3: [0.3, 0.55, 1.05], 4: [0.3, 0.55, 0.8, 1.15] };
const APPROACH = 0.12, SQUASH = 0.1, SQUASH_DEPTH = 0.03, HOLD_AFTER_LAST = 0.7, CLEAR_BLANK = 0.1;
const GHOST_SECONDS = 0.22, GHOST_GROWTH = 0.12, GHOST_OPACITY = 0.35;
/** Press-in scale is 1 + START_OVERSIZE · scaleDepth (1.6× at standard energy). */
const START_OVERSIZE = 0.6;
const ROTATIONS = [-10, 5, -3, 7], ROTATION_JITTER = 1.5, OFFSET_JITTER = 0.03;
/** Stamp geometry in em: padding around the ink, border width and corner radius. */
const PAD_X = 0.2, PAD_Y = 0.17, BORDER = 0.08, RADIUS = 0.2;
const SIZE_CAP = 0.3, SAFE_FILL = 0.94;
/**
 * Pile layouts by stamp count: stamp centres in units of the largest stamp's width
 * and height. Portrait stacks (with a zig-zag); landscape cascades left to right,
 * except four stamps, which pile two by two.
 */
const PILES: Readonly<Record<"portrait" | "landscape", Readonly<Record<number, readonly Point2[]>>>> = {
  portrait: {
    1: [[0, 0]],
    2: [[-0.12, -0.46], [0.12, 0.46]],
    3: [[-0.15, -0.9], [0.15, 0.02], [-0.05, 0.92]],
    4: [[-0.15, -1.35], [0.15, -0.45], [-0.13, 0.45], [0.13, 1.35]],
  },
  landscape: {
    1: [[0, 0]],
    2: [[-0.46, -0.22], [0.46, 0.22]],
    3: [[-0.86, -0.32], [0, 0.32], [0.86, -0.24]],
    4: [[-0.5, -0.52], [0.52, -0.44], [-0.46, 0.46], [0.5, 0.56]],
  },
};

export interface StampPlacement {
  readonly text: string;
  readonly color: string;
  /** Landing time (clip seconds) and the clear time shared by every stamp. */
  readonly land: number;
  readonly clear: number;
  /** Centre (frame px) and tilt (degrees, clockwise). */
  readonly cx: number;
  readonly cy: number;
  readonly rotation: number;
  /** Outer half extents of the border box (px, before rotation). */
  readonly halfWidth: number;
  readonly halfHeight: number;
  /** Corners of the rotated border box at the hold (frame px). */
  readonly corners: readonly Point2[];
}

export interface StampLayout {
  readonly fontSize: number;
  readonly timeScale: number;
  readonly startScale: number;
  readonly stamps: readonly StampPlacement[];
}

function rotatedCorners(cx: number, cy: number, halfWidth: number, halfHeight: number, degrees: number): Point2[] {
  const a = (degrees * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([sx, sy]) =>
    [cx + sx * halfWidth * cos - sy * halfHeight * sin, cy + sx * halfWidth * sin + sy * halfHeight * cos] as const);
}

/** Text size, landing times, colours and the pile geometry (shared by the generator and its tests). */
export function stampLayout(params: TextMotionParams, size: MotionFrameSize): StampLayout {
  const texts = params.lines.slice(0, 4);
  const count = texts.length;
  const lands = LANDS[count];
  const natural = lands[count - 1] + HOLD_AFTER_LAST + CLEAR_BLANK;
  const { energy, timeScale } = itemTiming(params.energy, params.durationSeconds, natural);
  const face = textFace(params.font, 900);
  const safe = titleSafeBox(size);
  const rng = createSeededRng(ID, params.seed, "pile");
  const jitter = texts.map((_, index) => {
    const r = rng.fork(index);
    return { rotation: r.range(-ROTATION_JITTER, ROTATION_JITTER), dx: r.range(-OFFSET_JITTER, OFFSET_JITTER), dy: r.range(-OFFSET_JITTER, OFFSET_JITTER) };
  });
  // Lay out at 100 px, fit the rotated pile into the title-safe box, then scale linearly.
  const half = (text: string, fontSize: number) => {
    const ink = layoutLine(text, { ...face, size: fontSize, tracking: displayTracking([text]) }).inkBox
      ?? { x0: 0, y0: -fontSize, x1: fontSize, y1: 0 };
    return { w: (ink.x1 - ink.x0) / 2 + (PAD_X + BORDER) * fontSize, h: (ink.y1 - ink.y0) / 2 + (PAD_Y + BORDER) * fontSize };
  };
  const pile = PILES[size.width < size.height ? "portrait" : "landscape"][count];
  const geometry = (fontSize: number) => {
    const halves = texts.map(text => half(text, fontSize));
    const unitW = 2 * Math.max(...halves.map(entry => entry.w)), unitH = 2 * Math.max(...halves.map(entry => entry.h));
    return halves.map((entry, index) => ({
      ...entry, x: (pile[index][0] + jitter[index].dx) * unitW, y: (pile[index][1] + jitter[index].dy) * unitH,
      rotation: ROTATIONS[index] + jitter[index].rotation,
    }));
  };
  const reference = geometry(100);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const stamp of reference) {
    for (const [x, y] of rotatedCorners(stamp.x, stamp.y, stamp.w, stamp.h, stamp.rotation)) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }
  const fontSize = Number(Math.max(8, Math.min(SIZE_CAP * Math.min(size.width, size.height),
    (100 * safe.width * SAFE_FILL) / (x1 - x0), (100 * safe.height * SAFE_FILL) / (y1 - y0))).toFixed(3));
  const k = fontSize / 100, shiftX = safe.cx - ((x0 + x1) / 2) * k, shiftY = safe.cy - ((y0 + y1) / 2) * k;

  const backdrop = textBackdrop(params);
  const primary = textOnBackground(params.palette, backdrop);
  const accent = secondaryTone(params.palette, backdrop);
  const clear = params.durationSeconds - CLEAR_BLANK * timeScale;
  const stamps = geometry(fontSize).map((stamp, index): StampPlacement => {
    const cx = shiftX + stamp.x, cy = shiftY + stamp.y;
    return {
      text: texts[index], color: index % 2 === 0 ? accent : primary, land: lands[index] * timeScale, clear,
      cx, cy, rotation: stamp.rotation, halfWidth: stamp.w, halfHeight: stamp.h,
      corners: rotatedCorners(cx, cy, stamp.w, stamp.h, stamp.rotation),
    };
  });
  return { fontSize, timeScale, startScale: 1 + START_OVERSIZE * energy.scaleDepth, stamps };
}

/** Rounded rectangle centred on the origin as absolute cubic path data (roughen-friendly: no arcs). */
function roundedRectPathD(halfWidth: number, halfHeight: number, radius: number): string {
  const r = Math.max(0, Math.min(radius, halfWidth, halfHeight)), k = 0.5523 * r;
  const x0 = -halfWidth, y0 = -halfHeight, x1 = halfWidth, y1 = halfHeight;
  return pathData(2).M(x0 + r, y0).L(x1 - r, y0).C(x1 - r + k, y0, x1, y0 + r - k, x1, y0 + r).L(x1, y1 - r)
    .C(x1, y1 - r + k, x1 - r + k, y1, x1 - r, y1).L(x0 + r, y1).C(x0 + r - k, y1, x0, y1 - r + k, x0, y1 - r)
    .L(x0, y0 + r).C(x0, y0 + r - k, x0 + r - k, y0, x0 + r, y0).Z().toString();
}

interface StampArt {
  readonly ring: string;
  readonly ghost: string;
  readonly text: string;
  readonly voids: string;
  readonly streaks: string;
}

const ART_CACHE_LIMIT = 48;
const artCache = new Map<string, StampArt>();

/** Baked stamp outlines and ink texture in stamp-local px (cached: identical for every frame of a clip). */
function stampArt(params: TextMotionParams, stamp: StampPlacement, index: number, fontSize: number): StampArt {
  const face = textFace(params.font, 900);
  const key = `${params.seed}|${index}|${fontSize}|${face.font}|${stamp.text}`;
  const hit = artCache.get(key);
  if (hit) return hit;
  const line = layoutLine(stamp.text, { ...face, size: fontSize, tracking: displayTracking([stamp.text]) });
  const ink = line.inkBox ?? { x0: 0, y0: -fontSize, x1: line.width, y1: 0 };
  const centred = translatePathD(line.pathD, -(ink.x0 + ink.x1) / 2, -(ink.y0 + ink.y1) / 2);
  const outer = roundedRectPathD(stamp.halfWidth, stamp.halfHeight, (RADIUS + BORDER) * fontSize);
  const inner = roundedRectPathD(stamp.halfWidth - BORDER * fontSize, stamp.halfHeight - BORDER * fontSize, RADIUS * fontSize);
  const seed = params.seed * 8 + index;
  const ring = roughenPathD(outer + inner, { amplitude: fontSize * 0.009, wavelength: fontSize * 0.11, step: Math.max(1, fontSize * 0.012), grain: 0.3, seed });
  const text = roughenPathD(centred, { amplitude: fontSize * 0.0045, wavelength: fontSize * 0.05, step: Math.max(1, fontSize * 0.009), grain: 0.25, seed });

  // Ink texture: small irregular voids (mostly tiny, a few larger) and a handful of dry streaks along one direction.
  const rng = createSeededRng(ID, params.seed, `ink/${index}`);
  let voids = "";
  const count = Math.round(70 + 40 * rng.next());
  for (let speck = 0; speck < count; speck += 1) {
    const x = rng.range(-stamp.halfWidth, stamp.halfWidth), y = rng.range(-stamp.halfHeight, stamp.halfHeight);
    const radius = fontSize * (0.004 + 0.02 * rng.next() ** 3);
    const sides = rng.int(5, 7), turn = rng.range(0, 2 * Math.PI);
    const points: Point2[] = Array.from({ length: sides }, (_, corner) => {
      const a = turn + (corner / sides) * 2 * Math.PI, r = radius * rng.range(0.6, 1.3);
      return [x + Math.cos(a) * r, y + Math.sin(a) * r] as const;
    });
    voids += `M${points.map(([px, py]) => `${fmt(px, 2)} ${fmt(py, 2)}`).join("L")}Z`;
  }
  let streaks = "";
  const angle = rng.range(-35, 35), streakCount = rng.int(3, 4);
  for (let streak = 0; streak < streakCount; streak += 1) {
    const a = ((angle + rng.range(-6, 6)) * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
    const length = fontSize * rng.range(0.07, 0.2), width = fontSize * rng.range(0.006, 0.012);
    const x = rng.range(-stamp.halfWidth * 0.85, stamp.halfWidth * 0.85), y = rng.range(-stamp.halfHeight * 0.85, stamp.halfHeight * 0.85);
    const corners: Point2[] = [[-length / 2, -width / 2], [length / 2, -width / 2], [length / 2, width / 2], [-length / 2, width / 2]]
      .map(([px, py]) => [x + px * cos - py * sin, y + px * sin + py * cos] as const);
    streaks += `M${corners.map(([px, py]) => `${fmt(px, 2)} ${fmt(py, 2)}`).join("L")}Z`;
  }
  const art: StampArt = { ring, ghost: outer, text, voids, streaks };
  artCache.set(key, art);
  if (artCache.size > ART_CACHE_LIMIT) artCache.delete(artCache.keys().next().value!);
  return art;
}

function drawStamp(doc: SvgDocument, params: TextMotionParams, layout: StampLayout, stamp: StampPlacement, index: number, t: number): string {
  const approach = APPROACH * layout.timeScale, begin = stamp.land - approach;
  if (t < begin || t >= stamp.clear) return "";
  let scale = 1, opacity = 1;
  if (t < stamp.land) {
    const p = (t - begin) / approach;
    scale = layout.startScale - (layout.startScale - 1) * cubicIn(p);
    opacity = clamp01(p / 0.5);
  } else {
    const q = (t - stamp.land) / (SQUASH * layout.timeScale);
    if (q < 1) scale = 1 - SQUASH_DEPTH * Math.sin(Math.PI * q);
  }
  if (opacity <= 0.002) return "";
  const art = stampArt(params, stamp, index, layout.fontSize);
  const pad = 0.04 * layout.fontSize;
  const mask = doc.mask([
    rect(-stamp.halfWidth - pad, -stamp.halfHeight - pad, 2 * (stamp.halfWidth + pad), 2 * (stamp.halfHeight + pad), { fill: "#FFFFFF" }),
    path(art.voids, { fill: "#000000" }),
    path(art.streaks, { fill: "#000000", "fill-opacity": 0.55 }),
  ], { x: -stamp.halfWidth - pad, y: -stamp.halfHeight - pad, width: 2 * (stamp.halfWidth + pad), height: 2 * (stamp.halfHeight + pad) });
  const placement = (s: number) => transform(tf.translate(stamp.cx, stamp.cy), tf.rotate(stamp.rotation), s !== 1 && tf.scale(s));
  const ghostAge = (t - stamp.land) / (GHOST_SECONDS * layout.timeScale);
  const ghost = ghostAge >= 0 && ghostAge < 1
    ? path(art.ghost, { fill: "none", stroke: stamp.color, "stroke-width": BORDER * layout.fontSize * 0.6, "stroke-linejoin": "round",
      opacity: GHOST_OPACITY * (1 - cubicOut(ghostAge)), transform: placement(1 + GHOST_GROWTH * cubicOut(ghostAge)) })
    : "";
  return ghost + g({ transform: placement(scale), opacity: opacity < 1 ? opacity : undefined },
    g({ mask }, path(art.ring, { fill: stamp.color, "fill-rule": "evenodd" }), path(art.text, { fill: stamp.color })));
}

export const T03_textStamp = defineTextMotion(ID, (params, t, size) => {
  const layout = stampLayout(params, size);
  const doc = createTextDocument(size, params);
  return doc.render(layout.stamps.map((stamp, index) => drawStamp(doc, params, layout, stamp, index, t)));
}, { revision: REVISION });
