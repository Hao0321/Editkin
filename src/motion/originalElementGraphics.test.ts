import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { applyCommand } from "../domain/commands";
import { createEmptyProject } from "../domain/editGraph";
import { projectSchema } from "../domain/schema";
import type { EditProject } from "../domain/types";
import { ORIGINAL_ELEMENTS, buildOriginalElement, defaultOriginalElementConfig, type ElementMeasure, type OriginalElementConfig } from "../creative/originalElements";
import { withReferenceMotionPhysicalFonts } from "../mcp/referenceMotionPhysicalFonts";
import { prepareMotionPhysicalLayouts } from "../render/motionPhysicalGlyphLayouts";
import { motionGraphicV2FrameReceipt, motionGraphicV2LayoutReceipt } from "./compositionV2";
import { isOriginalElementEffect, originalElementHoldSeconds, originalElementTimeline, prepareOriginalElementGraphics } from "./originalElementGraphics";

/** Deterministic stand-in so the port can be compared with the source module byte for byte. */
const fakeMeasure = ((text: string, size: number) => [...text].length * size * .92) as unknown as ElementMeasure;
fakeMeasure.bounds = (text, size) => ({ left: size * .02, right: [...text].length * size * .9, ascent: size * .86, descent: size * .2 });

// Byte-level fidelity against the research source runs outside vitest (its file
// lives outside the project root): scripts/check-original-elements-port.ts.

function config(id: OriginalElementConfig["id"], aspect: "landscape" | "portrait" = "landscape"): OriginalElementConfig {
  return { ...defaultOriginalElementConfig(id), aspect };
}

describe("Original Elements (Collection 01) port", () => {
  it("keeps the source's copy, contrast and reading rules", () => {
    expect(() => buildOriginalElement({ ...config("keyword-sticker"), title: "一".repeat(25) }, fakeMeasure)).toThrow(/最多 24 字/);
    expect(() => buildOriginalElement({ ...config("keyword-sticker"), colors: { primary: "#F4F4F0" } }, fakeMeasure)).toThrow();
    expect(() => buildOriginalElement({ ...config("step-path"), detail: "只有兩項／不夠" }, fakeMeasure)).toThrow(/三個重點/);
    expect(originalElementHoldSeconds(config("keyword-sticker"))).toBeGreaterThan(1.6);
  });
});

async function nativeElement(id: OriginalElementConfig["id"], width = 1920, height = 1080, mode: OriginalElementConfig["mode"] = "scene", finish = true) {
  let project: EditProject = createEmptyProject("Elements", { id: `oe-${id}`, width, height, fps: 30 });
  project.tracks[0].clips = [];
  const element = { ...config(id, height > width ? "portrait" : "landscape"), mode };
  const durationFrames = Math.ceil((originalElementHoldSeconds(element) + .94) * 30);
  element.duration = durationFrames / 30;
  if (element.target) element.target.visibleTo = element.duration;
  const graphics = await withReferenceMotionPhysicalFonts(dependencies => prepareOriginalElementGraphics(project, element, { startFrame: 0, durationFrames }, dependencies.prepareText, { finish }));
  for (const graphic of graphics) project = applyCommand(project, { type: "add_motion_graphic", graphic });
  return { project, graphics, durationFrames, layouts: await prepareMotionPhysicalLayouts(project, resolve("public/fonts")) };
}

