import { describe, expect, it } from "vitest";
import type { EngineNode } from "./engineGraph";
import { sampleScene25dCameraNode } from "./scene25dCameraAnimation";

const camera = (keyframes: unknown[]): EngineNode => ({
  id: "scene25d:camera", inputs: [], enabled: true, kind: "camera",
  position: [0, 0, 4], target: [0, 0, 0], up: [0, 1, 0], verticalFovRadians: Math.PI / 3,
  near: .1, far: 20, keyframes,
});

describe("scene25d camera animation", () => {
  it("samples base, midpoint and terminal camera values by project frame", () => {
    const node = camera([{ frame: 10, position: [1, 0, 5], target: [.5, 0, 0], verticalFovRadians: Math.PI / 2, easing: "ease_in_out" }]);
    expect(sampleScene25dCameraNode(node, 0)).toMatchObject({ position: [0, 0, 4], target: [0, 0, 0] });
    expect(sampleScene25dCameraNode(node, 5).position).toEqual([.5, 0, 4.5]);
    expect(sampleScene25dCameraNode(node, 10)).toMatchObject({ position: [1, 0, 5], target: [.5, 0, 0] });
    expect(sampleScene25dCameraNode(node, 30).verticalFovRadians).toBeCloseTo(Math.PI / 2);
  });

  it("uses the previous keyframe easing and preserves hold segments", () => {
    const node = camera([
      { frame: 10, position: [1, 0, 4], target: [0, 0, 0], verticalFovRadians: 1, easing: "hold" },
      { frame: 20, position: [3, 0, 4], target: [1, 0, 0], verticalFovRadians: 1.4, easing: "linear" },
    ]);
    expect(sampleScene25dCameraNode(node, 15)).toMatchObject({ position: [1, 0, 4], target: [0, 0, 0], verticalFovRadians: 1 });
    expect(sampleScene25dCameraNode(node, 20)).toMatchObject({ position: [3, 0, 4], target: [1, 0, 0], verticalFovRadians: 1.4 });
  });
});
