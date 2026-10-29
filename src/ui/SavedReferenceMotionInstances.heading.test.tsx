import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { referenceMotionInstanceSchema } from "../domain/referenceMotionInstance";
import { DEFAULT_REFERENCE_MOTION_STYLE, referenceMotionTemplate } from "../motion/referenceMotionTemplates";
import { interfacePreferences } from "./i18n/interfacePreferences";
import { referenceMotionInstanceDraft, SavedReferenceMotionInstanceForm } from "./SavedReferenceMotionInstances";

// Real React static rendering of the template editor form, in each interface mode.
function saved(instanceRevision: number) {
  return referenceMotionInstanceSchema.parse({ schema: "editkin.reference-motion-instance/v1", id: "saved-template", authoringGeneration: 2, instanceRevision,
    input: { templateId: "context_stack", clipId: "clip-demo", startFrame: 15, durationFrames: 300, title: "Own title", kicker: "Own kicker",
      items: [{ label: "A" }, { label: "B" }], sources: [], intent: "standalone_showcase", purpose: "Own authored message",
      evidenceRefs: ["manual:motion-template-input"], style: structuredClone(DEFAULT_REFERENCE_MOTION_STYLE) },
    frameFormat: { width: 1920, height: 1080, fps: 30 }, roles: [{ key: "heading", kind: "graphic", id: "owned-heading" }],
    primaryBefore: { layout: null }, appliedScopeSha256: "1".repeat(64), dependencies: { recipeVersion: "fixture-ui-only", presetHashes: [], fonts: [] } });
}
function heading(instanceRevision: number) {
  const instance = saved(instanceRevision);
  const html = renderToStaticMarkup(<SavedReferenceMotionInstanceForm instance={instance} assets={[]} inspection={{ status: "CURRENT", reason: "fixture" }}
    draft={referenceMotionInstanceDraft(instance)} onDraftChange={vi.fn()} busy={false} onRevise={vi.fn()} onDetach={vi.fn()} onCancel={vi.fn()} />);
  const match = /<h3 data-testid="saved-template-heading"(?: title="([^"]*)")?>([^<]*)<\/h3>/.exec(html);
  return { html, title: match?.[1], text: match?.[2] };
}
afterEach(() => { interfacePreferences.setMode("simple"); });

describe("the title template editor's heading", () => {
  it("shows only the template's name in simple mode: no version number anywhere", () => {
    interfacePreferences.setMode("simple");
    const shown = heading(7);
    expect(shown.text).toBe(referenceMotionTemplate("context_stack").name);
    expect(shown.title).toBeUndefined();
    expect(shown.html).not.toContain("版本");
    // Support still finds the saved version on the form itself.
    expect(shown.html).toContain('data-instance-revision="7"');
  });

  it("keeps the version in the heading's tooltip in advanced mode, out of the heading text", () => {
    interfacePreferences.setMode("advanced");
    const shown = heading(7);
    expect(shown.text).toBe(referenceMotionTemplate("context_stack").name);
    expect(shown.title).toBe("版本 7");
  });
});
