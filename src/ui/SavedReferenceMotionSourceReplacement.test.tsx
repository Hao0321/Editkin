import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { createProjectSession } from "../application/projectSession";
import { referenceMotionInstanceSchema } from "../domain/referenceMotionInstance";
import { DEFAULT_REFERENCE_MOTION_STYLE } from "../motion/referenceMotionTemplates";
import { SavedReferenceMotionSourceReplacement, ReferenceMotionSourceClipControl } from "./SavedReferenceMotionSourceReplacement";

function fixture() {
  const project = createDemoProject(), clip = project.tracks[0].clips[0]; clip.volume = 0; clip.duration = 8; project.assets[0].duration = 30;
  const instance = referenceMotionInstanceSchema.parse({ schema: "editkin.reference-motion-instance/v1", id: "owner", instanceRevision: 1, authoringGeneration: 2,
    input: { templateId: "level_bridge", overlayPresentation: "source_editorial_v1", clipId: clip.id, startFrame: 0, durationFrames: 240, title: "Owned title", sources: [],
      style: structuredClone(DEFAULT_REFERENCE_MOTION_STYLE), intent: "shortform", purpose: "SSR controls only", evidenceRefs: ["synthetic:ui"],
      focusRegion: { x: .1, y: .1, width: .5, height: .5 }, textRegion: { x: .1, y: .1, width: .5, height: .5 } },
    frameFormat: { width: project.width, height: project.height, fps: project.fps }, primaryBefore: { layout: null }, roles: [{ key: "heading", kind: "graphic", id: "synthetic-heading" }],
    dependencies: { recipeVersion: "synthetic", fonts: [], presetHashes: [] }, appliedScopeSha256: "1".repeat(64) });
  project.referenceMotionInstances = [instance];
  return { project, instance, clip, session: createProjectSession(project), busy: false, onReplace: vi.fn(), onCancel: vi.fn() };
}
describe("single source-replacement form shared by the manager and Inspector", () => {
  it("starts muted, clears saved regions and requires an explicit fresh selection confirmation", () => {
    const f = fixture(), html = renderToStaticMarkup(<SavedReferenceMotionSourceReplacement {...f} inspection={{ status: "CURRENT", reason: "Structural SSR control only" }} />);
    expect(html).toContain('data-testid="replace-template-source" disabled=""');
    expect(html).toContain('<option value="mute" selected="">');
    expect(html).toContain("沿用原本的文字位置"); expect(html).toContain("影格率未知");
    expect(html).not.toContain('type="checkbox" checked=""'); expect(f.onReplace).not.toHaveBeenCalled();
  });
  it("makes a manually edited template read-only and offers the honest detach fallback", () => {
    const f = fixture(), html = renderToStaticMarkup(<SavedReferenceMotionSourceReplacement {...f} inspection={{ status: "EDITED", reason: "Manually changed" }} />);
    expect(html).toContain('<fieldset disabled=""'); expect(html).toContain("解除模板連結");
  });
  it("routes only a managed clip to this form and leaves ordinary replacement to the host", () => {
    const f = fixture();
    expect(renderToStaticMarkup(<ReferenceMotionSourceClipControl {...f} clipId={f.clip.id} />)).toContain('data-testid="saved-template-source-replacement"');
    expect(renderToStaticMarkup(<ReferenceMotionSourceClipControl {...f} clipId="other" />)).toBe("");
  });
});
