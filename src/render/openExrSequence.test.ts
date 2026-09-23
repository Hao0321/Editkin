import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { buildOpenExrSequenceRenderRequest } from "./openExrSequence";

function project() {
  const value = createEmptyProject("EXR sequence", { width: 40, height: 24, fps: 30 });
  value.assets.push({ id: "plate", name: "plate.exr", kind: "image", uri: "C:/VFX/plate.exr", duration: 3 / 30, width: 40, height: 24, alphaMode: "straight", color: { interpretation: "linear_rec709" } });
  value.tracks[0].clips.push({ id: "clip", assetId: "plate", trackId: value.tracks[0].id, timelineStart: 0, sourceStart: 0, duration: 3 / 30, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
  return value;
}

describe("OpenEXR sequence product request", () => {
  it("builds a frame-aligned scene-linear visual-only graph", () => {
    const value = project();
    value.colorManagement = { ...value.colorManagement!, mode: "aces2" };
    const request = buildOpenExrSequenceRenderRequest(value);
    expect(request.frameCount).toBe(3);
    expect(request.graph.workingFormat).toBe("rgba32_float");
    expect(request.graph.audio).toBeUndefined();
    expect(request.assetBindings).toEqual({ plate: "C:/VFX/plate.exr" });
    expect(request.graph.nodes.find((node) => node.kind === "color")).toMatchObject({
      processor: "editkin-linear-primary/v1",
      inputSpace: "linear_rec709",
      workingSpace: "linear_rec709",
      outputSpace: "linear_rec709",
    });
  });

  it("fails closed for calibrated-unknown text in a scene-linear graph", () => {
    const value = project();
    value.captions.push({ id: "caption", text: "HDR", start: 0, duration: 2 / 30 });
    expect(() => buildOpenExrSequenceRenderRequest(value)).toThrow(/尚未校準 caption/);
  });
});
