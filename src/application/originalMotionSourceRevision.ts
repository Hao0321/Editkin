import { createHash } from "node:crypto";
import * as z from "zod/v4";
import type { EditorCommand } from "../domain/commandTypes";
import type { EditProject, MotionGraphic } from "../domain/types";
import { motionGraphicSchema } from "../domain/schema";
import { motionScene2dSchema } from "../domain/motionScene2dSchema";
import { MOTION_SCENE_2D_LIMITS } from "../domain/motionScene2d";
import { assertOriginalSceneGraphicRevision } from "../domain/originalSceneGraphicRevision";
import type { OriginalSourceOwnerRevisionCommand } from "../domain/originalSourceOwnerRevision";
import { canonicalJson } from "../shared/canonicalJson";
import type { EditorialPlan } from "./editorialPlan";
import { motionCommandFamilies } from "./motionTreatment";
import { ORIGINAL_MOTION_SCENE_2D_MAX_OUTLINE_CODE_UNITS, type OriginalMotionScene2dDependencies } from "./originalMotionScene2d";
import { ORIGINAL_MOTION_SOURCE_MAX_BYTES, originalMotionSourceEvidenceSchema, originalMotionSourceAuthoringSchema,
  originalMotionSourceRightsSchema, originalMotionAuthoringSourceSchema, prepareOriginalMotionSourceEvidence,
  assertOriginalMotionSourcePlanBinding, originalMotionCueEvidenceReference, type OriginalMotionSourceEvidence } from "./originalMotionSourceEvidence";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const index = z.number().int().min(0).max(99);
const projectIdentitySchema = z.strictObject({ id: z.string().min(1).max(256), revision: z.number().int().nonnegative(), sha256: sha,
  width: z.number().int().positive(), height: z.number().int().positive(), fps: z.number().finite().min(1).max(240) });
export const originalMotionSourceRevisionEvidenceSchema = z.strictObject({
  schema: z.literal("editkin.original-motion-source-revision-evidence/v1"), sourceSha256: sha,
  project: projectIdentitySchema, before: originalMotionSourceEvidenceSchema, after: originalMotionSourceEvidenceSchema,
  scene: motionScene2dSchema, expectedGraphics: z.array(motionGraphicSchema).min(1).max(32),
  commands: z.array(z.strictObject({ commandIndex: index, type: z.literal("revise_original_motion_scene_graphic"), sha256: sha })).min(1).max(32),
  graphicBindings: originalMotionSourceEvidenceSchema.shape.graphicBindings,
  resources: z.strictObject({ outlineCodeUnits: z.number().int().nonnegative().max(ORIGINAL_MOTION_SCENE_2D_MAX_OUTLINE_CODE_UNITS),
    graphicFrameEvaluations: z.number().int().positive().max(MOTION_SCENE_2D_LIMITS.graphicFrameEvaluations) }),
});
export const originalMotionSourceRevisionSetSchema = z.strictObject({
  schema: z.literal("editkin.original-motion-source/v2"), sources: z.tuple([originalMotionSourceRevisionEvidenceSchema]),
});
export const originalMotionSourceRevisionMaterialSchema = originalMotionSourceRevisionSetSchema.extend({ receipts: z.tuple([]) });
export type OriginalMotionSourceRevisionEvidence = z.infer<typeof originalMotionSourceRevisionEvidenceSchema>;
export type OriginalMotionSourceRevisionSet = z.infer<typeof originalMotionSourceRevisionSetSchema>;
/** A separate media-preserving branch; the v1 standalone schema and guards do
 * not accept this evidence or infer its surface from saved graphics. */
export const originalPaintedMediaSourceRevisionEvidenceSchema = originalMotionSourceRevisionEvidenceSchema.extend({
  schema: z.literal("editkin.original-motion-source-revision-evidence/v2"),
  revisionScope: z.literal("painted_authored_overlay_preserve_media"), preservedContextSha256: sha,
});
export const originalPaintedMediaSourceRevisionSetSchema = z.strictObject({
  schema: z.literal("editkin.original-motion-source/v3"), sources: z.tuple([originalPaintedMediaSourceRevisionEvidenceSchema]),
});
export const originalPaintedMediaSourceRevisionMaterialSchema = originalPaintedMediaSourceRevisionSetSchema.extend({ receipts: z.tuple([]) });
export type OriginalPaintedMediaSourceRevisionEvidence = z.infer<typeof originalPaintedMediaSourceRevisionEvidenceSchema>;
export type OriginalPaintedMediaSourceRevisionSet = z.infer<typeof originalPaintedMediaSourceRevisionSetSchema>;
type RevisionEvidence = OriginalMotionSourceRevisionEvidence | OriginalPaintedMediaSourceRevisionEvidence;
const authoringInput = z.strictObject({ authoring: originalMotionSourceAuthoringSchema, rights: originalMotionSourceRightsSchema,
  authoringSource: originalMotionAuthoringSourceSchema });
