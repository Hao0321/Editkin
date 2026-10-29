import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { annotationWorkflowFixtureV1 } from "../application/__fixtures__/annotationWorkflowV1.fixture";
import { ANNOTATION_STYLE_PROPOSAL_V1 } from "../application/annotationDraftV1";
import { createAnnotationInteractionV1 } from "../application/annotationInteractionV1";
import { createProjectSession } from "../application/projectSession";
import { AnnotationPreviewOverlayV1 } from "./AnnotationPreviewOverlayV1";

describe("preview authoring guide uses original compiled stroke-fill paths", () => {
  it.each(["arrow", "circle", "underline"] as const)("renders the original %s guide at its exact box origin without editing", kind => {
    const project = annotationWorkflowFixtureV1(), session = createProjectSession(project), owner = {};
    const driver = createAnnotationInteractionV1({ read: () => ({ project, projectSession: session, hostReady: true, commandOwner: owner,
      target: { clipId: "selected", frame: 60, range: { startFrame: 30, endFrame: 90 }, style: ANNOTATION_STYLE_PROPOSAL_V1, purpose: "Synthetic preview", evidenceRefs: ["synthetic:preview"] } }),
      apply: () => { throw Error("SSR does not apply"); }, makeId: () => "guide", name: () => "Guide", onPause: () => {} });
    driver.arm(kind); driver.begin({ x: 80, y: 60 }, 1); driver.finish({ x: 240, y: 180 }, 1);
    const state = driver.getState(), box = state.draft!.guide.box;
    const html = renderToStaticMarkup(<AnnotationPreviewOverlayV1 driver={driver} state={state} width={320} height={240} label="Preview <&>" />);
    expect(html).toContain('viewBox="0 0 320 240"'); expect(html).toContain('preserveAspectRatio="xMidYMid meet"'); expect(html).toContain('tabindex="0"');
    expect(html).toContain(`translate(${box.x} ${box.y})`); expect(html).toContain("Preview &lt;&amp;&gt;");
    for (const path of state.draft!.guide.paths) expect(html).toContain(path.svg);
    expect(session.getSnapshot().history.past).toHaveLength(0); expect(project.motionGraphics).toHaveLength(0);
  });
});
