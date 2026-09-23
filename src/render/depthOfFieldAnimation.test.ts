import { describe, expect, it } from "vitest";
import type { EngineNode } from "./engineGraph";
import { sampleDepthOfFieldNode } from "./depthOfFieldAnimation";

describe("camera depth-of-field animation", () => {
  const node: EngineNode = {
    id: "scene25d:depth-of-field", inputs: ["scene", "camera"], enabled: true, kind: "depth_of_field",
    focusDistance: 3, aperture: 2, maxBlurRadius: 8,
    keyframes: [
      { frame: 10, focusDistance: 5, aperture: 4, maxBlurRadius: 12, easing: "ease_in_out" },
      { frame: 20, focusDistance: 9, aperture: 8, maxBlurRadius: 20, easing: "hold" },
    ],
  };

  it("matches native base, eased segment and terminal sampling", () => {
    expect(sampleDepthOfFieldNode(node, 5)).toMatchObject({ focusDistance: 4, aperture: 3, maxBlurRadius: 10 });
    expect(sampleDepthOfFieldNode(node, 15)).toMatchObject({ focusDistance: 7, aperture: 6, maxBlurRadius: 16 });
    expect(sampleDepthOfFieldNode(node, 25)).toMatchObject({ focusDistance: 9, aperture: 8, maxBlurRadius: 20 });
  });

  it("uses the previous keyframe easing and preserves hold segments", () => {
    const held = structuredClone(node);
    (held.keyframes as Array<Record<string, unknown>>)[0].easing = "hold";
    expect(sampleDepthOfFieldNode(held, 15)).toMatchObject({ focusDistance: 5, aperture: 4, maxBlurRadius: 12 });
  });
});
