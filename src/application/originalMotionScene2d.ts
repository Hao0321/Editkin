import * as z from "zod/v4";
import type { EditProject, MotionGraphic } from "../domain/types";
import type { EditorCommand } from "../domain/commandTypes";
import { applyCommand } from "../domain/commands";
import type { MotionScene2D } from "../domain/motionScene2d";
import { assertMotionScene2D } from "../domain/motionScene2d";
import { motionSceneStyleSchema, validateMotionSceneStyle } from "../domain/motionSceneStyle";
import { motionPresetOverridesSchema, type MotionPresetVariant } from "../domain/schema";
import { assertMotionPaintContract, motionPaintDescriptorSchema } from "../domain/motionPaint";
import { assertMotionGraphicV2Contract } from "../domain/motionCompositionV2Contract";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { createMotionGraphic } from "../motion/composition";
import { motionGraphicV2LayoutReceipt, motionGraphicV2PhysicalLayoutReceipt, type MotionGraphicV2LayoutReceipt } from "../motion/compositionV2";
import { assertMotionScene2DPreparedFrameRange } from "../motion/sceneCamera2d";
import type { SpringTargetTrack } from "../motion/springTargetTrack";
import { resolveBundledFontFace } from "../typography/fontFaces";
import type { PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { canonicalJson } from "../shared/canonicalJson";
import { motionCommandFamilies } from "./motionTreatment";
import { assertScopedMotionReadingHold } from "./scopedMotionRevision";
import type { EditorialPlan } from "./editorialPlan";

const id = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/i);
const frame = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1800);
const pixel = z.number().finite().min(0).max(100_000);
const focusSchema = z.strictObject({ centerX: z.number().finite().min(-100_000).max(100_000),
  centerY: z.number().finite().min(-100_000).max(100_000), zoom: z.number().finite().min(.05).max(20) });
const springSchema = z.strictObject({ stiffness: z.number().finite().min(1).max(1000),
  damping: z.number().finite().min(0).max(100), mass: z.number().finite().min(.05).max(10) });
const rangeSchema = z.strictObject({ startFrame: frame, endFrame: frame });
const elementBase = { id, range: rangeSchema, xPixels: pixel, yPixels: pixel,
  widthPixels: z.number().finite().min(16).max(4096), motionV2: motionPresetOverridesSchema.shape.motionV2 };
const panelSchema = z.strictObject({ ...elementBase, kind: z.literal("panel"),
  heightPixels: z.number().finite().min(1).max(4096), cornerRadiusPixels: z.number().finite().min(0).max(384),
  colorRole: z.enum(["surface", "accent", "separator"]), paintV1: motionPaintDescriptorSchema.optional() });
const textSchema = z.strictObject({ ...elementBase, kind: z.literal("text"),
  text: z.string().min(1).max(180), typographyRole: z.enum(["heading", "body"]),
  fontWeight: z.number().int().min(100).max(900), fontSize: z.number().finite().min(8).max(384),
  minFontSize: z.number().int().min(8).max(384), maxLines: z.number().int().min(1).max(4),
  lineGapPixels: z.number().finite().min(0).max(64), letterSpacingPixels: z.number().finite().min(-16).max(64),
  colorRole: z.enum(["text", "muted", "accent"]), paintV1: motionPaintDescriptorSchema.optional() });

/** Only original graphic authoring. Caller refs are not measured media evidence. */
export const originalMotionScene2dInputSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(), sceneId: id.optional(),
  intent: z.enum(["standalone_showcase", "authored_overlay"]), reason: z.string().trim().min(1).max(480),
  startFrame: frame, durationFrames: z.number().int().min(2).max(1800),
  safeArea: z.strictObject({ left: pixel, right: pixel, top: pixel, bottom: pixel }),
  style: motionSceneStyleSchema,
  camera: z.strictObject({ initial: focusSchema, dynamics: springSchema }),
  elements: z.array(z.discriminatedUnion("kind", [panelSchema, textSchema])).min(1).max(32),
  semanticCues: z.array(z.strictObject({ id, frame,
    purpose: z.string().trim().min(1).max(240), graphicIds: z.array(id).min(1).max(32),
    evidenceRefs: z.array(z.string().trim().min(1).max(160)).min(1).max(8),
    focus: focusSchema.optional() })).min(1).max(32),
});
export type OriginalMotionScene2dInput = z.input<typeof originalMotionScene2dInputSchema>;
/** Source admission only. A declaration is not proof of a matching native
 * binary, preview/export parity, installation or artwork acceptance. */
