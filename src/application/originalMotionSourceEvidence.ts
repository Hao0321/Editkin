import { createHash } from "node:crypto";
import * as z from "zod/v4";
import type { EditProject } from "../domain/types";
import type { EditorCommand } from "../domain/commandTypes";
import { motionPresetVariantSchema } from "../domain/schema";
import { motionScene2dSchema } from "../domain/motionScene2dSchema";
import { assertMotionScene2D, MOTION_SCENE_2D_LIMITS } from "../domain/motionScene2d";
import { canonicalJson } from "../shared/canonicalJson";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { resolveBundledFontFace } from "../typography/fontFaces";
import { PREPARED_GLYPH_PARSER_VERSION, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { motionGraphicV2LayoutReceipt, motionGraphicV2PhysicalLayoutReceipt } from "../motion/compositionV2";
import type { EditorialPlan } from "./editorialPlan";
import { assertMotionPresetVariantBinding } from "./motionPresetVariant";
import { ORIGINAL_MOTION_SCENE_2D_MAX_OUTLINE_CODE_UNITS, originalMotionScene2dInputSchema,
  prepareOriginalMotionScene2d, type OriginalMotionScene2dInput, type OriginalMotionScene2dDependencies } from "./originalMotionScene2d";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/i);
const index = z.number().int().min(0).max(99);
const range = z.strictObject({ startFrame: z.number().int().nonnegative(), endFrame: z.number().int().positive() });
export const ORIGINAL_MOTION_SOURCE_MAX_BYTES = 192 * 1024;

/** Authorship is disclosed. This is not a license for outside reality claims. */
export const originalMotionSourceRightsSchema = z.strictObject({
  origin: z.literal("self_authored"), medium: z.literal("native_vector_and_glyph"),
  contentKind: z.literal("authored_illustration"), realityProof: z.literal(false), importedReferenceMedia: z.literal(false),
  declaration: z.string().trim().min(1).max(480),
});
export type OriginalMotionSourceRights = z.infer<typeof originalMotionSourceRightsSchema>;
export const originalMotionSourceAuthoringSchema = originalMotionScene2dInputSchema.extend({ sceneId: id });

export const originalMotionAuthoringSourceSchema = z.strictObject({
  sourcePath: z.string().trim().min(1).max(1024), sourceSha256: sha, sourcePayloadSha256: sha,
  bytes: z.number().int().positive().max(256 * 1024),
});
export type OriginalMotionAuthoringSource = z.infer<typeof originalMotionAuthoringSourceSchema>;

const physicalFont = z.strictObject({ schema: z.literal("editkin.motion-physical-layout/v1"),
  faceId: z.string().min(1).max(100), fontSha256: sha, manifestSha256: sha, parserVersion: z.literal(PREPARED_GLYPH_PARSER_VERSION) });
const evidenceSchema = z.strictObject({
  schema: z.literal("editkin.original-motion-source-evidence/v1"), sourceSha256: sha,
  compiler: z.literal("editkin.original-motion-scene-2d-preparation/v1"),
  project: z.strictObject({ id: z.string().min(1).max(256), revision: z.number().int().nonnegative(), sha256: sha,
    width: z.number().int().positive(), height: z.number().int().positive(), fps: z.number().finite().min(1).max(240) }),
  authoring: originalMotionSourceAuthoringSchema, rights: originalMotionSourceRightsSchema,
  authoringSource: originalMotionAuthoringSourceSchema.optional(),
  authoringSha256: sha, styleSha256: sha, sceneSha256: sha, cameraSha256: sha, semanticCuesSha256: sha,
  commandsSha256: sha, preparedSafetySha256: sha, scene: motionScene2dSchema, sceneCommandIndex: index,
  commands: z.array(z.strictObject({ commandIndex: index, type: z.enum(["add_motion_graphic", "add_motion_scene"]), sha256: sha })).min(2).max(33),
  graphicBindings: z.array(z.strictObject({ graphicId: id, commandIndex: index, presetId: id,
    presetVariant: motionPresetVariantSchema, range, layoutReceiptId: z.string().regex(/^motion-v2-[a-f0-9]{8}$/),
    layoutSha256: sha, physicalFont: physicalFont.optional() })).min(1).max(32),
  resources: z.strictObject({ outlineCodeUnits: z.number().int().nonnegative().max(ORIGINAL_MOTION_SCENE_2D_MAX_OUTLINE_CODE_UNITS),
    graphicFrameEvaluations: z.number().int().positive().max(MOTION_SCENE_2D_LIMITS.graphicFrameEvaluations) }),
});
/** Creation schema stays exact; the separately versioned owner revision nests
 * these independently compiled manifests without admitting updates to v1. */
