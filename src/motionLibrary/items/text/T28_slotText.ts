import { fe, g, path, polygon, rect, roundRect, transform, tf } from "../../svg/document";
import { backOut, clamp01, expoIn, expoOut } from "../../svg/easing";
import { assertMotionText, layoutLine, resolveMotionFace, type GlyphBox, type MotionFontSelector } from "../../svg/glyphs";
import { createSeededRng } from "../../svg/random";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  createTextDocument, heroTextBox, itemTiming, readableColor, secondaryTone, textBackdrop, textFace, textOnBackground, titleSafeBox,
} from "../shared";

/**
 * T28 Slot Text (スロット), SWITCH: one slot reel per character (大吉！ by
 * default), each a cream window on the dark card with the reel's glyphs running
 * through it top to bottom. The reels spin at 15 glyphs a second with a vertical
 * motion blur that follows their speed (a tight Gaussian blur on the reel, none once
 * stopped), then stop one by one, left to right, 0.25 s apart: the last 0.34 s of a
 * reel is a backOut landing onto the target with a small bounce past it. Reel
 * glyphs are seeded fortune slips and digits (吉 凶 福 7 …) plus the text's own
 * characters; the target only appears at the landing. A thin accent payline with
 * arrow markers runs behind the reels at the window centre (it shows in the gaps and
 * points at the row from both sides). Each window looks onto a real drum: a reel
 * cell at angle φ from the front shows at R sin φ, foreshortened to cos φ, under a
 * soft shade at the top and bottom edges. In a portrait frame the windows grow tall
 * (up to 2.3× their width) so the neighbouring cells curve into view above and below
 * the payline, as on a real machine. The windows pop in at the start (0.05 s apart)
 * and drop out at the end. Colours follow
 * the reference: cream windows with ink glyphs on the dark card (ART_DIRECTION §0;
 * dark windows with paper glyphs on a light plate). Times are standard-energy
 * seconds, scaled by energy and squeezed into short clips.
 */

const ID = "T28";
/** Art revision (part of the clip cache key): 1 = first render. */
const REVISION = 1;
const POP = 0.22, POP_STAGGER = 0.05, FIRST_STOP = 0.82, STOP_STAGGER = 0.25, LANDING = 0.34, MIN_HOLD = 0.9;
const EXIT = 0.24, EXIT_STAGGER = 0.05, TAIL = 0.08;
/** Spin speed (reel cells per second) and the motion-blur sigma per (cell per second), in cell heights; blur cap. */
const SPEED = 15, BLUR_PER_SPEED = 0.009, BLUR_MAX = 0.2;
/**
 * Window geometry: the base window is WINDOW_ASPECT × its width tall (one cell); a portrait frame grows it up to
 * TALL_ASPECT so the neighbouring cells show above and below the payline, as on a real machine. Gap (× width), glyph
 * em (× width), corner radius (× width), reel pitch (× the base window height).
 */
const WINDOW_ASPECT = 1.3, TALL_ASPECT = 2.3, GAP = 0.16, GLYPH_EM = 0.72, RADIUS = 0.08, PITCH = 1.02;
/** Strip cells beyond the target, visible above it in a tall window. */
const AFTER_TARGET = 2;
/** Payline: stroke (× window height), arrow marker size (× window width) and its gap outside the row (× window width). */
const PAYLINE = 0.016, MARKER = 0.16, MARKER_GAP = 0.08;
/** Drum shade at the window edges: depth (× window height) and strength. */
const DRUM_DEPTH = 0.26, DRUM_SHADE = 0.26;
/** The window shows the drum up to this angle from the front (the drum radius follows from the window height). */
const DRUM_EDGE = (72 * Math.PI) / 180;
const REEL_POOL = "吉凶福運財金7大中小末壹貳參";

export interface SlotReel {
  readonly index: number;
  /** Target character ("" for a blank reel). */
  readonly char: string;
  /** Strip index of the target cell (the reel stops with it on the payline). */
  readonly target: number;
  /** Window centre (frame px). */
  readonly cx: number;
  readonly cy: number;
  /** Clip seconds: pop-in start, stop (landing ends), exit start. */
  readonly appear: number;
  readonly stop: number;
  readonly exitAt: number;
  /** Reel strip: cell k shows strip[k]; the reel stops on strip[target], with AFTER_TARGET seeded cells beyond it. */
  readonly strip: readonly string[];
}

