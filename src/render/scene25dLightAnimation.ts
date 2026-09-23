import type { KeyframeEasing } from "../domain/types";
import { easingProgress } from "./depthOfFieldAnimation";
import type { EngineNode } from "./engineGraph";

export interface Scene25dLightSample {
  color: [number, number, number];
  intensity: number;
  direction: [number, number, number];
}

export interface Scene25dLightGraphKeyframe extends Scene25dLightSample {
  frame: number;
  easing: KeyframeEasing;
}

function interpolate(left: Scene25dLightSample, right: Scene25dLightSample, ratio: number): Scene25dLightSample {
  const amount = Math.max(0, Math.min(1, ratio));
  const mix = (start: number, end: number) => start + (end - start) * amount;
  return {
    color: left.color.map((value, index) => mix(value, right.color[index])) as [number, number, number],
    intensity: mix(left.intensity, right.intensity),
    direction: left.direction.map((value, index) => mix(value, right.direction[index])) as [number, number, number],
  };
}

export function scene25dLightGraphKeyframes(node: EngineNode): Scene25dLightGraphKeyframe[] {
  return (node.keyframes as Scene25dLightGraphKeyframe[] | undefined) ?? [];
}

export function sampleScene25dLightNode(node: EngineNode, timelineFrame: number): Scene25dLightSample {
  const base = {
    color: node.color as [number, number, number], intensity: Number(node.intensity),
    direction: node.direction as [number, number, number],
  };
  const keyframes = scene25dLightGraphKeyframes(node);
  const index = keyframes.findIndex((keyframe) => keyframe.frame >= timelineFrame);
  if (index < 0) return keyframes.length ? keyframes[keyframes.length - 1] : base;
  const next = keyframes[index];
  if (index === 0) return timelineFrame === next.frame ? next : interpolate(base, next, timelineFrame / next.frame);
  const previous = keyframes[index - 1];
  if (timelineFrame === next.frame) return next;
  if (previous.easing === "hold") return previous;
  return interpolate(previous, next, easingProgress((timelineFrame - previous.frame) / (next.frame - previous.frame), previous.easing));
}
