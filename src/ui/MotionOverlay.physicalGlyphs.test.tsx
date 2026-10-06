import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { createMotionGraphic, legacyMotionGraphicSeed } from "../motion/composition";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { motionGraphicV2FrameReceipt, motionGraphicV2PhysicalLayoutReceipt } from "../motion/compositionV2";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareGlyphRun, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import type { MotionFontSelection } from "../typography/motionFontReadiness";
import type { MotionFontConsumerReadiness } from "./useMotionFontReadiness";

const adapter = vi.hoisted(() => ({ run: undefined as PreparedGlyphRun | undefined, status: "pending" as MotionFontConsumerReadiness["status"],
  requests: [] as { selection: MotionFontSelection; priority: string; physical: boolean }[] }));
vi.mock("./useMotionFontReadiness", () => ({ useMotionFontReadiness: (selection: MotionFontSelection, priority: string, options?: { prepareGlyphs?: boolean }) => {
  adapter.requests.push({ selection, priority, physical: options?.prepareGlyphs === true });
  return { selectionKey: selection.selectionKey, status: adapter.status, face: selection.face,
    ...(adapter.run ? { glyphRun: adapter.run } : {}), ...(adapter.status === "ready" ? {} : { reason: "controlled unready font" }) };
} }));
import MotionOverlay from "./MotionOverlay";

let run: PreparedGlyphRun;
beforeAll(async () => { const faceId = "EditkinFace-bebas-neue-400", spec = bundledFontFaceSpec(faceId);
  run = await prepareGlyphRun(faceId, "AV 12", new Uint8Array(await readFile(resolve("public/fonts", spec.fontFile)))); });
beforeEach(() => { adapter.run = undefined; adapter.status = "pending"; adapter.requests.length = 0; });
function fixture() {
  const project = createEmptyProject("physical preview", { width: 1920, height: 1080, fps: 30 });
  const graphic = createMotionGraphic("physical-preview", "title", "AV 12", 0, 3, undefined, findMotionGraphicPreset("v2-word-cascade").seed);
  graphic.fontFamily = "Bebas Neue"; graphic.fontWeight = 400; graphic.shadowDepth = 0; graphic.backgroundColor = "#00000000";
  project.motionGraphics = [graphic]; return { project, graphic };
}
const markup = (project: ReturnType<typeof createEmptyProject>, playhead = .2) => renderToStaticMarkup(<MotionOverlay project={project} playhead={playhead} trackingSelectionEnabled={false} />);

describe("actual MotionOverlay physical SVG connection (authentic run, controlled readiness; no mounted/pixel proof)", () => {
  it("draws the exact receipt outlines using the unchanged frame evaluator's segment-local transforms", () => {
    const { project, graphic } = fixture(); adapter.run = run; adapter.status = "ready";
    const layout = motionGraphicV2PhysicalLayoutReceipt(project, graphic, run), frame = motionGraphicV2FrameReceipt(project, graphic, 6, layout), html = markup(project);
    expect(html).toContain(`data-motion-layout-receipt="${layout.receiptId}"`); expect(html).toContain(`data-motion-font-sha="${run.fontSha256}"`);
    expect(html).toContain('data-motion-glyph-source="physical-outline"'); expect(html).not.toContain("<span"); expect(html).not.toContain("font-family:");
    for (const segment of layout.segments) {
      const state = frame.segments.find(item => item.segmentId === segment.id)!;
      expect(html).toContain(`d="${segment.outline!.svg}"`);
      expect(html).toContain(`transform="translate(${segment.x - layout.box.x + state.translateXPixels} ${segment.y - layout.box.y + state.translateYPixels}) scale(${state.scale})"`);
    }
    expect(adapter.requests).toHaveLength(1); expect(adapter.requests[0]).toMatchObject({ physical: true, priority: "current" });
    expect(html).toContain('fill-rule="nonzero"');
  });

  it.each(["pending", "blocked", "unverified", "unobserved", "not-required"] as const)("blocks %s text without estimated spans or outline fallback", status => {
    const { project } = fixture(); adapter.status = status; const html = markup(project);
    expect(html).toContain('data-testid="motion-font-blocked"'); expect(html).not.toContain('data-testid="motion-glyph-outlines"'); expect(html).not.toContain("<span style=");
  });

  it("does not render contours from registration/readiness alone or a copied run", () => {
    const { project } = fixture(); adapter.status = "ready";
    expect(markup(project)).toContain("尚未準備實體 glyph 輪廓");
    adapter.run = { ...run }; const html = markup(project);
    expect(html).toContain("not made by this factory"); expect(html).not.toContain('data-testid="motion-glyph-outlines"');
  });

  it("refuses stale text/face identities and a physical safe-area overflow", () => {
    const { project, graphic } = fixture(); adapter.run = run; adapter.status = "ready";
    graphic.text = "CHANGED"; expect(markup(project)).toContain("當前文字不一致");
    graphic.text = "AV 12"; graphic.fontFamily = "Fredoka"; expect(markup(project)).toContain('data-testid="motion-font-blocked"');
    graphic.fontFamily = "Bebas Neue"; graphic.width = .02; graphic.fontSize = 72;
    graphic.layoutV2 = { ...graphic.layoutV2!, minFontSize: 72, maxLines: 1 };
    const html = markup(project); expect(html).toContain('data-testid="motion-font-blocked"'); expect(html).not.toContain('data-testid="motion-glyph-outlines"');
  });

  it("prepares in the five-second lookahead, promotes current text, and unmounts outside the range", () => {
    const { project, graphic } = fixture(); graphic.timelineStart = 5;
    expect(markup(project, 0)).toBe(""); expect(adapter.requests[0]).toMatchObject({ physical: true, priority: "lookahead" });
    adapter.requests.length = 0; expect(markup(project, 5.2)).toContain('data-testid="motion-font-blocked"'); expect(adapter.requests[0].priority).toBe("current");
    adapter.requests.length = 0; graphic.timelineStart = 6; expect(markup(project, 0)).toBe(""); expect(adapter.requests).toHaveLength(0);
  });

  it("preserves the declared background layer and never requests glyphs for vectors or v1 text", () => {
    const { project, graphic } = fixture(); graphic.compositeLayer = "background"; adapter.status = "ready"; adapter.run = run;
    expect(markup(project)).toContain('data-motion-composite-layer="background"'); expect(markup(project)).toContain("z-index:0");
    adapter.requests.length = 0; project.motionGraphics = [createMotionGraphic("vector", "card", "", 0, 3, undefined, findMotionGraphicPreset("reel_native_disc").seed)];
    expect(markup(project)).toContain('data-testid="motion-vector-v2"'); expect(adapter.requests).toHaveLength(0);
    adapter.run = undefined; adapter.status = "unobserved"; project.motionGraphics = [createMotionGraphic("legacy", "title", "LEGACY", 0, 3, undefined, legacyMotionGraphicSeed("title"))];
    const legacy = markup(project); expect(legacy).toContain("LEGACY"); expect(legacy).toContain("<span"); expect(adapter.requests[0].physical).toBe(false);
  });
});
