import { createSvgDocument, emptySvg, path, rect, rectPathD } from "../../svg/document";
import { clamp01, cubicInOut, expoInOut, quartInOut, sineInOut, type EasingFunction } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineTransitionMotion, type MotionEnergy, type MotionFrameSize } from "../../types";
import { createMatteDocument, frameUnit, MATTE_SHOW_B } from "../shared";

/**
 * X28 Four Panel: the frame's 2×2 quadrants switch to B one after another, top left, top
 * right, bottom right, bottom left, each with a quick slide that flows clockwise: B slides
 * into the top left from the left edge, into the top right from the top, into the bottom
 * right from the right and into the bottom left from the bottom, so the four slides chase
 * each other round the frame. Each slide is led by a flat panel (accent and ink in
 * alternation round the frame; the seed swaps them) with a paper seam on its trailing edge,
 * where B follows.
 *
 * Timing: the slides start 0.16 of the duration apart and each takes 0.32–0.4 of it, centred
 * symmetrically on D/2, so with equal quadrants and a symmetric ease B covers exactly half
 * the frame at D/2 (ART_DIRECTION §4) and only ever grows. A panel lands on its quadrant's far
 * edge at 60% of its slide (it covers the quadrant just ahead of B), so no sliver of A
 * lingers ahead of B. Energy sets the curve and
 * the slide length (calm sine … hype expo in-out). The quadrants meet on whole-pixel lines and
 * every edge snaps to whole pixels, so no seam opens between them. Not directional: the
 * order runs round the frame by design.
 */

const ID = "X28";
const REVISION = 1;
/** Delay between neighbouring quadrants' slides, fraction of the duration. */
const STAGGER = 0.16;
/** A panel lands on its quadrant's far edge at this fraction of its slide. */
const LAND = 0.6;
/** Paper seam on each panel's trailing edge (px at 1080). */
const SEAM = 18;

interface PanelTiming { readonly slide: number; readonly ease: EasingFunction }
const TIMING: Record<MotionEnergy, PanelTiming> = {
  calm: { slide: 0.4, ease: sineInOut },
  standard: { slide: 0.36, ease: cubicInOut },
  punchy: { slide: 0.34, ease: quartInOut },
  hype: { slide: 0.32, ease: expoInOut },
};

/** Quadrants in switching order: top left, top right, bottom right, bottom left, with the edge each slide enters from. */
const QUADRANTS = [
  { column: 0, row: 0, from: "left" },
  { column: 1, row: 0, from: "top" },
  { column: 1, row: 1, from: "right" },
  { column: 0, row: 1, from: "bottom" },
] as const;

/** Palette roles of the four panels in switching order. */
export function fourPanelTones(seed: number): readonly ("accent" | "ink")[] {
  return createSeededRng(ID, seed, "layout").int(0, 1) === 1 ? ["accent", "ink", "accent", "ink"] : ["ink", "accent", "ink", "accent"];
}

/** B's edge and the panel's edge in quadrant i (fractions of its extent along the slide) at progress p. */
export function fourPanelEdges(index: number, p: number, energy: MotionEnergy): { readonly b: number; readonly panel: number } {
  const { slide, ease } = TIMING[energy];
  const local = clamp01((p - (0.5 + (index - 1.5) * STAGGER - slide / 2)) / slide);
  return { b: ease(local), panel: ease(clamp01(local / LAND)) };
}

/** The part of quadrant i that lies between `from` and `to` (px along its slide from its entry edge), as path data. */
function band(index: number, from: number, to: number, size: MotionFrameSize): string {
  const halfW = Math.round(size.width / 2), halfH = Math.round(size.height / 2);
  const { column, row, from: side } = QUADRANTS[index];
  const x0 = column === 0 ? 0 : halfW, x1 = column === 0 ? halfW : size.width;
  const y0 = row === 0 ? 0 : halfH, y1 = row === 0 ? halfH : size.height;
  if (!(to > from)) return "";
  switch (side) {
    case "left": return rectPathD(x0 + from, y0, to - from, y1 - y0, 0);
    case "right": return rectPathD(x1 - to, y0, to - from, y1 - y0, 0);
    case "top": return rectPathD(x0, y0 + from, x1 - x0, to - from, 0);
    case "bottom": return rectPathD(x0, y1 - to, x1 - x0, to - from, 0);
  }
}

export const X28_fourPanel = defineTransitionMotion(ID, (params, t, size) => {
  const p = clamp01(t / params.durationSeconds);
  const matte = createMatteDocument(size);
  const allB = () => matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B }));
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= 1) return { matte: allB(), overlay: emptySvg(size) };

  const tones = fourPanelTones(params.seed), seamMax = Math.round(SEAM * frameUnit(size));
  const halfW = Math.round(size.width / 2), halfH = Math.round(size.height / 2);
  let matteD = "", seams = "";
  const fills: Record<string, string> = {};
  QUADRANTS.forEach(({ column, from }, index) => {
    const extent = from === "left" || from === "right" ? (column === 0 ? halfW : size.width - halfW) : (index < 2 ? halfH : size.height - halfH);
    const edges = fourPanelEdges(index, p, params.energy);
    const b = Math.round(extent * edges.b), lead = Math.round(extent * edges.panel);
    matteD += band(index, 0, b, size);
    fills[tones[index]] = (fills[tones[index]] ?? "") + band(index, b, lead, size);
    const seam = Math.min(seamMax, Math.floor((lead - b) / 3));
    if (seam > 0) seams += band(index, b, b + seam, size);
  });
  return {
    matte: matte.render(path(matteD, { fill: MATTE_SHOW_B })),
    overlay: createSvgDocument(size).render(
      path(fills.accent ?? "", { fill: params.palette.accent }),
      path(fills.ink ?? "", { fill: params.palette.ink }),
      path(seams, { fill: params.palette.paper })),
  };
}, { revision: REVISION });
