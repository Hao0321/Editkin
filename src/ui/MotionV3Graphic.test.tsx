import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MOTION_DESIGN_V3_PRESETS } from "../creative/motionDesignV3Presets";
import { createEmptyProject } from "../domain/editGraph";
import type { MotionGraphic } from "../domain/types";
import { motionGraphicV3Frame } from "../motion/compositionV3";
import MotionOverlay from "./MotionOverlay";
import MotionV3Library from "./MotionV3Library";

function projectWith(graphic: Partial<MotionGraphic>, presetId = "v3_title_reveal_panel") {
  const project = createEmptyProject("v3 preview", { id: "v3-preview", width: 1920, height: 1080, fps: 30 });
  const preset = MOTION_DESIGN_V3_PRESETS.find(item => item.id === presetId)!;
  project.motionGraphics = [{ ...preset.seed, id: "g1", timelineStart: 0, duration: 3, ...graphic } as MotionGraphic];
  return project;
}

describe("Motion Design v3 preview", () => {
  it("draws the evaluated frame's ops as one canvas-sized SVG", () => {
    const project = projectWith({});
    const markup = renderToStaticMarkup(<MotionOverlay project={project} playhead={1.5} trackingSelectionEnabled={false} />);
    const frame = motionGraphicV3Frame(project, project.motionGraphics[0], 45);
    expect(markup).toContain('class="motion-graphic-v3"');
    expect(markup).toContain('viewBox="0 0 1920 1080"');
    expect(markup).toContain('data-motion-template="title_reveal"');
    expect(markup).toContain("一個人的北海道");
    expect(markup.match(/<(path|text) /g)).toHaveLength(frame.ops.length);
    // Clips and blur sit on a group in canvas space; glyphs scale inside it.
    expect(markup).toMatch(/<clipPath id="[^"]+"><rect /u);
    expect(markup).toMatch(/<feGaussianBlur stdDeviation="[\d.]+"/u);
  });

  it("draws nothing before or after the graphic", () => {
    const project = projectWith({ timelineStart: 2 });
    expect(renderToStaticMarkup(<MotionOverlay project={project} playhead={1} trackingSelectionEnabled={false} />)).not.toContain("motion-graphic-v3");
    expect(renderToStaticMarkup(<MotionOverlay project={project} playhead={5.5} trackingSelectionEnabled={false} />)).not.toContain("motion-graphic-v3");
  });

  it("shows a blocked marker instead of guessing when copy cannot fit the template", () => {
    const project = projectWith({ text: "字".repeat(60), fontSize: 240 }, "v3_title_reveal");
    const markup = renderToStaticMarkup(<MotionOverlay project={project} playhead={1} trackingSelectionEnabled={false} />);
    expect(markup).toContain('data-testid="motion-v3-blocked"');
    expect(markup).toContain("超出版型");
  });

  it("lists every preset in the gallery with a live thumbnail", () => {
    const markup = renderToStaticMarkup(<MotionV3Library onAddMotionGraphic={() => undefined} />);
    for (const preset of MOTION_DESIGN_V3_PRESETS) expect(markup).toContain(`data-testid="motion-v3-${preset.id}"`);
    expect(markup.match(/class="motion-graphic-v3"/g)?.length).toBe(MOTION_DESIGN_V3_PRESETS.length);
  });
});
