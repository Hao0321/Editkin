import { circlePathD, createSvgDocument, path } from "../../svg/document";
import { clamp, energyProfile, loopPhase, smoothstep } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion } from "../../types";
import { frameUnit } from "../shared";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B03 Comic Dots (ART_DIRECTION §10, base C→D): a misregistered two-colour halftone,
 * as in American comics, on the cream card. One square dot screen is printed
 * twice: the accent first, then ink on top, knocked a few pixels off register, so
 * every ink dot shows an accent crescent and the fine dots split into pairs. The
 * dot size follows a broad tone that travels across the frame: a band of big ink
 * dots, almost touching (the card reads dark there), then a stretch of fine dots on
 * cream. The halftone itself carries the card from cream to dark, with no gradient
 * fill. The registration offset wanders on a small circle, like a press drifting
 * out of true.
 *
 * Loop: the tone and the wander are periodic in their loop: two tone cycles per loop
 * at speed 1; other speeds scale the rate and stretch the loop by 1, 2 or 4 so it
 * still holds whole cycles (backgroundLoop). density sets the screen pitch
 * (the tone is measured in frame units). Energy scales the big dots; the seed sets
 * the misregistration direction and the phase.
 */

const ID = "B03";
/**
 * Art revision: 1 = dark card with cream under-layer; 2 = §10 reference recreation (cream card, square screen, travelling
 * tone); 3 = a shorter tone wavelength, so every frame shows both the cream and the dark side.
 */
const REVISION = 3;
export const B03_LOOP_SECONDS = 6;
/** Authored px (1080 short side) between neighbouring dots. */
const BASE_PITCH = 40;
/** Tone cycles per loop at speed 1. */
export const B03_LOOP_CYCLES = 2;
/** The tone's wavelength as a multiple of the frame width: one dark band and one cream band span it, so a frame always shows both. */
const WAVELENGTH = 1.4;
/** The tone fronts lean this far from vertical, so the gradient reads as a printed tone, not a stripe. */
const TILT_DEGREES = 12;
/** Misregistration offset and its wander radius (fractions of the pitch). */
const OFFSET = 0.2, WANDER = 0.04;
/** Dot radius = pitch × (MIN_DOT + (MAX_DOT − MIN_DOT) × smoothstep(LOW, HIGH, tone)); square-screen dots touch at 0.5. */
const MIN_DOT = 0.05, MAX_DOT = 0.5, LOW = 0.18, HIGH = 0.85;

export const B03_comicDots = defineBackgroundMotion(ID, (params, t, size) => {
  const unit = frameUnit(size);
  const big = MAX_DOT * clamp(energyProfile(params.energy).amplitude, 0.8, 1.06);
  const pitch = (BASE_PITCH * unit) / params.density;
  const { loopSeconds, cycles } = backgroundLoop(B03_LOOP_SECONDS, B03_LOOP_CYCLES, params.speed);
  const u = loopPhase(t, loopSeconds);
  const rng = createSeededRng(ID, params.seed);
  const offsetAngle = ((rng.range(20, 50) + (rng.chance(0.5) ? 180 : 0)) * Math.PI) / 180;
  const phase = rng.next();
  const cx = size.width / 2, cy = size.height / 2;
  const wavelength = WAVELENGTH * size.width, lean = Math.tan((TILT_DEGREES * Math.PI) / 180);
  const wanderAngle = 2 * Math.PI * (cycles * u + phase);
  const offsetX = pitch * (OFFSET * Math.cos(offsetAngle) + WANDER * Math.cos(wanderAngle));
  const offsetY = pitch * (OFFSET * Math.sin(offsetAngle) + WANDER * Math.sin(wanderAngle));

  let accentD = "", inkD = "";
  const columns = Math.ceil(cx / pitch) + 2, rows = Math.ceil(cy / pitch) + 2;
  for (let row = -rows; row <= rows; row += 1) {
    const y = cy + row * pitch, leanShift = (y - cy) * lean;
    for (let column = -columns; column <= columns; column += 1) {
      const x = cx + column * pitch;
      // The tone travels toward +x: dark where it peaks, cream where it is low.
      const tone = (1 + Math.cos(2 * Math.PI * ((x + leanShift - cx) / wavelength - cycles * u - phase))) / 2;
      const r = pitch * (MIN_DOT + (big - MIN_DOT) * smoothstep(LOW, HIGH, tone));
      accentD += circlePathD(x + offsetX, y + offsetY, r, 1);
      inkD += circlePathD(x, y, r, 1);
    }
  }

  const doc = createSvgDocument(size, { background: params.palette.paper });
  return doc.render(path(accentD, { fill: params.palette.accent }), path(inkD, { fill: params.palette.ink }));
}, { revision: REVISION, loopSeconds: B03_LOOP_SECONDS, loopCycles: B03_LOOP_CYCLES });
