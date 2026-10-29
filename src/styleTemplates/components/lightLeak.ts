import { createSvgDocument, ellipse } from "../../motionLibrary/svg/document";
import { clamp01, curve, lerp, sineIn, sineOut } from "../../motionLibrary/svg/easing";
import { createSeededRng } from "../../motionLibrary/svg/random";

/**
 * C7 warm light leak (design §2.1; R2's warm wash rising from the bottom).
 *
 * Procedural, original: soft radial blobs of warm colour drifting in from one
 * edge on black. The clip is opaque and is composited with blendMode "screen"
 * (black = no change), so it only ever adds warm light, like a real leak.
 * Envelope: rises fast (sineOut), holds briefly, falls slower (sineIn).
 */

export const LIGHT_LEAK_REVISION = 2;

export interface LightLeakParams {
  readonly component: "lightLeak";
  readonly revision: number;
  readonly width: number;
  readonly height: number;
  readonly duration: number;
  /** Warm colours, brightest first. */
  readonly colors: readonly string[];
  readonly peak: number;
  readonly origin: "bottom" | "left" | "right" | "top";
  readonly seed: number;
}

export function lightLeakEnvelope(t: number, duration: number): number {
  const p = clamp01(t / duration);
  if (p < 0.32) return sineOut(p / 0.32);
  if (p < 0.5) return 1;
  return 1 - sineIn((p - 0.5) / 0.5);
}

export function lightLeakFrame(params: LightLeakParams, t: number): string {
  const doc = createSvgDocument({ width: params.width, height: params.height }, { background: "#000000", idPrefix: "lk" });
  const amp = lightLeakEnvelope(t, params.duration) * params.peak;
  if (amp <= 0.002) return doc.render();
  const { width: W, height: H } = params;
  const rng = createSeededRng("lightLeak", params.seed, "blobs");
  const travel = curve("expoOut", clamp01(t / (params.duration * 0.8)));
  const long = Math.max(W, H);
  const blobs: string[] = [];
  const count = params.colors.length + 1;
  for (let index = 0; index < count; index += 1) {
    const color = params.colors[index % params.colors.length];
    const across = rng.range(0.1, 0.9), depth = rng.range(0.05, 0.35), radius = rng.range(0.42, 0.75) * long, squash = rng.range(0.55, 0.85);
    // u runs along the entry edge, v inward from it; blobs rise from beyond the edge to `depth` inside.
    const v = lerp(-0.3, depth, travel) + index * 0.03;
    const [cx, cy] = params.origin === "bottom" ? [across * W, H * (1 - v)] : params.origin === "top" ? [across * W, H * v]
      : params.origin === "left" ? [W * v, across * H] : [W * (1 - v), across * H];
    const horizontal = params.origin === "bottom" || params.origin === "top";
    const rx = horizontal ? radius : radius * squash, ry = horizontal ? radius * squash : radius;
    const strength = amp * (index === 0 ? 1 : 0.75);
    // objectBoundingBox units stretch the gradient to the ellipse, so the falloff follows its shape.
    const fill = doc.radialGradient({ cx: 0.5, cy: 0.5, r: 0.5, units: "objectBoundingBox", stops: [
      { offset: 0, color, opacity: Math.min(1, strength) },
      { offset: 0.35, color, opacity: Math.min(1, strength * 0.55) },
      { offset: 1, color, opacity: 0 },
    ] });
    blobs.push(ellipse(cx, cy, rx, ry, { fill }));
  }
  // A soft anamorphic streak across the leak's brightest band.
  const streakAlong = params.origin === "bottom" || params.origin === "top";
  const sv = lerp(-0.1, 0.22, travel);
  const [sx, sy] = params.origin === "bottom" ? [W / 2, H * (1 - sv)] : params.origin === "top" ? [W / 2, H * sv] : params.origin === "left" ? [W * sv, H / 2] : [W * (1 - sv), H / 2];
  const streak = doc.radialGradient({ cx: 0.5, cy: 0.5, r: 0.5, units: "objectBoundingBox", stops: [
    { offset: 0, color: params.colors[0], opacity: Math.min(1, amp * 0.6) }, { offset: 1, color: params.colors[0], opacity: 0 }] });
  const streakShape = ellipse(sx, sy, streakAlong ? long * 0.6 : long * 0.06, streakAlong ? long * 0.06 : long * 0.6, { fill: streak });
  return doc.render(blobs, streakShape);
}