export const originalMotionSourceEvidenceSchema = evidenceSchema;
export const originalMotionSourceEvidenceV1Schema = evidenceSchema;
export type OriginalMotionSourceEvidence = z.infer<typeof evidenceSchema>;
export type OriginalMotionSourceEvidenceV1 = OriginalMotionSourceEvidence;
export const originalMotionSourceSetSchema = z.strictObject({
  schema: z.literal("editkin.original-motion-source/v1"), sources: z.array(evidenceSchema).min(1).max(16),
});
// Empty-only array, not z.tuple([]): same accepted values, but no empty prefixItems in MCP tool JSON Schema.
export const originalMaterialEvidenceSchema = originalMotionSourceSetSchema.extend({ receipts: z.array(z.never()).max(0) });
export type OriginalMotionSourceSet = z.infer<typeof originalMotionSourceSetSchema>;
export interface OriginalMotionSourceEvidenceRuntime {
  prepareText?: OriginalMotionScene2dDependencies["prepareText"];
  /** Trusted producer metadata from an actual full-byte source read. */
  authoringSource?: OriginalMotionAuthoringSource;
  /** Audit/apply caller re-reads each file through its authorized workspace resolver. */
  resolveAuthoringSource?: (expected: OriginalMotionAuthoringSource) => Promise<OriginalMotionAuthoringSource>;
}
type EditorialBinding = Pick<EditorialPlan, "graphics" | "narrative">;
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
function equal(actual: unknown, expected: unknown, label: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`Original Motion ${label} differs from the authored source`);
}
function manifestHash(evidence: OriginalMotionSourceEvidence): string {
  const { sourceSha256: _digest, ...body } = evidence;
  return hash(body);
}
export function originalMotionCueEvidenceReference(sourceSha256: string, cueId: string): string {
  return `original:${sha.parse(sourceSha256)}:cue:${id.parse(cueId)}`;
}
function canonicalEvents(evidence: OriginalMotionSourceEvidence, events: EditorialPlan["graphics"]): EditorialPlan["graphics"] {
  return events.map(event => ({ ...structuredClone(event), evidenceRefs: evidence.scene.semanticCues
    .filter(cue => cue.graphicIds.includes(event.id)).slice(0, 8)
    .map(cue => originalMotionCueEvidenceReference(evidence.sourceSha256, cue.id)) }));
}
function setProjection(raw: OriginalMotionSourceSet): OriginalMotionSourceSet {
  // originalMaterialEvidence adds only a fixed empty receipt tuple. Its schema is
  // checked by the plan caller; this shared verifier still validates all sources.
  const checked = Object.prototype.hasOwnProperty.call(raw, "receipts") ? originalMaterialEvidenceSchema.parse(raw) : originalMotionSourceSetSchema.parse(raw);
  return originalMotionSourceSetSchema.parse({ schema: checked.schema, sources: checked.sources });
}
function admitSet(set: OriginalMotionSourceSet): void {
  if (Buffer.byteLength(canonicalJson(set), "utf8") > ORIGINAL_MOTION_SOURCE_MAX_BYTES) throw new Error("Original Motion source set exceeds its byte bound");
  let frames = 0, outlines = 0, commandCount = 0;
  for (const source of set.sources) {
    frames += source.resources.graphicFrameEvaluations; outlines += source.resources.outlineCodeUnits;
    commandCount += source.commands.length;
  }
  if (frames > MOTION_SCENE_2D_LIMITS.graphicFrameEvaluations || outlines > ORIGINAL_MOTION_SCENE_2D_MAX_OUTLINE_CODE_UNITS || commandCount > 100) {
    throw new Error("Original Motion source set exceeds aggregate frame/outline/command bounds");
  }
}

