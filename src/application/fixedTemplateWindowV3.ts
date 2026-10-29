import type { ClipMask, EditProject, TimelineClip } from "../domain/types";
import { fixedTemplateWindowSamplesV3 } from "../domain/fixedTemplateWindowPathV3";
export { FIXED_TEMPLATE_WINDOW_V3_CONTRACT } from "../domain/fixedTemplateWindowV3";

/** Materialized control for per-frame comparisons. Product plans store the compact version marker. */
export function compileFixedTemplateWindowMaskV3(project: EditProject, clip: TimelineClip, mask: ClipMask): ClipMask {
  const keyframes = fixedTemplateWindowSamplesV3(project, clip, mask).map((sample, frame) =>
    ({ ...sample, frame, confidence: 1, status: "manual" as const }));
  const { fixedWindowV3: _compact, ...authored } = structuredClone(mask);
  return { ...authored, keyframes };
}