export const ORIGINAL_MOTION_DISPLAY_PAINT_CAPABILITY = Object.freeze({
  schema: "editkin.original-motion-display-paint-capability/v1",
  paintSchema: "editkin.motion-paint/v2", trackSchema: "editkin.native-motion-paint-track/v2",
  colorIntent: "display_rec709_sdr", compositionBoundary: "after_aces2_before_output_encoding",
  scope: "authored_overlay_flat_2d", projectMode: "aces2", outputTransform: "rec709_sdr",
  maxProjectGraphics: 4, matchingNativeRuntimeRequired: true, sourceAdmissionOnly: true,
  installedOrFullProductCertified: false,
} as const);
/** Explicit per-element timing uses the same glyph/frame evaluator and preset
 * binding as saved graphics. Omitted timing retains the passive scene source. */
export const ORIGINAL_MOTION_ELEMENT_ANIMATION_CAPABILITY = Object.freeze({
  schema: "editkin.original-motion-element-animation-capability/v1",
  motionSchema: "hao.motion-composition/v2", units: Object.freeze(["all", "word", "character"]),
  timing: "integer_project_frames", textPreparation: "physical-glyph-binary/v1",
  minimumReadingHoldSeconds: .8, preparedFrameSafetyRequired: true,
  independentExitStaggerFrames: true, wholeSentenceExit: "sequence.exitStaggerFrames=0",
  omittedExitStaggerFrames: "preserve_entrance_stagger",
  sourceAdmissionOnly: true, installedOrFullProductCertified: false,
} as const);
export interface OriginalMotionScene2dDependencies {
  /** Must return the real immutable factory run prepared from verified bytes. */
  prepareText?: (faceId: string, text: string) => Promise<PreparedGlyphRun>;
}

export const ORIGINAL_MOTION_SCENE_2D_MAX_OUTLINE_CODE_UNITS = 8 * 1024 * 1024;

/** Cumulative SVG plus ASS UTF-16 units, matching actual render preparation. */
export function originalMotionScene2dOutlineCodeUnits(previous: number, layout: MotionGraphicV2LayoutReceipt): number {
  if (!Number.isSafeInteger(previous) || previous < 0 || previous > ORIGINAL_MOTION_SCENE_2D_MAX_OUTLINE_CODE_UNITS) {
    throw new Error("Scene physical outline budget is invalid or exceeded");
  }
  let total = previous;
  for (const segment of layout.segments) {
    total += (segment.outline?.svg.length ?? 0) + (segment.outline?.ass.length ?? 0);
    if (!Number.isSafeInteger(total) || total > ORIGINAL_MOTION_SCENE_2D_MAX_OUTLINE_CODE_UNITS) throw new Error("Scene physical outline budget exceeds 8Mi code units");
  }
  return total;
}

async function sha(value: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is required for scene authoring identity");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function allProjectIds(project: EditProject): Set<string> {
  return new Set([project.id, ...project.compositions.map(c => c.id), ...project.assets.map(a => a.id), ...project.tracks.flatMap(t => [t.id, ...t.clips.map(c => c.id)]),
    ...project.motionGraphics.map(g => g.id), ...project.motionTracks.map(t => t.id), ...project.captions.map(c => c.id),
    ...(project.motionScenes ?? []).map(scene => scene.id)]);
}

