import { describe, expect, it } from "vitest";
import { trackedTextFixtureV1 } from "../application/__fixtures__/trackedTextV1.fixture";
import { trackedPhysicalTextFrameV1 } from "../application/trackedTextGeometryV1";
import { trackedTextAssFrameV1 } from "./trackedTextAssV1";
import { assMotionFrameTime, writeAssContent } from "./captionAss";
import { commonVideoMotionGraphicsSupported } from "./gpuCompositorAdmission";
import { buildEngineRenderGraph } from "./engineGraph";
import { prepareMotionNativePaintForRender } from "./motionPhysicalGlyphLayouts";

const seconds = (s: string) => { const [h, m, v] = s.split(":").map(Number); return h * 3600 + m * 60 + v; };
function draws(ass: string, frame: number, fps: number) {
  const time = seconds(assMotionFrameTime(frame, fps));
  return ass.split("\n").flatMap(line => {
    const m = /^Dialogue: (\d+),([^,]+),([^,]+),Motion,,0,0,0,,(.*)$/.exec(line.replace(/\r$/, ""));
    return m && seconds(m[2]) <= time && seconds(m[3]) > time ? [{ layer: Number(m[1]), body: m[4] }] : [];
  });
}
describe("physical tracked text formal ASS consumer", () => {
  it.each(["anchor", "surface"] as const)("writes the exact shared %s contours on every frame and skips lost frames", async mode => {
    const f = await trackedTextFixtureV1({ mode, text: "B8" });
    const ass = writeAssContent(f.p, f.p.captionStyle, { requirePhysicalGlyphs: true, physicalLayouts: new Map([[f.g.id, f.layout]]) });
    for (let frame = 0; frame < 24; frame++) {
      const expected = trackedTextAssFrameV1(f.p, f.g, f.layout, frame, f.camera(frame)).map(({ layer, body }) => ({ layer, body }));
      expect(draws(ass, frame, f.p.fps)).toEqual(expected);
      const geometry = trackedPhysicalTextFrameV1(f.p, f.g, f.layout, frame, f.camera(frame));
      for (const p of geometry.paths) expect(expected.some(e => e.body.includes(p.ass))).toBe(true);
      if (frame >= 18) expect(expected).toEqual([]);
    }
    expect(new Set(Array.from({ length: 13 }, (_, frame) => draws(ass, frame, f.p.fps)[0].body)).size).toBe(13);
    expect(ass).toContain(`; MotionPhysicalGlyph: ${f.g.id},${f.layout.physicalFont!.faceId},${f.run.fontSha256}`);
    expect(ass).toContain("\\pos(0,0)\\fscx100\\fscy100"); expect(ass).not.toContain(`}${f.g.text}`);
  });
  it("keeps panels, shadows and path layers in the same order as SVG", async () => {
    const f = await trackedTextFixtureV1({ edit: (_p, g) => { g.backgroundColor = "#112233DD"; g.outlineWidth = 2; g.shadowDepth = 2; g.shadowBlurPixels = 1.5; } });
    const geometry = trackedPhysicalTextFrameV1(f.p, f.g, f.layout, 6, f.camera(6)), ass = trackedTextAssFrameV1(f.p, f.g, f.layout, 6, f.camera(6));
    expect(ass.map(p => p.layer)).toEqual(geometry.paths.map(p => p.layer));
    expect(ass.map(p => p.slot)).toEqual([0, 1, 2, 3]); expect(ass[2].body).toContain("\\blur1.5");
  });
  it("refuses estimated export layouts even when the generic writer permits legacy estimates", async () => {
    const f = await trackedTextFixtureV1(); expect(() => writeAssContent(f.p, f.p.captionStyle)).toThrow("PHYSICAL_LAYOUT_REQUIRED");
  });
  it.each(["anchor", "surface"] as const)("keeps native %s text unsupported and never silently drops the binding", async mode => {
    const f = await trackedTextFixtureV1({ mode }); expect(commonVideoMotionGraphicsSupported(f.p)).toBe(false);
    expect(() => buildEngineRenderGraph(f.p)).toThrow("原生 GPU graph 尚未支援 hao.motion-composition/v2");
    await expect(prepareMotionNativePaintForRender(f.p, "public/fonts")).rejects.toThrow("Native paint");
    expect(f.g.vectorTrackingV1!.mode).toBe(mode);
  });
});
