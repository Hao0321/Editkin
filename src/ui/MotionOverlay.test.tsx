import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { createEmptyProject } from "../domain/editGraph";
import { createMotionGraphic } from "../motion/composition";
import { motionGraphicV2LayoutReceipt } from "../motion/compositionV2";
import MotionOverlay from "./MotionOverlay";

describe("MotionOverlay v2", () => {
  it("uses the physical alias and exposes substituted weight without synthetic bold", () => {
    const project=createEmptyProject("font consumer",{width:1920,height:1080,fps:30});
    const g=createMotionGraphic("font","title","TEXT",0,3,undefined,findMotionGraphicPreset("v2-word-cascade").seed);
    g.fontFamily="Fredoka";g.fontWeight=850;project.motionGraphics=[g];
    const html=renderToStaticMarkup(<MotionOverlay project={project} playhead={1} trackingSelectionEnabled={false}/>);
    expect(html).toContain("EditkinFace fredoka 700");expect(html).toContain("font-weight:700");expect(html).toContain("font-synthesis:style");expect(html).toContain('data-font-weight-substituted="true"');
  });
  it("renders the exact shared layout receipt and sequenced segments", () => {
    const project = createEmptyProject("Motion v2", { width: 1920, height: 1080, fps: 30 });
    const preset = findMotionGraphicPreset("v2-word-cascade");
    const graphic = createMotionGraphic("dom-v2", "title", "DOM AND EXPORT", 0, 3, undefined, preset.seed);
    project.motionGraphics.push(graphic);
    const layout = motionGraphicV2LayoutReceipt(project, graphic);
    const html = renderToStaticMarkup(<MotionOverlay project={project} playhead={.2} trackingSelectionEnabled={false} />);
    expect(html).toContain(`data-motion-layout-receipt="${layout.receiptId}"`);
    expect(html.match(/<span/g)).toHaveLength(layout.segments.length);
  });

  it("shows an explicit blocked state instead of silently using v1 layout", () => {
    const project = createEmptyProject("Motion v2", { width: 320, height: 180, fps: 30 });
    const preset = findMotionGraphicPreset("v2-word-cascade");
    const graphic = createMotionGraphic("dom-blocked", "title", "THIS CANNOT FIT", 0, 3, undefined, preset.seed);
    graphic.width = .05;
    graphic.fontSize = 72;
    graphic.layoutV2 = { ...graphic.layoutV2!, minFontSize: 72, maxLines: 1 };
    project.motionGraphics.push(graphic);
    const html = renderToStaticMarkup(<MotionOverlay project={project} playhead={.2} trackingSelectionEnabled={false} />);
    expect(html).toContain("data-testid=\"motion-v2-blocked\"");
    expect(html).toContain("v2 排版受阻");
    expect(html).not.toContain("data-testid=\"motion-graphic\"");
  });

  it("keeps v2 lower-third tags on their declared width", () => {
    const project = createEmptyProject("Lower third", { width: 1920, height: 1080, fps: 30 });
    const preset = findMotionGraphicPreset("lower_third_clean_blue_unit");
    const graphic = createMotionGraphic("unit", "tag", "Editkin 創辦人", 0, 3, undefined, preset.seed);
    project.motionGraphics.push(graphic);
    const html = renderToStaticMarkup(<MotionOverlay project={project} playhead={.5} trackingSelectionEnabled={false} />);
    expect(html).toContain('data-motion-preset="lower_third_clean_blue_unit"');
    expect(html).toContain(`width:${graphic.width * 100}%`);
  });
});
