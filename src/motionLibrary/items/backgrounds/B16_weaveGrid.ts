import { createSvgDocument, path, rectPathD } from "../../svg/document";
import { clamp, energyProfile, loopPhase } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion } from "../../types";
import { frameUnit } from "../shared";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B16 Weave Grid (ART_DIRECTION §10, base A with a cream weave): a plain weave, as
 * in the reference, in two tones of the accent so it sits calmly under text. Broad
 * horizontal weft bands are the accent card itself, separated by gaps in the accent's
 * deep shade; cream warp threads run vertically through them, passing over one band
 * and under the next, so the cream bars sit on alternate bands like a basket. In every
 * gap the warp shows between the bands. No ink anywhere. The warps slide sideways
 * along the bands while the bands stay put, so the over-and-under pattern flows
 * across the cloth.
 *
 * Loop: the warps move exactly two warp pitches per cycle (the plain weave repeats
 * every two), one cycle per loop at speed 1 (backgroundLoop). density sets the
 * pitch. Energy scales the warp width; the seed sets the direction and the phase.
 */

const ID = "B16";
/** Art revision: 1 = first implementation (p2n-bg2); 2 = two-tone (deep-shade gaps, no ink) to sit under text. */
const REVISION = 2;
export const B16_LOOP_SECONDS = 4;
/** Two-pitch slides per loop at speed 1. */
export const B16_LOOP_CYCLES = 1;
/** Pitch of the weft rows and the warp columns (authored px, 1080 short side). */
const BASE_PITCH = 112;
/** Weft band height and warp width (× pitch); the rest of each row is the deep-shade gap. */
const WEFT = 0.62, WARP = 0.36;

/** Whether the warp in column `column` passes over the weft in row `row` (plain weave: alternate). */
export function warpOver(column: number, row: number): boolean {
  return ((column + row) & 1) === 0;
}

export const B16_weaveGrid = defineBackgroundMotion(ID, (params, t, size) => {
  const unit = frameUnit(size);
  const pitch = (BASE_PITCH * unit) / params.density;
  const { loopSeconds, cycles } = backgroundLoop(B16_LOOP_SECONDS, B16_LOOP_CYCLES, params.speed);
  const u = loopPhase(t, loopSeconds);
  const rng = createSeededRng(ID, params.seed);
  const direction = rng.sign(), phase = rng.next();
  const warp = WARP * pitch * clamp(energyProfile(params.energy).amplitude, 0.85, 1.12);
  const weft = WEFT * pitch, gap = pitch - weft;
  const cx = size.width / 2, cy = size.height / 2;
  // Warp offset: two pitches per cycle; columns keep their identity, so their over/under parity travels with them.
  const offset = direction * 2 * pitch * (cycles * u + phase);
  const rows = Math.ceil(cy / pitch) + 1;
  const first = Math.floor((-cx - offset) / pitch) - 1, last = Math.ceil((cx - offset) / pitch) + 1;
  const gaps: string[] = [], under: string[] = [], over: string[] = [];

  for (let row = -rows; row <= rows; row += 1) {
    const top = cy + row * pitch - weft / 2;
    gaps.push(rectPathD(0, top + weft, size.width, gap, 2));
    for (let column = first; column <= last; column += 1) {
      const x = cx + offset + column * pitch - warp / 2;
      if (x > size.width || x + warp < 0) continue;
      // Between the bands the warp always shows; across a band only where it passes over.
      under.push(rectPathD(x, top + weft, warp, gap, 2));
      if (warpOver(column, row)) over.push(rectPathD(x, top - gap * 0.18, warp, weft + gap * 0.36, 2));
    }
  }

  const doc = createSvgDocument(size, { background: params.palette.accent });
  return doc.render(
    path(gaps.join(""), { fill: params.palette.accent2 }),
    path(under.join(""), { fill: params.palette.paper }),
    // A deep-shade edge (3 px at 1080, never a hairline) separates a thread passing over from the one under it.
    path(over.join(""), { fill: params.palette.paper, stroke: params.palette.accent2, "stroke-width": 3 * unit }),
  );
}, { revision: REVISION, loopSeconds: B16_LOOP_SECONDS, loopCycles: B16_LOOP_CYCLES });
