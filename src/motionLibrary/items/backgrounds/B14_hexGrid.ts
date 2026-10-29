import { mixHex } from "../../svg/color";
import { createSvgDocument, path, polygonPathD, type Point2 } from "../../svg/document";
import { clamp, energyProfile, loopPhase } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion } from "../../types";
import { frameUnit } from "../shared";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B14 Hex Grid (ART_DIRECTION §10, base A): a honeycomb on the accent card, as in
 * the reference. Every cell is a pointy-top hexagon outlined in the accent's deep
 * shade, a card-coloured gap between neighbours. A wave of light travels across the
 * comb: as it passes, a cell steps from the accent to a mid shade to the deep shade,
 * takes a crisp ink rim at the crest, and breathes (its scale swells from 0.88 to
 * 0.97 of the cell, so the gaps narrow), then steps back. Three crisp fill levels,
 * no blends: a confident, graphic pattern that still leaves the card readable.
 *
 * Loop: the wave advances whole wavelengths per cycle, one cycle per loop at speed 1
 * (backgroundLoop). density sets the cell size (the wave is measured in frame
 * units). Energy scales how far the crest reaches (how many cells light up); the
 * seed tilts the wave (±15°) and jitters each cell's phase.
 */

const ID = "B14";
/** Art revision: 1 = first implementation (p2n-bg2). */
const REVISION = 1;
export const B14_LOOP_SECONDS = 4;
/** Wave cycles per loop at speed 1. */
export const B14_LOOP_CYCLES = 1;
/** Cell circumradius (authored px, 1080 short side). */
const BASE_RADIUS = 46;
/** Wavelength of the light wave (× the frame's short side) and its travel direction (degrees from +x, SVG y-down). */
const WAVELENGTH = 0.85, DIRECTION_DEGREES = 30;
/** Cell scale at rest and at the crest (the catalog's breathing 0.9–1.0, with a gap kept at the crest). */
const REST_SCALE = 0.88, CREST_SCALE = 0.97;
/** Wave value thresholds for the mid shade, the deep shade and the ink rim (at standard energy). */
const MID_AT = 0.55, DEEP_AT = 0.8, RIM_AT = 0.92;
/** Per-cell phase jitter (± of a wavelength) and weight range: the crest lights cells in patches. */
const JITTER = 0.14, WEIGHT_MIN = 0.62, WEIGHT_MAX = 1.12;
/** Outline widths (authored px): every cell, and the crest rim. */
const OUTLINE = 2, RIM = 3.4;

/** Wave value 0..1 of a cell at signed distance `s` along the travel (px), wavelength `lambda`, cycle phase `p` and jitter. */
export function hexWave(s: number, lambda: number, p: number, jitter: number): number {
  return 0.5 + 0.5 * Math.cos(2 * Math.PI * (s / lambda - p + jitter));
}

/** Fill level of a cell for a wave value (0 = accent, 1 = mid shade, 2 = deep shade), with the energy's reach. */
export function hexLevel(value: number, reach: number): 0 | 1 | 2 {
  const v = clamp(value * reach, 0, 1);
  return v >= DEEP_AT ? 2 : v >= MID_AT ? 1 : 0;
}

export const B14_hexGrid = defineBackgroundMotion(ID, (params, t, size) => {
  const unit = frameUnit(size);
  const radius = (BASE_RADIUS * unit) / params.density;
  const { loopSeconds, cycles } = backgroundLoop(B14_LOOP_SECONDS, B14_LOOP_CYCLES, params.speed);
  const p = cycles * loopPhase(t, loopSeconds);
  const reach = clamp(0.92 + 0.08 * energyProfile(params.energy).amplitude, 0.95, 1.08);
  const rng = createSeededRng(ID, params.seed);
  const angle = ((DIRECTION_DEGREES + rng.range(-15, 15)) * Math.PI) / 180, ca = Math.cos(angle), sa = Math.sin(angle);
  const lambda = WAVELENGTH * Math.min(size.width, size.height);
  const jitterRng = rng.fork("jitter");
  const cx = size.width / 2, cy = size.height / 2;
  const w = Math.sqrt(3) * radius, rowStep = 1.5 * radius;
  const columns = Math.ceil(cx / w) + 1, rows = Math.ceil(cy / rowStep) + 1;
  const mid = mixHex(params.palette.accent, params.palette.accent2, 0.5);
  const fills: [string[], string[], string[]] = [[], [], []];
  const rims: string[] = [];

  for (let row = -rows; row <= rows; row += 1) {
    const y = cy + row * rowStep, shift = row & 1 ? w / 2 : 0;
    for (let column = -columns; column <= columns; column += 1) {
      const x = cx + column * w + shift;
      // Each cell has its own phase jitter and weight, so the crest lights the comb in patches, not a straight band.
      const jitter = jitterRng.range(-JITTER, JITTER), weight = jitterRng.range(WEIGHT_MIN, WEIGHT_MAX);
      const value = clamp(hexWave((x - cx) * ca + (y - cy) * sa, lambda, p, jitter) * weight, 0, 1);
      const level = hexLevel(value, reach);
      const scale = REST_SCALE + (CREST_SCALE - REST_SCALE) * value;
      const corners: Point2[] = [];
      for (let k = 0; k < 6; k += 1) {
        const a = ((60 * k - 90) * Math.PI) / 180;
        corners.push([x + radius * scale * Math.cos(a), y + radius * scale * Math.sin(a)]);
      }
      const d = polygonPathD(corners, 2);
      fills[level].push(d);
      if (value * reach >= RIM_AT) rims.push(d);
    }
  }

  const doc = createSvgDocument(size, { background: params.palette.accent });
  const outline = { stroke: params.palette.accent2, "stroke-width": OUTLINE * unit, "stroke-linejoin": "round" };
  return doc.render(
    path(fills[0].join(""), { fill: params.palette.accent, ...outline }),
    path(fills[1].join(""), { fill: mid, ...outline }),
    path(fills[2].join(""), { fill: params.palette.accent2, ...outline }),
    path(rims.join(""), { fill: "none", stroke: params.palette.ink, "stroke-width": RIM * unit, "stroke-linejoin": "round" }),
  );
}, { revision: REVISION, loopSeconds: B14_LOOP_SECONDS, loopCycles: B14_LOOP_CYCLES });
