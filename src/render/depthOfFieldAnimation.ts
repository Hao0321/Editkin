import type { KeyframeEasing } from "../domain/types";
import type { EngineNode } from "./engineGraph";

export interface DepthOfFieldSample {
  focusDistance: number;
  aperture: number;
  maxBlurRadius: number;
}

interface DepthOfFieldGraphKeyframe extends DepthOfFieldSample {
  frame: number;
  easing: KeyframeEasing;
}

export function easingProgress(ratio: number, easing: KeyframeEasing): number {
  const value = Math.max(0, Math.min(1, ratio));
  if (easing === "hold") return 0;
  if (easing === "ease_in") return value * value;
  if (easing === "ease_out") return 1 - (1 - value) * (1 - value);
  if (easing === "ease_in_out") return value < .5 ? 2 * value * value : 1 - ((-2 * value + 2) ** 2) / 2;
  if (easing === "spring_soft") return Math.max(0, Math.min(1.08, 1 - Math.exp(-6 * value) * Math.cos(8 * value)));
  return value;
}

function interpolate(left: DepthOfFieldSample, right: DepthOfFieldSample, ratio: number): DepthOfFieldSample {
  const mix = (start: number, end: number) => start + (end - start) * Math.max(0, Math.min(1, ratio));
  return { focusDistance: mix(left.focusDistance, right.focusDistance), aperture: mix(left.aperture, right.aperture), maxBlurRadius: mix(left.maxBlurRadius, right.maxBlurRadius) };
}

export function depthOfFieldGraphKeyframes(node: EngineNode): DepthOfFieldGraphKeyframe[] {
  return (node.keyframes as DepthOfFieldGraphKeyframe[] | undefined) ?? [];
}

export function sampleDepthOfFieldNode(node: EngineNode, timelineFrame: number): DepthOfFieldSample {
  const base = { focusDistance: Number(node.focusDistance), aperture: Number(node.aperture), maxBlurRadius: Number(node.maxBlurRadius) };
  const keyframes = depthOfFieldGraphKeyframes(node);
  const index = keyframes.findIndex((keyframe) => keyframe.frame >= timelineFrame);
  if (index < 0) return keyframes.length ? keyframes[keyframes.length - 1] : base;
  const next = keyframes[index];
  if (index === 0) return timelineFrame === next.frame ? next : interpolate(base, next, timelineFrame / next.frame);
  const previous = keyframes[index - 1];
  if (timelineFrame === next.frame) return next;
  if (previous.easing === "hold") return previous;
  return interpolate(previous, next, easingProgress((timelineFrame - previous.frame) / (next.frame - previous.frame), previous.easing));
}
