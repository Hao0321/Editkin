import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { applyCommand } from "../domain/commands";
import { createEmptyProject } from "../domain/editGraph";
import { assertMotionGraphicV2Contract } from "../domain/motionCompositionV2Contract";
import { editorCommandSchema, motionPresetVariantSchema, motionVectorV2Schema } from "../domain/schema";
import type { EditProject, MotionGraphic } from "../domain/types";
import { decodeProjectBytes, encodeProjectBytes, parseProject } from "../application/projectCodec";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { createMotionGraphic } from "../motion/composition";
import { motionGraphicV2PhysicalLayoutReceipt } from "../motion/compositionV2";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareGlyphRun, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import MotionStudio from "../ui/MotionStudio";
import { writeAssContent } from "./captionAss";

const ANNOTATION = "editkin.motion-vector-annotation/v1" as const;
const LEGACY = "editkin.motion-vector/v1" as const;
const STAGE = "editkin.motion-vector-stage/v1" as const;
const FACE_ID = "EditkinFace-noto-sans-tc-700";
let glyphs: PreparedGlyphRun;

beforeAll(async () => {
  const face = bundledFontFaceSpec(FACE_ID);
  const bytes = new Uint8Array(await readFile(resolve(process.env.EDITKIN_FONT_ROOT ?? "public/fonts", face.fontFile)));
  // Production parser, sealed source bytes and actual Han outlines; no metrics,
  // contour, frame, font or renderer mocks and no media fixture is opened.
  glyphs = await prepareGlyphRun(face.faceId, "重點", bytes);
});

function stillMotion(): NonNullable<MotionGraphic["motionV2"]> {
  return {
    sequence: { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0 },
    entrance: { durationFrames: 1, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 1, easing: { type: "linear" } },
    exit: { durationFrames: 1, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 0, easing: { type: "linear" } },
  };
}

function rule(schema: typeof ANNOTATION | typeof LEGACY | typeof STAGE = ANNOTATION): MotionGraphic {
  const graphic = createMotionGraphic("ink-rule", "card", "", 1, 4 / 30, undefined, findMotionGraphicPreset("reel_rule_reveal").seed);
  graphic.vectorV2 = { schema, kind: "rule", heightPixels: 4, revealFrames: 1 };
  graphic.x = .1; graphic.y = .2; graphic.width = .5;
  graphic.fontSize = 8; graphic.cornerRadius = 0; graphic.shadowDepth = 0; graphic.outlineWidth = 0;
  graphic.accentColor = "#175CD3";
  graphic.layoutV2 = { safeArea: { top: 0, right: 0, bottom: 0, left: 0 }, maxLines: 1, minFontSize: 8, lineGap: 0, align: "left" };
  graphic.motionV2 = stillMotion();
  return graphic;
}

function title(): MotionGraphic {
  const graphic = createMotionGraphic("physical-title", "title", "重點", 1, 4 / 30, undefined, findMotionGraphicPreset("v2-word-cascade").seed);
  graphic.fontFamily = "Noto Sans TC"; graphic.fontWeight = 700; graphic.fontSize = 48; graphic.letterSpacing = 0;
  graphic.x = .08; graphic.y = .2; graphic.width = .8;
  graphic.backgroundColor = "#FFFFFF"; graphic.textColor = "#172033";
  graphic.shadowDepth = 0; graphic.outlineWidth = 0;
  graphic.layoutV2 = { safeArea: { top: 0, right: 0, bottom: 0, left: 0 }, maxLines: 1, minFontSize: 48, lineGap: 0, align: "left" };
  graphic.motionV2 = stillMotion();
  return graphic;
}

function physicalProject(annotationFirst = false) {
  const project = parseProject(createDemoProject()), text = title();
  const physical = motionGraphicV2PhysicalLayoutReceipt(project, text, glyphs);
  const annotation = rule();
  // The independently prepared glyph box supplies an actual intersecting slot.
  // ASS layer order is tested here; pixel coverage is a separate acceptance.
  annotation.x = physical.box.x / project.width;
  annotation.y = (physical.box.y + physical.box.height / 2) / project.height;
  annotation.width = physical.box.width / project.width;
  project.motionGraphics = annotationFirst ? [annotation, text] : [text, annotation];
  const options = { requirePhysicalGlyphs: true, physicalLayouts: new Map([[text.id, physical]]) };
  return { project, text, annotation, physical, options };
}

function events(ass: string, layer?: number): string[] {
  return ass.split("\n").filter(line => line.startsWith(layer === undefined ? "Dialogue: " : `Dialogue: ${layer},`));
}

