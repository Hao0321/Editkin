import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { createMotionGraphic, legacyMotionGraphicSeed } from "../motion/composition";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import MotionOverlay from "./MotionOverlay";

describe("painted vectors cannot silently use the compatibility solid-fill path", () => {
  function fixture() {
    const project = createEmptyProject("paint preview ownership", { width: 640, height: 360, fps: 30 });
    const graphic = createMotionGraphic("panel", "title", "", .5, 3, undefined, findMotionGraphicPreset("v2-word-cascade").seed);
    Object.assign(graphic, { x: .1, y: .1, width: .5, shadowDepth: 0, outlineWidth: 0 });
    graphic.vectorV2 = { schema: "editkin.motion-vector/v1", kind: "panel", heightPixels: 100, revealFrames: 1 };
    graphic.motionV2!.sequence = { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0 };
    project.motionGraphics = [graphic]; return { project, graphic };
  }
  it("accepts an ordinary vector and blocks the same actual vector with authored gradient paint", () => {
    const { project, graphic } = fixture();
    const render = () => renderToStaticMarkup(<MotionOverlay project={project} playhead={1} trackingSelectionEnabled={false} />);
    expect(render()).toContain('data-testid="motion-vector-v2"');
    graphic.paintV1 = { schema: "editkin.motion-paint/v2", colorIntent: "display_rec709_sdr",
      fill: { kind: "linear", start: { x: 0, y: 0 }, end: { x: 1, y: 0 },
        stops: [{ at: 0, color: "#D5EEFFFF" }, { at: 1, color: "#378AB080" }] }, clips: [] };
    graphic.visualStyle = "native_paint";
    graphic.backgroundColor = "#00000000";
    const before = JSON.stringify(project), html = render();
    expect(html).toContain('data-testid="motion-paint-preview-unavailable"');
    expect(html).not.toContain("<svg"); expect(JSON.stringify(project)).toBe(before);
  });
  it("a previously baked painted vector is not re-rendered or replaced by a warning", () => {
    const { project, graphic } = fixture();
    graphic.paintV1 = { schema: "editkin.motion-paint/v1", fill: { kind: "solid", color: "#D5EEFF80" }, clips: [] };
    expect(renderToStaticMarkup(<MotionOverlay project={project} playhead={1} bakedGraphicIds={[graphic.id]} trackingSelectionEnabled={false} />)).toBe("");
  });
  it("native pending suppresses all graphics without pretending IDs were baked, while tracking stays available", () => {
    const { project } = fixture();
    project.motionGraphics = [createMotionGraphic("ordinary", "title", "不得疊在等待中的原生畫面", 0, 3, undefined, legacyMotionGraphicSeed("title"))];
    const render = (suppressGraphics: boolean) => renderToStaticMarkup(<MotionOverlay project={project} playhead={1}
      bakedGraphicIds={[]} suppressGraphics={suppressGraphics} trackingSelectionEnabled
      trackingSelection={{ x: .1, y: .2, width: .3, height: .4 }} />);
    expect(render(false)).toContain("不得疊在等待中的原生畫面");
    const pending = render(true); expect(pending).not.toContain("不得疊在等待中的原生畫面");
    expect(pending).toContain("tracking-help"); expect(pending).toContain("tracking-box");
  });
});
