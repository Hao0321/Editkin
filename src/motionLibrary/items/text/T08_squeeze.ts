import { g, path, transform, tf } from "../../svg/document";
import { energyProfile, quadIn, wrap } from "../../svg/easing";
import { layoutLine, type GlyphBox, type LineLayout } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import { createTextDocument, displayTracking, heroTextBox, secondaryTone, textBackdrop, textFace, textOnBackground, titleSafeBox } from "../shared";

/**
 * T08 Squeeze (スクイーズ): a word holds, then squeezes horizontally like rubber
 * (scaleX 1 → 0.35, scaleY 1 → 1.15, 0.2 s, ease-in). At full squeeze it swaps
 * to the next word (one per line; 彈力 ⇄ 反彈 by default), which springs back out
 * with an elastic overshoot (scaleX 0.35 → 1.12 → 1.0 in 0.35 s, scaleY moving
 * opposite so the rubber keeps its volume) and holds. Words alternate the readable
 * text role and the accent. A seamless 2.0 s loop (catalog loopSeconds): the words
 * share it equally, and t = 0 sits in the middle of the first word's hold, so frame
 * 0 equals the frame at 2 s. Energy deepens the squeeze and the overshoot; if many
 * words leave too little hold, the squeeze and spring are shortened to fit.
 */

const ID = "T08";
/** Art revision (part of the clip cache key): 1 = first render; 2 = ART_DIRECTION §0 (hero size, tight tracking, secondaryTone). */
const REVISION = 2;
export const T08_LOOP_SECONDS = 2;
const SQUEEZE = 0.2, SPRING = 0.35, MIN_HOLD = 0.12;
/** Full squeeze at standard energy: scaleX 0.35 (1 − 0.65), scaleY 1.15. */
const SQUEEZE_X = 0.65, SQUEEZE_Y = 0.15, MIN_SCALE_X = 0.12;
/** Elastic spring E(p) = 1 − cos(ω p)(1 − p)^k: peaks ≈ 1.18 at p ≈ 0.36 (scaleX ≈ 1.12), exactly 1 at p = 1. */
const SPRING_OMEGA = 7, SPRING_DECAY = 3.4;
/** Room for the spring's horizontal overshoot (scaleX ≈ 1.12). */
const OVERSHOOT_ROOM = 1.12;

export interface SqueezeWord {
  readonly layout: LineLayout;
  readonly color: string;
  /** Ink box at rest (frame px). */
  readonly box: GlyphBox;
}

export interface SqueezeLayout {
  readonly fontSize: number;
  readonly words: readonly SqueezeWord[];
  readonly slotSeconds: number;
  readonly squeezeSeconds: number;
  readonly springSeconds: number;
  /** Clip time 0 sits this far into the first word's slot (the middle of its hold). */
  readonly offset: number;
  /** scaleX at full squeeze. */
  readonly squeezedX: number;
}

/** Elastic spring from 0 to 1 with one overshoot (see SPRING_OMEGA). */
export function squeezeSpring(p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  return 1 - Math.cos(SPRING_OMEGA * p) * (1 - p) ** SPRING_DECAY;
}

