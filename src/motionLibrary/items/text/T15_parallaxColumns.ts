import { mixHex } from "../../svg/color";
import { g } from "../../svg/document";
import { energyProfile, loopPhase } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import { createTextDocument, textBackdrop, textFace, textOnBackground, titleSafeBox } from "../shared";
import { distinctFrom } from "./T09_hugeTextScroll";
import { columnRepeatStarts, columnRepeatsForEnergy, columnStrip, columnUnit, columnUnitText, type ColumnUnit } from "./T10_verticalTypography";

/**
 * T15 Parallax Columns (縦書き三層): three depth layers of tategaki mincho columns
 * scroll upward at parallax speeds, each column in its own lane so text never sits
 * on text; depth reads from size, tone and speed. Far: small pale columns (the text
 * colour mixed 26% into the backdrop), one repeat per loop. Mid: medium columns
 * (55%), two repeats per loop. Near: big columns in the full text colour with accent
 * separators, three repeats per loop. Layer k takes line k (lines cycle). Lanes run
 * far · near · far · mid · far · mid · far · near · far across the 5% title-safe
 * width in portrait (15 lanes with three near columns in landscape), spaced evenly.
 * The columns run through the top and bottom edges by definition; the near layer's
 * glyphs are at least 9% of the short side.
 *
 * A seamless 4 s loop (catalog loopSeconds): every column advances a whole number
 * of repeats per loop. Energy scales the speeds (whole repeats only).
 */

const ID = "T15";
const REVISION = 1;
export const T15_LOOP_SECONDS = 4;
export type ParallaxDepth = "far" | "mid" | "near";

interface LayerSpec {
  /** em (× short side), weight, tone (share of the text colour over the backdrop), repeats per loop, tracking (em), line index. */
  readonly em: number; readonly weight: number; readonly tone: number; readonly repeats: number; readonly tracking: number; readonly line: number;
}
const LAYERS: Readonly<Record<ParallaxDepth, LayerSpec>> = {
  far: { em: 0.046, weight: 500, tone: 0.26, repeats: 1, tracking: 0.12, line: 0 },
  mid: { em: 0.088, weight: 700, tone: 0.55, repeats: 2, tracking: 0.06, line: 1 },
  near: { em: 0.17, weight: 900, tone: 1, repeats: 3, tracking: 0.02, line: 2 },
};
const PORTRAIT_LANES = "FNFMFMFNF", LANDSCAPE_LANES = "FNFMFMFNFMFMFNF";
const DEPTH_OF: Readonly<Record<string, ParallaxDepth>> = { F: "far", M: "mid", N: "near" };

export interface ParallaxLane {
  readonly depth: ParallaxDepth;
  readonly x: number;
  readonly phase: number;
}

export interface ParallaxLayer {
  readonly unit: ColumnUnit;
  readonly color: string;
  readonly separatorColor: string;
  readonly repeatsPerLoop: number;
}

export interface ParallaxColumnsPlan {
  readonly layers: Readonly<Record<ParallaxDepth, ParallaxLayer>>;
  /** Lanes left to right; drawn far first, near last. */
  readonly lanes: readonly ParallaxLane[];
}

export function parallaxColumnsPlan(params: TextMotionParams, size: MotionFrameSize): ParallaxColumnsPlan {
  const safe = titleSafeBox(size), short = Math.min(size.width, size.height);
  const backdrop = textBackdrop(params);
  const primary = textOnBackground(params.palette, backdrop);
  const amplitude = energyProfile(params.energy).amplitude;
  const layer = (depth: ParallaxDepth): ParallaxLayer => {
    const spec = LAYERS[depth];
    const unit = columnUnit(columnUnitText(params.lines[spec.line % params.lines.length]), textFace(params.font, spec.weight), spec.em * short, spec.tracking);
    const color = spec.tone >= 1 ? primary : mixHex(backdrop, primary, spec.tone);
    return { unit, color, separatorColor: depth === "near" ? distinctFrom(backdrop, params.palette.accent, [color]) : color,
      repeatsPerLoop: columnRepeatsForEnergy(spec.repeats, amplitude) };
  };
  const layers = { far: layer("far"), mid: layer("mid"), near: layer("near") };
  // Lanes: each column's ink width, the leftover safe width shared as equal gaps.
  const pattern = [...(size.width >= size.height * 1.3 ? LANDSCAPE_LANES : PORTRAIT_LANES)].map(code => DEPTH_OF[code]);
  const widths = pattern.map(depth => layers[depth].unit.ink.x1 - layers[depth].unit.ink.x0);
  const gap = Math.max(0, (safe.width - widths.reduce((sum, width) => sum + width, 0)) / Math.max(1, pattern.length - 1));
  const rng = createSeededRng(ID, params.seed, "lanes");
  let cursor = safe.x0;
  const lanes = pattern.map((depth, index) => {
    const ink = layers[depth].unit.ink;
    const x = cursor - ink.x0;
    cursor += widths[index] + gap;
    return { depth, x, phase: rng.next() };
  });
  return { layers, lanes };
}

export const T15_parallaxColumns = defineTextMotion(ID, (params, t, size) => {
  const plan = parallaxColumnsPlan(params, size);
  const doc = createTextDocument(size, params);
  const u = loopPhase(t, T15_LOOP_SECONDS);
  const draw = (depth: ParallaxDepth) => {
    const layer = plan.layers[depth];
    return g(undefined, plan.lanes.filter(lane => lane.depth === depth).flatMap(lane =>
      columnStrip(layer.unit, lane.x, columnRepeatStarts(layer.unit, 0, layer.repeatsPerLoop * u + lane.phase, 0, size.height),
        layer.color, layer.separatorColor)));
  };
  return doc.render(draw("far"), draw("mid"), draw("near"));
}, { revision: REVISION });
