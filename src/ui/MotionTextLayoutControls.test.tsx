import { isValidElement, type ReactNode, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import MotionTextLayoutControls from "./MotionTextLayoutControls";
import MotionStudio from "./MotionStudio";
import { createDemoProject } from "../domain/demo";
import { applyCommand } from "../domain/commands";
import { projectSchema } from "../domain/schema";
import { createMotionGraphic } from "../motion/composition";
import { defaultMotionGraphicV2Seed } from "../motion/defaultGraphicSeedsV2";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareGlyphRun } from "../typography/preparedGlyphRun";
import { motionGraphicV2PhysicalLayoutReceipt } from "../motion/compositionV2";

type NumberInput = ReactElement<{ onBlur: (event: { currentTarget: { value: string } }) => void }>;
function input(node: ReactNode, label: string): NumberInput | undefined {
  if (Array.isArray(node)) return node.map(child => input(child, label)).find(Boolean);
  if (!isValidElement<{ children?: ReactNode; "aria-label"?: string }>(node)) return;
  if (node.type === "input" && node.props["aria-label"] === label) return node as NumberInput;
  return input(node.props.children, label);
}

describe("ordinary Motion text canvas controls", () => {
  it("resizes and places the same stored graphic with authentic physical contours and unchanged clocks", async () => {
    let p = createDemoProject(); p.width = 1080; p.height = 1920;
    const g = createMotionGraphic("layout", "title", "AV 12", 0, 3, undefined, defaultMotionGraphicV2Seed("title"));
    g.fontFamily = "Bebas Neue"; g.fontWeight = 400;
    p.motionGraphics = [g, createMotionGraphic("untouched", "card", "OTHER", 1, 2)];
    const spec = bundledFontFaceSpec("EditkinFace-bebas-neue-400");
    const run = await prepareGlyphRun(spec.faceId, g.text, new Uint8Array(await readFile(resolve("public/fonts", spec.fontFile))));
    const before = motionGraphicV2PhysicalLayoutReceipt(p, g, run);
    const update = vi.fn(patch => { p = applyCommand(p, { type: "update_motion_graphic", graphicId: g.id, patch }); });
    for (const [label, value] of [["字級 px", "160"], ["水平位置 %", "15"], ["垂直位置 %", "30"]]) {
      const tree = MotionTextLayoutControls({ graphic: p.motionGraphics[0], onUpdate: update });
      input(tree, `${g.name}${label}`)!.props.onBlur({ currentTarget: { value } });
    }
    const reopened = projectSchema.parse(JSON.parse(JSON.stringify(p))), edited = reopened.motionGraphics[0];
    expect(edited).toEqual({ ...g, fontSize: 160, x: .15, y: .3 });
    expect(reopened.motionGraphics[1]).toEqual(p.motionGraphics[1]);
    const after = motionGraphicV2PhysicalLayoutReceipt(reopened, edited, run);
    expect(after.physicalFont).toEqual(before.physicalFont);
    expect(after.sourceSignature).not.toBe(before.sourceSignature);
    expect(after.fontSize).toBe(160);
    expect(after.box.x).toBeGreaterThan(before.box.x);
    expect(after.box.y).toBeGreaterThan(before.box.y);
    expect(after.segments[0].height).toBeGreaterThan(before.segments[0].height * 2);
    expect(after.segments.every(segment => segment.outline?.svg && segment.outline.ass)).toBe(true);
    expect(update).toHaveBeenCalledTimes(3);
  });
  it("restores empty numeric drafts and bounds committed canvas values", () => {
    const g = createMotionGraphic("bounds", "title", "TITLE", 0, 3, undefined, defaultMotionGraphicV2Seed("title")), update = vi.fn();
    const tree = MotionTextLayoutControls({ graphic: g, onUpdate: update });
    const blank = { value: "" }; input(tree, `${g.name}字級 px`)!.props.onBlur({ currentTarget: blank });
    expect(blank.value).toBe(String(g.fontSize)); expect(update).not.toHaveBeenCalled();
    input(tree, `${g.name}字級 px`)!.props.onBlur({ currentTarget: { value: "2" } });
    input(tree, `${g.name}水平位置 %`)!.props.onBlur({ currentTarget: { value: "103" } });
    expect(update.mock.calls.map(call => call[0])).toEqual([{ fontSize: 32 }, { x: 1 }]);
  });
  it("leaves a valid fractional canvas font unchanged when the draft is unchanged or cancelled", () => {
    const g = createMotionGraphic("fractional", "title", "TITLE", 0, 3, undefined, defaultMotionGraphicV2Seed("title"));
    g.fontSize = 50.6667;
    const update = vi.fn(), tree = MotionTextLayoutControls({ graphic: g, onUpdate: update });
    const originalDraft = { value: String(g.fontSize) };
    input(tree, `${g.name}字級 px`)!.props.onBlur({ currentTarget: originalDraft });
    expect(originalDraft.value).toBe("50.6667"); expect(update).not.toHaveBeenCalled();
  });
  it("keeps direct layout controls out of saved-template, camera-owned and tracked scope", () => {
    const p = createDemoProject(), g = createMotionGraphic("scope", "title", "TITLE", 0, 3, undefined, defaultMotionGraphicV2Seed("title")), noop = () => {};
    const props = { asset: p.assets[0], motionTracks: [], motionGraphics: [g], wave2Presets: [], trackingBusy: false, trackingSelectionActive: false, onBeginMotionTrack: noop, onCorrectMotionTrack: noop, onDeleteMotionTrack: noop, onAddMotionGraphic: noop, onUpdateMotionGraphic: noop, onDeleteMotionGraphic: noop };
    expect(renderToStaticMarkup(MotionStudio(props))).toContain(`${g.name}字級 px`);
    expect(renderToStaticMarkup(MotionStudio({ ...props, managedMotionGraphicIds: [g.id] }))).not.toContain(`${g.name}字級 px`);
    expect(renderToStaticMarkup(MotionStudio({ ...props, motionGraphics: [{ ...g, trackId: "subject" }] }))).not.toContain(`${g.name}字級 px`);
  });
});
