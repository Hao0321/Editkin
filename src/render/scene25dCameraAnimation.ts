import type { KeyframeEasing } from "../domain/types";
import { easingProgress } from "./depthOfFieldAnimation";
import type { EngineNode } from "./engineGraph";

export interface Scene25dCameraSample {
  position: [number, number, number];
  target: [number, number, number];
  verticalFovRadians: number;
}

export interface Scene25dCameraGraphKeyframe extends Scene25dCameraSample {
  frame: number;
  easing: KeyframeEasing;
}

function interpolate(left: Scene25dCameraSample, right: Scene25dCameraSample, ratio: number): Scene25dCameraSample {
  const amount = Math.max(0, Math.min(1, ratio));
  const mix = (start: number, end: number) => start + (end - start) * amount;
  return {
    position: left.position.map((value, index) => mix(value, right.position[index])) as [number, number, number],
    target: left.target.map((value, index) => mix(value, right.target[index])) as [number, number, number],
    verticalFovRadians: mix(left.verticalFovRadians, right.verticalFovRadians),
  };
}

export function scene25dCameraGraphKeyframes(node: EngineNode): Scene25dCameraGraphKeyframe[] {
  return (node.keyframes as Scene25dCameraGraphKeyframe[] | undefined) ?? [];
}

export function sampleScene25dCameraNode(node: EngineNode, timelineFrame: number): Scene25dCameraSample {
  const base = { position: node.position as [number, number, number], target: node.target as [number, number, number], verticalFovRadians: Number(node.verticalFovRadians) };
  const keyframes = scene25dCameraGraphKeyframes(node);
  const index = keyframes.findIndex((keyframe) => keyframe.frame >= timelineFrame);
  if (index < 0) return keyframes.length ? keyframes[keyframes.length - 1] : base;
  const next = keyframes[index];
  if (index === 0) return timelineFrame === next.frame ? next : interpolate(base, next, timelineFrame / next.frame);
  const previous = keyframes[index - 1];
  if (timelineFrame === next.frame) return next;
  if (previous.easing === "hold") return previous;
  return interpolate(previous, next, easingProgress((timelineFrame - previous.frame) / (next.frame - previous.frame), previous.easing));
}
