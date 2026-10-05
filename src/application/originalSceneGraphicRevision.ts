import * as z from "zod/v4";
import type { EditProject, MotionGraphic } from "../domain/types";
import { editorCommandSchema, motionPresetOverridesSchema } from "../domain/schema";
import { applyCommand } from "../domain/commands";
import type { OriginalSceneGraphicRevisionCommand } from "../domain/originalSceneGraphicRevision";
import { assertOriginalSceneGraphicRevision, issueOriginalSceneGraphicRevision } from "../domain/originalSceneGraphicRevision";
import { assertMotionPaintContract } from "../domain/motionPaint";
import { assertMotionGraphicV2Contract } from "../domain/motionCompositionV2Contract";
import { canonicalJson } from "../shared/canonicalJson";
import { resolveBundledFontFace } from "../typography/fontFaces";
import type { PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { motionGraphicV2LayoutReceipt, motionGraphicV2PhysicalLayoutReceipt, type MotionGraphicV2LayoutReceipt } from "../motion/compositionV2";
import { assertMotionScene2DPreparedFrameRange } from "../motion/sceneCamera2d";
import { assertScopedMotionReadingHold } from "./scopedMotionRevision";
import { originalMotionScene2dOutlineCodeUnits } from "./originalMotionScene2d";

const hex = z.string().regex(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i);
const edit = z.strictObject({ graphicId: z.string().trim().min(1).max(80),
  text: z.string().min(1).max(180).optional(), fontFamily: z.string().trim().min(1).max(80).optional(),
  fontWeight: z.number().int().min(100).max(900).optional(), fontSize: z.number().finite().min(8).max(384).optional(),
  letterSpacing: z.number().finite().min(-16).max(64).optional(),
  maxLines: z.number().int().min(1).max(4).optional(), minFontSize: z.number().int().min(8).max(384).optional(),
  lineGap: z.number().finite().min(0).max(64).optional(), align: z.enum(["left", "center", "right"]).optional(),
  textColor: hex.optional(), backgroundColor: hex.optional(), paintColors: z.array(hex).min(1).max(16).optional(),
  motionV2: motionPresetOverridesSchema.shape.motionV2,
});
export const originalSceneGraphicRevisionInputSchema = z.strictObject({
  sceneId: z.string().trim().min(1).max(80), expectedRevision: z.number().int().nonnegative(), edits: z.array(edit).min(1).max(32),
});
export type OriginalSceneGraphicRevisionInput = z.input<typeof originalSceneGraphicRevisionInputSchema>;
export interface OriginalSceneGraphicRevisionDependencies {
  prepareText?: (faceId: string, text: string) => Promise<PreparedGlyphRun>;
  signal?: AbortSignal;
}

/** An explicit edit of saved graphics. No original authoring draft, rights or
 * material proof is reconstructed from a derived layout or compiled scene. */
export async function prepareOriginalSceneGraphicRevision(project: EditProject, raw: OriginalSceneGraphicRevisionInput,
  dependencies: OriginalSceneGraphicRevisionDependencies = {}) {
  const check = () => { if (dependencies.signal?.aborted) throw new Error("Motion scene content preparation was cancelled"); };
  check();
  const input = originalSceneGraphicRevisionInputSchema.parse(raw), projectSignature = canonicalJson(project);
  if (project.revision !== input.expectedRevision) throw new Error("Motion scene project revision is stale");
  const scene = project.motionScenes?.find(item => item.id === input.sceneId);
  if (!scene) throw new Error("Motion scene owner is missing");
  const expectedGraphics = scene.graphicIds.map(id => {
    const matches = project.motionGraphics.filter(graphic => graphic.id === id);
    if (matches.length !== 1) throw new Error("Motion scene graphic is missing or duplicated");
    return structuredClone(matches[0]);
  });
  if (new Set(input.edits.map(item => item.graphicId)).size !== input.edits.length) throw new Error("Motion scene content edits must have unique graphic IDs");
  if (input.edits.some(item => !scene.graphicIds.includes(item.graphicId))) throw new Error("Motion scene edit targets a foreign graphic");
  const graphics = expectedGraphics.map(before => {
    const patch = input.edits.find(item => item.graphicId === before.id), graphic = structuredClone(before);
    if (!patch) return graphic;
    const { graphicId: _id, maxLines, minFontSize, lineGap, align, paintColors, ...fields } = patch;
    const hasTextEdit = [fields.text, fields.fontFamily, fields.fontWeight, fields.fontSize, fields.letterSpacing,
      maxLines, minFontSize, lineGap, align].some(value => value !== undefined);
    if (hasTextEdit && before.vectorV2) throw new Error("Text controls cannot revise a scene vector");
    Object.assign(graphic, structuredClone(fields));
    if ([maxLines, minFontSize, lineGap, align].some(value => value !== undefined)) {
      if (!graphic.layoutV2) throw new Error("Motion scene text needs its existing physical layout");
      graphic.layoutV2 = { ...graphic.layoutV2, ...(maxLines === undefined ? {} : { maxLines }),
        ...(minFontSize === undefined ? {} : { minFontSize }), ...(lineGap === undefined ? {} : { lineGap }), ...(align === undefined ? {} : { align }) };
    }
    if (paintColors) {
      if (!graphic.paintV1) throw new Error("Scene graphic has no native paint color stops");
      const fill = graphic.paintV1.fill, colors = fill.kind === "solid" ? [fill.color] : fill.stops.map(stop => stop.color);
      if (paintColors.length !== colors.length || paintColors.some((color, i) => color.slice(7).toLowerCase() !== colors[i].slice(7).toLowerCase())) {
        throw new Error("Scene paint edits must preserve stop count and alpha");
      }
      graphic.paintV1.fill = fill.kind === "solid" ? { ...fill, color: paintColors[0] }
        : { ...fill, stops: fill.stops.map((stop, i) => ({ ...stop, color: paintColors[i] })) };
    }
    if (graphic.paintV1 && (fields.textColor !== undefined || fields.backgroundColor !== undefined)) {
      throw new Error("Edit the actual native paint colors, not unused legacy colors");
    }
    if (!graphic.vectorV2 && (graphic.text !== graphic.text.trim() || graphic.text.includes("\r") || !graphic.text.trim()
      || !graphic.layoutV2 || graphic.layoutV2.minFontSize > graphic.fontSize)) throw new Error("Motion scene text needs exact content and explicit fitting bounds");
    return graphic;
  });
  if (canonicalJson(graphics) === canonicalJson(expectedGraphics)) return { status: "UNCHANGED" as const, commands: [] };
  const command: OriginalSceneGraphicRevisionCommand = { type: "revise_motion_scene_graphics", expectedRevision: input.expectedRevision,
    expectedScene: structuredClone(scene), expectedGraphics, graphics };
  editorCommandSchema.parse(command);
  assertOriginalSceneGraphicRevision(project, command);
  const replacements = new Map(graphics.map(graphic => [graphic.id, graphic]));
  const preview = { ...structuredClone(project), motionGraphics: project.motionGraphics.map(graphic => replacements.get(graphic.id) ?? structuredClone(graphic)) };
  const layouts = new Map<string, MotionGraphicV2LayoutReceipt>();
  let outlineCodeUnits = 0;
  for (const graphic of graphics) {
    check(); assertMotionPaintContract(graphic); assertMotionGraphicV2Contract(graphic, project.fps);
    let layout: MotionGraphicV2LayoutReceipt;
    if (graphic.vectorV2) layout = motionGraphicV2LayoutReceipt(preview, graphic);
    else {
      assertScopedMotionReadingHold(graphic, project.fps);
      const face = resolveBundledFontFace(graphic.fontFamily ?? "Noto Sans TC", graphic.fontWeight ?? 700);
      if (!face || face.fontWeight !== (graphic.fontWeight ?? 700)) throw new Error("FONT_BYTES_REQUIRED: choose an exact verified physical font weight");
      if (!dependencies.prepareText) throw new Error("FONT_BYTES_REQUIRED: actual physical glyph preparation is required");
      const run = await dependencies.prepareText(face.faceId, graphic.text); check();
      layout = motionGraphicV2PhysicalLayoutReceipt(preview, graphic, run);
    }
    if (Math.abs(layout.box.x - graphic.x * project.width) > 1e-5 || Math.abs(layout.box.y - graphic.y * project.height) > 1e-5
      || (graphic.layoutV2?.widthMode ?? "fixed") === "fixed" && Math.abs(layout.box.width - graphic.width * project.width) > 1e-5) {
      throw new Error("Motion scene revision cannot silently clamp or reposition its authored slot");
    }
    outlineCodeUnits = originalMotionScene2dOutlineCodeUnits(outlineCodeUnits, layout);
    layouts.set(graphic.id, layout);
  }
  const preparedSafety = assertMotionScene2DPreparedFrameRange(preview, scene, layouts);
  check();
  if (canonicalJson(project) !== projectSignature) throw new Error("Motion scene project changed during physical preparation");
  issueOriginalSceneGraphicRevision(project, command);
  applyCommand(project, command); // Real immutable domain path after proof, never an early grant.
  return { schema: "editkin.original-scene-graphic-revision/v1" as const, status: "REVIEW_REQUIRED" as const,
    commands: [command], readOnly: true, preparedSafety, outlineCodeUnits,
    sourceBoundary: "Manual compiled-graphic editing; not reconstructed original source or rights, not v4 admitted or artwork approval.",
    v4Admission: "NOT_V4_ADMITTED" as const };
}