/** Words, colours, rest boxes and the loop timing (shared by the generator and its tests). */
export function squeezeLayout(params: TextMotionParams, size: MotionFrameSize): SqueezeLayout {
  const texts = params.lines;
  const energy = energyProfile(params.energy);
  const slotSeconds = T08_LOOP_SECONDS / texts.length;
  // Energy sets the pace; squeeze + spring shrink further only when the slot leaves less than MIN_HOLD.
  const motion = (SQUEEZE + SPRING) * energy.time;
  const fit = Math.min(1, (slotSeconds - MIN_HOLD) / motion);
  const squeezeSeconds = SQUEEZE * energy.time * fit, springSeconds = SPRING * energy.time * fit;
  const hold = slotSeconds - squeezeSeconds - springSeconds;
  const face = textFace(params.font, 900);
  const safe = titleSafeBox(size);
  let widest = 1e-6, tallest = 1e-6;
  for (const text of texts) {
    const ink = layoutLine(text, { ...face, size: 100, tracking: displayTracking([text]) }).inkBox;
    if (ink) { widest = Math.max(widest, ink.x1 - ink.x0); tallest = Math.max(tallest, ink.y1 - ink.y0); }
  }
  const squeezeY = 1 + SQUEEZE_Y * energy.scaleDepth;
  // Hero size (ART_DIRECTION §0) with room for the overshoot; the squeeze's vertical growth fits under the height cap.
  const hero = heroTextBox(size, { headroom: OVERSHOOT_ROOM, heightFill: Math.min(0.62, 0.95 / squeezeY) });
  const fontSize = Number(Math.max(8, Math.min(hero.maxSize, (100 * hero.maxWidth) / widest, (100 * hero.maxHeight) / tallest)).toFixed(3));
  const backdrop = textBackdrop(params);
  const primary = textOnBackground(params.palette, backdrop);
  const accent = secondaryTone(params.palette, backdrop);
  const words = texts.map((text, index): SqueezeWord => {
    const layout = layoutLine(text, { ...face, size: fontSize, tracking: displayTracking([text]) });
    const ink = layout.inkBox ?? { x0: 0, y0: -fontSize, x1: layout.width, y1: 0 };
    const cx = (ink.x0 + ink.x1) / 2, cy = (ink.y0 + ink.y1) / 2;
    return { layout, color: index % 2 === 0 ? primary : accent,
      box: { x0: safe.cx + ink.x0 - cx, y0: safe.cy + ink.y0 - cy, x1: safe.cx + ink.x1 - cx, y1: safe.cy + ink.y1 - cy } };
  });
  return { fontSize, words, slotSeconds, squeezeSeconds, springSeconds, offset: springSeconds + hold / 2,
    squeezedX: Math.max(MIN_SCALE_X, 1 - SQUEEZE_X * energy.scaleDepth) };
}

export const T08_squeeze = defineTextMotion(ID, (params, t, size) => {
  const layout = squeezeLayout(params, size);
  const energy = energyProfile(params.energy);
  const doc = createTextDocument(size, params);
  // Slot structure: [spring out | hold | squeeze in]; the swap happens at full squeeze between slots.
  const clock = wrap(t + layout.offset, T08_LOOP_SECONDS);
  const index = Math.min(layout.words.length - 1, Math.floor(clock / layout.slotSeconds));
  const local = clock - index * layout.slotSeconds;
  const word = layout.words[index];
  const squeezedX = layout.squeezedX, squeezedY = 1 + SQUEEZE_Y * energy.scaleDepth;
  let scaleX = 1;
  if (local < layout.springSeconds) {
    // Spring out of the squeeze: elastic, the overshoot follows the energy's scale depth.
    const spring = squeezeSpring(local / layout.springSeconds);
    scaleX = squeezedX + (1 - squeezedX) * spring;
  } else if (local > layout.slotSeconds - layout.squeezeSeconds) {
    const p = (local - (layout.slotSeconds - layout.squeezeSeconds)) / layout.squeezeSeconds;
    scaleX = 1 - (1 - squeezedX) * quadIn(p);
  }
  // Rubber keeps its volume: scaleY moves opposite to scaleX (1.15 at full squeeze, ≈ 0.97 at the overshoot).
  const scaleY = 1 + (squeezedY - 1) * ((1 - scaleX) / (1 - squeezedX));
  const ink = word.layout.inkBox ?? { x0: 0, y0: -layout.fontSize, x1: word.layout.width, y1: 0 };
  const cx = (word.box.x0 + word.box.x1) / 2, cy = (word.box.y0 + word.box.y1) / 2;
  const scaled = Math.abs(scaleX - 1) > 1e-6 || Math.abs(scaleY - 1) > 1e-6;
  return doc.render(g({
    transform: transform(tf.translate(cx, cy), scaled && tf.scale(scaleX, scaleY), tf.translate(-(ink.x0 + ink.x1) / 2, -(ink.y0 + ink.y1) / 2)),
  }, path(word.layout.pathD, { fill: word.color })));
}, { revision: REVISION });