const revisionInputSchema = z.strictObject({ before: authoringInput, after: authoringInput });
export type OriginalMotionSourceRevisionInput = z.input<typeof revisionInputSchema>;
export interface OriginalMotionSourceRevisionRuntime { prepareText?: OriginalMotionScene2dDependencies["prepareText"] }
type EditorialBinding = Pick<EditorialPlan, "graphics" | "narrative">;
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
function equal(actual: unknown, expected: unknown, label: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`Original source revision ${label} differs`);
}
function projectIdentity(project: EditProject) {
  return { id: project.id, revision: project.revision, sha256: hash(project), width: project.width, height: project.height, fps: project.fps };
}
function sourceHash(source: RevisionEvidence): string {
  const { sourceSha256: _digest, ...body } = source; return hash(body);
}
function creationHash(source: OriginalMotionSourceEvidence): string {
  const { sourceSha256: _digest, ...body } = source; return hash(body);
}
function projection(raw: OriginalMotionSourceRevisionSet): OriginalMotionSourceRevisionSet {
  const parsed = Object.prototype.hasOwnProperty.call(raw, "receipts")
    ? originalMotionSourceRevisionMaterialSchema.parse(raw) : originalMotionSourceRevisionSetSchema.parse(raw);
  const set = originalMotionSourceRevisionSetSchema.parse({ schema: parsed.schema, sources: parsed.sources });
  if (Buffer.byteLength(canonicalJson(set), "utf8") > ORIGINAL_MOTION_SOURCE_MAX_BYTES) throw new Error("Original source revision set exceeds its byte bound");
  return set;
}
function paintedProjection(raw: OriginalPaintedMediaSourceRevisionSet): OriginalPaintedMediaSourceRevisionSet {
  const parsed = Object.prototype.hasOwnProperty.call(raw, "receipts")
    ? originalPaintedMediaSourceRevisionMaterialSchema.parse(raw) : originalPaintedMediaSourceRevisionSetSchema.parse(raw);
  const set = originalPaintedMediaSourceRevisionSetSchema.parse({ schema: parsed.schema, sources: parsed.sources });
  if (Buffer.byteLength(canonicalJson(set), "utf8") > ORIGINAL_MOTION_SOURCE_MAX_BYTES) throw new Error("Original painted-media revision set exceeds its byte bound");
  return set;
}
function preservedAuthoring(authoring: z.infer<typeof originalMotionSourceAuthoringSchema>): unknown {
  const { expectedRevision: _revision, style, elements, ...rest } = authoring;
  const { palette: _palette, typography: _typography, ...fixedStyle } = style;
  return { ...rest, style: fixedStyle, elements: elements.map(element => {
    if (element.kind === "panel") {
      const { motionV2: _motion, colorRole: _color, paintV1: _paint, ...fixed } = element; return fixed;
    }
    const { text: _text, fontWeight: _weight, fontSize: _size, minFontSize: _minimum, maxLines: _lines,
      lineGapPixels: _gap, letterSpacingPixels: _spacing, motionV2: _motion, colorRole: _color, paintV1: _paint, ...fixed } = element;
    return fixed;
  }) };
}
function assertSourcePair(before: z.infer<typeof authoringInput>, after: z.infer<typeof authoringInput>, currentRevision: number): void {
  if (before.authoring.intent !== "standalone_showcase" || after.authoring.intent !== "standalone_showcase"
    || before.authoring.elements.some(element => element.paintV1) || after.authoring.elements.some(element => element.paintV1)) {
    throw new Error("Original source revision v1 only admits standalone unpainted original scenes");
  }
  assertSourcePairIdentity(before, after, currentRevision);
}
function assertSourcePairIdentity(before: z.infer<typeof authoringInput>, after: z.infer<typeof authoringInput>, currentRevision: number): void {
  if (before.authoring.expectedRevision > currentRevision || after.authoring.expectedRevision !== currentRevision) {
    throw new Error("Original source revision current/historical authoring revision is stale or future");
  }
  if (before.authoringSource.sourcePath === after.authoringSource.sourcePath) throw new Error("Original source revision requires separate immutable before and after files");
  equal(before.rights, after.rights, "rights boundary");
  equal(preservedAuthoring(before.authoring), preservedAuthoring(after.authoring), "preserved authoring geometry, reason, camera, cues and ranges");
}
function assertPaintedSourcePair(before: z.infer<typeof authoringInput>, after: z.infer<typeof authoringInput>, currentRevision: number): void {
  if ([before, after].some(input => input.authoring.intent !== "authored_overlay" || input.authoring.elements.some(element =>
    element.paintV1?.schema !== "editkin.motion-paint/v2" || element.paintV1.colorIntent !== "display_rec709_sdr"))) {
    throw new Error("Original painted-media revision requires explicit authored_overlay display paint v2 on every element");
  }
  assertSourcePairIdentity(before, after, currentRevision);
  const topology = (input: z.infer<typeof authoringInput>) => input.authoring.elements.map(element => {
    const paint = element.paintV1!;
    return { ...paint, fill: paint.fill.kind === "solid" ? { kind: "solid", alpha: paint.fill.color.slice(7).toLowerCase() }
      : { ...paint.fill, stops: paint.fill.stops.map(({ color, ...stop }) => ({ ...stop, alpha: color.slice(7).toLowerCase() })) } };
  });
  equal(topology(before), topology(after), "paint topology, alpha encoding, stroke and shadow");
}
function assertPaintedMediaProject(project: EditProject, authoring: z.infer<typeof originalMotionSourceAuthoringSchema>): void {
  if (project.scene3d?.enabled || project.scene25d?.enabled || project.colorManagement?.mode !== "aces2"
    || project.colorManagement.outputTransform !== "rec709_sdr" || project.motionGraphics.length > 4) {
    throw new Error("Original painted-media revision requires flat ACES2 rec709_sdr with at most four project graphics");
  }
  if (project.tracks.some(track => track.clips.some(clip => clip.floatingFrame))
    || project.compositions.some(composition => composition.tracks.some(track => track.clips.some(clip => clip.floatingFrame)))) {
    throw new Error("Original painted-media revision does not admit floating-video frames in ACES2");
  }
  const sceneStart = authoring.startFrame / project.fps, sceneEnd = (authoring.startFrame + authoring.durationFrames) / project.fps;
  if (!project.tracks.some(track => track.kind === "video" && track.clips.some(clip =>
    Number.isFinite(clip.duration) && clip.duration > 0 && Number.isFinite(clip.timelineStart) && clip.timelineStart >= 0
    && clip.timelineStart < sceneEnd && clip.timelineStart + clip.duration > sceneStart
    && project.assets.some(asset => asset.id === clip.assetId && asset.kind === "video" && Number.isFinite(asset.duration) && asset.duration > 0)))) {
    throw new Error("Original painted-media revision requires an actual saved video clip; authoring rights do not certify its media source");
  }
}
/** Exact canonical context projection shared with the canonical controller.
 * Remove only mutable top-level commit metadata and the target owner. Keep
 * director, media, colours, other owners and omitted optional fields intact. */