export interface SlotLayout {
  readonly windowWidth: number;
  readonly windowHeight: number;
  /** Distance between reel cells (px). */
  readonly pitch: number;
  readonly fontSize: number;
  readonly timeScale: number;
  readonly reels: readonly SlotReel[];
  /** Row box (windows only) at rest, frame px; the payline markers sit outside it. */
  readonly box: GlyphBox;
}

const poolCache = new Map<string, readonly string[]>();

function reelPool(face: MotionFontSelector, texts: readonly string[]): readonly string[] {
  const own = [...new Set(texts.flatMap(text => [...text]).filter(character => character.trim() !== ""))];
  const key = `${resolveMotionFace(face).faceId}\u0000${own.join("")}`;
  const hit = poolCache.get(key);
  if (hit) return hit;
  const pool: string[] = [];
  for (const character of [...REEL_POOL, ...own]) {
    if (pool.includes(character)) continue;
    try { assertMotionText(character, face); pool.push(character); } catch { /* the face lacks it: not a reel glyph */ }
  }
  const frozen = Object.freeze(pool);
  poolCache.set(key, frozen);
  if (poolCache.size > 32) poolCache.delete(poolCache.keys().next().value!);
  return frozen;
}

/** Reel distance travelled (cells, 0 at the start) and speed (cells/s) at clip time t. */
export function reelMotion(reel: SlotReel, t: number, timeScale: number): { readonly position: number; readonly speed: number } {
  const total = reel.target, landing = LANDING * timeScale;
  // The landing covers `land` cells: backOut's initial slope (overshoot + 3) matches the spin speed.
  const land = (SPEED * landing) / (1.70158 + 3);
  const landStart = reel.stop - landing;
  if (t >= reel.stop) return { position: total, speed: 0 };
  if (t >= landStart) {
    const p = (t - landStart) / landing;
    const eps = 1e-3, slope = (backOut(Math.min(1, p + eps)) - backOut(Math.max(0, p - eps))) / (Math.min(1, p + eps) - Math.max(0, p - eps));
    return { position: total - land + land * backOut(p), speed: (land * slope) / landing };
  }
  return { position: Math.max(0, total - land - SPEED * (landStart - t)), speed: SPEED };
}

