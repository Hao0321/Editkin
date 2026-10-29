import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedGlyphRun } from "../typography/preparedGlyphRun";
import type { MotionFontSelection } from "../typography/motionFontReadiness";
import { trackedTextFixtureV1 } from "../application/__fixtures__/trackedTextV1.fixture";
import { trackedPhysicalTextFrameV1 } from "../application/trackedTextGeometryV1";

const adapter = vi.hoisted(() => ({ run: undefined as PreparedGlyphRun | undefined, status: "ready", calls: 0 }));
vi.mock("./useMotionFontReadiness", () => ({ useMotionFontReadiness: (selection: MotionFontSelection) => {
  adapter.calls++; return { selectionKey: selection.selectionKey, status: adapter.status, face: selection.face,
    ...(adapter.run ? { glyphRun: adapter.run } : {}), reason: "controlled readiness" };
} }));
import MotionOverlay from "./MotionOverlay";
beforeEach(() => { adapter.run = undefined; adapter.status = "ready"; adapter.calls = 0; });

describe("actual MotionOverlay text tracking route with genuine glyphs and controlled readiness", () => {
  it.each(["anchor", "surface"] as const)("routes %s through shared world contours once, without a second layout transform", async mode => {
    const f = await trackedTextFixtureV1({ mode, text: "B8" }); adapter.run = f.run;
    const frame = trackedPhysicalTextFrameV1(f.p, f.g, f.layout, 6, f.camera(6));
    const html = renderToStaticMarkup(<MotionOverlay project={f.p} playhead={.5} trackingSelectionEnabled={false} />);
    expect(html).toContain('data-testid="motion-tracked-text-v2"'); expect(html).toContain(`data-motion-tracking-mode="${mode}"`);
    expect(html).toContain(`data-motion-font-sha="${f.run.fontSha256}"`); expect(html).toContain('viewBox="0 0 320 180"');
    for (const path of frame.paths) expect(html).toContain(`d="${path.svg}"`);
    expect(html).not.toContain('data-testid="motion-font-blocked"'); expect(html).not.toContain('transform="translate(');
    expect(adapter.calls).toBe(1);
  });
  it("unmounts the tracked label on a lost sample", async () => {
    const f = await trackedTextFixtureV1(); adapter.run = f.run;
    const html = renderToStaticMarkup(<MotionOverlay project={f.p} playhead={1.5} trackingSelectionEnabled={false} />);
    expect(html).not.toContain("motion-tracked-text-v2"); expect(html).not.toContain("motion-glyph-outlines");
  });
  it("keeps the existing visible font boundary for missing/copied physical runs", async () => {
    const f = await trackedTextFixtureV1();
    let html = renderToStaticMarkup(<MotionOverlay project={f.p} playhead={.5} trackingSelectionEnabled={false} />);
    expect(html).toContain('data-testid="motion-font-blocked"'); expect(html).not.toContain('data-testid="motion-tracked-text-v2"');
    adapter.run = { ...f.run }; html = renderToStaticMarkup(<MotionOverlay project={f.p} playhead={.5} trackingSelectionEnabled={false} />);
    expect(html).toContain("not made by this factory"); expect(html).not.toContain('data-testid="motion-tracked-text-v2"');
  });
  it("continues using the unchanged physical glyph component when no tracking is authored", async () => {
    const f = await trackedTextFixtureV1(); delete f.g.vectorTrackingV1; adapter.run = f.run;
    const html = renderToStaticMarkup(<MotionOverlay project={f.p} playhead={.5} trackingSelectionEnabled={false} />);
    expect(html).toContain('data-testid="motion-graphic-v2"'); expect(html).not.toContain("motion-tracked-text-v2");
    expect(html).toContain(`d="${f.layout.segments[0].outline!.svg}"`);
  });
});
