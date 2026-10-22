import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { createProjectSession } from "../application/projectSession";
import { ValueParticlesPanelV1, type ValueParticlesLabelsV1, type ValueParticlesPanelPropsV1 } from "./ValueParticlesPanelV1";
function fixture(language: string): ValueParticlesPanelPropsV1 {
  const p = createEmptyProject("Panel copy", { width: 64, height: 40, fps: 24 });
  p.tracks[0].clips = [{ id: "selected" } as never];
  const keys = ["title", "source", "material", "manual", "amount", "confirmation", "note", "add", "cancel", "idle", "applying", "done", "cancelled", "failed", "uncertain", "unavailable", "locked", "artPending", "help"];
  return { project: p, projectSession: createProjectSession(p), clipId: "selected", range: { startFrame: 0, endFrame: 12 }, operationId: "copy", createdAt: p.updatedAt,
    parameters: { seed: 37, ratePerSecond: 24, lifetimeSeconds: .3, maxParticles: 12, emitterPosition: [.5, .5], initialVelocity: [0, -20], gravity: [0, 40], radiusPixels: 2, color: [1, 1, 1, 1] },
    labels: Object.fromEntries(keys.map(k => [k, `${language} <&> ${k}`])) as unknown as ValueParticlesLabelsV1 };
}
describe("manual value source panel explicit provenance and capability", () => {
  it.each(["zh", "en", "es", "ja", "ko"])("escapes %s copy and keeps an unavailable host disabled", language => {
    const f = fixture(language), html = renderToStaticMarkup(<ValueParticlesPanelV1 {...f} />);
    expect(html).toContain(`${language} &lt;&amp;&gt; title`); expect(html).toContain(`${language} &lt;&amp;&gt; unavailable`);
    expect(html).toContain('data-testid="value-confirm"'); expect(html.match(/<button\b[^>]*data-testid="value-add"[^>]*>/u)?.[0]).toContain('disabled=""'); expect(html).toContain('aria-live="polite"');
    expect(f.projectSession.getSnapshot().history.past).toHaveLength(0);
  });
  it("presents an existing material quote without silently requiring a manual assertion", () => {
    const f = fixture("en"); f.evidence = { materialId: "a".repeat(64), semanticReceiptSha256: "b".repeat(64), segmentIndex: 0, cueIndex: 0, quotedValue: "12000元" };
    f.onApply = async () => { throw Error("Render must not apply"); }; const html = renderToStaticMarkup(<ValueParticlesPanelV1 {...f} />);
    expect(html).toContain('data-testid="value-evidence-amount">12000元'); expect(html).not.toContain('data-testid="value-confirm"');
    expect(html.match(/<button\b[^>]*data-testid="value-add"[^>]*>/u)?.[0]).not.toContain('disabled=""'); expect(f.projectSession.getSnapshot().history.past).toHaveLength(0);
  });
  it("shows locked provenance context without enabling an existing host", () => {
    const f = fixture("en"); f.project.tracks[0].locked = true; f.onApply = async () => ({ status: "applied" });
    const html = renderToStaticMarkup(<ValueParticlesPanelV1 {...f} />); expect(html.match(/<button\b[^>]*data-testid="value-add"[^>]*>/u)?.[0]).toContain('disabled=""'); expect(html).toContain("en &lt;&amp;&gt; locked");
  });
});