type PositionSelect = ReactElement<{ "aria-label"?: string; value: string; children?: ReactNode;
  onChange: (event: { target: { value: string } }) => void }>;
function positionSelect(node: ReactNode, label: string): PositionSelect | undefined {
  if (Array.isArray(node)) return node.map(child => positionSelect(child, label)).find(Boolean);
  if (!isValidElement<{ children?: ReactNode; "aria-label"?: string }>(node)) return;
  if (node.type === "select" && node.props["aria-label"] === label) return node as PositionSelect;
  return positionSelect(node.props.children, label);
}

function studio(project: EditProject, onUpdate: Parameters<typeof MotionStudio>[0]["onUpdateMotionGraphic"]) {
  const noop = () => {};
  return MotionStudio({ asset: project.assets[0], motionTracks: project.motionTracks,
    motionGraphics: project.motionGraphics, wave2Presets: [], trackingBusy: false, trackingSelectionActive: false,
    onBeginMotionTrack: noop, onCorrectMotionTrack: noop, onDeleteMotionTrack: noop, onAddMotionGraphic: noop,
    onUpdateMotionGraphic: onUpdate, onDeleteMotionGraphic: noop });
}

// Hand-authored literal historical rule oracle, including all three frame
// intervals, color/alpha and the complete contour. No current geometry helper
// generates the expected result, and annotations must not modify these bytes.
const LEGACY_RULE_DRAWING = "{\\an7\\pos(32,36)\\p1\\fscx100\\fscy100\\bord0\\shad0\\1c&HD35C17&\\1a&H00&}m 0 0 l 160 0 b 160 0 160 0 160 0 l 160 4 b 160 4 160 4 160 4 l 0 4 b 0 4 0 4 0 4 l 0 0 b 0 0 0 0 0 0{\\p0}";
const LEGACY_RULE_EVENTS = [
  `Dialogue: 1,0:00:01.00,0:00:01.03,Motion,,0,0,0,,${LEGACY_RULE_DRAWING}`,
  `Dialogue: 1,0:00:01.03,0:00:01.06,Motion,,0,0,0,,${LEGACY_RULE_DRAWING}`,
  `Dialogue: 1,0:00:01.06,0:00:01.10,Motion,,0,0,0,,${LEGACY_RULE_DRAWING}`,
];