/** A real compile produces the manifest; supplied checksums never replace it. */
export async function prepareOriginalMotionSourceEvidence(project: EditProject, raw: OriginalMotionScene2dInput,
  rawRights: OriginalMotionSourceRights, commandIndexOffset: number, runtime: OriginalMotionSourceEvidenceRuntime = {}) {
  const authoring = originalMotionSourceAuthoringSchema.parse(raw), rights = originalMotionSourceRightsSchema.parse(rawRights);
  index.parse(commandIndexOffset);
  if (commandIndexOffset + authoring.elements.length + 1 > 100) throw new Error("Original Motion command indexes exceed the v4 100-command bound");
  const projectIdentity = { id: project.id, revision: project.revision, sha256: hash(project), width: project.width, height: project.height, fps: project.fps };
  const runs = new Map<string, PreparedGlyphRun>();
  const preparation = await prepareOriginalMotionScene2d(project, authoring, undefined, { prepareText: runtime.prepareText && (async (faceId, text) => {
    const run = await runtime.prepareText!(faceId, text); runs.set(`${faceId}\u0000${text}`, run); return run;
  }) });
  const bindings = preparation.graphicBindings.map(binding => {
    const command = preparation.commands[binding.commandIndex];
    if (command.type !== "add_motion_graphic") throw new Error("Original Motion compiler returned a foreign graphic command");
    const graphic = command.graphic;
    const run = binding.physicalFont && runs.get(`${binding.physicalFont.faceId}\u0000${graphic.text}`);
    if (!graphic.vectorV2 && !run) throw new Error("Original Motion physical glyph preparation is missing");
    const layout = graphic.vectorV2 ? motionGraphicV2LayoutReceipt(project, graphic) : motionGraphicV2PhysicalLayoutReceipt(project, graphic, run!);
    return { ...structuredClone(binding), commandIndex: commandIndexOffset + binding.commandIndex, layoutSha256: hash(layout) };
  });
  const body = { schema: "editkin.original-motion-source-evidence/v1" as const, compiler: preparation.schema,
    project: projectIdentity, authoring, rights,
    ...(runtime.authoringSource ? { authoringSource: originalMotionAuthoringSourceSchema.parse(runtime.authoringSource) } : {}),
    authoringSha256: hash(authoring), styleSha256: preparation.styleSha256, sceneSha256: preparation.sceneSha256,
    cameraSha256: hash(preparation.scene.camera), semanticCuesSha256: hash(preparation.scene.semanticCues),
    commandsSha256: hash(preparation.commands), preparedSafetySha256: hash(preparation.preparedSafety), scene: structuredClone(preparation.scene),
    sceneCommandIndex: commandIndexOffset + preparation.v4Binding.sceneCommandIndex,
    commands: preparation.commands.map((command, ordinal) => ({ commandIndex: commandIndexOffset + ordinal,
      type: command.type as "add_motion_graphic" | "add_motion_scene", sha256: hash(command) })),
    graphicBindings: bindings, resources: { outlineCodeUnits: preparation.resources.outlineCodeUnits,
      graphicFrameEvaluations: preparation.resources.requestedGraphicFrames } };
  const evidence = evidenceSchema.parse({ ...body, sourceSha256: hash(body) });
  admitSet({ schema: "editkin.original-motion-source/v1", sources: [evidence] });
  // Actual async work has settled before checking drift again. No new receipt
  // status or source manifest can certify audit/apply, pixels or artwork.
  if (hash(project) !== projectIdentity.sha256) throw new Error("Original Motion project changed during source preparation");
  return { evidence, preparation: { ...preparation, editorialGraphics: canonicalEvents(evidence, preparation.editorialGraphics),
    v4Binding: { ...preparation.v4Binding, sceneCommandIndex: evidence.sceneCommandIndex,
      commands: preparation.v4Binding.commands.map(row => ({ ...row, commandIndex: row.commandIndex + commandIndexOffset })),
      semanticCues: preparation.v4Binding.semanticCues.map(row => ({ ...row, commandIndexes: row.commandIndexes.map(value => value + commandIndexOffset) })) } } };
}