export function originalPaintedMediaRevisionPreservedContext(project: EditProject, sceneId: string): unknown {
  const owner = project.motionScenes?.filter(scene => scene.id === sceneId) ?? [];
  if (owner.length !== 1) throw new Error("Original painted-media context requires one actual scene owner");
  const ids = new Set(owner[0].graphicIds);
  const { revision: _revision, updatedAt: _updatedAt, aestheticSystem: _aesthetic, ...context } = structuredClone(project);
  return { ...context, motionScenes: context.motionScenes!.filter(scene => scene.id !== sceneId),
    motionGraphics: context.motionGraphics.filter(graphic => !ids.has(graphic.id)) };
}
export function assertOriginalPaintedMediaRevisionPreservedContext(before: EditProject, after: EditProject, sceneId: string): void {
  equal(originalPaintedMediaRevisionPreservedContext(after, sceneId), originalPaintedMediaRevisionPreservedContext(before, sceneId), "preserved full media/project context");
}
function ownerFree(project: EditProject, sceneId: string, revision: number): { project: EditProject; scene: NonNullable<EditProject["motionScenes"]>[number]; graphics: MotionGraphic[] } {
  const scenes = project.motionScenes?.filter(scene => scene.id === sceneId) ?? [];
  if (scenes.length !== 1) throw new Error("Original source revision requires one actual current scene owner");
  const scene = scenes[0], graphics = scene.graphicIds.map(id => {
    const matches = project.motionGraphics.filter(graphic => graphic.id === id);
    if (matches.length !== 1) throw new Error("Original source revision owner graphic is missing or duplicated");
    const graphic = matches[0];
    if (graphic.templateOwner || project.referenceMotionInstances?.some(instance => instance.roles.some(role => role.kind === "graphic" && role.id === id))
      || project.motionScenes?.some(other => other.id !== scene.id && other.graphicIds.includes(id))) throw new Error("Original source revision graphic has another owner");
    return graphic;
  });
  const removed = new Set(scene.graphicIds), analysis = structuredClone(project);
  analysis.motionScenes = analysis.motionScenes?.filter(item => item.id !== sceneId);
  analysis.motionGraphics = analysis.motionGraphics.filter(graphic => !removed.has(graphic.id));
  // Explicit analysis context, not a rewrite of the file or live project. The
  // exact raw author's historical revision remains pinned in nested evidence.
  analysis.revision = revision;
  return { project: analysis, scene, graphics };
}
function compiledGraphics(preparation: Awaited<ReturnType<typeof prepareOriginalMotionSourceEvidence>>["preparation"]): MotionGraphic[] {
  return preparation.commands.filter((command): command is Extract<EditorCommand, { type: "add_motion_graphic" }> => command.type === "add_motion_graphic")
    .map(command => structuredClone(command.graphic));
}
function assertCurrentSceneBudget(project: EditProject, ownerSceneId: string,
  after: z.infer<typeof originalMotionSourceAuthoringSchema>): void {
  const scenes = project.motionScenes ?? [];
  if (scenes.length > MOTION_SCENE_2D_LIMITS.scenes) throw new Error("Original source revision current project exceeds the 16-scene bound");
  let currentEvaluations = 0, revisedEvaluations = 0;
  for (const scene of scenes) {
    const cost = scene.durationFrames * scene.graphicIds.length;
    const revisedCost = scene.id === ownerSceneId ? after.durationFrames * after.elements.length : cost;
    if (!Number.isSafeInteger(cost) || cost < 0 || cost > MOTION_SCENE_2D_LIMITS.graphicFrameEvaluations - currentEvaluations
      || !Number.isSafeInteger(revisedCost) || revisedCost < 0 || revisedCost > MOTION_SCENE_2D_LIMITS.graphicFrameEvaluations - revisedEvaluations) {
      throw new Error("Original source revision current/revised project exceeds 100000 aggregate graphic-frame evaluations");
    }
    currentEvaluations += cost; revisedEvaluations += revisedCost;
  }
}

