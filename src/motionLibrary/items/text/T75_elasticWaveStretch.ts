import { g } from "../../svg/document";
import { energyProfile, loopPhase } from "../../svg/easing";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import { createTextDocument } from "../shared";
import { drawStretchWord, stretchWordLayout, type StretchPose, type StretchWordLayout } from "./T06_stretchText";

/**
 * T75 Elastic Wave Stretch (彈性伸縮), MOOD, shown on the paper plate: a continuous
 * stretch wave runs through the word, every character anchored on the line's floor:
 * scaleY = 1 + 0.45·max(0, sin(2πt/1.4 − 0.8·i)) and scaleX = 1/√scaleY, so a
 * character grows tall and slim for half of each period and rests at its normal shape
 * for the other half, its neighbours following 0.8 rad behind, like a bellows playing.
 * A seamless 1.4 s loop (catalog loopSeconds).
 *
 * This is T06's generator (CATALOG: T75 ↔ T06) with a continuous sine instead of
 * discrete pulses: stretchWordLayout lays the word out on its floor with room for the
 * full stretch inside the 5% title-safe box, and drawStretchWord draws each character
 * with its pose. Colours alternate ink and the deep gold on the cream card (the gold
 * itself is 1.4:1 on cream; ART_DIRECTION §0 gives its deep shade), cream and gold on
 * the dark card. Energy scales the stretch depth, never the period.
 */

const ID = "T75";
const REVISION = 1;
export const T75_LOOP_SECONDS = 1.4;
/** Stretch depth (scaleY − 1 at the crest, standard energy) and the phase step per character (rad). */
export const T75_STRETCH = 0.45, T75_PHASE_STEP = 0.8;

export function elasticDepth(params: TextMotionParams): number {
  return T75_STRETCH * Math.min(1.5, energyProfile(params.energy).scaleDepth);
}

export function elasticLayout(params: TextMotionParams, size: MotionFrameSize): StretchWordLayout {
  return stretchWordLayout(params, size, elasticDepth(params));
}

/** Pose of character `index` at loop phase u: scaleY = 1 + depth·max(0, sin(2πu − 0.8·i)), scaleX = 1/√scaleY. */
export function elasticPose(depth: number, index: number, u: number): StretchPose {
  const scaleY = 1 + depth * Math.max(0, Math.sin(2 * Math.PI * u - T75_PHASE_STEP * index));
  return { scaleX: 1 / Math.sqrt(scaleY), scaleY };
}

export const T75_elasticWaveStretch = defineTextMotion(ID, (params, t, size) => {
  const layout = elasticLayout(params, size);
  const depth = elasticDepth(params);
  const u = loopPhase(t, T75_LOOP_SECONDS);
  return createTextDocument(size, params).render(g(undefined, drawStretchWord(layout, glyph => elasticPose(depth, glyph.index, u))));
}, { revision: REVISION });
