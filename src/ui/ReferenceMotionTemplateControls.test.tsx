import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createDemoProject } from "../domain/demo";
import ReferenceMotionTemplateControls from "./ReferenceMotionTemplateControls";
import { REFERENCE_MOTION_LEGACY_TEMPLATES, REFERENCE_MOTION_DESIGN_ONLY_TEMPLATE_IDS } from "../motion/referenceMotionTemplates";

describe("Motion template inspector entry", () => {
  it("exposes only compatible legacy recipes and requires real copy before applying", () => {
    const project = createDemoProject();
    const html = renderToStaticMarkup(<ReferenceMotionTemplateControls clip={project.tracks[0].clips[0]} assets={project.assets} portrait fps={30} onApply={() => {}} />);
    for (const recipe of REFERENCE_MOTION_LEGACY_TEMPLATES) expect(html).toContain(`value="${recipe.id}"`);
    for (const id of REFERENCE_MOTION_DESIGN_ONLY_TEMPLATE_IDS) expect(html).not.toContain(`value="${id}"`);
    expect(html).toContain('aria-label="模板主標題"');
    expect(html).toMatch(/data-testid="apply-reference-motion-template" disabled/);
  });
  it("requires an explicit standalone-showcase choice on landscape projects", () => {
    const project = createDemoProject();
    const html = renderToStaticMarkup(<ReferenceMotionTemplateControls clip={project.tracks[0].clips[0]} assets={project.assets} portrait={false} onApply={() => {}} />);
    expect(html).toContain('aria-label="橫式獨立展示"'); expect(html).toContain("長片局部提示保留全尺寸原片");
    expect(html).toMatch(/data-testid="apply-reference-motion-template" disabled/);
  });
});