/** Shared independent compiler. Branch admission precedes this call and is
 * never selected by changing an author's intent or saved scene fields. */
async function compileRevision(project: EditProject, input: z.infer<typeof revisionInputSchema>,
  commandIndexOffset: number, runtime: OriginalMotionSourceRevisionRuntime) {
  index.parse(commandIndexOffset);
  const identity = projectIdentity(project);
  if (commandIndexOffset + input.after.authoring.elements.length > 100) throw new Error("Original source revision commands exceed the v4 bound");
  const beforeContext = ownerFree(project, input.before.authoring.sceneId, input.before.authoring.expectedRevision);
  // Collection occupancy is independent of the two physical compilations' work
  // budget. Admit the actual saved collection and owner replacement first.
  assertCurrentSceneBudget(project, beforeContext.scene.id, input.after.authoring);
  const before = await prepareOriginalMotionSourceEvidence(beforeContext.project, input.before.authoring, input.before.rights, 0,
    { prepareText: runtime.prepareText, authoringSource: input.before.authoringSource });
  const expectedGraphics = compiledGraphics(before.preparation);
  equal(before.preparation.scene, beforeContext.scene, "actual before scene owner");
  equal(expectedGraphics, beforeContext.graphics, "actual before ordered owner graphics");
  const afterContext = ownerFree(project, input.after.authoring.sceneId, input.after.authoring.expectedRevision);
  const after = await prepareOriginalMotionSourceEvidence(afterContext.project, input.after.authoring, input.after.rights, 0,
    { prepareText: runtime.prepareText, authoringSource: input.after.authoringSource });
  const graphics = compiledGraphics(after.preparation);
  equal(after.preparation.scene, beforeContext.scene, "unchanged after scene, camera, cues and ranges");
  assertOriginalSceneGraphicRevision(project, { type: "revise_motion_scene_graphics", expectedRevision: project.revision,
    expectedScene: beforeContext.scene, expectedGraphics, graphics });
  if (canonicalJson(graphics) === canonicalJson(expectedGraphics)) throw new Error("Original source revision contains no actual content change");
  const resources = { outlineCodeUnits: before.evidence.resources.outlineCodeUnits + after.evidence.resources.outlineCodeUnits,
    graphicFrameEvaluations: before.evidence.resources.graphicFrameEvaluations + after.evidence.resources.graphicFrameEvaluations };
  const commands: OriginalSourceOwnerRevisionCommand[] = graphics.map((graphic, ordinal) => ({ type: "revise_original_motion_scene_graphic",
    sceneId: beforeContext.scene.id, expectedGraphic: structuredClone(expectedGraphics[ordinal]), graphic }));
  const graphicBindings = after.evidence.graphicBindings.map((binding, ordinal) => ({ ...structuredClone(binding), commandIndex: commandIndexOffset + ordinal }));
  const body = { project: identity,
    before: before.evidence, after: after.evidence, scene: structuredClone(beforeContext.scene), expectedGraphics,
    commands: commands.map((command, ordinal) => ({ commandIndex: commandIndexOffset + ordinal, type: command.type, sha256: hash(command) })),
    graphicBindings, resources };
  if (hash(project) !== identity.sha256) throw new Error("Original source revision project changed during both physical compilations");
  return { body, commands, graphicBindings, resources, before, after };
}
function revisionPreparation(project: EditProject, evidence: RevisionEvidence, compiled: Awaited<ReturnType<typeof compileRevision>>) {
  const { commands, graphicBindings, resources, before, after } = compiled;
  const editorialGraphics = after.preparation.editorialGraphics.map(event => ({ ...structuredClone(event), evidenceRefs: evidence.scene.semanticCues
    .filter(cue => cue.graphicIds.includes(event.id)).slice(0, 8).map(cue => originalMotionCueEvidenceReference(evidence.sourceSha256, cue.id)) }));
  return { schema: evidence.schema === "editkin.original-motion-source-revision-evidence/v1"
    ? "editkin.original-motion-source-revision-preparation/v1" as const : "editkin.original-motion-source-revision-preparation/v2" as const,
    status: "PREPARED_NOT_APPLIED" as const, readOnly: true as const, projectRevision: project.revision,
    ...(evidence.schema === "editkin.original-motion-source-revision-evidence/v2" ? { revisionScope: evidence.revisionScope, preservedContextSha256: evidence.preservedContextSha256 } : {}),
    scene: structuredClone(evidence.scene), commands, editorialGraphics, graphicBindings, resources,
    preparedSafety: { before: before.preparation.preparedSafety, after: after.preparation.preparedSafety },
    v4Binding: { admission: "SOURCE_BOUND_REVISION_REVIEW_REQUIRED" as const, requiresCurrentDesignIdentity: true as const,
      commands: commands.map((command, ordinal) => ({ commandIndex: evidence.commands[ordinal].commandIndex,
        visibleFamilies: motionCommandFamilies({ type: "add_motion_graphic", graphic: command.graphic }) })),
      semanticCues: evidence.scene.semanticCues.map(cue => ({ ...structuredClone(cue), sceneId: evidence.scene.id,
        absoluteFrame: evidence.scene.startFrame + cue.frame, commandIndexes: graphicBindings.filter(binding => cue.graphicIds.includes(binding.graphicId)).map(binding => binding.commandIndex) })) },
    sourceBoundary: "Source-only before/after physical recompile; not applied, rendered, artwork-approved, installed or full-product certified." };
}