describe("opt-in foreground ink annotation over authentic physical glyphs", () => {
  it("keeps the annotation above glyphs and panels for either authored array order", () => {
    const first = physicalProject(true), last = physicalProject(false);
    const firstAss = writeAssContent(first.project, first.project.captionStyle, first.options);
    const lastAss = writeAssContent(last.project, last.project.captionStyle, last.options);
    expect(first.physical.physicalFont).toMatchObject({ faceId: FACE_ID, fontSha256: bundledFontFaceSpec(FACE_ID).sha256 });
    expect(first.physical.segments[0].outline?.ass).toContain("m ");
    expect(events(firstAss, 3)).toHaveLength(3);
    expect(events(firstAss, 2)).toHaveLength(3);
    expect(events(firstAss, 1).length).toBeGreaterThan(0);
    expect(events(firstAss, 3)).toEqual(events(lastAss, 3));
    expect(events(firstAss, 2)).toEqual(events(lastAss, 2));
    expect(events(firstAss, 1)).toEqual(events(lastAss, 1));
    expect(events(firstAss, 3).every(line => line.includes("\\1c&HD35C17&"))).toBe(true);
    expect(events(firstAss, 2).every(line => line.includes(first.physical.segments[0].outline!.ass))).toBe(true);
  });

  it("preserves omitted foreground while explicit foreground produces the same drawing events", () => {
    const fixture = physicalProject(), implicit = writeAssContent(fixture.project, fixture.project.captionStyle, fixture.options);
    fixture.annotation.compositeLayer = "foreground";
    const explicit = writeAssContent(fixture.project, fixture.project.captionStyle, fixture.options);
    expect(events(explicit)).toEqual(events(implicit));
    expect(events(explicit, 3)).toHaveLength(3);
  });

  it("keeps the exact historical rule events and does not promote a legacy rule", () => {
    const project = createEmptyProject("literal old rule", { width: 320, height: 180, fps: 30 });
    project.motionGraphics = [rule(LEGACY)];
    const ass = writeAssContent(project, project.captionStyle);
    expect(events(ass)).toEqual(LEGACY_RULE_EVENTS);
    expect(events(ass, 3)).toHaveLength(0);
    expect(ass.endsWith("\n")).toBe(true);
    expect(project.motionGraphics[0].vectorV2?.schema).toBe(LEGACY);
  });

  it("keeps the existing stage rule in its background script at the original layer", () => {
    const project = createEmptyProject("literal stage rule", { width: 320, height: 180, fps: 30 });
    const stage = rule(STAGE); stage.compositeLayer = "background"; project.motionGraphics = [stage];
    const ass = writeAssContent(project, project.captionStyle, { compositeLayer: "background" });
    expect(events(ass)).toEqual(LEGACY_RULE_EVENTS);
    expect(events(ass, 3)).toHaveLength(0);
    expect(events(writeAssContent(project, project.captionStyle, { compositeLayer: "foreground" }))).toHaveLength(0);
  });

  it("roundtrips annotation and physical font settings without changing source/audio/frame identities", () => {
    const fixture = physicalProject(), before = structuredClone(fixture.project);
    const reopened = decodeProjectBytes(encodeProjectBytes(fixture.project));
    expect(fixture.project).toEqual(before);
    expect(reopened).toEqual(parseProject(before));
    expect(reopened.tracks).toEqual(before.tracks);
    expect(reopened.assets).toEqual(before.assets);
    expect(reopened.fps).toBe(before.fps);
    expect(reopened.motionGraphics.map(graphic => [graphic.id, graphic.timelineStart, graphic.duration, graphic.schema, graphic.vectorV2?.schema])).toEqual(
      before.motionGraphics.map(graphic => [graphic.id, graphic.timelineStart, graphic.duration, graphic.schema, graphic.vectorV2?.schema]));
    const reopenedTitle = reopened.motionGraphics.find(graphic => graphic.id === fixture.text.id)!;
    const layout = motionGraphicV2PhysicalLayoutReceipt(reopened, reopenedTitle, glyphs);
    expect(layout.physicalFont).toEqual(fixture.physical.physicalFont);
    expect(reopenedTitle.fontFamily).toBe("Noto Sans TC"); expect(reopenedTitle.fontWeight).toBe(700);
    expect(events(writeAssContent(reopened, reopened.captionStyle, { requirePhysicalGlyphs: true, physicalLayouts: new Map([[reopenedTitle.id, layout]]) }))).toEqual(
      events(writeAssContent(before, before.captionStyle, fixture.options)));
  });

  it("retains the explicit annotation opt-in through actual command and preset variant codecs", () => {
    const preset = findMotionGraphicPreset("reel_ink_annotation");
    expect(preset.renderer).toBe("hao-motion-composition/v2");
    expect(preset.seed.vectorV2).toEqual({ schema: ANNOTATION, kind: "rule", heightPixels: 4, revealFrames: 7 });
    const annotation = createMotionGraphic("native-preset-annotation", "card", "", 1, 3, undefined, preset.seed);
    const command = editorCommandSchema.parse(JSON.parse(JSON.stringify({ type: "add_motion_graphic", graphic: annotation })));
    const applied = applyCommand(createEmptyProject("command annotation"), command);
    const reopened = decodeProjectBytes(encodeProjectBytes(applied));
    expect(reopened.motionGraphics[0].vectorV2).toEqual(annotation.vectorV2);
    const variant = { schema: "editkin.motion-preset-variant/v1", basePresetSha256: "b".repeat(64), reason: "Explicit foreground ink annotation", overrides: { compositeLayer: "foreground", vectorV2: annotation.vectorV2 } };
    // The digest is a syntax fixture, not a claimed trusted preset identity.
    expect(motionPresetVariantSchema.parse(JSON.parse(JSON.stringify(variant)))).toEqual(variant);
  });

  it("uses the actual rule-only MotionStudio selector and preserves its mode/geometry on save and reopen", () => {
    const project = parseProject(createDemoProject()), original = rule(LEGACY); project.motionGraphics = [original];
    const before = structuredClone(project), update = vi.fn();
    const label = `${original.name}合成位置`;
    const select = positionSelect(studio(project, update), label);
    expect(select).toBeDefined(); expect(select!.props.value).toBe("foreground");
    select!.props.onChange({ target: { value: "annotation" } });
    const patch = { compositeLayer: "foreground", vectorV2: { ...original.vectorV2, schema: ANNOTATION } };
    expect(update).toHaveBeenCalledTimes(1); expect(update).toHaveBeenCalledWith(original.id, patch);
    const command = editorCommandSchema.parse({ type: "update_motion_graphic", graphicId: original.id, patch: update.mock.calls[0][1] });
    const reopened = decodeProjectBytes(encodeProjectBytes(applyCommand(project, command)));
    expect(project).toEqual(before);
    expect(reopened.motionGraphics[0]).toEqual({ ...original, ...patch });
    expect(reopened.tracks).toEqual(project.tracks);
    expect(reopened.assets).toEqual(project.assets);
    expect(positionSelect(studio(reopened, update), label)?.props.value).toBe("annotation");
    const restoredSelect = positionSelect(studio(reopened, update), label)!;
    restoredSelect.props.onChange({ target: { value: "foreground" } });
    const foregroundPatch = update.mock.calls[1][1];
    expect(foregroundPatch).toEqual({ compositeLayer: "foreground", vectorV2: { ...original.vectorV2, schema: STAGE } });
    const foreground = applyCommand(reopened, editorCommandSchema.parse({ type: "update_motion_graphic", graphicId: original.id, patch: foregroundPatch }));
    expect(foreground.motionGraphics[0].id).toBe(original.id);
    expect(foreground.motionGraphics[0].vectorV2).toEqual({ ...original.vectorV2, schema: STAGE });
    expect(events(writeAssContent(foreground, foreground.captionStyle), 3)).toHaveLength(0);
  });

  it("rejects annotation on the other ordinary native primitives without weakening either ingress guard", () => {
    const specimens = [
      { kind: "panel" }, { kind: "ellipse" },
      { kind: "step_progress", steps: 2, activeStep: 1, gapPixels: 4 },
      { kind: "dot_grid", spacingPixels: 16, dotRadiusPixels: 2 },
      { kind: "line_grid", spacingPixels: 16, lineWidthPixels: 1, majorEvery: 4 },
      { kind: "connection_field", seed: 1, points: 8, dotRadiusPixels: 1, lineWidthPixels: 1, burstFrames: 1, gatherStartFrame: 1, gatherFrames: 1, connectStartFrame: 2, connectFrames: 1 },
    ];
    for (const specimen of specimens) {
      const input = { ...rule(), vectorV2: { schema: ANNOTATION, heightPixels: 4, revealFrames: 1, ...specimen } };
      expect(motionVectorV2Schema.safeParse(input.vectorV2).success, specimen.kind).toBe(false);
      expect(editorCommandSchema.safeParse({ type: "add_motion_graphic", graphic: input }).success, specimen.kind).toBe(false);
      // Deliberately untrusted wire values exercise the real runtime boundary.
      expect(() => assertMotionGraphicV2Contract(input as MotionGraphic, 30), specimen.kind).toThrow(/註記|rule|未知原生向量/);
    }
  });

  it("rejects annotation in the background at command, persisted-project and renderer boundaries", () => {
    const annotation = rule(); annotation.compositeLayer = "background";
    expect(editorCommandSchema.safeParse({ type: "add_motion_graphic", graphic: annotation }).success).toBe(false);
    const project = createEmptyProject("rejected background"); project.motionGraphics = [annotation];
    expect(() => encodeProjectBytes(project)).toThrow();
    expect(() => assertMotionGraphicV2Contract(annotation, project.fps)).toThrow(/背景|stage|註記/);
    expect(() => writeAssContent(project, project.captionStyle, { compositeLayer: "background" })).toThrow(/背景|stage|註記/);
  });

  it("rejects an unsupported schema rather than treating it as legacy or annotation", () => {
    const input = { ...rule(), vectorV2: { schema: "editkin.motion-vector-annotation/v2", kind: "rule", heightPixels: 4, revealFrames: 1 } };
    expect(motionVectorV2Schema.safeParse(input.vectorV2).success).toBe(false);
    expect(editorCommandSchema.safeParse({ type: "add_motion_graphic", graphic: input }).success).toBe(false);
    expect(() => assertMotionGraphicV2Contract(input as MotionGraphic, 30)).toThrow(/未知原生向量/);
  });

  it("keeps authentic glyph admission mandatory while the new annotation itself needs no font substitute", () => {
    const fixture = physicalProject();
    expect(() => writeAssContent(fixture.project, fixture.project.captionStyle, { requirePhysicalGlyphs: true })).toThrow(/glyph.*receipt/);
    expect(() => writeAssContent(fixture.project, fixture.project.captionStyle, { requirePhysicalGlyphs: true, physicalLayouts: new Map() })).toThrow(/glyph.*receipt/);
    const vectorOnly = createEmptyProject("font-free geometry"); vectorOnly.motionGraphics = [rule()];
    expect(events(writeAssContent(vectorOnly, vectorOnly.captionStyle, { requirePhysicalGlyphs: true }), 3)).toHaveLength(3);
    expect(glyphs.faceId).toBe(FACE_ID);
    expect(glyphs.fontSha256).toBe(bundledFontFaceSpec(FACE_ID).sha256);
  });
});