/** Synchronous wire integrity/binding. Byte authority is checked again below. */
export function assertOriginalMotionSourcePlanBinding(raw: OriginalMotionSourceSet, commands: readonly EditorCommand[], editorial: EditorialBinding): void {
  const set = setProjection(raw); admitSet(set);
  if (commands.length > 100 || commands.some(command => command.type === "batch" || command.type === "update_motion_scene" || command.type === "delete_motion_scene" || command.type === "revise_motion_scene_graphics")) {
    throw new Error("Original Motion requires flat add-only scene commands within the v4 bound");
  }
  if (commands.some(command => command.type === "set_project_resolution")) {
    throw new Error("Original Motion canvas must be chosen before source preparation; resolution commands invalidate its prepared dimensions");
  }
  const occupied = new Set<string>(), boundIndexes = new Set<number>(), cueTokens = new Map<string, { source: OriginalMotionSourceEvidence; cue: OriginalMotionSourceEvidence["scene"]["semanticCues"][number] }>();
  for (const source of set.sources) {
    if (manifestHash(source) !== source.sourceSha256) throw new Error("Original Motion source manifest hash is invalid");
    equal(source.authoring.expectedRevision, source.project.revision, "revision");
    equal(source.authoringSha256, hash(source.authoring), "authoring hash");
    equal(source.styleSha256, hash(source.authoring.style), "style hash");
    equal(source.sceneSha256, hash(source.scene), "scene hash");
    equal(source.cameraSha256, hash(source.scene.camera), "camera hash");
    equal(source.semanticCuesSha256, hash(source.scene.semanticCues), "cue hash");
    const authored = source.authoring;
    equal({ id: source.scene.id, startFrame: source.scene.startFrame, durationFrames: source.scene.durationFrames, fps: source.scene.fps,
      graphicIds: source.scene.graphicIds, safeArea: source.scene.safeArea }, { id: authored.sceneId, startFrame: authored.startFrame,
      durationFrames: authored.durationFrames, fps: source.project.fps, graphicIds: authored.elements.map(element => element.id), safeArea: authored.safeArea }, "scene scope");
    equal(source.scene.semanticCues, authored.semanticCues.map(({ focus: _focus, ...cue }) => cue), "authored cue frames and purpose");
    for (const axis of ["centerX", "centerY", "zoom"] as const) equal(source.scene.camera[axis], { fps: source.project.fps,
      initialPosition: authored.camera.initial[axis], initialTarget: authored.camera.initial[axis], initialVelocity: 0,
      spring: authored.camera.dynamics, events: authored.semanticCues.filter(cue => cue.focus).map(cue => ({ frame: cue.frame, target: cue.focus![axis] })) }, "authored camera targets");
    const sceneCommand = commands[source.sceneCommandIndex];
    if (sceneCommand?.type !== "add_motion_scene") throw new Error("Original Motion scene command index is missing or foreign");
    equal(sceneCommand.scene, source.scene, "actual scene command");
    const graphics: Extract<EditorCommand, { type: "add_motion_graphic" }>["graphic"][] = [];
    const firstIndex = source.commands[0].commandIndex;
    if (source.commands.length !== authored.elements.length + 1 || source.sceneCommandIndex !== firstIndex + authored.elements.length
      || source.graphicBindings.length !== authored.elements.length) throw new Error("Original Motion command/graphic cardinality is invalid");
    const actual = source.commands.map((binding, ordinal) => {
      if (binding.commandIndex !== firstIndex + ordinal || boundIndexes.has(binding.commandIndex)) throw new Error("Original Motion command indexes must be unique and contiguous");
      const command = commands[binding.commandIndex];
      if (!command || command.type !== binding.type || hash(command) !== binding.sha256) throw new Error("Original Motion actual command hash/type differs");
      boundIndexes.add(binding.commandIndex); return command;
    });
    equal(source.commandsSha256, hash(actual), "command sequence hash");
    for (const scopedId of [source.scene.id, ...source.scene.graphicIds]) {
      if (occupied.has(scopedId)) throw new Error("Original Motion sources cannot share scene/graphic identities"); occupied.add(scopedId);
    }
    for (const [ordinal, binding] of source.graphicBindings.entries()) {
      const element = authored.elements[ordinal], command = actual[ordinal];
      if (command.type !== "add_motion_graphic" || command.graphic.id !== element.id || binding.graphicId !== element.id
        || binding.commandIndex !== firstIndex + ordinal) throw new Error("Original Motion graphic identity/index is invalid");
      const graphic = command.graphic; graphics.push(graphic);
      equal(binding.range, { startFrame: authored.startFrame + element.range.startFrame, endFrame: authored.startFrame + element.range.endFrame }, "graphic frame range");
      if (Math.abs(graphic.timelineStart * source.project.fps - binding.range.startFrame) > 1e-6
        || Math.abs(graphic.duration * source.project.fps - (binding.range.endFrame - binding.range.startFrame)) > 1e-6) throw new Error("Original Motion graphic frame timing differs");
      assertMotionPresetVariantBinding(graphic, binding.presetId, binding.presetVariant);
      if (element.kind === "text") {
        const family = element.typographyRole === "body" ? authored.style.typography.bodyFamily : authored.style.typography.headingFamily;
        const face = resolveBundledFontFace(family, element.fontWeight), physical = binding.physicalFont;
        if (!face || !physical) throw new Error("Original Motion text needs a real physical font identity");
        const spec = bundledFontFaceSpec(face.faceId);
        equal(physical, { schema: "editkin.motion-physical-layout/v1", faceId: spec.faceId, fontSha256: spec.sha256,
          manifestSha256: spec.manifestSha256, parserVersion: PREPARED_GLYPH_PARSER_VERSION }, "physical font catalog");
      } else if (binding.physicalFont) throw new Error("Original Motion vector cannot claim physical text evidence");
      const events = editorial.graphics.filter(event => event.id === graphic.id);
      if (events.length !== 1) throw new Error("Original Motion graphic needs exactly one editorial event");
      const event = events[0];
      equal({ id: event.id, presetId: event.presetId, presetVariant: event.presetVariant, range: event.range, kind: event.kind,
        purpose: event.purpose, message: event.message, trackingId: event.trackingId, matteId: event.matteId }, {
        id: graphic.id, presetId: binding.presetId, presetVariant: binding.presetVariant, range: binding.range,
        kind: element.kind === "panel" ? "native_shape" : "title_card", purpose: "context", message: element.kind === "panel" ? "" : element.text }, "editorial graphic");
      const tokens = source.scene.semanticCues.filter(cue => cue.graphicIds.includes(graphic.id)).map(cue => originalMotionCueEvidenceReference(source.sourceSha256, cue.id));
      if (!event.evidenceRefs.length || event.evidenceRefs.length > 8 || new Set(event.evidenceRefs).size !== event.evidenceRefs.length
        || event.evidenceRefs.some(reference => !tokens.includes(reference))) throw new Error("Original Motion graphic evidence must bind its actual authored cue");
    }
    assertMotionScene2D(source.scene, { ...source.project, motionGraphics: graphics, motionScenes: [source.scene] });
    equal(source.resources.graphicFrameEvaluations, source.scene.durationFrames * source.scene.graphicIds.length, "frame resource count");
    for (const cue of source.scene.semanticCues) cueTokens.set(originalMotionCueEvidenceReference(source.sourceSha256, cue.id), { source, cue });
  }
  for (const [commandIndex, command] of commands.entries()) {
    if (command.type === "add_motion_scene" && !boundIndexes.has(commandIndex)) throw new Error("Original Motion scene command is not source-bound");
    if (command.type === "add_motion_graphic" && occupied.has(command.graphic.id) && !boundIndexes.has(commandIndex)) throw new Error("Original Motion graphic identity has an unbound duplicate command");
    if ((command.type === "update_motion_graphic" || command.type === "delete_motion_graphic") && occupied.has(command.graphicId)) {
      throw new Error("Original Motion source-owned graphics cannot be changed by unbound update/delete commands");
    }
  }
  const covered = new Set<string>();
  for (const beat of editorial.narrative.beats) for (const reference of beat.evidenceRefs) {
    if (!reference.startsWith("original:")) continue;
    const bound = cueTokens.get(reference);
    if (!bound) throw new Error("Original Motion narrative cites a foreign source/cue");
    const absoluteFrame = bound.source.scene.startFrame + bound.cue.frame;
    if (absoluteFrame < beat.range.startFrame || absoluteFrame >= beat.range.endFrame) throw new Error("Original Motion narrative cue is outside its actual beat frame range");
    if (beat.role === "proof") throw new Error("Original authored illustrations cannot be narrative reality proof, even alongside material-looking references");
    covered.add(reference);
  }
  if ([...cueTokens.keys()].some(token => !covered.has(token))) throw new Error("Original Motion narrative must bind every actual authored cue");
  // An original cue cannot be smuggled into an unrelated graphic identity or
  // human identity claim. Existing material identity rules still apply there.
  for (const event of editorial.graphics) for (const reference of event.evidenceRefs) if (reference.startsWith("original:")) {
    const bound = cueTokens.get(reference);
    if (!bound || !bound.cue.graphicIds.includes(event.id) || event.purpose === "identity" || event.purpose === "proof") throw new Error("Original Motion illustration is not identity/reality evidence");
  }
}