/** Original v1 admission stays genuinely media-free and unpainted. */
export async function prepareOriginalMotionSourceRevisionEvidence(project: EditProject, raw: OriginalMotionSourceRevisionInput,
  commandIndexOffset: number, runtime: OriginalMotionSourceRevisionRuntime = {}) {
  const input = revisionInputSchema.parse(raw);
  if (project.assets.length || project.tracks.some(track => track.clips.length) || project.captions.length
    || project.scene3d?.enabled || project.scene25d?.enabled) throw new Error("Original source revision v1 requires a genuinely media-free 2D project");
  assertSourcePair(input.before, input.after, project.revision);
  const compiled = await compileRevision(project, input, commandIndexOffset, runtime);
  const body = { schema: "editkin.original-motion-source-revision-evidence/v1" as const, ...compiled.body };
  const evidence = originalMotionSourceRevisionEvidenceSchema.parse({ ...body, sourceSha256: hash(body) });
  projection({ schema: "editkin.original-motion-source/v2", sources: [evidence] });
  return { evidence, preparation: { ...revisionPreparation(project, evidence, compiled),
    schema: "editkin.original-motion-source-revision-preparation/v1" as const } };
}

/** Explicit new painted overlay surface. The immutable raw source pair and
 * actual full media graph are independently recompiled; no media proof is
 * inferred from the native vector/glyph authorship declaration. */