/** Window row, reel strips and timing (shared by the generator and its tests). */
export function slotLayout(params: TextMotionParams, size: MotionFrameSize): SlotLayout {
  const chars = params.lines.flatMap(line => [...line.trim()]).map(character => (character.trim() === "" ? "" : character));
  const count = Math.max(1, chars.length);
  const natural = FIRST_STOP + STOP_STAGGER * (count - 1) + MIN_HOLD + EXIT + EXIT_STAGGER * (count - 1) + TAIL;
  const { timeScale } = itemTiming(params.energy, params.durationSeconds, natural);
  const face = textFace(params.font, 900);
  const safe = titleSafeBox(size);
  // Hero size (ART_DIRECTION §0): the row and its payline markers fill 86% of the title-safe width.
  const hero = heroTextBox(size, { heightFill: 0.62 });
  const unitsWide = count + GAP * (count - 1) + 2 * (MARKER + MARKER_GAP);
  const windowWidth = Math.min(hero.maxWidth / unitsWide, hero.maxHeight / WINDOW_ASPECT);
  const aspect = size.height > size.width ? Math.max(WINDOW_ASPECT, Math.min(TALL_ASPECT, hero.maxHeight / windowWidth)) : WINDOW_ASPECT;
  const windowHeight = windowWidth * aspect;
  const rowWidth = count * windowWidth + GAP * windowWidth * (count - 1);
  const left = safe.cx - rowWidth / 2;
  const pool = reelPool(face, params.lines);
  const exitStart = params.durationSeconds - (EXIT + EXIT_STAGGER * (count - 1) + TAIL) * timeScale;
  const reels = chars.map((char, index): SlotReel => {
    const appear = POP_STAGGER * index * timeScale;
    const stop = (FIRST_STOP + STOP_STAGGER * index) * timeScale;
    // Cells needed from t = 0 to the stop at full speed plus the landing (rounded up: the strip starts a little early).
    const landing = LANDING * timeScale, land = (SPEED * landing) / (1.70158 + 3);
    const cells = Math.ceil(land + SPEED * Math.max(0, stop - landing)) + 3;
    const rng = createSeededRng(ID, params.seed, `reel/${index}`);
    const strip: string[] = [];
    for (let cell = 0; cell < cells; cell += 1) {
      let pick = rng.pick(pool);
      for (let attempt = 0; attempt < 8 && (pick === strip[strip.length - 1] || pick === char); attempt += 1) pick = rng.pick(pool);
      // Still a repeat after the retries: step through the pool (deterministic).
      for (let step = 1; step < pool.length && (pick === strip[strip.length - 1] || pick === char); step += 1) pick = pool[(pool.indexOf(pick) + 1) % pool.length];
      strip.push(pick);
    }
    const target = strip.length;
    strip.push(char);
    for (let cell = 0; cell < AFTER_TARGET; cell += 1) {
      let pick = rng.pick(pool);
      for (let attempt = 0; attempt < 8 && (pick === strip[strip.length - 1] || pick === char); attempt += 1) pick = rng.pick(pool);
      // Still a repeat after the retries: step through the pool (deterministic).
      for (let step = 1; step < pool.length && (pick === strip[strip.length - 1] || pick === char); step += 1) pick = pool[(pool.indexOf(pick) + 1) % pool.length];
      strip.push(pick);
    }
    return { index, char, target, cx: left + index * windowWidth * (1 + GAP) + windowWidth / 2, cy: safe.cy, appear, stop,
      exitAt: exitStart + EXIT_STAGGER * index * timeScale, strip };
  });
  return {
    windowWidth, windowHeight, pitch: PITCH * WINDOW_ASPECT * windowWidth, fontSize: Number((GLYPH_EM * windowWidth).toFixed(3)), timeScale, reels,
    box: { x0: left, y0: safe.cy - windowHeight / 2, x1: left + rowWidth, y1: safe.cy + windowHeight / 2 },
  };
}

