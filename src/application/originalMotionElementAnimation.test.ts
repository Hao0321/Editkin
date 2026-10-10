import { beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createEmptyProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import type { EditProject, MotionGraphic, MotionGraphicV2Motion } from "../domain/types";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareGlyphRun, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { motionGraphicV2FrameReceipt, motionGraphicV2LayoutReceipt, motionGraphicV2PhysicalLayoutReceipt,
  type MotionGraphicV2LayoutReceipt } from "../motion/compositionV2";
import { writeAssContent } from "../render/captionAss";
import { prepareMotionPhysicalLayouts } from "../render/motionPhysicalGlyphLayouts";
import { canonicalJson } from "../shared/canonicalJson";
import { parseProject } from "./projectFiles";
import { assertMotionPresetVariantBinding } from "./motionPresetVariant";
import { prepareOriginalMotionSourceEvidence, type OriginalMotionSourceRights } from "./originalMotionSourceEvidence";
import { originalMotionScene2dInputSchema, prepareOriginalMotionScene2d,
  ORIGINAL_MOTION_ELEMENT_ANIMATION_CAPABILITY, type OriginalMotionScene2dInput } from "./originalMotionScene2d";
import { compactAutopilotContract } from "./autopilotPlan";

const fontRoot = resolve("public/fonts");
const faceIds = ["EditkinFace-noto-sans-tc-500", "EditkinFace-noto-sans-tc-700"] as const;
const fontBytes = new Map<string, Uint8Array>();
const runs = new Map<string, Promise<PreparedGlyphRun>>();
beforeAll(async () => {
  for (const faceId of faceIds) fontBytes.set(faceId,
    new Uint8Array(await readFile(join(fontRoot, bundledFontFaceSpec(faceId).fontFile))));
});
function actualText(faceId: string, text: string): Promise<PreparedGlyphRun> {
  const bytes = fontBytes.get(faceId);
  if (!bytes) throw new Error(`Fixture did not load the requested genuine face: ${faceId}`);
  const key = JSON.stringify([faceId, text]);
  if (!runs.has(key)) runs.set(key, prepareGlyphRun(faceId, text, bytes));
  return runs.get(key)!;
}
function animation(unit: MotionGraphicV2Motion["sequence"]["unit"] = "character"): MotionGraphicV2Motion {
  return { sequence: { unit, order: "forward", exitOrder: "forward", staggerFrames: unit === "all" ? 0 : 2 },
    entrance: { durationFrames: 8, offsetXPixels: 0, offsetYPixels: 24, scale: 1, opacity: 0, easing: { type: "linear" } },
    exit: { durationFrames: 5, offsetXPixels: 0, offsetYPixels: -12, scale: 1, opacity: 0, easing: { type: "linear" } } };
}
function fixture(text = "我的作品", frames = 120, weight = 700) {
  const project = parseProject(createEmptyProject("Original per-element animation", { width: 1920, height: 1080, fps: 30 }));
  const input: OriginalMotionScene2dInput = { expectedRevision: project.revision, sceneId: "element-animation-scene",
    intent: "standalone_showcase", reason: "Original editable title enters after a declared local cue and retains reading time",
    startFrame: 30, durationFrames: frames, safeArea: { left: 96, right: 96, top: 96, bottom: 96 },
    style: { palette: { surface: "#FFFFFF", text: "#172033", accent: "#175CD3", muted: "#5B6678", separator: "#D8DEE8" },
      typography: { headingFamily: "Noto Sans TC", bodyFamily: "Noto Sans TC" }, animationSpeed: 1 },
    camera: { initial: { centerX: 960, centerY: 540, zoom: 1 }, dynamics: { stiffness: 120, damping: 24, mass: 1 } },
    elements: [{ id: "editable-title", kind: "text", text, typographyRole: "heading", fontWeight: weight,
      range: { startFrame: 0, endFrame: frames }, xPixels: 160, yPixels: 360, widthPixels: 1600,
      fontSize: 64, minFontSize: 64, maxLines: 2, lineGapPixels: 8, letterSpacingPixels: 0,
      colorRole: "text", motionV2: animation() }],
    semanticCues: [{ id: "introduce-title", frame: 0, purpose: "Start the original title animation; this cue is not settled-reading proof",
      graphicIds: ["editable-title"], evidenceRefs: ["brief:original-title"], focus: { centerX: 960, centerY: 540, zoom: 1 } }] };
  return { project, input };
}
function panelFixture(frames = 60) {
  const { project, input } = fixture("我的作品", frames);
  const motion = animation("all"); motion.entrance.offsetYPixels = 0; motion.exit.offsetYPixels = 0;
  input.elements = [{ id: "editable-title", kind: "panel", range: { startFrame: 0, endFrame: frames },
    xPixels: 160, yPixels: 360, widthPixels: 400, heightPixels: 100, cornerRadiusPixels: 12,
    colorRole: "accent", motionV2: motion }];
  return { project, input };
}
type Prepared = Awaited<ReturnType<typeof prepareOriginalMotionScene2d>>;
function applied(project: EditProject, prepared: Prepared) {
  const output = applyCommand(project, { type: "batch", commands: prepared.commands });
  return { output, graphic: output.motionGraphics[0] };
}
async function physical(project: EditProject, graphic: MotionGraphic): Promise<MotionGraphicV2LayoutReceipt> {
  const face = `EditkinFace-noto-sans-tc-${graphic.fontWeight}`;
  return motionGraphicV2PhysicalLayoutReceipt(project, graphic, await actualText(face, graphic.text));
}
function state(project: EditProject, graphic: MotionGraphic, layout: MotionGraphicV2LayoutReceipt, local: number, unit = 0) {
  const frame = motionGraphicV2FrameReceipt(project, graphic, Math.round(graphic.timelineStart * project.fps) + local, layout);
  const segment = layout.segments.find(item => item.unitIndex === unit);
  if (!segment) throw new Error(`Missing actual physical unit ${unit}`);
  return frame.segments.find(item => item.segmentId === segment.id)!;
}
const dependencies = { prepareText: actualText };

describe("original authoring per-element motion with genuine physical glyphs", () => {
  it("publishes the implemented source admission capability without certifying the installed product", () => {
    const declared = compactAutopilotContract().originalSourceExecution.explicitElementAnimationV2;
    expect(declared).toBe(ORIGINAL_MOTION_ELEMENT_ANIMATION_CAPABILITY);
    expect(declared.units).toEqual(["all", "word", "character"]);
    expect(declared.installedOrFullProductCertified).toBe(false);
  });
  it("preserves a declared character cascade and actual ASS frame transforms through entry, hold and exit", async () => {
    const { project, input } = fixture("我的作品", 49), before = canonicalJson(project);
    const prepared = await prepareOriginalMotionScene2d(project, input, undefined, dependencies);
    const { output, graphic } = applied(project, prepared), layout = await physical(output, graphic);
    expect(canonicalJson(project)).toBe(before);
    expect(prepared.graphicBindings[0].physicalFont?.faceId).toBe(faceIds[1]);
    expect(layout.unitCount).toBe(4);
    expect(state(output, graphic, layout, 0)).toMatchObject({ opacity: 0, translateYPixels: 24, scale: 1 });
    expect(state(output, graphic, layout, 3, 1).opacity).toBeCloseTo(1 / 7, 6);
    expect(state(output, graphic, layout, 3, 2).opacity).toBe(0);
    for (let unit = 0; unit < 4; unit++) expect(state(output, graphic, layout, 13, unit))
      .toMatchObject({ opacity: 1, translateXPixels: 0, translateYPixels: 0, scale: 1 });
    expect(state(output, graphic, layout, 40, 0)).toMatchObject({ opacity: .5, translateYPixels: -6 });
    expect(state(output, graphic, layout, 40, 1).opacity).toBe(1);
    expect(state(output, graphic, layout, 48, 3).opacity).toBe(0);
    expect(motionGraphicV2FrameReceipt(output, graphic, 79, layout).visible).toBe(false);
    const ass = writeAssContent(output, output.captionStyle, { requirePhysicalGlyphs: true, physicalLayouts: new Map([[graphic.id, layout]]) });
    const unit = layout.segments.find(item => item.unitIndex === 1)!, sample = state(output, graphic, layout, 3, 1);
    const event = ass.split("\n").find(line => line.startsWith("Dialogue: 2,0:00:01.10,0:00:01.13,") && line.includes(`}${unit.outline!.ass}{\\p0}`));
    expect(event).toBeDefined();
    expect(event).toContain(`\\pos(${Number(unit.x.toFixed(6))},${Number((unit.y + sample.translateYPixels).toFixed(6))})`);
    expect(event).toContain("\\p1"); expect(event).toContain("\\fscx100\\fscy100");
    expect(event).not.toContain("\\fad(");
  });

  it("animates genuine 500-weight word groups with an independently ordered exit", async () => {
    const { project, input } = fixture("我的 作品", 90, 500);
    input.elements[0].motionV2 = animation("word"); input.elements[0].motionV2!.sequence.exitOrder = "reverse";
    const prepared = await prepareOriginalMotionScene2d(project, input, undefined, dependencies);
    const { output, graphic } = applied(project, prepared), layout = await physical(output, graphic);
    expect(prepared.graphicBindings[0].physicalFont?.faceId).toBe(faceIds[0]); expect(layout.unitCount).toBe(2);
    expect(layout.segments.filter(item => item.outline?.svg).map(item => item.text.trim())).toEqual(["我的", "作品"]);
    expect(state(output, graphic, layout, 3, 0).opacity).toBeCloseTo(3 / 7, 6);
    expect(state(output, graphic, layout, 3, 1).opacity).toBeCloseTo(1 / 7, 6);
    // Exit starts at local 83; reverse order starts the second word first.
    expect(state(output, graphic, layout, 85, 1)).toMatchObject({ opacity: .5, translateYPixels: -6 });
    expect(state(output, graphic, layout, 85, 0).opacity).toBe(1);
  });

  it("fades one editable vector panel with no fake glyphs and refuses a text-unit panel sequence", async () => {
    const { project, input } = panelFixture();
    const prepared = await prepareOriginalMotionScene2d(project, input);
    const { output, graphic } = applied(project, prepared), layout = motionGraphicV2LayoutReceipt(output, graphic);
    expect(prepared.graphicBindings[0].physicalFont).toBeUndefined();
    const at = (local: number) => motionGraphicV2FrameReceipt(output, graphic, 30 + local, layout).vectorState!;
    expect(at(0).opacity).toBe(0); expect(at(3).opacity).toBeCloseTo(3 / 7, 6);
    expect(at(7)).toMatchObject({ opacity: 1, scale: 1, translateXPixels: 0, translateYPixels: 0 });
    expect(at(57).opacity).toBe(.5); expect(at(59).opacity).toBe(0);
    const invalid = structuredClone(input); invalid.elements[0].motionV2!.sequence.unit = "character";
    await expect(prepareOriginalMotionScene2d(project, invalid)).rejects.toThrow(/原生向量/);
  });

  it("keeps the exact historical passive fallback when an element has no authored animation", async () => {
    const { project, input } = fixture(); delete input.elements[0].motionV2;
    const prepared = await prepareOriginalMotionScene2d(project, input, undefined, dependencies);
    const { output, graphic } = applied(project, prepared), layout = await physical(output, graphic);
    const passive = { durationFrames: 1, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 1, easing: { type: "linear" } };
    expect(graphic.motionV2).toEqual({ sequence: { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0 }, entrance: passive, exit: passive });
    for (const local of [0, 17, 119, 0]) expect(state(output, graphic, layout, local))
      .toMatchObject({ opacity: 1, scale: 1, translateXPixels: 0, translateYPixels: 0 });
  });

  it("requires the full short-title and long-title reading floors instead of shortening the cascade", async () => {
    for (const [text, minimum, units] of [["我的作品", 49, 4], ["用 Codex 做自己的剪輯效果", 89, 14]] as const) {
      const { project, input } = fixture(text, minimum);
      const prepared = await prepareOriginalMotionScene2d(project, input, undefined, dependencies);
      const { output, graphic } = applied(project, prepared), layout = await physical(output, graphic);
      expect(layout.unitCount).toBe(units); expect(graphic.motionV2).toEqual(input.elements[0].motionV2);
      const firstComplete = 2 * (units - 1) + 7;
      for (const segment of motionGraphicV2FrameReceipt(output, graphic, 30 + firstComplete, layout).segments)
        expect(segment).toMatchObject({ opacity: 1, scale: 1, translateXPixels: 0, translateYPixels: 0 });
      const short = fixture(text, minimum - 1);
      await expect(prepareOriginalMotionScene2d(short.project, short.input, undefined, dependencies)).rejects.toThrow(/閱讀停留/);
    }
  });

  it("rejects unknown animation commands at every strict nested authoring boundary", () => {
    const { input } = fixture();
    for (const key of ["motion", "sequence", "phase", "easing"] as const) {
      const changed = structuredClone(input), motion = changed.elements[0].motionV2!;
      const target = key === "motion" ? motion : key === "sequence" ? motion.sequence : key === "phase" ? motion.entrance : motion.entrance.easing;
      Object.assign(target, { arbitraryExpression: "caller code must not survive" });
      expect(originalMotionScene2dInputSchema.safeParse(changed).success).toBe(false);
    }
  });

  it("rejects a visible translated glyph that leaves the safe area although its settled slot fits", async () => {
    const { project, input } = fixture("字", 60); const text = input.elements[0];
    if (text.kind !== "text") throw new Error("Expected text fixture");
    text.xPixels = 96; text.fontSize = 24; text.minFontSize = 24;
    text.motionV2!.entrance.offsetYPixels = 0;
    const baseline = await prepareOriginalMotionScene2d(project, input, undefined, dependencies);
    const { output, graphic } = applied(project, baseline), layout = await physical(output, graphic);
    const ink = layout.segments[0].outline!.ink!;
    expect(layout.segments[0].x + ink.xMin).toBeGreaterThanOrEqual(96);
    expect(layout.segments[0].x + ink.xMin - 24 * (1 - 1 / 7)).toBeLessThan(96);
    const clipped = structuredClone(input); clipped.elements[0].motionV2!.entrance.offsetXPixels = -24;
    await expect(prepareOriginalMotionScene2d(project, clipped, undefined, dependencies)).rejects.toThrow(/actual ink\/contour.*safe-area/);
  });

  it("catches constructive cubic and undamped spring overshoot between otherwise safe panel endpoints", async () => {
    for (const easing of [
      { type: "cubic_bezier", x1: 1 / 3, y1: 2, x2: 2 / 3, y2: 2 },
      { type: "spring", stiffness: 100, damping: 0, mass: 1, initialVelocity: 0 },
    ] as const) {
      const { project, input } = panelFixture(); input.elements[0].xPixels = 96;
      const motion = input.elements[0].motionV2!; motion.entrance.opacity = 1; motion.entrance.offsetXPixels = 24;
      await prepareOriginalMotionScene2d(project, input); // Monotonic endpoints and every intermediate frame fit.
      motion.entrance.easing = easing;
      await expect(prepareOriginalMotionScene2d(project, input)).rejects.toThrow(/actual ink\/contour.*safe-area/);
    }
  });

  it("saves and reopens editable animation and regenerates the same real physical layout after nonmonotonic seeks", async () => {
    const { project, input } = fixture("我的 作品", 90, 500); input.elements[0].motionV2 = animation("word");
    const prepared = await prepareOriginalMotionScene2d(project, input, undefined, dependencies);
    const { output, graphic } = applied(project, prepared), layout = await physical(output, graphic);
    const reopened = parseProject(JSON.parse(JSON.stringify(output))), reopenedGraphic = reopened.motionGraphics[0];
    const layouts = await prepareMotionPhysicalLayouts(reopened, fontRoot), currentLayout = layouts.get(graphic.id)!;
    expect(reopenedGraphic.motionV2).toEqual(graphic.motionV2); expect(currentLayout.receiptId).toBe(layout.receiptId);
    expect(currentLayout.physicalFont).toEqual(layout.physicalFont);
    for (const local of [40, 3, 89, 7, 40]) expect(motionGraphicV2FrameReceipt(reopened, reopenedGraphic, 30 + local, currentLayout))
      .toEqual(motionGraphicV2FrameReceipt(output, graphic, 30 + local, layout));
  });

  it("refuses stale glyph layouts after text or 500-to-700 font changes and accepts genuine re-preparation", async () => {
    const { project, input } = fixture("我的作品", 120, 500);
    const prepared = await prepareOriginalMotionScene2d(project, input, undefined, dependencies);
    const { output, graphic } = applied(project, prepared), oldLayout = await physical(output, graphic);
    for (const mutation of ["text", "font"] as const) {
      const changed = parseProject(JSON.parse(JSON.stringify(output))), title = changed.motionGraphics[0];
      if (mutation === "text") title.text = "用 Codex 做自己的剪輯效果"; else title.fontWeight = 700;
      expect(() => motionGraphicV2FrameReceipt(changed, title, 45, oldLayout)).toThrow(/layout receipt|glyph 字型/);
      const newLayout = (await prepareMotionPhysicalLayouts(changed, fontRoot)).get(title.id)!;
      expect(newLayout.receiptId).not.toBe(oldLayout.receiptId);
      expect(() => motionGraphicV2FrameReceipt(changed, title, 45, newLayout)).not.toThrow();
      expect(newLayout.physicalFont!.faceId).toBe(mutation === "font" ? faceIds[1] : faceIds[0]);
    }
  });

  it("binds phase-only changes to new source and preset evidence while correctly retaining identical glyph geometry", async () => {
    const { project, input } = fixture();
    const rights: OriginalMotionSourceRights = { origin: "self_authored", medium: "native_vector_and_glyph", contentKind: "authored_illustration",
      realityProof: false, importedReferenceMedia: false, declaration: "Self-authored editable title; no outside footage or reality claim" };
    const original = await prepareOriginalMotionSourceEvidence(project, input, rights, 0, dependencies);
    const changed = structuredClone(input); changed.elements[0].motionV2!.entrance.durationFrames = 7;
    const revised = await prepareOriginalMotionSourceEvidence(project, changed, rights, 0, dependencies);
    expect(revised.evidence.authoringSha256).not.toBe(original.evidence.authoringSha256);
    expect(revised.evidence.commandsSha256).not.toBe(original.evidence.commandsSha256);
    expect(revised.evidence.sourceSha256).not.toBe(original.evidence.sourceSha256);
    expect(revised.evidence.graphicBindings[0].layoutReceiptId).toBe(original.evidence.graphicBindings[0].layoutReceiptId);
    const command = revised.preparation.commands[0]; if (command.type !== "add_motion_graphic") throw new Error("Missing real compiled graphic");
    const old = original.evidence.graphicBindings[0], current = revised.evidence.graphicBindings[0];
    expect(() => assertMotionPresetVariantBinding(command.graphic, old.presetId, old.presetVariant)).toThrow(/motionV2/);
    expect(() => assertMotionPresetVariantBinding(command.graphic, current.presetId, current.presetVariant)).not.toThrow();
    changed.elements[0].motionV2!.entrance.durationFrames = 6;
    expect(command.graphic.motionV2!.entrance.durationFrames).toBe(7); // The compiler owns the caller's supplied phase.
  });
});
