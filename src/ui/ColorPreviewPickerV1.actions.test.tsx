import { createHash } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ColorPreviewPickerV1 } from "./ColorPreviewPickerV1";

it("keeps the original picker default HTML byte-exact when the new action option is omitted",()=>{
  const getRoot=vi.fn(()=>null),html=renderToStaticMarkup(createElement(ColorPreviewPickerV1,{getRoot,contextKey:"baseline",expected:{pipelineKey:"source",primaryKey:"neutral"}}));
  // Captured from the actual unchanged component before this wave's optional bridge.
  expect(createHash("sha256").update(html).digest("hex")).toBe("2d91169a27be086d8f56c64270279f2a95fbd9a6e53159e1e88ad511477a92da");
  expect(html).not.toContain("eyedropper-neutral-action");expect(html).not.toContain("eyedropper-hsl-action");expect(getRoot).not.toHaveBeenCalled();
});
