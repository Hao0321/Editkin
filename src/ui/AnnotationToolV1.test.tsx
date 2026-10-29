import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { annotationWorkflowFixtureV1 } from "../application/__fixtures__/annotationWorkflowV1.fixture";
import { ANNOTATION_STYLE_PROPOSAL_V1 } from "../application/annotationDraftV1";
import { createProjectSession } from "../application/projectSession";
import { AnnotationToolV1, type AnnotationLabelsV1, type AnnotationToolPropsV1 } from "./AnnotationToolV1";

function props(language: string): AnnotationToolPropsV1 {
  const project = annotationWorkflowFixtureV1(), keys = ["title", "arrow", "circle", "underline", "tracking", "trackingMode", "none", "anchor", "surface", "apply", "cancel", "help", "preview", "idle", "armed", "drawing", "ready", "applying", "done", "failed", "locked", "source", "trackingError", "stale", "invalid", "unavailable", "uncertain", "artPending"];
  const labels = Object.fromEntries(keys.map(k => [k, `${language} <&> ${k}`])) as unknown as AnnotationLabelsV1;
  return { project, projectSession: createProjectSession(project), labels, target: { clipId: "selected", frame: 60, range: { startFrame: 30, endFrame: 90 }, style: ANNOTATION_STYLE_PROPOSAL_V1,
    purpose: "Synthetic copy control", evidenceRefs: ["synthetic:copy"] }, onPause: () => {} };
}
describe("annotation controls require an actual preview and command owner", () => {
  it.each(["zh-TW", "en", "es", "ja", "ko"])("escapes host %s copy and shows unavailable without hidden apply capability", language => {
    const p = props(language), html = renderToStaticMarkup(<AnnotationToolV1 {...p} />);
    expect(html).toContain(`${language} &lt;&amp;&gt; title`); expect(html).toContain(`${language} &lt;&amp;&gt; unavailable`);
    expect(html.match(/disabled=""/g)).toHaveLength(4); expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain('data-testid="annotation-apply"'); expect(html).not.toContain('data-testid="annotation-overlay"'); expect(p.project.motionGraphics).toHaveLength(0);
  });
  it("only enables drawing when both owners exist and never creates a draft during rendering", () => {
    const p = props("en"); p.onCommand = () => { throw Error("render must not apply"); };
    expect(renderToStaticMarkup(<AnnotationToolV1 {...p} />)).toContain("unavailable");
    p.previewRoot = {} as HTMLElement; const html = renderToStaticMarkup(<AnnotationToolV1 {...p} />);
    expect(html).not.toContain('disabled=""'); expect(html).toContain('data-state="idle"'); expect(html).not.toContain('data-testid="annotation-overlay"');
    expect(p.projectSession.getSnapshot().history.past).toHaveLength(0);
  });
});
