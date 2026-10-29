import { createSvgDocument, path, pathData } from "../../svg/document";
import { clamp, cubicInOut, loopPhase, quartInOut, sineInOut, type EasingFunction } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion, type MotionEnergy } from "../../types";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B36 Minimal Arcs (ART_DIRECTION §10, base D): thick concentric half rings on the
 * dark card, accent and cream in turn from the centre out, as in the reference.
 * Once per cycle they all line up into one bowl (every half ring hanging below the
 * centre, like a logo mark) and hold there for a moment; then they spin apart, each
 * ring at its own speed and in its own direction, fan out into a broken target and
 * gather back into the bowl. The spin eases in and out, so the rings glide rather
 * than whirl.
 *
 * Loop: each ring turns a whole number of times per cycle (one or two, either way),
 * so the bowl re-forms exactly; two cycles per loop at speed 1 (backgroundLoop).
 * density sets the ring count (5 at density 1). Energy sets the spin curve (calm
 * sine, standard cubic, punchy and hype quart); the seed flips every spin direction.
 */

const ID = "B36";
/** Art revision: 1 = first implementation (p2p-bg4). */
const REVISION = 1;
export const B36_LOOP_SECONDS = 8;
/** Gather cycles per loop at speed 1 (the bowl forms once per cycle). */
export const B36_LOOP_CYCLES = 2;
/** Rings at density 1; outer radius (× short side); stroke (× ring spacing). */
const BASE_RINGS = 5, OUTER = 0.4, STROKE = 0.62;
/** Share of a cycle the bowl holds still (split around the gather point). */
const HOLD = 0.16;
/** Turns per cycle for ring i (inner first); the pattern repeats outward. */
const TURNS = [1, -1, 2, -1, 1, -2] as const;

const SPIN: Record<MotionEnergy, EasingFunction> = { calm: sineInOut, standard: cubicInOut, punchy: quartInOut, hype: quartInOut };

/** Spin progress through cycle phase p: whole cycles plus an eased part that holds still around each gather point. */
export function arcSpin(p: number, ease: EasingFunction): number {
  const whole = Math.floor(p), local = p - whole;
  return whole + ease(clamp((local - HOLD / 2) / (1 - HOLD), 0, 1));
}

/** Rings at a density (5 at 1, 3 at 0.5, 10 at 2). */
export function arcRings(density: number): number {
  return Math.max(3, Math.round(BASE_RINGS * density));
}

export const B36_minimalArcs = defineBackgroundMotion(ID, (params, t, size) => {
  const { loopSeconds, cycles } = backgroundLoop(B36_LOOP_SECONDS, B36_LOOP_CYCLES, params.speed);
  const spin = arcSpin(cycles * loopPhase(t, loopSeconds), SPIN[params.energy]);
  const rng = createSeededRng(ID, params.seed);
  const flip = rng.sign();
  /** The bowl hangs below the centre (90° in SVG's y-down frame) when the rings gather. */
  const facing = 90;
  const rings = arcRings(params.density);
  const cx = size.width / 2, cy = size.height / 2;
  const spacing = (OUTER * Math.min(size.width, size.height)) / rings, width = STROKE * spacing;
  const accent = pathData(2), paper = pathData(2);

  for (let ring = 0; ring < rings; ring += 1) {
    const r = spacing * (ring + 1);
    // The half ring's middle points at `facing` (90° = straight down) when the rings gather; whole turns drop out (mod 360).
    const turns = flip * TURNS[ring % TURNS.length] * spin;
    const middle = ((((facing + 360 * turns) % 360) + 360) % 360) * (Math.PI / 180);
    const at = (angle: number) => [cx + r * Math.cos(angle), cy + r * Math.sin(angle)] as const;
    const [x0, y0] = at(middle - Math.PI / 2), [x1, y1] = at(middle), [x2, y2] = at(middle + Math.PI / 2);
    // Two quarter arcs (an exact half circle is ambiguous as one arc).
    (ring % 2 === 0 ? accent : paper).M(x0, y0).A(r, r, 0, false, true, x1, y1).A(r, r, 0, false, true, x2, y2);
  }

  const doc = createSvgDocument(size, { background: params.palette.bg });
  const stroke = (colour: string) => ({ fill: "none", stroke: colour, "stroke-width": Number(width.toFixed(2)), "stroke-linecap": "butt" });
  return doc.render(path(paper.toString(), stroke(params.palette.paper)), path(accent.toString(), stroke(params.palette.accent)));
}, { revision: REVISION, loopSeconds: B36_LOOP_SECONDS, loopCycles: B36_LOOP_CYCLES });