export async function prepareOriginalPaintedMediaSourceRevisionEvidence(project: EditProject, raw: OriginalMotionSourceRevisionInput,
  commandIndexOffset: number, runtime: OriginalMotionSourceRevisionRuntime = {}) {
  const input = revisionInputSchema.parse(raw);
  assertPaintedSourcePair(input.before, input.after, project.revision);
  assertPaintedMediaProject(project, input.after.authoring);
  const preservedContextSha256 = hash(originalPaintedMediaRevisionPreservedContext(project, input.before.authoring.sceneId));
  const compiled = await compileRevision(project, input, commandIndexOffset, runtime);
  const body = { schema: "editkin.original-motion-source-revision-evidence/v2" as const,
    revisionScope: "painted_authored_overlay_preserve_media" as const, preservedContextSha256, ...compiled.body };
  const evidence = originalPaintedMediaSourceRevisionEvidenceSchema.parse({ ...body, sourceSha256: hash(body) });
  paintedProjection({ schema: "editkin.original-motion-source/v3", sources: [evidence] });
  equal(hash(originalPaintedMediaRevisionPreservedContext(project, evidence.scene.id)), preservedContextSha256, "full preserved media/project context during physical compilation");
  return { evidence, preparation: { ...revisionPreparation(project, evidence, compiled),
    schema: "editkin.original-motion-source-revision-preparation/v2" as const } };
}

function exactRevisionCommands(source: RevisionEvidence, commands: readonly EditorCommand[]): OriginalSourceOwnerRevisionCommand[] {
  if (sourceHash(source) !== source.sourceSha256 || creationHash(source.before) !== source.before.sourceSha256 || creationHash(source.after) !== source.after.sourceSha256) {
    throw new Error("Original source revision manifest hash is invalid");
  }
  const firstIndex = source.commands[0].commandIndex;
  if (source.commands.length !== source.scene.graphicIds.length || source.expectedGraphics.length !== source.scene.graphicIds.length) throw new Error("Original source revision graphic cardinality differs");
  return source.commands.map((binding, ordinal) => {
    const command = commands[binding.commandIndex];
    if (binding.commandIndex !== firstIndex + ordinal || command?.type !== "revise_original_motion_scene_graphic"
      || hash(command) !== binding.sha256 || command.sceneId !== source.scene.id
      || command.expectedGraphic.id !== source.scene.graphicIds[ordinal] || command.graphic.id !== source.scene.graphicIds[ordinal]) {
      throw new Error("Original source revision actual command hash/index/owner differs");
    }
    equal(command.expectedGraphic, source.expectedGraphics[ordinal], "expected graphic command");
    return command;
  });
}
function nestedEditorial(source: RevisionEvidence, nested: OriginalMotionSourceEvidence, editorial: EditorialBinding,
  before: boolean): EditorialBinding {
  const references = new Map(source.scene.semanticCues.map(cue => [originalMotionCueEvidenceReference(source.sourceSha256, cue.id),
    originalMotionCueEvidenceReference(nested.sourceSha256, cue.id)]));
  const graphics = editorial.graphics.map(event => {
    const ordinal = nested.authoring.elements.findIndex(element => element.id === event.id);
    if (ordinal < 0) return structuredClone(event);
    const element = nested.authoring.elements[ordinal], binding = nested.graphicBindings[ordinal];
    return { ...structuredClone(event), ...(before ? { presetId: binding.presetId, presetVariant: structuredClone(binding.presetVariant),
      range: structuredClone(binding.range), kind: element.kind === "panel" ? "native_shape" as const : "title_card" as const,
      purpose: "context" as const, message: element.kind === "panel" ? "" : element.text } : {}),
      evidenceRefs: event.evidenceRefs.map(reference => references.get(reference) ?? reference) };
  });
  return { graphics, narrative: { ...structuredClone(editorial.narrative), beats: editorial.narrative.beats.map(beat => ({ ...structuredClone(beat),
    evidenceRefs: beat.evidenceRefs.map(reference => references.get(reference) ?? reference) })) } };
}

