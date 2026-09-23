import { describe, expect, it } from "vitest";
import type { EngineNode } from "./engineGraph";
import { sampleScene25dLightNode } from "./scene25dLightAnimation";

function light(keyframes: EngineNode["keyframes"]): EngineNode {
  return { id: "light", inputs: [], enabled: true, kind: "light", color: [1, .8, .6], intensity: .2, direction: [0, 0, 1], keyframes };
}

describe("2.5D light timeline sampling", () => {
  it("interpolates light color, intensity and direction before native shading", () => {
    const node = light([{ frame: 10, color: [.2, .4, 1], intensity: 1.2, direction: [1, 0, 1], easing: "linear" }]);
    expect(sampleScene25dLightNode(node, 0)).toEqual({ color: [1, .8, .6], intensity: .2, direction: [0, 0, 1] });
    const midpoint = sampleScene25dLightNode(node, 5);
    expect(midpoint.color[0]).toBeCloseTo(.6); expect(midpoint.color[1]).toBeCloseTo(.6); expect(midpoint.color[2]).toBeCloseTo(.8);
    expect(midpoint.intensity).toBeCloseTo(.7); expect(midpoint.direction).toEqual([.5, 0, 1]);
    expect(sampleScene25dLightNode(node, 10)).toMatchObject({ color: [.2, .4, 1], intensity: 1.2, direction: [1, 0, 1] });
  });

  it("holds the previous sample until the next keyframe but switches on the exact frame", () => {
    const node = light([
      { frame: 10, color: [1, 1, 1], intensity: .5, direction: [0, 0, 1], easing: "hold" },
      { frame: 20, color: [0, .2, 1], intensity: 1.5, direction: [-1, 0, 1], easing: "linear" },
    ]);
    expect(sampleScene25dLightNode(node, 15).intensity).toBe(.5);
    expect(sampleScene25dLightNode(node, 20)).toMatchObject({ color: [0, .2, 1], intensity: 1.5, direction: [-1, 0, 1] });
  });
});