export const T28_slotText = defineTextMotion(ID, (params, t, size) => {
  const layout = slotLayout(params, size);
  const doc = createTextDocument(size, params);
  const palette = params.palette;
  const backdrop = textBackdrop(params);
  const windowColor = readableColor(backdrop, [palette.paper, palette.bg], 1.6);
  const glyphColor = textOnBackground(palette, windowColor);
  const lineColor = readableColor(backdrop, [palette.accent, secondaryTone(palette, backdrop), textOnBackground(palette, backdrop)]);
  const { windowWidth: w, windowHeight: h, fontSize, timeScale, pitch } = layout;
  const face = textFace(params.font, 900);
  const glyphs = new Map<string, string>();
  const glyph = (character: string): string => {
    if (!character) return "";
    let markup = glyphs.get(character);
    if (markup === undefined) {
      const line = layoutLine(character, { ...face, size: fontSize });
      markup = path(line.pathD, { fill: glyphColor, transform: tf.translate(-line.width / 2, -(line.emTop + line.emBottom) / 2) });
      glyphs.set(character, markup);
    }
    return markup;
  };
  // The window clip and the drum shade are shared by every window; they are defined on the first window drawn.
  let shared: { clip: string; drum: string } | undefined;
  const windowDefs = () => shared ??= {
    clip: doc.clipPath(roundRect(-w / 2, -h / 2, w, h, RADIUS * w)),
    drum: doc.linearGradient({ x1: 0, y1: -h / 2, x2: 0, y2: h / 2, stops: [
      { offset: 0, color: palette.ink, opacity: DRUM_SHADE }, { offset: DRUM_DEPTH, color: palette.ink, opacity: 0 },
      { offset: 1 - DRUM_DEPTH, color: palette.ink, opacity: 0 }, { offset: 1, color: palette.ink, opacity: DRUM_SHADE }] }),
  };
  const parts: string[] = [];
  let anyVisible = false;
  for (const reel of layout.reels) {
    if (t < reel.appear) continue;
    let scale = 1, opacity = 1, drop = 0;
    const pop = POP * timeScale;
    if (t < reel.appear + pop) {
      const p = (t - reel.appear) / pop;
      scale = 0.82 + 0.18 * backOut(p, 2.2);
      opacity = clamp01(p * 2.5);
    }
    if (t >= reel.exitAt) {
      const q = (t - reel.exitAt) / (EXIT * timeScale);
      if (q >= 1) continue;
      drop = 0.35 * h * expoIn(q);
      opacity *= 1 - expoIn(q);
      scale *= 1 - 0.1 * expoIn(q);
    }
    if (opacity <= 0.002) continue;
    anyVisible = true;
    const { position, speed } = reelMotion(reel, t, timeScale);
    // Cell k sits (position - k) pitches along the drum below the front: the strip runs downwards. On the drum a cell
    // at angle φ from the front shows at y = R sin φ, foreshortened to cos φ, so neighbours curve away over the edges.
    const base = Math.floor(position), radius = h / 2 / Math.sin(DRUM_EDGE), cells: string[] = [];
    const reach = Math.ceil((radius * Math.PI) / 2 / pitch) + 1;
    for (let k = base - reach; k <= base + reach + 1; k += 1) {
      if (k < 0 || k >= reel.strip.length) continue;
      const angle = ((position - k) * pitch) / radius;
      if (Math.abs(angle) >= Math.PI / 2 - 0.05) continue;
      const foreshorten = Math.cos(angle);
      cells.push(g({ transform: transform(tf.translate(0, radius * Math.sin(angle)), foreshorten < 0.999 && tf.scale(1, foreshorten)) }, glyph(reel.strip[k])));
    }
    // Vertical motion blur in the window's own coordinates (the filter region is the window, padded by 3σ).
    const sigma = Math.min(BLUR_MAX * pitch, BLUR_PER_SPEED * Math.abs(speed) * pitch);
    const blur = sigma >= 0.5 ? doc.filter(fe.blur({ in: "SourceGraphic", stdDeviation: [0, sigma] }),
      { x: -w / 2, y: -h / 2 - 3 * sigma, width: w, height: h + 6 * sigma }) : undefined;
    const placement = transform(tf.translate(reel.cx, reel.cy + drop), scale !== 1 && tf.scale(scale));
    const { clip, drum } = windowDefs();
    parts.push(g({ transform: placement, opacity: opacity < 1 ? opacity : undefined },
      roundRect(-w / 2, -h / 2, w, h, RADIUS * w, { fill: windowColor }),
      g({ "clip-path": clip }, blur ? g({ filter: blur }, cells) : cells),
      rect(-w / 2, -h / 2, w, h, { fill: drum, "clip-path": clip })));
  }
  // Payline and its arrow markers, drawn while any reel shows: under the windows, so it reads in the gaps and never
  // strikes through a glyph.
  const under: string[] = [];
  if (anyVisible) {
    const first = layout.reels[0], last = layout.reels[layout.reels.length - 1];
    const lineWidth = PAYLINE * h, marker = MARKER * w, gapOut = MARKER_GAP * w;
    const x0 = first.cx - w / 2 - gapOut, x1 = last.cx + w / 2 + gapOut, cy = first.cy;
    const markerOpacity = clamp01((t - first.appear) / (POP * timeScale)) * (t >= last.exitAt ? 1 - expoIn(clamp01((t - last.exitAt) / (EXIT * timeScale))) : 1);
    const reach = expoOut(clamp01((t - first.appear) / (2 * POP * timeScale)));
    if (markerOpacity > 0.002) {
      under.push(g({ opacity: markerOpacity < 1 ? markerOpacity : undefined },
        rect(x0, cy - lineWidth / 2, (x1 - x0) * reach, lineWidth, { fill: lineColor, opacity: 0.85 }),
        polygon([[x0 - marker, cy - marker * 0.6], [x0, cy], [x0 - marker, cy + marker * 0.6]], { fill: lineColor }),
        polygon([[x1 + marker, cy - marker * 0.6], [x1, cy], [x1 + marker, cy + marker * 0.6]], { fill: lineColor })));
    }
  }
  return doc.render(under, parts);
}, { revision: REVISION });
