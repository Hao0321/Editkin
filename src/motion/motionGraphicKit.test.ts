import { describe, expect, it } from "vitest";
import { applyCommand } from "../domain/commands";
import { createEmptyProject } from "../domain/editGraph";
import { projectSchema } from "../domain/schema";
import type { EditProject, MotionGraphic } from "../domain/types";
import { withReferenceMotionPhysicalFonts } from "../mcp/referenceMotionPhysicalFonts";
import { writeAssContent } from "../render/captionAss";
import { prepareMotionPhysicalLayouts } from "../render/motionPhysicalGlyphLayouts";
import { motionGraphicV2FrameReceipt, motionGraphicV2LayoutReceipt } from "./compositionV2";
import { compileMotionGraphicKit, EDITKIN_BLUE_WHITE, motionGraphicKitTexts, prepareMotionGraphicKit, type MotionKitScene } from "./motionGraphicKit";
import { resolve } from "node:path";

const scene: MotionKitScene = {
  id: "kit", startFrame: 0, durationFrames: 225,
  elements: [
    { kind: "board", at: 0 },
    { kind: "kicker", text: "EDITKIN", x: .07, y: .1, at: .15 },
    { kind: "headline", text: "讓動態，有設計感。", x: .07, y: .16, width: .58, size: 116, at: .3 },
    { kind: "body", text: "快速落定、流暢收尾。", x: .07, y: .35, width: .5, at: .8 },
    { kind: "chip", text: "MOTION", x: .07, y: .45, at: 1 },
    { kind: "bubble", text: "準備開剪了嗎？", x: .64, y: .17, role: "ask", at: 1.4 },
    { kind: "bubble", text: "這次不再死板。", x: .68, y: .3, role: "reply", at: 2 },
    { kind: "card", title: "把點子做成作品", body: "先完成一個小版本。", x: .64, y: .48, width: .29, at: 2.7 },
    { kind: "ripple", x: .87, y: .82, at: 3.3 },
  ],
};

function emptyProject(): EditProject {
  const project = createEmptyProject("Kit", { id: "kit", width: 1920, height: 1080, fps: 30 });
  project.tracks[0].clips = [];
  return project;
}

async function physical() {
  const project = emptyProject();
  const graphics = await withReferenceMotionPhysicalFonts(dependencies => prepareMotionGraphicKit(project, scene, dependencies.prepareText));
  let applied = project;
  for (const graphic of graphics) applied = applyCommand(applied, { type: "add_motion_graphic", graphic });
  return { project: applied, graphics, layouts: await prepareMotionPhysicalLayouts(applied, resolve("public/fonts")) };
}

const byId = (graphics: MotionGraphic[], suffix: string) => graphics.find(graphic => graphic.id.endsWith(suffix))!;

describe("Motion Graphic Kit (native translation of the approved CSS study)", () => {
  it("builds editable back-to-front layers in the Editkin blue-white palette", async () => {
    const { graphics } = await physical();
    expect(graphics.length).toBe(17);
    expect(graphics[0]).toMatchObject({ backgroundColor: EDITKIN_BLUE_WHITE.background, vectorV2: { kind: "panel" } });
    expect(graphics[1].vectorV2?.kind).toBe("line_grid");
    expect(graphics.every(graphic => graphic.presetId === undefined)).toBe(true);
    expect(motionGraphicKitTexts(scene).map(row => row.text)).toContain("把點子做成作品");
  }, 60000);

  it("measures bubbles, chips and cards from the true physical text box", async () => {
    const { project, graphics, layouts } = await physical();
    for (const [panelId, textId] of [["5-bubble:panel", "5-bubble"], ["6-bubble:panel", "6-bubble"], ["4-chip:panel", "4-chip"], ["7-card:panel", "7-card:body"]]) {
      const panel = motionGraphicV2LayoutReceipt(project, byId(graphics, panelId)).box, text = layouts.get(byId(graphics, textId).id)!.box;
      expect(panel.x).toBeLessThanOrEqual(text.x);
      expect(panel.y).toBeLessThanOrEqual(text.y);
      expect(panel.x + panel.width).toBeGreaterThanOrEqual(text.x + text.width);
      expect(panel.y + panel.height).toBeGreaterThanOrEqual(text.y + text.height);
    }
  }, 60000);

  it("aligns kicker, headline and body ink to one left edge", async () => {
    const { graphics, layouts } = await physical();
    const inkLeft = (suffix: string) => { const layout = layouts.get(byId(graphics, suffix).id)!;
      return Math.min(...layout.segments.map(segment => segment.x + segment.outline!.ink!.xMin)); };
    const edges = ["1-kicker", "2-headline", "3-body"].map(inkLeft);
    expect(Math.max(...edges) - Math.min(...edges)).toBeLessThan(14);
  }, 60000);

  it("reopens byte-stable, evaluates every frame and lets the board leave last", async () => {
    const { project, graphics, layouts } = await physical();
    const reopened = projectSchema.parse(JSON.parse(JSON.stringify(project)));
    expect(reopened.motionGraphics).toEqual(project.motionGraphics);
    for (const graphic of project.motionGraphics) for (const frame of [0, 10, 60, 200, 224]) {
      expect(() => motionGraphicV2FrameReceipt(project, graphic, frame, layouts.get(graphic.id) ?? motionGraphicV2LayoutReceipt(project, graphic))).not.toThrow();
    }
    const end = (graphic: MotionGraphic) => Math.round((graphic.timelineStart + graphic.duration) * 30);
    expect(end(graphics[0])).toBe(225);
    expect(Math.max(...graphics.slice(2).map(end))).toBeLessThan(225);
    const ass = writeAssContent(project, project.captionStyle, { physicalLayouts: layouts, requirePhysicalGlyphs: true });
    expect(ass.split("\n").filter(line => line.startsWith("Dialogue:")).length).toBeGreaterThan(1000);
  }, 60000);

  it("fails closed on scenes that cannot be read", () => {
    const project = emptyProject();
    expect(() => compileMotionGraphicKit(project, { ...scene, durationFrames: 20 })).toThrow(/至少 1 秒/);
    expect(() => compileMotionGraphicKit(project, { ...scene, elements: [{ kind: "headline", text: "太晚", x: .1, y: .1, width: .5, at: 7.2 }] })).toThrow(/閱讀時間/);
    expect(() => compileMotionGraphicKit(project, { ...scene, elements: [] })).toThrow(/1–24/);
  });
});