/** Wire integrity only; actual source reads and independent recompilation are
 * mandatory at audit/apply before the host can capture opaque authority. */
function assertRevisionPlanBinding(source: RevisionEvidence, commands: readonly EditorCommand[], editorial: EditorialBinding): void {
  const actual = exactRevisionCommands(source, commands);
  if (commands.length > 100 || commands.some(command => command.type !== "revise_original_motion_scene_graphic" && command.type !== "set_aesthetic_system")
    || commands.filter(command => command.type === "set_aesthetic_system").length > 1
    || commands.filter(command => command.type === "revise_original_motion_scene_graphic").length !== actual.length) {
    throw new Error("Original source revision requires only one flat complete owner replacement plus aesthetic metadata");
  }
  if (!source.before.authoringSource || !source.after.authoringSource) throw new Error("Original source revision requires both actual immutable authoring files");
  const before = { authoring: source.before.authoring, rights: source.before.rights, authoringSource: source.before.authoringSource },
    after = { authoring: source.after.authoring, rights: source.after.rights, authoringSource: source.after.authoringSource };
  if (source.schema === "editkin.original-motion-source-revision-evidence/v1") assertSourcePair(before, after, source.project.revision);
  else assertPaintedSourcePair(before, after, source.project.revision);
  equal(source.scene, source.before.scene, "before scene"); equal(source.scene, source.after.scene, "after scene");
  for (const nested of [source.before, source.after]) {
    equal({ id: nested.project.id, width: nested.project.width, height: nested.project.height, fps: nested.project.fps },
      { id: source.project.id, width: source.project.width, height: source.project.height, fps: source.project.fps }, "nested project dimensions");
  }
  equal(source.graphicBindings, source.after.graphicBindings.map((binding, ordinal) => ({ ...binding, commandIndex: source.commands[0].commandIndex + ordinal })), "after graphic bindings");
  equal(source.resources, { outlineCodeUnits: source.before.resources.outlineCodeUnits + source.after.resources.outlineCodeUnits,
    graphicFrameEvaluations: source.before.resources.graphicFrameEvaluations + source.after.resources.graphicFrameEvaluations }, "actual two-compile work budget");
  for (const [nested, graphics, before] of [[source.before, source.expectedGraphics, true], [source.after, actual.map(command => command.graphic), false]] as const) {
    const projected: EditorCommand[] = [...graphics.map(graphic => ({ type: "add_motion_graphic" as const, graphic })), { type: "add_motion_scene", scene: nested.scene }];
    assertOriginalMotionSourcePlanBinding({ schema: "editkin.original-motion-source/v1", sources: [nested] }, projected, nestedEditorial(source, nested, editorial, before));
  }
}
export function assertOriginalMotionSourceRevisionPlanBinding(raw: OriginalMotionSourceRevisionSet, commands: readonly EditorCommand[], editorial: EditorialBinding): void {
  assertRevisionPlanBinding(projection(raw).sources[0], commands, editorial);
}
export function assertOriginalPaintedMediaSourceRevisionPlanBinding(raw: OriginalPaintedMediaSourceRevisionSet, commands: readonly EditorCommand[], editorial: EditorialBinding): void {
  assertRevisionPlanBinding(paintedProjection(raw).sources[0], commands, editorial);
}

/** Reporting projection keeps physical plan indexes. It is not authority and
 * never translates a raw/manual/partial revision into execution permission. */
