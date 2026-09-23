import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LONG_FORM_TEMPLATES } from "../application/longFormTemplates";
import { buildLowerThirdCommand } from "../application/lowerThirds";
import { buildLongFormTemplateCommand } from "../application/longFormTemplates";
import { SHORT_FORM_TEMPLATES } from "../application/shortFormTemplates";
import { applyCommand } from "../domain/commands";
import { createDemoProject } from "../domain/demo";
import ShortFormTemplateBrowser from "./ShortFormTemplateBrowser";

describe("template browser information architecture", () => {
  it("separates short and long formats, exposes purpose categories and keeps lower thirds compact", () => {
    const html = renderToStaticMarkup(<ShortFormTemplateBrowser onApplyShort={() => {}} onApplyLong={() => {}} />);
    expect(html).toContain(`短片 9:16 <b>${SHORT_FORM_TEMPLATES.length}</b>`);
    expect(html).toContain(`長片 16:9 <b>${LONG_FORM_TEMPLATES.length}</b>`);
    expect(html).toContain("人物字幕條");
    expect(html).toContain("單位／職稱 BAR");
    expect(html).toContain("教學");
    expect(html).not.toContain(LONG_FORM_TEMPLATES[0].description);
  });

  it("renders managed bars with explicit deletion instead of trapping overlapping elements", () => {
    const project = createDemoProject();
    const withBars = applyCommand(project, buildLowerThirdCommand(project, {
      presetId: "clean_blue", personName: "王小明", organization: "Editkin", timelineStart: 0,
    }, (prefix) => `${prefix}-test`));
    const html = renderToStaticMarkup(<ShortFormTemplateBrowser onApplyShort={() => {}} onApplyLong={() => {}} motionGraphics={withBars.motionGraphics} onDeleteMotionGraphic={() => {}} />);
    expect(html).toContain("目前可管理的元素");
    expect(html).toContain("刪除 王小明");
    expect(html).toContain("刪除 Editkin");
    expect(html).toContain('maxLength="18"');
    expect(html).toContain('maxLength="28"');
  });

  it("lists every explicitly owned template element and offers honest full rollback", () => {
    let id = 0;
    const source = createDemoProject();
    const project = applyCommand(source, buildLongFormTemplateCommand(source, "hao_tutorial", (prefix) => `${prefix}-${id++}`));
    const html = renderToStaticMarkup(<ShortFormTemplateBrowser
      onApplyShort={() => {}} onApplyLong={() => {}}
      motionGraphics={project.motionGraphics} captions={project.captions} directorMarkers={project.director.markers}
      templateApplication={project.templateApplication} onDeleteMotionGraphic={() => {}} onDeleteCaption={() => {}}
      onDeleteDirectorMarker={() => {}} onClearTemplateApplication={() => {}}
    />);
    expect(html).toContain("已套用：Hao 教學長片");
    expect(html).toContain("8 個圖卡／字幕／註記");
    expect(html).toContain("模板示範字幕");
    expect(html).toContain("節奏註記");
    expect(html).toContain("還原成片模板");
    expect(html).toContain("還原套用前的字幕樣式、調色、特效、轉場與剪輯類型");
  });
});
