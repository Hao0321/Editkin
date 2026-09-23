import type { EditProject } from "../domain/types";

export function scene25dCameraNode(
  project: EditProject,
  timeToFrame: (seconds: number, fps: number) => number,
) {
  const camera = project.scene25d!.camera;
  return {
    id: "scene25d:camera", inputs: [] as string[], enabled: true, kind: "camera",
    position: camera.position, target: camera.target, up: camera.up,
    verticalFovRadians: camera.verticalFovDegrees * Math.PI / 180, near: camera.near, far: camera.far,
    keyframes: camera.keyframes.map((keyframe) => ({ frame: timeToFrame(keyframe.time, project.fps), position: keyframe.position,
      target: keyframe.target, verticalFovRadians: keyframe.verticalFovDegrees * Math.PI / 180, easing: keyframe.easing })),
  };
}

export function scene25dLightNodes(
  project: EditProject,
  timeToFrame: (seconds: number, fps: number) => number,
) {
  const scene = project.scene25d!;
  return [
    {
      id: "scene25d:ambient", inputs: [] as string[], enabled: true, kind: "light", lightKind: "ambient",
      color: scene.ambientLight.color, intensity: scene.ambientLight.intensity, position: [0, 0, 0], direction: [0, 0, -1],
      keyframes: scene.ambientLight.keyframes.map((keyframe) => ({ frame: timeToFrame(keyframe.time, project.fps),
        color: [1, 1, 1], intensity: keyframe.intensity, direction: [0, 0, -1], easing: keyframe.easing })),
    },
    {
      id: "scene25d:directional", inputs: [] as string[], enabled: true, kind: "light", lightKind: "directional",
      color: scene.directionalLight.color, intensity: scene.directionalLight.intensity, position: [0, 0, 0], direction: scene.directionalLight.direction,
      keyframes: scene.directionalLight.keyframes.map((keyframe) => ({ frame: timeToFrame(keyframe.time, project.fps),
        color: keyframe.color, intensity: keyframe.intensity, direction: keyframe.direction, easing: keyframe.easing })),
    },
  ];
}

export function scene25dDepthOfFieldNode(
  project: EditProject,
  inputNodeId: string,
  timeToFrame: (seconds: number, fps: number) => number,
) {
  const lens = project.scene25d?.depthOfField;
  if (!project.scene25d?.enabled || !lens?.enabled) return undefined;
  return {
    id: "scene25d:depth-of-field",
    inputs: [inputNodeId, "scene25d:camera"],
    enabled: true,
    kind: "depth_of_field",
    focusDistance: lens.focusDistance,
    aperture: lens.aperture,
    maxBlurRadius: lens.maxBlurRadius,
    keyframes: lens.keyframes.map((keyframe) => ({
      frame: timeToFrame(keyframe.time, project.fps),
      focusDistance: keyframe.focusDistance,
      aperture: keyframe.aperture,
      maxBlurRadius: keyframe.maxBlurRadius,
      easing: keyframe.easing,
    })),
  };
}
