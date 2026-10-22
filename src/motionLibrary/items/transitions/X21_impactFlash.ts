import { circleBezierPathD, createSvgDocument, emptySvg, path, polygonPathD, rect, type Point2 } from "../../svg/document";
import { clamp01, cubicOut, energyProfile, quadIn } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineTransitionMotion, type MotionEnergy, type MotionFrameSize } from "../../types";
import { createMatteDocument, frameUnit, MATTE_SHOW_B } from "../shared";

/**
 * X21 Impact Flash: A gathers itself, a single white (paper) flash hits, and B
 * arrives with a shockwave. Before the hit, ink focus lines (manga 集中線) rush in
 * from beyond the frame edges toward the centre. The flash is one full-frame paper
 * plane: fully opaque for 1/15 s (2 frames at 30 fps) around the switch, then a fast
 * decay. Then a shockwave bursts out of the centre: a paper ring hugging a thinner
 * deep-shade (accent2) inner band, with a crown of deep-shade spikes flying ahead of
 * it, all shaken by a decaying jolt.
 *
 * Timing: the focus lines run 10–50%; the flash is fully opaque from 1/60 s before the
 * switch to 1/20 s after it, so the matte switches at exactly D/2 under full cover
 * (ART_DIRECTION §4), and fades over the next 0.06 s (sooner when the transition is too
 * short for that); the ring expands over 50–95% at a near-constant speed (u^1 calm …
 * u^0.65 hype), so it crosses the frame in the frames after the flash, from 10% of the
 * half-diagonal to past the frame corners, thinning from 8.5% to 1.2% of the short
 * side. One flash per transition, so the flash rate stays far below 3 per second (WCAG
 * 2.3.1). The shake is a damped 16 Hz two-axis oscillation (seeded phases) of at most
 * 1% of the short side (× √amplitude: 1.3% at hype, under the 2% ceiling), dying away
 * over 50–80%; it moves the shockwave graphics (a transition matte cannot move the
 * footage itself). Energy sets the ring's speed curve, the spike count and the jolt.
 * t = 0 is pure A and t = D pure B with an empty overlay. Not directional.
 */

const ID = "X21";
const REVISION = 1;
const SWITCH = 0.5;
/** Flash: fully opaque from FLASH_LEAD before the switch to FLASH_HOLD after it (seconds), then a FLASH_DECAY fade. */
const FLASH_LEAD = 1 / 60, FLASH_HOLD = 1 / 20, FLASH_DECAY = 0.06;
/** Focus lines: start, count, width at the frame edge (px at 1080). */
const FOCUS_START = 0.1, FOCUS_LINES = 20, FOCUS_WIDTH = 44;
/** Shockwave: end of its expansion, start radius (fraction of the half-diagonal), start and end widths (fractions of the short side). */
const RING_END = 0.95, RING_START = 0.1, RING_START_WIDTH = 0.085, RING_END_WIDTH = 0.012;
/** Shake: amplitude (fraction of the short side), frequency (Hz of real time) and the progress by which it has died away. */
const SHAKE = 0.01, SHAKE_HZ = 16, SHAKE_END = 0.8;
const SPIKES: Record<MotionEnergy, number> = { calm: 10, standard: 14, punchy: 16, hype: 18 };
/** Ring expansion u^power: near-constant speed (a shockwave), a little faster off the mark at higher energy. */
const RING_POWER: Record<MotionEnergy, number> = { calm: 1, standard: 0.85, punchy: 0.75, hype: 0.65 };

/** Opacity of the flash at time t (seconds) for a transition of duration D: 1 around the switch, then a decay; 0 elsewhere. */
export function impactFlashOpacity(t: number, durationSeconds: number): number {
  const at = SWITCH * durationSeconds;
  if (t < at - FLASH_LEAD) return 0;
  if (t <= at + FLASH_HOLD) return 1;
  // The fade ends by 95% of the duration even when the transition is short.
  const decay = Math.max(1e-3, Math.min(FLASH_DECAY, 0.95 * durationSeconds - (at + FLASH_HOLD)));
  return 1 - cubicOut((t - at - FLASH_HOLD) / decay);
}

/** A thin wedge along the ray at `angle` (radians) from radius r0 (width w0) to r1 (width w1). */
function wedge(cx: number, cy: number, angle: number, r0: number, w0: number, r1: number, w1: number): Point2[] {
  const ux = Math.cos(angle), uy = Math.sin(angle), nx = -uy, ny = ux;
  return [
    [cx + ux * r0 + (nx * w0) / 2, cy + uy * r0 + (ny * w0) / 2], [cx + ux * r1 + (nx * w1) / 2, cy + uy * r1 + (ny * w1) / 2],
    [cx + ux * r1 - (nx * w1) / 2, cy + uy * r1 - (ny * w1) / 2], [cx + ux * r0 - (nx * w0) / 2, cy + uy * r0 - (ny * w0) / 2],
  ];
}

/** A ring (annulus) as two circles (fill-rule evenodd). */
function ringD(cx: number, cy: number, outer: number, inner: number): string {
  return outer > inner ? circleBezierPathD(cx, cy, outer, 2) + circleBezierPathD(cx, cy, inner, 2) : "";
}

