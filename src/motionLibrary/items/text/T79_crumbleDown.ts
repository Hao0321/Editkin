import { g, path, tf, transform } from "../../svg/document";
import { clamp01, cubicIn, cubicOut, quadIn, smoothstep } from "../../svg/easing";
import type { GlyphBox } from "../../svg/glyphs";
import { createSeededRng } from "../../svg/random";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  createTextDocument, displayTracking, heroTextBox, itemTiming, layoutFittedText, placeWordGlyphs, secondaryTone, textBackdrop, textFace,
  textOnBackground, titleSafeBox, type WordGlyph,
} from "../shared";

/**
 * T79 Crumble Down (崩塌落下), MOOD, shown on the paper plate in Noto Serif TC: the
 * word drops in, sits a little askew, then crumbles away like loose bricks.
 * - Drop in 0.0–0.45 s: one after another, 0.06 s apart, each character falls from
 *   above the frame under gravity (quadIn), lands, bounces a little (a 6% hop) and
 *   settles at a seeded tilt of ±3–6°; the last character sits slightly lower.
 * - Hold 0.45–1.2 s (it grows with longer clips).
 * - Crumble from 1.2 s, left to right, 0.07 s apart: each character tips over to
 *   ±25–40° about the bottom corner it leans toward (0.12 s, easing in), then falls out
 *   of the frame under gravity within 0.4 s, still turning, fading over the last 30%
 *   of the fall.
 * - Empty after the last fall (to 2.2 s).
 * Colours alternate ink and the deep gold on the cream card (ART_DIRECTION §0: the
 * gold is 1.4:1 on cream); cream and gold on the dark card. The word is hero-sized
 * (heroTextBox, tight displayTracking, serif 900) with room for the tilts, inside the
 * 5% title-safe box at the hold. Times are standard-energy seconds, scaled by energy
 * and squeezed into short clips (itemTiming); energy scales the tilts.
 */

const ID = "T79";
const REVISION = 1;
/** Standard-energy seconds: drop stagger, fall, bounce, crumble start, crumble stagger, tip, fall out. */
export const T79_DROP_STAGGER = 0.06, T79_DROP = 0.18, T79_BOUNCE = 0.1, T79_CRUMBLE = 1.2, T79_CRUMBLE_STAGGER = 0.07, T79_TIP = 0.12, T79_FALL = 0.4;
const NATURAL_SECONDS = 2.2;
/** Settle tilt and tip angle ranges (degrees), bounce height and the last character's drop (× glyph height). */
export const T79_SETTLE_TILT: readonly [number, number] = [3, 6], T79_TIP_TILT: readonly [number, number] = [25, 40];
export const T79_BOUNCE_HEIGHT = 0.06, T79_LAST_DROP = 0.05;
const LINE_HEIGHT = 1.08;

export interface CrumbleGlyph extends WordGlyph {
  readonly color: string;
  /** Settled tilt (degrees, signed), tip angle (same sign), extra drop (px). */
  readonly tilt: number;
  readonly tip: number;
  readonly drop: number;
}

export interface CrumblePlan {
  readonly glyphs: readonly CrumbleGlyph[];
  readonly glyphHeight: number;
  readonly frameHeight: number;
  readonly box: GlyphBox;
  readonly timeScale: number;
  readonly dropStagger: number;
  readonly crumbleStagger: number;
}

export function crumblePlan(params: TextMotionParams, size: MotionFrameSize): CrumblePlan {
  const safe = titleSafeBox(size);
  const { energy, timeScale } = itemTiming(params.energy, params.durationSeconds, NATURAL_SECONDS);
  const amplitude = Math.min(1.5, energy.amplitude);
  const text = layoutFittedText(params.lines, textFace(params.font, 900), {
    ...heroTextBox(size, { headroom: 1 + 0.12 * amplitude }), lineHeight: LINE_HEIGHT, tracking: displayTracking(params.lines),
  });
  const dx = safe.cx - text.inkCenter[0], dy = safe.cy - text.inkCenter[1];
  const { glyphs, glyphHeight } = placeWordGlyphs(text, dx, dy);
  const backdrop = textBackdrop(params);
  const first = textOnBackground(params.palette, backdrop), second = secondaryTone(params.palette, backdrop);
  const rng = createSeededRng(ID, params.seed, "tilt");
  const n = glyphs.length;
  return {
    glyphs: glyphs.map((glyph, index) => {
      const r = rng.fork(index), sign = r.sign();
      return {
        ...glyph, color: index % 2 === 0 ? first : second,
        tilt: sign * r.range(T79_SETTLE_TILT[0], T79_SETTLE_TILT[1]) * amplitude, tip: sign * r.range(T79_TIP_TILT[0], T79_TIP_TILT[1]),
        drop: index === n - 1 && n > 1 ? T79_LAST_DROP * glyphHeight : 0,
      };
    }),
    glyphHeight, frameHeight: size.height, timeScale,
    box: { x0: text.ink.x0 + dx, y0: text.ink.y0 + dy, x1: text.ink.x1 + dx, y1: text.ink.y1 + dy },
    // The last character settles by about 0.46 s: long lines tighten the stagger, four characters keep 0.06 s.
    dropStagger: Math.min(T79_DROP_STAGGER, n > 1 ? (0.46 - T79_DROP - T79_BOUNCE) / (n - 1) : T79_DROP_STAGGER) * timeScale,
    crumbleStagger: Math.min(T79_CRUMBLE_STAGGER, n > 1 ? 0.55 / (n - 1) : T79_CRUMBLE_STAGGER) * timeScale,
  };
}

