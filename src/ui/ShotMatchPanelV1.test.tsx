import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ShotMatchPanelV1, type ShotMatchLabelsV1 } from "./ShotMatchPanelV1";
import { ShotGradeRegionPickerV1 } from "./ShotGradeRegionPickerV1";

// Label-content verification against the five-language proposal pack is separate.
const fields = "title target reference chooseReference match balance apply cancel discard reload neutral skin clearMarks sample before after append replace nodeLabel nodeName timeout markHelp optionalMarks idle loading analysing ready applying applied unchanged not_applicable held cancelled uncertain unavailable locked aces stale frames destination".split(" ");
const labels = Object.fromEntries(fields.map(name => [name, `Label:${name}`])) as unknown as ShotMatchLabelsV1;
it("renders labelled match, balance, explicit destination and disabled Apply without an injected host", () => {
  const html = renderToStaticMarkup(<ShotMatchPanelV1 getHost={() => undefined} labels={labels}/>);
  expect(html).toContain('aria-label="Label:title"'); expect(html).toContain('data-testid="shot-match-reference-strip"');
  expect(html).toMatch(/disabled=""[^>]*data-testid="shot-match-apply"/); expect(html).toContain("Label:optionalMarks"); expect(html).not.toContain("engine_task_v1");
});
it("renders an exact raster coordinate overlay independently of display preview pixels", () => {
  const frame = { sampleId: "p", timeSeconds: .1, width: 4, height: 2, format: "rgb8" as const, workingSpace: "rec709_display" as const, stage: "clip_working_post_v2" as const, pixels: new Uint8Array(24) };
  const html = renderToStaticMarkup(<ShotGradeRegionPickerV1 frame={frame} contextKey="owned" regions={[{ sampleId: "p", role: "skin", x: .5, y: 0, width: .5, height: 1 }]} role="skin" label="Technical local layer" help="Declared region" onMark={() => undefined}/>);
  expect(html).toContain('width="4" height="2"'); expect(html).toContain('viewBox="0 0 4 2"'); expect(html).toContain('data-role="skin" x="2" y="0" width="2" height="2"');
});