/** Read-only original scene compiler. No media is imported, modified or claimed. */
export async function prepareOriginalMotionScene2d(project: EditProject, raw: OriginalMotionScene2dInput,
  idFactory: (prefix: string) => string = () => {
    if (!globalThis.crypto?.randomUUID) throw new Error("A secure scene ID factory is required");
    return globalThis.crypto.randomUUID();
  }, dependencies: OriginalMotionScene2dDependencies = {}) {
  const input = originalMotionScene2dInputSchema.parse(raw);
  if (project.revision !== input.expectedRevision) throw new Error("Scene project revision is stale; re-read the current project");
  if (project.scene25d?.enabled || project.scene3d?.enabled) throw new Error("Original scene authoring requires a 2D project");
  const authoredPaint = input.elements.some(element => element.paintV1 !== undefined);
  if (authoredPaint) {
    // Match the current native renderer's actual admission. Do not silently
    // promote Rec.709 projects or route media-free scenes through dummy video.
    if (input.intent !== "authored_overlay" || project.colorManagement?.mode !== "aces2"
      || project.colorManagement.outputTransform !== "rec709_sdr"
      || input.elements.some(element => element.paintV1 === undefined)
      || project.motionGraphics.length + input.elements.length > 4
      || project.motionGraphics.some(graphic => graphic.schema === "hao.motion-composition/v2"
        && (graphic.visualStyle !== "native_paint" || !graphic.paintV1))) {
      throw new Error("Native paint source authoring requires explicit ACES2 rec709_sdr, authored_overlay, only physical paint text or typed paint panels and at most four graphics");
    }
    project.motionGraphics.forEach(assertMotionPaintContract);
  } else if (project.colorManagement?.mode === "aces2") {
    throw new Error("Original scene authoring currently requires a Rec.709 2D project unless explicit native paint is authored");
  }
  const projectSignature = canonicalJson(project), ownedProject = structuredClone(project);
  const sceneId = id.parse(input.sceneId ?? idFactory("motion-scene"));
  const occupied = allProjectIds(ownedProject);
  const graphicIds = input.elements.map(element => element.id);
  if (occupied.has(sceneId) || new Set(graphicIds).size !== graphicIds.length
    || graphicIds.some(graphicId => occupied.has(graphicId) || graphicId === sceneId)) throw new Error("Scene and graphic IDs must be unique and unoccupied");
  if ((ownedProject.motionScenes?.length ?? 0) >= 16) throw new Error("Project scene count exceeds the 16-scene bound");
  if (input.durationFrames * input.elements.length > 100_000) throw new Error("Scene frame/graphic work exceeds the admitted bound");
  const style = validateMotionSceneStyle(input.style);
  if (input.safeArea.left + input.safeArea.right >= project.width || input.safeArea.top + input.safeArea.bottom >= project.height) {
    throw new Error("Scene safe area has no usable canvas");
  }
  for (const element of input.elements) {
    if (element.range.startFrame >= element.range.endFrame || element.range.endFrame > input.durationFrames
      || element.range.endFrame - element.range.startFrame < 2) throw new Error("Element ranges must be local integer frames inside the scene");
    if (element.widthPixels / project.width < .01 || element.xPixels + element.widthPixels > project.width
      || element.yPixels > project.height) throw new Error("Element width/position exceeds the canvas or existing 1% preset-variant bound");
    if (element.kind === "text" && (element.minFontSize > element.fontSize || element.text !== element.text.trim()
      || element.text.includes("\r"))) throw new Error("Text and its font size must be exact bounded author inputs");
    if (element.kind === "panel" && (element.yPixels + element.heightPixels > project.height
      || element.cornerRadiusPixels > Math.min(element.widthPixels, element.heightPixels) / 2)) throw new Error("Panel geometry exceeds its authored canvas bounds");
  }
  let previousFrame = -1;
  const cueIds = new Set<string>();
  for (const cue of input.semanticCues) {
    if (cue.frame <= previousFrame || cue.frame >= input.durationFrames || cueIds.has(cue.id)
      || new Set(cue.graphicIds).size !== cue.graphicIds.length || new Set(cue.evidenceRefs).size !== cue.evidenceRefs.length) {
      throw new Error("Semantic cues require unique IDs, ascending scene-local frames and unique bindings");
    }
    for (const graphicId of cue.graphicIds) {
      const element = input.elements.find(item => item.id === graphicId);
      if (!element || cue.frame < element.range.startFrame || cue.frame >= element.range.endFrame) throw new Error("Semantic cue must bind an active authored graphic");
    }
    cueIds.add(cue.id); previousFrame = cue.frame;
  }
  if (graphicIds.some(graphicId => !input.semanticCues.some(cue => cue.graphicIds.includes(graphicId)))) throw new Error("Every authored graphic requires a semantic purpose and evidence reference");
  const axis = (property: "centerX" | "centerY" | "zoom"): SpringTargetTrack => ({ fps: project.fps,
    initialPosition: input.camera.initial[property], initialTarget: input.camera.initial[property], initialVelocity: 0,
    spring: structuredClone(input.camera.dynamics), events: input.semanticCues.filter(cue => cue.focus)
      .map(cue => ({ frame: cue.frame, target: cue.focus![property] })) });
  const scene: MotionScene2D = { schema: "editkin.motion-scene-2d/v1", id: sceneId,
    startFrame: input.startFrame, durationFrames: input.durationFrames, fps: project.fps, graphicIds: [...graphicIds],
    camera: { centerX: axis("centerX"), centerY: axis("centerY"), zoom: axis("zoom") },
    semanticCues: input.semanticCues.map(({ focus: _focus, ...cue }) => structuredClone(cue)), safeArea: { ...input.safeArea } };
  const commands: EditorCommand[] = [], editorialGraphics: EditorialPlan["graphics"] = [];
  const layouts = new Map<string, MotionGraphicV2LayoutReceipt>();
  let outlineCodeUnits = 0;
  const graphicBindings: Array<{ graphicId: string; commandIndex: number; presetId: string; presetVariant: MotionPresetVariant;
    range: { startFrame: number; endFrame: number }; layoutReceiptId: string; physicalFont?: MotionGraphicV2LayoutReceipt["physicalFont"] }> = [];
  const safeArea = { left: input.safeArea.left / project.width, right: input.safeArea.right / project.width,
    top: input.safeArea.top / project.height, bottom: input.safeArea.bottom / project.height };
  // Explicit cue frames and target dynamics drive this scene. Style speed does
  // not infer beat times or subdivide/retime the authored scene-local frame grid.
  const passivePhase = { durationFrames: 1, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 1, easing: { type: "linear" as const } };
  for (const element of input.elements) {
    const presetId = element.kind === "panel" ? "reel_native_panel" : "reel_spatial_headline";
    const preset = findMotionGraphicPreset(presetId);
    const range = { startFrame: input.startFrame + element.range.startFrame, endFrame: input.startFrame + element.range.endFrame };
    const text = element.kind === "text" ? element.text : "";
    const fontFamily = element.kind === "text" && element.typographyRole === "body" ? style.typography.bodyFamily : style.typography.headingFamily;
    const overrides = motionPresetOverridesSchema.parse({ name: `${input.reason.slice(0, 120)} · ${element.id}`.slice(0, 160),
      compositeLayer: "foreground", x: element.xPixels / project.width, y: element.yPixels / project.height,
      width: element.widthPixels / project.width, fontFamily, fontWeight: element.kind === "text" ? element.fontWeight : 700,
      fontSize: element.kind === "text" ? element.fontSize : 8, letterSpacing: element.kind === "text" ? element.letterSpacingPixels : 0,
      textColor: element.kind === "text" ? style.palette[element.colorRole] : style.palette.text,
      backgroundColor: element.kind === "panel" && !element.paintV1 ? style.palette[element.colorRole] : "#00000000", accentColor: "#00000000",
      outlineWidth: 0, shadowDepth: 0, cornerRadius: element.kind === "panel" ? element.cornerRadiusPixels : 0,
      motionV2: element.motionV2 ? structuredClone(element.motionV2)
        : { sequence: { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0 }, entrance: { ...passivePhase }, exit: { ...passivePhase } },
      layoutV2: { safeArea, maxLines: element.kind === "text" ? element.maxLines : 1,
        minFontSize: element.kind === "text" ? element.minFontSize : 8, lineGap: element.kind === "text" ? element.lineGapPixels : 0, align: "left" },
      ...(element.kind === "panel" ? { vectorV2: { schema: "editkin.motion-vector/v1", kind: "panel", heightPixels: element.heightPixels, revealFrames: 1 } } : {}),
      ...(element.paintV1 ? { visualStyle: "native_paint", paintV1: element.paintV1 } : {}) });
    const graphic: MotionGraphic = createMotionGraphic(element.id, preset.seed.kind ?? "card", text, range.startFrame / project.fps,
      (range.endFrame - range.startFrame) / project.fps, undefined, { ...preset.seed, ...overrides });
    assertMotionPaintContract(graphic);
    assertMotionGraphicV2Contract(graphic, project.fps);
    let layout: MotionGraphicV2LayoutReceipt;
    if (element.kind === "text") {
      if (!dependencies.prepareText) throw new Error("FONT_BYTES_REQUIRED: actual verified physical glyph preparation is required for scene text");
      assertScopedMotionReadingHold(graphic, project.fps);
      const face = resolveBundledFontFace(fontFamily, element.fontWeight);
      if (!face) throw new Error("FONT_BYTES_REQUIRED: unsupported scene font family");
      const run = await dependencies.prepareText(face.faceId, text);
      layout = motionGraphicV2PhysicalLayoutReceipt(ownedProject, graphic, run);
    } else layout = motionGraphicV2LayoutReceipt(ownedProject, graphic);
    outlineCodeUnits = originalMotionScene2dOutlineCodeUnits(outlineCodeUnits, layout);
    if (Math.abs(layout.box.x - element.xPixels) > 1e-5 || Math.abs(layout.box.y - element.yPixels) > 1e-5
      || Math.abs(layout.box.width - element.widthPixels) > 1e-5) {
      throw new Error("Scene authoring cannot silently clamp/reposition/truncate the declared graphic slot");
    }
    const presetVariant: MotionPresetVariant = { schema: "editkin.motion-preset-variant/v1",
      basePresetSha256: await sha({ id: preset.id, renderer: preset.renderer, seed: preset.seed }), reason: input.reason, overrides };
    const evidenceRefs = [...new Set(input.semanticCues.filter(cue => cue.graphicIds.includes(element.id)).flatMap(cue => cue.evidenceRefs))];
    if (evidenceRefs.length > 8) throw new Error("Graphic editorial evidence exceeds the current eight-reference binding limit");
    graphicBindings.push({ graphicId: graphic.id, commandIndex: commands.length, presetId, presetVariant, range,
      layoutReceiptId: layout.receiptId, ...(layout.physicalFont ? { physicalFont: { ...layout.physicalFont } } : {}) });
    editorialGraphics.push({ id: graphic.id, presetId, presetVariant, range, kind: element.kind === "panel" ? "native_shape" : "title_card",
      purpose: "context", message: text, evidenceRefs });
    layouts.set(graphic.id, layout); commands.push({ type: "add_motion_graphic", graphic });
  }
  const sceneCommandIndex = commands.length;
  commands.push({ type: "add_motion_scene", scene });
  const preview = applyCommand(ownedProject, { type: "batch", commands });
  assertMotionScene2D(scene, preview);
  const preparedSafety = assertMotionScene2DPreparedFrameRange(preview, scene, layouts);
  const [sceneSha256, authoringSha256, styleSha256] = await Promise.all([sha(scene), sha(input), sha(style)]);
  if (project.revision !== input.expectedRevision || canonicalJson(project) !== projectSignature) throw new Error("Scene project changed during preparation; re-read before authoring");
  return { schema: "editkin.original-motion-scene-2d-preparation/v1" as const,
    status: "PREPARED_NOT_APPLIED" as const, readOnly: true as const, projectRevision: input.expectedRevision,
    intent: input.intent, reason: input.reason, scene, commands, editorialGraphics,
    graphicBindings, preparedSafety, sceneSha256, authoringSha256, styleSha256,
    resources: { outlineCodeUnits, maximumOutlineCodeUnits: ORIGINAL_MOTION_SCENE_2D_MAX_OUTLINE_CODE_UNITS,
      graphicCount: graphicIds.length, requestedGraphicFrames: scene.durationFrames * graphicIds.length },
    source: { kind: "original_authored_graphics" as const, noMediaCommands: true as const,
      existingMediaUntouched: true as const, evidenceBoundary: "Authoring references describe purpose; they are not material receipts, measured source semantics, reference-video observation or art approval." },
    v4Binding: { admission: "NOT_V4_ADMITTED" as const, requiresCurrentDesignIdentity: true as const, sceneCommandIndex,
      commands: commands.map((command, commandIndex) => ({ commandIndex, visibleFamilies: motionCommandFamilies(command) })),
      semanticCues: scene.semanticCues.map(cue => ({ ...structuredClone(cue), sceneId,
        absoluteFrame: scene.startFrame + cue.frame, commandIndexes: [...graphicBindings.filter(binding => cue.graphicIds.includes(binding.graphicId)).map(binding => binding.commandIndex), sceneCommandIndex] })) },
    next: "Bind the actual original-graphics source, scene/cue frames, command indexes, preset variants and current trusted design/review policy to a supported v4 route. Preparation is not audit/apply, rendered pixels, continuous art or complete-template acceptance." };
}
