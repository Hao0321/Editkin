import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { buildAces2DisplayVideoRenderRequest, buildAces2SdrVideoRenderRequest, containsSceneLinearMedia } from "./aces2SdrVideo";

function project() {
  const value = createEmptyProject("ACES 2 SDR", { width: 64, height: 36, fps: 30 });
  value.assets.push({ id: "plate", name: "plate.exr", kind: "image", uri: "C:/VFX/plate.exr", duration: 3 / 30, width: 64, height: 36, alphaMode: "straight", color: { interpretation: "linear_rec709" } });
  value.tracks[0].clips.push({ id: "clip", assetId: "plate", trackId: value.tracks[0].id, timelineStart: 0, sourceStart: 0, duration: 3 / 30, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
  return value;
}

describe("native ACES 2 Rec.709 SDR product request", () => {
  it("wraps the complete scene-linear composite in one measured display transform", () => {
    const value = project();
    value.captions.push({ id: "caption", text: "白色字幕", start: 0, duration: 2 / 30 });
    expect(containsSceneLinearMedia(value)).toBe(true);
    const request = buildAces2SdrVideoRenderRequest(value);
    const display = request.graph.nodes.find((node) => node.id === "color:display:aces2-rec709_sdr");
    const output = request.graph.nodes.find((node) => node.id === request.graph.outputNode);
    expect(display).toMatchObject({ processor: request.colorProcessor, inputSpace: "linear_rec709", workingSpace: "ACEScct", outputSpace: "rec709_sdr" });
    expect(output?.inputs).toEqual([display?.id]);
    expect(request.graph.nodes.some((node) => node.kind === "caption")).toBe(false);
  });

  it("builds measured HLG/PQ display nodes and fails closed for unmeasured P3 or primary grading", () => {
    const hdr = project();
    hdr.colorManagement = { ...hdr.colorManagement!, mode: "aces2", outputTransform: "rec2100_pq_1000" };
    expect(buildAces2DisplayVideoRenderRequest(hdr)).toMatchObject({
      outputTransform: "rec2100_pq_1000",
      colorProcessor: "editkin-ocio-aces2-linear-rec709-to-rec2100-pq-1000/v1",
    });
    const p3 = project();
    p3.colorManagement = { ...p3.colorManagement!, mode: "aces2", outputTransform: "p3d65_sdr" };
    expect(() => buildAces2DisplayVideoRenderRequest(p3)).toThrow(/P3 D65/);
    const graded = project();
    graded.tracks[0].clips[0].color.exposure = 1;
    expect(() => buildAces2SdrVideoRenderRequest(graded)).toThrow(/動態 grading processor/);
  });
});