export interface CrumblePose {
  /** Vertical offset (px, positive = down), the tilt about the ink centre, then an extra turn about the bottom corner it leans toward. */
  readonly dy: number;
  readonly tilt: number;
  readonly extra: number;
  readonly opacity: number;
}

/** Pose of a character at time t, or null before it drops in and after it has fallen out. */
export function crumblePose(plan: CrumblePlan, glyph: CrumbleGlyph, t: number): CrumblePose | null {
  const s = plan.timeScale;
  const dropStart = glyph.index * plan.dropStagger, land = dropStart + T79_DROP * s, settled = land + T79_BOUNCE * s;
  if (t < dropStart) return null;
  if (t < land) {
    // From above the frame under gravity, turning from a looser tilt to its settled one.
    const p = (t - dropStart) / (T79_DROP * s), start = -(glyph.box.y1 + 0.2 * plan.glyphHeight);
    return { dy: start * (1 - quadIn(p)) + glyph.drop * quadIn(p), tilt: glyph.tilt * (2.5 - 1.5 * cubicOut(p)), extra: 0, opacity: 1 };
  }
  if (t < settled) {
    const p = (t - land) / (T79_BOUNCE * s);
    return { dy: glyph.drop - 4 * T79_BOUNCE_HEIGHT * plan.glyphHeight * p * (1 - p), tilt: glyph.tilt, extra: 0, opacity: 1 };
  }
  const tipStart = T79_CRUMBLE * s + glyph.index * plan.crumbleStagger, fallStart = tipStart + T79_TIP * s, gone = fallStart + T79_FALL * s;
  if (t < tipStart) return { dy: glyph.drop, tilt: glyph.tilt, extra: 0, opacity: 1 };
  if (t < fallStart) {
    const p = (t - tipStart) / (T79_TIP * s);
    return { dy: glyph.drop, tilt: glyph.tilt, extra: (glyph.tip - glyph.tilt) * cubicIn(p), opacity: 1 };
  }
  if (t >= gone) return null;
  const p = (t - fallStart) / (T79_FALL * s);
  // Out of the frame: past the bottom edge with room for the turned glyph (a corner can sit a glyph height above the pivot).
  const travel = plan.frameHeight - glyph.box.y0 + 1.2 * plan.glyphHeight;
  return {
    dy: glyph.drop + travel * quadIn(p), tilt: glyph.tilt, extra: glyph.tip - glyph.tilt + Math.sign(glyph.tip) * 25 * p,
    opacity: 1 - smoothstep(0.7, 1, clamp01(p)),
  };
}

/** The bottom corner a character leans toward, after its tilt about the ink centre (frame px, before dy). */
export function tipPivot(glyph: CrumbleGlyph): readonly [number, number] {
  const x = glyph.tip >= 0 ? glyph.box.x1 : glyph.box.x0, y = glyph.box.y1;
  const radians = (glyph.tilt * Math.PI) / 180, c = Math.cos(radians), sn = Math.sin(radians);
  return [glyph.cx + (x - glyph.cx) * c - (y - glyph.cy) * sn, glyph.cy + (x - glyph.cx) * sn + (y - glyph.cy) * c];
}

export const T79_crumbleDown = defineTextMotion(ID, (params, t, size) => {
  const plan = crumblePlan(params, size);
  const doc = createTextDocument(size, params);
  const parts = plan.glyphs.map(glyph => {
    const pose = crumblePose(plan, glyph, t);
    if (!pose || pose.opacity <= 0.004) return "";
    const [px, py] = tipPivot(glyph);
    return path(glyph.pathD, {
      fill: glyph.color, opacity: pose.opacity < 1 ? Number(pose.opacity.toFixed(3)) : undefined,
      transform: transform(tf.translate(0, pose.dy), pose.extra !== 0 && tf.rotate(pose.extra, px, py), tf.rotate(pose.tilt, glyph.cx, glyph.cy),
        tf.translate(glyph.x, glyph.y)),
    });
  });
  return doc.render(g(undefined, parts));
}, { revision: REVISION });