/**
 * The jolt's offset (px) at time t (seconds): a damped two-axis oscillation at SHAKE_HZ of real time (so it reads
 * as a camera jolt at any duration) with seeded phases, starting at the switch and gone by SHAKE_END of the duration.
 */
export function impactShake(t: number, durationSeconds: number, seed: number, energy: MotionEnergy, size: MotionFrameSize): readonly [number, number] {
  const p = t / durationSeconds;
  if (p < SWITCH || p >= SHAKE_END) return [0, 0];
  const decay = (1 - (p - SWITCH) / (SHAKE_END - SWITCH)) ** 2;
  const amount = SHAKE * Math.min(size.width, size.height) * Math.sqrt(energyProfile(energy).amplitude) * decay;
  const rng = createSeededRng(ID, seed, "shake");
  const phaseX = rng.range(0, 2 * Math.PI), phaseY = rng.range(0, 2 * Math.PI);
  const elapsed = t - SWITCH * durationSeconds;
  return [amount * Math.sin(2 * Math.PI * SHAKE_HZ * elapsed + phaseX), amount * Math.sin(2 * Math.PI * SHAKE_HZ * 1.37 * elapsed + phaseY)];
}

export const X21_impactFlash = defineTransitionMotion(ID, (params, t, size) => {
  const D = params.durationSeconds, p = clamp01(t / D);
  const matte = createMatteDocument(size);
  const allB = () => matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B }));
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= 1) return { matte: allB(), overlay: emptySvg(size) };

  const { width, height } = size, cx = width / 2, cy = height / 2;
  const short = Math.min(width, height), halfDiagonal = Math.hypot(width, height) / 2, unit = frameUnit(size);
  const rng = createSeededRng(ID, params.seed, "layout");
  const focusAngles = Array.from({ length: FOCUS_LINES }, (_, index) => ((index + rng.range(-0.3, 0.3)) / FOCUS_LINES) * 2 * Math.PI);
  const focusReach = Array.from({ length: FOCUS_LINES }, () => rng.range(0.12, 0.3));
  const spikeCount = SPIKES[params.energy];
  const spikeAngles = Array.from({ length: spikeCount }, (_, index) => ((index + 0.5 + rng.range(-0.35, 0.35)) / spikeCount) * 2 * Math.PI);
  const spikeLength = Array.from({ length: spikeCount }, () => rng.range(0.55, 1));

  const parts: string[] = [];
  if (p < SWITCH) {
    // Focus lines: from beyond the frame edge, their tips rush toward the centre (ease-in), never reaching it.
    const q = clamp01((p - FOCUS_START) / (SWITCH - FOCUS_START));
    if (q > 0) {
      let lines = "";
      focusAngles.forEach((angle, index) => {
        const outer = halfDiagonal * 1.08, tip = halfDiagonal * (1.04 - (1.04 - focusReach[index]) * quadIn(q));
        if (outer - tip > 0.5) lines += polygonPathD(wedge(cx, cy, angle, outer, FOCUS_WIDTH * unit, tip, 0), 2);
      });
      parts.push(path(lines, { fill: params.palette.ink }));
    }
  } else {
    // Shockwave (a paper band hugging a deep-shade inner band) and spikes, shaken.
    const u = clamp01((p - SWITCH) / (RING_END - SWITCH));
    if (u < 1) {
      const [dx, dy] = impactShake(t, D, params.seed, params.energy, size);
      const sx = cx + dx, sy = cy + dy;
      const radius = halfDiagonal * (RING_START + (1.08 - RING_START) * u ** RING_POWER[params.energy]);
      const ringWidth = Math.min(radius, short * (RING_START_WIDTH + (RING_END_WIDTH - RING_START_WIDTH) * Math.sqrt(u)));
      const inner = Math.max(0, radius - ringWidth);
      let spikes = "";
      spikeAngles.forEach((angle, index) => {
        const from = radius + 0.25 * ringWidth, length = spikeLength[index] * 0.36 * short * (1 - u) ** 1.2;
        if (length > 1) spikes += polygonPathD(wedge(sx, sy, angle, from, 0.03 * short * (1 - u) ** 0.8, from + length, 0), 2);
      });
      parts.push(
        path(spikes, { fill: params.palette.accent2 }),
        path(ringD(sx, sy, inner + 1, Math.max(0, inner - 0.5 * ringWidth)), { fill: params.palette.accent2, "fill-rule": "evenodd" }),
        path(ringD(sx, sy, radius, inner), { fill: params.palette.paper, "fill-rule": "evenodd" }),
      );
    }
  }
  // The flash on top of everything (one per transition).
  const flash = impactFlashOpacity(t, D);
  if (flash > 0.001) parts.push(rect(0, 0, width, height, { fill: params.palette.paper, ...(flash < 1 ? { opacity: Number(flash.toFixed(3)) } : {}) }));
  return { matte: p < SWITCH ? matte.render() : allB(), overlay: createSvgDocument(size).render(parts) };
}, { revision: REVISION });