/** Recompile from live project and genuine factory runs at both audit and apply. */
export async function verifyOriginalMotionSourceEvidence(raw: OriginalMotionSourceSet, liveProject: EditProject,
  commands: readonly EditorCommand[], editorial: EditorialBinding, runtime: OriginalMotionSourceEvidenceRuntime = {}) {
  const set = setProjection(raw); assertOriginalMotionSourcePlanBinding(set, commands, editorial);
  const before = hash(liveProject);
  const existing = liveProject.motionScenes ?? [];
  if (existing.length + set.sources.length > 16 || existing.reduce((sum, scene) => sum + scene.durationFrames * scene.graphicIds.length, 0)
    + set.sources.reduce((sum, source) => sum + source.resources.graphicFrameEvaluations, 0) > MOTION_SCENE_2D_LIMITS.graphicFrameEvaluations) throw new Error("Original Motion combined project scene/frame budget exceeds bounds");
  for (const source of set.sources) {
    equal(source.project, { id: liveProject.id, revision: liveProject.revision, sha256: before,
      width: liveProject.width, height: liveProject.height, fps: liveProject.fps }, "live project identity");
    let authoringSource: OriginalMotionAuthoringSource | undefined;
    if (source.authoringSource) {
      const current = runtime.resolveAuthoringSource ? await runtime.resolveAuthoringSource(source.authoringSource) : runtime.authoringSource;
      if (!current) throw new Error("Original Motion authoring file requires a current authorized full-byte read");
      authoringSource = originalMotionAuthoringSourceSchema.parse(current); equal(authoringSource, source.authoringSource, "current authoring file");
    }
    const regenerated = await prepareOriginalMotionSourceEvidence(liveProject, source.authoring, source.rights, source.commands[0].commandIndex,
      { prepareText: runtime.prepareText, authoringSource });
    equal(regenerated.evidence, source, "recompiled source/layout/font/safety identities");
    if (source.authoringSource) {
      const after = runtime.resolveAuthoringSource ? await runtime.resolveAuthoringSource(source.authoringSource) : runtime.authoringSource;
      if (!after) throw new Error("Original Motion authoring file requires a current authorized full-byte read after preparation");
      equal(originalMotionAuthoringSourceSchema.parse(after), source.authoringSource, "current authoring file after preparation");
    }
  }
  if (hash(liveProject) !== before) throw new Error("Original Motion live project changed during evidence verification");
  return { schema: "editkin.original-motion-source-verification/v1" as const, state: "SOURCE_BOUND_REVIEW_REQUIRED" as const,
    sourceSetSha256: hash(set), sourceCount: set.sources.length, sceneIds: set.sources.map(source => source.scene.id),
    sourceSha256s: set.sources.map(source => source.sourceSha256), graphicCount: set.sources.reduce((sum, source) => sum + source.graphicBindings.length, 0),
    evidenceBoundary: "Verified authored source and current physical identities; not observed media, audit/apply completion, rendered pixels, outside reality proof or art approval." };
}