export function originalMotionSourceRevisionVisibleProjection(raw: OriginalMotionSourceRevisionSet | undefined, commands: readonly EditorCommand[]): EditorCommand[] {
  if (!raw) return [...commands];
  return revisionVisibleProjection(projection(raw).sources[0], commands);
}
export function originalPaintedMediaSourceRevisionVisibleProjection(raw: OriginalPaintedMediaSourceRevisionSet | undefined, commands: readonly EditorCommand[]): EditorCommand[] {
  if (!raw) return [...commands];
  return revisionVisibleProjection(paintedProjection(raw).sources[0], commands);
}
function revisionVisibleProjection(source: RevisionEvidence, commands: readonly EditorCommand[]): EditorCommand[] {
  const actual = exactRevisionCommands(source, commands);
  const graphics = new Map(source.commands.map((binding, ordinal) => [binding.commandIndex, actual[ordinal].graphic]));
  if (commands.some((command, index) => command.type === "revise_original_motion_scene_graphic" && !graphics.has(index))) throw new Error("Original source revision contains an unbound graphic command");
  return commands.map((command, index) => graphics.has(index) ? { type: "add_motion_graphic", graphic: structuredClone(graphics.get(index)!) } : command);
}

/** The host verifies both payloads/raw-byte/font declarations around this call.
 * No editable JSON proof is returned or issued by this verifier. */
export async function verifyOriginalMotionSourceRevisionEvidence(raw: OriginalMotionSourceRevisionSet, liveProject: EditProject,
  commands: readonly EditorCommand[], editorial: EditorialBinding, runtime: OriginalMotionSourceRevisionRuntime = {}) {
  const set = projection(raw); assertOriginalMotionSourceRevisionPlanBinding(set, commands, editorial);
  const verified = await verifyRevision(set, liveProject, runtime);
  return { ...verified, schema: "editkin.original-motion-source-revision-verification/v1" as const };
}
export async function verifyOriginalPaintedMediaSourceRevisionEvidence(raw: OriginalPaintedMediaSourceRevisionSet, liveProject: EditProject,
  commands: readonly EditorCommand[], editorial: EditorialBinding, runtime: OriginalMotionSourceRevisionRuntime = {}) {
  const set = paintedProjection(raw); assertOriginalPaintedMediaSourceRevisionPlanBinding(set, commands, editorial);
  const verified = await verifyRevision(set, liveProject, runtime);
  return { ...verified, schema: "editkin.original-motion-source-revision-verification/v2" as const };
}
async function verifyRevision(set: OriginalMotionSourceRevisionSet | OriginalPaintedMediaSourceRevisionSet, liveProject: EditProject,
  runtime: OriginalMotionSourceRevisionRuntime) {
  const source = set.sources[0], before = hash(liveProject);
  equal(source.project, projectIdentity(liveProject), "current full live project identity");
  if (source.schema === "editkin.original-motion-source-revision-evidence/v2") {
    equal(source.preservedContextSha256, hash(originalPaintedMediaRevisionPreservedContext(liveProject, source.scene.id)), "current full preserved media/project context");
  }
  const input = {
    before: { authoring: source.before.authoring, rights: source.before.rights, authoringSource: source.before.authoringSource! },
    after: { authoring: source.after.authoring, rights: source.after.rights, authoringSource: source.after.authoringSource! },
  };
  const regenerated = source.schema === "editkin.original-motion-source-revision-evidence/v1"
    ? await prepareOriginalMotionSourceRevisionEvidence(liveProject, input, source.commands[0].commandIndex, runtime)
    : await prepareOriginalPaintedMediaSourceRevisionEvidence(liveProject, input, source.commands[0].commandIndex, runtime);
  equal(regenerated.evidence, source, "independently recompiled before/after source, font, layout and every-frame identities");
  if (hash(liveProject) !== before) throw new Error("Original source revision live project changed during verification");
  return { schema: source.schema === "editkin.original-motion-source-revision-evidence/v1"
    ? "editkin.original-motion-source-revision-verification/v1" as const : "editkin.original-motion-source-revision-verification/v2" as const,
    state: "SOURCE_BOUND_REVIEW_REQUIRED" as const,
    sourceSetSha256: hash(set), sourceCount: 1, sceneIds: [source.scene.id], sourceSha256s: [source.sourceSha256], graphicCount: source.graphicBindings.length,
    ...(source.schema === "editkin.original-motion-source-revision-evidence/v2" ? { revisionScope: source.revisionScope, preservedContextSha256: source.preservedContextSha256 } : {}),
    evidenceBoundary: "Authorized file checks plus source/physical recompile only; not atomic apply, pixels, reality evidence, artwork or installation." };
}