describe("native Original Element graphics", () => {
  it("compiles all eight elements into valid editable layers that exit together", async () => {
    for (const element of ORIGINAL_ELEMENTS) {
      const { project, graphics, durationFrames, layouts } = await nativeElement(element.id);
      expect(graphics.some(graphic => graphic.vectorV2?.kind === "shape")).toBe(true);
      expect(graphics.some(graphic => !graphic.vectorV2)).toBe(true);
      const lasting = graphics.filter(graphic => !isOriginalElementEffect(graphic)), effects = graphics.filter(isOriginalElementEffect);
      const ends = new Set(lasting.map(graphic => Math.round((graphic.timelineStart + graphic.duration) * 30)));
      expect([...ends]).toEqual([durationFrames]);
      // One-shot effects play out before the element's exit begins.
      const exitFrames = lasting[0].motionV2!.exit.durationFrames;
      expect(effects.length).toBeGreaterThan(0);
      for (const effect of effects) expect(Math.round((effect.timelineStart + effect.duration) * 30)).toBeLessThanOrEqual(durationFrames - exitFrames);
      // Staged, not simultaneous — and the finished layout still holds long enough to read.
      const timeline = originalElementTimeline(graphics, 30);
      expect(timeline.buildSeconds).toBeGreaterThan(.6);
      expect(timeline.holdAfterBuildSeconds).toBeGreaterThanOrEqual(.85);
      for (const graphic of project.motionGraphics) for (const frame of [0, 6, 20, durationFrames - 10, durationFrames - 1]) {
        expect(() => motionGraphicV2FrameReceipt(project, graphic, frame, layouts.get(graphic.id) ?? motionGraphicV2LayoutReceipt(project, graphic))).not.toThrow();
      }
      expect(projectSchema.parse(JSON.parse(JSON.stringify(project))).motionGraphics).toEqual(project.motionGraphics);
    }
  }, 120000);

  it("lands every text baseline where the design draws it", async () => {
    const { project, layouts } = await nativeElement("conversation-bubble");
    const ir = buildOriginalElement({ ...config("conversation-bubble"), duration: 6 }, fakeMeasure);
    expect(ir.shapes.some(shape => shape.type === "text")).toBe(true);
    for (const graphic of project.motionGraphics.filter(item => !item.vectorV2)) {
      const segment = layouts.get(graphic.id)!.segments[0];
      expect(Number.isFinite(segment.x)).toBe(true);
      expect(segment.y + segment.baselinePixels!).toBeGreaterThan(0);
    }
  }, 60000);

  it("builds in staged beats instead of landing every layer at once", async () => {
    const frame = (graphic: { timelineStart: number }) => Math.round(graphic.timelineStart * 30);
    const ticket = (await nativeElement("chapter-ticket")).graphics;
    const starts = ticket.map(frame);
    expect(new Set(starts).size).toBeGreaterThanOrEqual(10);
    expect(Math.max(...starts) - Math.min(...starts)).toBeGreaterThanOrEqual(15);
    // Perforations are separate layers that pop one after another.
    const stitches = ticket.filter(graphic => graphic.id.endsWith(":stitch")).map(frame);
    expect(stitches.length).toBeGreaterThanOrEqual(10);
    expect(stitches).toEqual([...stitches].sort((a, b) => a - b));
    expect(stitches.at(-1)!).toBeGreaterThan(stitches[0]);
    // Grid lines draw on individually with a wipe from their leading edge.
    const grid = ticket.filter(graphic => graphic.id.endsWith(":background:grid"));
    expect(grid.length).toBeGreaterThanOrEqual(6);
    for (const line of grid) expect(line.vectorV2).toMatchObject({ kind: "shape", revealFrom: expect.stringMatching(/^(top|left)$/) });
    expect(grid.every(line => line.vectorV2!.kind === "shape" && line.vectorV2!.revealFrames > 1)).toBe(true);

    const sticker = (await nativeElement("keyword-sticker")).graphics;
    const plate = sticker.find(graphic => /:\d+:plate$/.test(graphic.id))!, shadow = sticker.find(graphic => graphic.id.endsWith(":plate:shadow"))!;
    expect(plate.vectorV2).toMatchObject({ kind: "shape", revealFrom: "left" });
    // The hard shadow slides out from behind the plate after it lands.
    expect(frame(shadow)).toBeGreaterThan(frame(plate));
    expect(shadow.motionV2!.entrance.offsetXPixels).toBeLessThan(0);
    const headline = Math.min(...sticker.filter(graphic => /:headline:title$/.test(graphic.id)).map(frame));
    const detail = Math.min(...sticker.filter(graphic => /:\d+:detail$/.test(graphic.id) && graphic.text).map(frame));
    expect(headline).toBeLessThan(detail);
  }, 60000);

  it("adds the studio finish on top of the authored design, and can leave it out", async () => {
    const { graphics } = await nativeElement("keyword-sticker");
    for (const suffix of [":plate:lead", ":fx:fx-shine", ":fx:fx-burst", ":detail:quote-bar"]) expect(graphics.some(graphic => graphic.id.endsWith(suffix))).toBe(true);
    // The glint sweeps from one side of the plate to the other without leaving it.
    const shine = graphics.find(graphic => graphic.id.endsWith(":fx-shine"))!, plate = graphics.find(graphic => /:\d+:plate$/.test(graphic.id))!;
    expect(shine.x * 1920 + shine.motionV2!.entrance.offsetXPixels).toBeGreaterThanOrEqual(plate.x * 1920);
    expect((shine.x + shine.width) * 1920 + shine.motionV2!.exit.offsetXPixels).toBeLessThanOrEqual((plate.x + plate.width) * 1920 + .01);
    expect(shine.backgroundColor).toMatch(/^#FFFFFF[0-9A-F]{2}$/);
    // The accent lead runs ahead of the plate it sits under.
    const lead = graphics.find(graphic => graphic.id.endsWith(":plate:lead"))!;
    expect(lead.timelineStart).toBeLessThan(plate.timelineStart);
    const classic = (await nativeElement("keyword-sticker", 1920, 1080, "scene", false)).graphics;
    expect(classic.some(isOriginalElementEffect)).toBe(false);
    expect(classic.some(graphic => graphic.id.endsWith(":plate:lead"))).toBe(false);
    expect(classic.length).toBeLessThan(graphics.length);
    // Step paths get a progress rail whose packets ride each fill segment.
    const steps = (await nativeElement("step-path")).graphics;
    expect(steps.filter(graphic => graphic.id.endsWith(":rail:rail-fill"))).toHaveLength(3);
    expect(steps.filter(graphic => graphic.id.endsWith(":fx:fx-packet"))).toHaveLength(3);
  }, 60000);

  it("places overlay elements with the authored group transform, without a paper ground", async () => {
    const plate = (graphics: Awaited<ReturnType<typeof nativeElement>>["graphics"]) => graphics.find(graphic => /:\d+:plate$/.test(graphic.id))!;
    const scene = (await nativeElement("keyword-sticker")).graphics, overlay = (await nativeElement("keyword-sticker", 1920, 1080, "overlay")).graphics;
    // Landscape overlay is translate(288 70) scale(.70) in the design.
    expect(plate(overlay).width).toBeCloseTo(plate(scene).width * .7, 3);
    expect(plate(overlay).x * 1920).toBeCloseTo(288 + plate(scene).x * 1920 * .7, 0);
    expect(overlay.some(graphic => graphic.id.endsWith(":background:paper"))).toBe(false);
    expect(scene.some(graphic => graphic.id.endsWith(":background:paper"))).toBe(true);
    const portrait = (await nativeElement("reaction-seal", 1080, 1920, "overlay")).graphics;
    expect(portrait.length).toBeGreaterThan(5);
  }, 60000);

  it("reflows natively for portrait instead of stretching", async () => {
    const { project } = await nativeElement("recap-strip", 1080, 1920);
    const rows = project.motionGraphics.filter(graphic => graphic.vectorV2?.kind === "shape" && graphic.id.includes(":row:"));
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...rows.map(row => row.y)) - Math.min(...rows.map(row => row.y))).toBeGreaterThan(.2);
  }, 60000);
});
