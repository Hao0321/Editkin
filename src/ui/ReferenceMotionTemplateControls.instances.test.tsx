import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import ReferenceMotionTemplateControls from "./ReferenceMotionTemplateControls";
import { bundledFontFamilies } from "../typography/fontFaces";

describe("saved-instance creation controls", () => {
  it("offers real compiled heading and body families for initial instance creation", () => {
    const project = createDemoProject(), html = renderToStaticMarkup(<ReferenceMotionTemplateControls clip={project.tracks[0].clips[0]} assets={project.assets} portrait onApply={() => {}} />);
    expect(html).toContain('aria-label="模板標題字型"'); expect(html).toContain('aria-label="模板內文字型"');
    for (const family of bundledFontFamilies()) expect(html).toContain(family);
    expect(html).toContain("建立可儲存 Motion 模板");
  });
  it("blocks draft changes during preparation and renders a separate enabled cancellation control", () => {
    const project = createDemoProject(), html = renderToStaticMarkup(<ReferenceMotionTemplateControls clip={project.tracks[0].clips[0]} assets={project.assets} portrait busy onCancel={() => {}} />);
    expect(html).toMatch(/<fieldset[^>]*disabled/);
    expect(html).toMatch(/<\/fieldset>[\s\S]*data-testid="cancel-reference-motion-template"/);
    expect(/<button[^>]*data-testid="cancel-reference-motion-template"[^>]*>/.exec(html)?.[0]).not.toContain("disabled");
  });
});
