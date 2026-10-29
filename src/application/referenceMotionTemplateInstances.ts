import type { ClipCreativeState, ClipKeyframe, ClipMask, EditProject, MotionGraphic, TimelineClip, TimelineTrack } from "../domain/types";
import type { EditorCommand } from "../domain/commandTypes";
import { applyCommand, type EditorCommandContext } from "../domain/commands";
import { issueNativePaintOwnerRevisionProof } from "../domain/nativePaintOwnerRevision";
import { referenceMotionInstanceSchema, referenceMotionTemplateRevisionPatchSchema,
  type ReferenceMotionTemplateInstance, type ReferenceMotionInstanceRole, type ReferenceMotionTemplateRevisionPatch } from "../domain/referenceMotionInstance";
import { referenceMotionTemplate, REFERENCE_MOTION_SEMANTIC_REPLACE_CONTRACT, REFERENCE_MOTION_SOURCE_OVERLAY_CONTRACT, REFERENCE_MOTION_SOURCE_OVERLAY_V2_CONTRACT, REFERENCE_MOTION_EDITORIAL_CONTRACT, REFERENCE_MOTION_SOURCE_BACKDROP_CONTRACT, REFERENCE_MOTION_DESIGN_CONTRACT, REFERENCE_MOTION_DESIGN_THEMES, REFERENCE_MOTION_NATIVE_PAINT_PRESENTATION_CONTRACT, REFERENCE_MOTION_DISPLAY_PAINT_PRESENTATION_CONTRACT, isNativeReferenceMotionPresentation, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { fixedTemplateWindowKeyRevisionV3 } from "./fixedTemplateWindowRevisionV3";
import { FIXED_TEMPLATE_WINDOW_V3_CONTRACT } from "../domain/fixedTemplateWindowV3";
import { GRAPHIC_TIMING_V2_CONTRACT } from "../domain/graphicTimingV2";
import { GRAPHIC_COPY_FIT_V3_CONTRACT } from "../domain/graphicCopyFitV3";
import { GRAPHIC_POSTER_RANGE_V3_CONTRACT } from "../domain/graphicPosterRangeV3";
import { GRAPHIC_HOLD_BEAT_V3_CONTRACT } from "../domain/graphicHoldBeatV3";
import { GRAPHIC_CADENCE_CONTRACT, GRAPHIC_CADENCE_KINETIC_CONTRACT, compileGraphicCadence, graphicCadenceContract } from "../motion/graphicCadence";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { canonicalJson } from "../shared/canonicalJson";
import { prepareReferenceMotionTemplate, normalizeReferenceMotionTemplateInput, REFERENCE_MOTION_INSTANCE_RECIPE_VERSION,
  REFERENCE_MOTION_PREPARATION_TIMEOUT_MS, type ReferenceMotionTemplatePreparationDependencies } from "./referenceMotionTemplates";
import { yieldToBrowser } from "./templateFollowProgress";

export { referenceMotionTemplateRevisionPatchSchema };
export type { ReferenceMotionTemplateRevisionPatch };
export type ReferenceMotionTemplateInstanceIdFactory = (prefix: string, roleKey?: string) => string;
const revisionContexts = new WeakMap<object, EditorCommandContext>();
/** Only the live compiler result owns this authority; serialized preparations do not. */
export function referenceMotionTemplateRevisionCommandContext(prepared: object): EditorCommandContext | undefined {
  return revisionContexts.get(prepared);
}
export interface ReferenceMotionTemplateRevisionDependencies extends ReferenceMotionTemplatePreparationDependencies {
  expectedInstanceRevision: number;
  idFactory?: ReferenceMotionTemplateInstanceIdFactory;
}
export interface ReferenceMotionTemplateInstanceInspection {
  status: "CURRENT" | "EDITED" | "MISSING" | "ENVIRONMENT_CHANGED";
  reason: string;
  instance?: ReferenceMotionTemplateInstance;
}

async function digest(value: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is required for saved template identity");
  const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const clips = (project: EditProject) => project.tracks.flatMap(track => track.clips);
function primary(project: EditProject, instance: { input: Pick<ReferenceMotionTemplateInstance["input"], "clipId"> }) {
  const clip = clips(project).find(clip => clip.id === instance.input.clipId);
  if (!clip) throw new Error("MISSING: primary template source clip no longer exists");
  return clip;
}
function element(project: EditProject, role: ReferenceMotionInstanceRole): unknown {
  if (role.kind === "graphic") return project.motionGraphics.find(graphic => graphic.id === role.id);
  if (role.kind === "track") return project.tracks.find(track => track.id === role.id);
  if (role.kind === "clip") return project.tracks.find(track => track.id === role.parentId)?.clips.find(clip => clip.id === role.id);
  const clip = clips(project).find(clip => clip.id === role.parentId);
  return role.kind === "mask" ? clip?.masks?.find(mask => mask.id === role.id) : clip?.keyframes.find(key => key.id === role.id);
}

/** External graph dependencies cannot be silently deleted during scratch reconstruction. A re-apply tolerates the
 * template's own layers being gone (`tolerateMissing`): what is left of them is rebuilt, never anything external. */
function assertIsolated(project: EditProject, instance: ReferenceMotionTemplateInstance, tolerateMissing = false): void {
  const owned = new Set(instance.roles.map(role => role.id));
  const generatedClips = new Set(instance.roles.filter(role => role.kind === "clip" && role.id !== instance.input.clipId).map(role => role.id));
  if (instance.roles.some(role => role.kind === "clip" && role.id === instance.input.clipId)) {
    const original = primary(project, instance);
    if (original.keyframes.some(key => !owned.has(key.id)) || original.masks?.some(mask => mask.enabled && !owned.has(mask.id))) {
      throw new Error("EDITED: primary template visuals contain an external keyframe or enabled mask");
    }
  }
  for (const role of instance.roles) {
    if (element(project, role) === undefined) {
      if (tolerateMissing) continue;
      throw new Error(`MISSING: template role ${role.key} no longer exists in its original parent`);
    }
    if (role.kind === "track") {
      const track = project.tracks.find(track => track.id === role.id)!;
      if (track.clips.some(clip => !generatedClips.has(clip.id))) throw new Error("EDITED: a generated template track contains an external clip");
    }
  }
  for (const clip of clips(project)) {
    if (owned.has(clip.id)) continue;
    if ((clip.layer?.parentClipId && owned.has(clip.layer.parentClipId))
      || (clip.layer?.trackMatte && owned.has(clip.layer.trackMatte.sourceClipId))) {
      throw new Error("EDITED: an external clip depends on a template source role");
    }
  }
  if (project.motionTracks.some(track => generatedClips.has(track.clipId))) throw new Error("EDITED: external motion tracking depends on a generated template clip");
  if (project.motionScenes?.some(scene => scene.graphicIds.some(id => owned.has(id)))) throw new Error("EDITED: an external Motion scene owns a template graphic");
  for (const other of project.referenceMotionInstances ?? []) {
    if (other.id !== instance.id && other.roles.some(role => owned.has(role.id))) throw new Error("EDITED: template roles have another instance owner");
  }
}

function scopePayload(project: EditProject, instance: ReferenceMotionTemplateInstance) {
  assertIsolated(project, instance);
  const original = primary(project, instance);
  const ownedMaskIds = new Set(instance.roles.filter(role => role.kind === "mask" && role.parentId === original.id).map(role => role.id));
  const ownedKeyIds = new Set(instance.roles.filter(role => role.kind === "keyframe" && role.parentId === original.id).map(role => role.id));
  const primaryManaged = instance.roles.some(role => role.kind === "clip" && role.id === original.id);
  const graphicIds = new Set(instance.roles.filter(role => role.kind === "graphic").map(role => role.id));
  const originalTrack = project.tracks.find(track => track.id === original.trackId);
  const sourceAssets = [original.assetId, ...instance.input.sources.map(source => source.assetId)].map(id => {
    const asset = project.assets.find(asset => asset.id === id);
    if (!asset) throw new Error("MISSING: template source asset no longer exists");
    return { id: asset.id, uri: asset.uri, duration: asset.duration, width: asset.width, height: asset.height,
      displayAspectRatio: asset.displayAspectRatio, interpretation: asset.color?.interpretation ?? "rec709", compositionId: asset.compositionId };
  });
  return { input: instance.input, frameFormat: instance.frameFormat, dependencies: instance.dependencies, primaryBefore: instance.primaryBefore,
    primarySource: { id: original.id, assetId: original.assetId, trackId: original.trackId, sourceStart: original.sourceStart,
      timelineStart: original.timelineStart, duration: original.duration,
      track: originalTrack && { id: originalTrack.id, kind: originalTrack.kind, locked: originalTrack.locked, muted: originalTrack.muted } },
    sourceAssets, managedDrawOrder: project.motionGraphics.filter(graphic => graphicIds.has(graphic.id)).map(graphic => graphic.id),
    roles: [...instance.roles].sort((a, b) => a.key.localeCompare(b.key)).map(role => {
      let value = element(project, role);
      if (role.kind === "track") {
        const track = project.tracks.find(track => track.id === role.id)!;
        value = { ...track, clips: track.clips.map(clip => clip.id) };
      } else if (role.kind === "clip" && role.id === original.id && primaryManaged) {
        // The primary audio gain and unrelated disabled masks remain ordinary user data.
        const { volume: _volume, masks, keyframes, ...base } = original;
        value = { ...base, masks: masks?.filter(mask => ownedMaskIds.has(mask.id)), keyframes: keyframes.filter(key => ownedKeyIds.has(key.id)) };
      }
      return { ...role, value };
    }) };
}
export async function referenceMotionTemplateInstanceScopeSha256(project: EditProject, instance: ReferenceMotionTemplateInstance) {
  return digest(scopePayload(project, instance));
}

/**
 * The saved templates an edit changes: their own layers or their main clip are different in `after` (or can no longer be
 * read there, as when the main clip is gone). These are the templates that must follow the edit. A synchronous check,
 * so the editor knows at once whether a gesture is an ordinary edit or one that lays a template out again.
 */
export function referenceMotionTemplatesTouchedBy(project: EditProject, after: EditProject): ReferenceMotionTemplateInstance[] {
  const clipJson = (value: EditProject, id: string) => canonicalJson(clips(value).find(clip => clip.id === id) ?? null);
  return (project.referenceMotionInstances ?? []).filter(instance => {
    let before: string;
    // A template that is not on its own any more (edited by hand) cannot follow; it is touched when its main clip changes.
    try { before = canonicalJson(scopePayload(project, instance)); }
    catch { return clipJson(project, instance.input.clipId) !== clipJson(after, instance.input.clipId); }
    try { return canonicalJson(scopePayload(after, instance)) !== before; } catch { return true; }
  });
}
function ownsSoftComparisonFrame(input: ReferenceMotionTemplateInput) {
  return input.templateId === "comparison_pair" && input.mediaPresentation === "source_soft_v2";
}
async function recipeVersion(input: ReferenceMotionTemplateInput): Promise<string> {
  if (input.holdBeatV3 !== undefined) {
    const { holdBeatV3, ...baseInput } = input;
    return `editkin.reference-motion-recipes/hold-v3:${await digest({ base: await recipeVersion(baseInput), contract: GRAPHIC_HOLD_BEAT_V3_CONTRACT, hold: holdBeatV3 })}`;
  }
  if (input.posterV3 !== undefined) {
    const { posterV3, ...baseInput } = input;
    return `editkin.reference-motion-recipes/poster-v3:${await digest({ base: await recipeVersion(baseInput), contract: GRAPHIC_POSTER_RANGE_V3_CONTRACT, poster: posterV3 })}`;
  }
  if (input.copyFitV3 !== undefined) {
    const { copyFitV3, ...baseInput } = input;
    return `editkin.reference-motion-recipes/copy-fit-v3:${await digest({ base: await recipeVersion(baseInput), contract: GRAPHIC_COPY_FIT_V3_CONTRACT, copy: copyFitV3 })}`;
  }
  if (input.fixedWindowV3 !== undefined) {
    const { fixedWindowV3, ...baseInput } = input;
    return `editkin.reference-motion-recipes/fixed-window-v3:${await digest({ base: await recipeVersion(baseInput), contract: FIXED_TEMPLATE_WINDOW_V3_CONTRACT, window: fixedWindowV3 })}`;
  }
  if (input.graphicTimingV2 !== undefined) {
    const { graphicTimingV2, ...legacyInput } = input;
    return `editkin.reference-motion-recipes/timing-v2:${await digest({ base: await recipeVersion(legacyInput), contract: GRAPHIC_TIMING_V2_CONTRACT, timing: graphicTimingV2 })}`;
  }
  if (input.designSystem !== undefined) {
    return `editkin.reference-motion-recipes/design-v1:${await digest({ recipe: referenceMotionTemplate(input.templateId),
      design: REFERENCE_MOTION_DESIGN_CONTRACT, theme: { id: input.designSystem, ...REFERENCE_MOTION_DESIGN_THEMES[input.designSystem] },
      graphicCadence: graphicCadenceContract(input.graphicCadence) })}`;
  }
  if (input.windowPresentation === "source_backdrop_v1") {
    return `editkin.reference-motion-recipes/source-backdrop-v1:${await digest({ recipe: referenceMotionTemplate(input.templateId),
      backdrop: REFERENCE_MOTION_SOURCE_BACKDROP_CONTRACT, editorial: REFERENCE_MOTION_EDITORIAL_CONTRACT,
      graphicCadence: graphicCadenceContract(input.graphicCadence) })}`;
  }
  if (input.overlayPresentation === "source_editorial_v1") {
    return `editkin.reference-motion-recipes/source-editorial-v1:${await digest({ recipe: referenceMotionTemplate(input.templateId),
      editorial: REFERENCE_MOTION_EDITORIAL_CONTRACT, graphicCadence: graphicCadenceContract(input.graphicCadence) })}`;
  }
  if (input.graphicPresentation === "native_paint_display_v2") {
    return `editkin.reference-motion-recipes/display-paint-v2:${await digest({ recipe: referenceMotionTemplate(input.templateId),
      paint: REFERENCE_MOTION_DISPLAY_PAINT_PRESENTATION_CONTRACT,
      graphicCadence: graphicCadenceContract(input.graphicCadence) })}`;
  }
  if (input.graphicPresentation === "native_paint_v1") {
    return `editkin.reference-motion-recipes/native-paint-v1:${await digest({ recipe: referenceMotionTemplate(input.templateId),
      paint: REFERENCE_MOTION_NATIVE_PAINT_PRESENTATION_CONTRACT,
      graphicCadence: graphicCadenceContract(input.graphicCadence) })}`;
  }
  if (input.templateId === "strike_reframe" && input.strikePresentation === "semantic_replace_v1") {
    const { staggerFrames, ...profileFrames } = compileGraphicCadence(30, 1, input.graphicCadence);
    const contract = { recipe: referenceMotionTemplate(input.templateId),
      strikePresentation: "semantic_replace_v1", semanticReplace: REFERENCE_MOTION_SEMANTIC_REPLACE_CONTRACT,
      graphicCadence: graphicCadenceContract(input.graphicCadence),
      profileFrames: { ...profileFrames, staggerFrames: [1, 2, 16, 128].map(count => ({ count, frames: staggerFrames(count) })) } };
    if (input.strikeSurface === "source_overlay") return `editkin.reference-motion-recipes/source-overlay-v1:${await digest({
      ...contract, sourceOverlay: REFERENCE_MOTION_SOURCE_OVERLAY_CONTRACT })}`;
    if (input.strikeSurface === "source_overlay_v2") return `editkin.reference-motion-recipes/source-overlay-v2:${await digest({
      ...contract, sourceOverlay: REFERENCE_MOTION_SOURCE_OVERLAY_V2_CONTRACT })}`;
    return `editkin.reference-motion-recipes/semantic-replace-v1:${await digest(contract)}`;
  }
  if (input.graphicCadence === "kinetic") {
    return `editkin.reference-motion-recipes/kinetic-v1:${await digest({ recipe: referenceMotionTemplate(input.templateId),
      mediaPresentation: ownsSoftComparisonFrame(input) ? "source_soft_v2" : "legacy_layout", graphicCadence: GRAPHIC_CADENCE_KINETIC_CONTRACT })}`;
  }
  if (input.graphicCadence === "brisk") {
    return `editkin.reference-motion-recipes/brisk-v1:${await digest({ recipe: referenceMotionTemplate(input.templateId),
      mediaPresentation: ownsSoftComparisonFrame(input) ? "source_soft_v2" : "legacy_layout", graphicCadence: GRAPHIC_CADENCE_CONTRACT })}`;
  }
  // Historical omitted/explicit legacy inputs retain their original dependency identity.
  const version = ownsSoftComparisonFrame(input)
    ? "editkin.reference-motion-recipes/comparison-soft-v2"
    : REFERENCE_MOTION_INSTANCE_RECIPE_VERSION;
  return `${version}:${await digest(referenceMotionTemplate(input.templateId))}`;
}
async function assertEnvironment(project: EditProject, instance: ReferenceMotionTemplateInstance) {
  if (!same(instance.frameFormat, { width: project.width, height: project.height, fps: project.fps })) throw new Error("ENVIRONMENT_CHANGED: canvas or project frame rate changed");
  if (instance.dependencies.recipeVersion !== await recipeVersion(instance.input)) throw new Error("ENVIRONMENT_CHANGED: template recipe contract changed");
  for (const row of instance.dependencies.presetHashes) {
    let preset: ReturnType<typeof findMotionGraphicPreset>;
    try { preset = findMotionGraphicPreset(row.presetId); } catch { throw new Error("ENVIRONMENT_CHANGED: registered template preset is unavailable"); }
    if (row.sha256 !== await digest({ id: preset.id, renderer: preset.renderer, seed: preset.seed })) throw new Error("ENVIRONMENT_CHANGED: registered template preset changed");
  }
  for (const row of instance.dependencies.fonts) {
    let face: ReturnType<typeof bundledFontFaceSpec>;
    try { face = bundledFontFaceSpec(row.faceId); } catch { throw new Error("ENVIRONMENT_CHANGED: compiled physical template font is unavailable"); }
    if (row.fontSha256 !== face.sha256 || row.manifestSha256 !== face.manifestSha256 || row.parserVersion !== "opentype.js@1.3.4") throw new Error("ENVIRONMENT_CHANGED: physical template font dependency changed");
  }
}
export async function inspectReferenceMotionTemplateInstance(project: EditProject, id: string): Promise<ReferenceMotionTemplateInstanceInspection> {
  const stored = project.referenceMotionInstances?.find(instance => instance.id === id);
  if (!stored) return { status: "MISSING", reason: "Saved template instance no longer exists" };
  let instance: ReferenceMotionTemplateInstance;
  try { instance = referenceMotionInstanceSchema.parse(stored); }
  catch { return { status: "EDITED", reason: "Saved template metadata is malformed" }; }
  try {
    assertIsolated(project, instance); primary(project, instance);
    await assertEnvironment(project, instance);
    if (await referenceMotionTemplateInstanceScopeSha256(project, instance) !== instance.appliedScopeSha256) return { status: "EDITED", reason: "Managed template content or source binding changed", instance };
    return { status: "CURRENT", reason: "Managed template scope and compiled dependencies match; current review is still required", instance };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Template inspection failed";
    const status = reason.startsWith("MISSING:") ? "MISSING" : reason.startsWith("ENVIRONMENT_CHANGED:") ? "ENVIRONMENT_CHANGED" : "EDITED";
    return { status, reason, instance };
  }
}

async function lifetime<T>(project: EditProject, input: unknown, dependencies: ReferenceMotionTemplatePreparationDependencies,
  operation: (dependencies: ReferenceMotionTemplatePreparationDependencies, check: () => void) => Promise<T>): Promise<T> {
  if (typeof dependencies?.prepareText !== "function") throw new Error("FONT_BYTES_REQUIRED: saved template authoring needs a true glyph provider");
  const before = canonicalJson(project), beforeInput = canonicalJson(input), deadline = performance.now() + REFERENCE_MOTION_PREPARATION_TIMEOUT_MS;
  const controller = new AbortController();
  const abort = () => controller.abort();
  dependencies.signal?.addEventListener("abort", abort, { once: true });
  if (dependencies.signal?.aborted) controller.abort();
  const timer = setTimeout(abort, REFERENCE_MOTION_PREPARATION_TIMEOUT_MS);
  const check = () => {
    if (performance.now() >= deadline) throw new Error("Saved template exceeded its original 10-second deadline");
    if (controller.signal.aborted) throw new Error("Saved template preparation cancelled; no commands were applied");
    if (before !== canonicalJson(project) || beforeInput !== canonicalJson(input)) throw new Error("Saved template source generation changed during preparation");
  };
  try {
    check();
    const result = await operation({ signal: controller.signal, prepareText: async (faceId, text) => {
      // Each glyph request ends one long compiler pass: let the editor paint and take input before the next one.
      check(); await yieldToBrowser(); const run = await dependencies.prepareText(faceId, text); check(); return run;
    } }, check);
    check(); return result;
  } finally { clearTimeout(timer); dependencies.signal?.removeEventListener("abort", abort); }
}
async function dependenciesFor(packet: Awaited<ReturnType<typeof prepareReferenceMotionTemplate>>, input: ReferenceMotionTemplateInput) {
  const presetHashes = new Map(packet.editorialGraphics.map(graphic => [graphic.presetId, graphic.presetVariant!.basePresetSha256]));
  const fonts = new Map(packet.physicalLayoutBindings.map(binding => [binding.physicalFont.faceId, binding.physicalFont]));
  return { recipeVersion: await recipeVersion(input), presetHashes: [...presetHashes].sort(([a], [b]) => a.localeCompare(b)).map(([presetId, sha256]) => ({ presetId, sha256 })),
    fonts: [...fonts.values()].sort((a, b) => a.faceId.localeCompare(b.faceId)) };
}
function knownIds(project: EditProject) {
  return new Set([project.id, ...project.assets.map(value => value.id), ...project.compositions.map(value => value.id),
    ...project.tracks.map(value => value.id), ...project.motionGraphics.map(value => value.id), ...project.motionTracks.map(value => value.id),
    ...project.captions.map(value => value.id), ...project.director.markers.map(value => value.id),
    ...(project.motionScenes ?? []).map(value => value.id), ...(project.referenceMotionInstances ?? []).map(value => value.id),
    ...clips(project).flatMap(clip => [clip.id, ...clip.keyframes.map(value => value.id), ...(clip.masks ?? []).map(value => value.id)])]);
}
function allocator(project: EditProject, idFactory: ReferenceMotionTemplateInstanceIdFactory, retained: readonly ReferenceMotionInstanceRole[] = []) {
  const occupied = knownIds(project), reserved = new Set<string>();
  return (prefix: string, key?: string) => {
    if (!key) throw new Error("Saved template compiler omitted a semantic role key");
    const old = retained.find(role => role.key === key);
    if (old) return old.id;
    const id = idFactory(prefix, key);
    if (typeof id !== "string" || !id.trim() || id.trim() !== id || id.length > 160 || occupied.has(id) || reserved.has(id)) throw new Error(`Saved template identity collides or is invalid: ${key}`);
    reserved.add(id); return id;
  };
}

/** Commands are flat and unapplied. The caller commits one batch including the final metadata command. */
export async function prepareReferenceMotionTemplateInstance(project: EditProject, input: ReferenceMotionTemplateInput,
  idFactory: ReferenceMotionTemplateInstanceIdFactory, dependencies: ReferenceMotionTemplatePreparationDependencies) {
  return lifetime(project, input, dependencies, async (deps, check) => {
    // Default only at NEW saved-instance creation, never while normalizing old metadata.
    // New comparisons default to soft source frames; over a source backdrop they use rounded source-ratio windows.
    const normalized = normalizeReferenceMotionTemplateInput(input.templateId === "comparison_pair" && input.mediaPresentation === undefined
      ? { ...input, mediaPresentation: input.windowPresentation === "source_backdrop_v1" || input.designSystem !== undefined ? "legacy_layout" : "source_soft_v2" } : input), ids = allocator(project, idFactory);
    const instanceId = ids("reference-motion-instance", "instance");
    const original = primary(project, { input: normalized });
    const packet = await prepareReferenceMotionTemplate(project, normalized, ids, deps); check();
    const candidate = applyCommand(project, { type: "batch", commands: packet.commands });
    const instance: ReferenceMotionTemplateInstance = { schema: "editkin.reference-motion-instance/v1", id: instanceId,
      authoringGeneration: 2, instanceRevision: 1, input: normalized, frameFormat: { width: project.width, height: project.height, fps: project.fps },
      roles: packet.roles!, primaryBefore: { layout: original.layout ? structuredClone(original.layout) : null,
        ...(normalized.windowPresentation === "source_backdrop_v1" || normalized.designSystem !== undefined ? { transform: structuredClone(original.transform),
          creative: original.creative ? structuredClone(original.creative) : null } : {}) },
      appliedScopeSha256: "0".repeat(64), dependencies: await dependenciesFor(packet, normalized) };
    instance.appliedScopeSha256 = await referenceMotionTemplateInstanceScopeSha256(candidate, instance); check();
    referenceMotionInstanceSchema.parse(instance);
    const commands: EditorCommand[] = [...packet.commands, { type: "upsert_reference_motion_instance", instance }];
    applyCommand(project, { type: "batch", commands }); check();
    return { ...packet, instance, commands };
  });
}

function patchInput(instance: ReferenceMotionTemplateInstance, raw: ReferenceMotionTemplateRevisionPatch) {
  const patch = referenceMotionTemplateRevisionPatchSchema.parse(raw), next = structuredClone(instance.input);
  const design = next.designSystem !== undefined;
  if (design && (patch.strikePresentation !== undefined || patch.strikeSurface !== undefined)) throw new Error("Design-system instances do not use strike presentation fields");
  if (!design && (patch.accentText !== undefined || patch.tag !== undefined || patch.verdicts !== undefined)) throw new Error("Accent, tag and verdict revisions require a design-system instance");
  if (design) {
    // A design system carries its wordmark on every family.
    if (patch.brandMark === null || patch.brandMark === "") delete next.brandMark; else if (patch.brandMark !== undefined) next.brandMark = patch.brandMark;
    for (const key of ["accentText", "tag"] as const) {
      if (patch[key] === null) delete next[key]; else if (patch[key] !== undefined) next[key] = patch[key];
    }
    if (patch.verdicts === null) delete next.verdicts; else if (patch.verdicts !== undefined) next.verdicts = [...patch.verdicts];
  } else if (patch.strikePresentation !== undefined || patch.brandMark !== undefined || patch.strikeSurface !== undefined) {
    if (next.templateId !== "strike_reframe") throw new Error("Strike presentation and wordmark revisions require the saved strike template");
    if (patch.strikePresentation !== undefined) next.strikePresentation = patch.strikePresentation;
    if (next.strikePresentation !== "semantic_replace_v1") {
      if (patch.strikeSurface !== undefined) throw new Error("A surface revision requires the explicit semantic replacement presentation");
      if (patch.brandMark !== undefined && patch.brandMark !== null && patch.brandMark !== "") {
        throw new Error("A wordmark requires the explicit semantic replacement presentation");
      }
      // An explicit mode change retires only the semantic wordmark input. Historical
      // omitted presentation remains omitted when editing unrelated saved copy.
      delete next.brandMark;
      delete next.strikeSurface;
      delete next.textRegion;
    } else if (patch.brandMark === null || patch.brandMark === "") delete next.brandMark;
    else if (patch.brandMark !== undefined) next.brandMark = patch.brandMark;
    if (patch.strikeSurface !== undefined) {
      next.strikeSurface = patch.strikeSurface;
      // An observed text region belongs to the on-footage editorial surface only.
      if (patch.strikeSurface !== "source_overlay_v2") delete next.textRegion;
    }
  }
  if (patch.windowPresentation !== undefined) {
    if (patch.windowPresentation === null) delete next.windowPresentation; else next.windowPresentation = patch.windowPresentation;
  }
  if (patch.overlayPresentation !== undefined) {
    if (patch.overlayPresentation === null) { delete next.overlayPresentation; delete next.textRegion; } else next.overlayPresentation = patch.overlayPresentation;
  }
  if (patch.textRegion !== undefined) {
    if (next.strikeSurface !== "source_overlay_v2" && next.overlayPresentation !== "source_editorial_v1") throw new Error("A text region revision requires the source_overlay_v2 strike surface or the source_editorial_v1 presentation");
    if (patch.textRegion === null) delete next.textRegion; else next.textRegion = structuredClone(patch.textRegion);
  }
  if (patch.graphicCadence !== undefined) next.graphicCadence = patch.graphicCadence;
  if (patch.holdBeatV3 === null) delete next.holdBeatV3;
  else if (patch.holdBeatV3 !== undefined) next.holdBeatV3 = structuredClone(patch.holdBeatV3);
  if (patch.posterV3 === null) delete next.posterV3;
  else if (patch.posterV3 !== undefined) next.posterV3 = structuredClone(patch.posterV3);
  if (patch.copyFitV3 === null) delete next.copyFitV3;
  else if (patch.copyFitV3 !== undefined) next.copyFitV3 = structuredClone(patch.copyFitV3);
  if (patch.fixedWindowV3 === null) delete next.fixedWindowV3;
  else if (patch.fixedWindowV3 !== undefined) next.fixedWindowV3 = structuredClone(patch.fixedWindowV3);
  if (patch.graphicTimingV2 === null) delete next.graphicTimingV2;
  else if (patch.graphicTimingV2 !== undefined) next.graphicTimingV2 = structuredClone(patch.graphicTimingV2);
  if (patch.graphicPresentation !== undefined) {
    if (next.templateId !== "level_bridge") throw new Error("Display paint upgrade requires the saved level_bridge template");
    next.graphicPresentation = patch.graphicPresentation;
  }
  if (patch.title !== undefined) {
    next.title = patch.title;
    // A replaced title keeps its accent only when the accent word still occurs in it.
    if (patch.accentText === undefined && next.accentText !== undefined && !next.title.includes(next.accentText)) delete next.accentText;
  }
  for (const key of ["kicker", "subtitle", "previousText", "primaryLabel"] as const) {
    if (patch[key] === null) delete next[key]; else if (patch[key] !== undefined) next[key] = patch[key];
  }
  if (patch.items) {
    if (!next.items || patch.items.length !== next.items.length) throw new Error("Template item count and ordered semantic slots are fixed");
    next.items = patch.items.map((item, index) => ({ label: item.label,
      ...(item.detail === null ? {} : item.detail === undefined ? (next.items![index].detail === undefined ? {} : { detail: next.items![index].detail }) : { detail: item.detail }) }));
  }
  if (patch.network) {
    if (next.templateId !== "kinetic_network" || !next.network) throw new Error("Network text patch requires the existing network recipe");
    for (const key of ["labels", "hubLabel"] as const) {
      if (patch.network[key] === null) delete next.network[key];
    }
    if (patch.network.labels != null) next.network.labels = [...patch.network.labels];
    if (patch.network.hubLabel != null) next.network.hubLabel = patch.network.hubLabel;
  }
  if (patch.style?.palette) next.style.palette = { ...next.style.palette, ...patch.style.palette };
  if (patch.style?.typography) next.style.typography = { ...next.style.typography, ...patch.style.typography };
  return normalizeReferenceMotionTemplateInput(next);
}
function scratchProject(project: EditProject, instance: ReferenceMotionTemplateInstance, tolerateMissing = false): EditProject {
  assertIsolated(project, instance, tolerateMissing);
  const scratch = structuredClone(project), owned = new Set(instance.roles.map(role => role.id));
  scratch.motionGraphics = scratch.motionGraphics.filter(graphic => !owned.has(graphic.id));
  scratch.tracks = scratch.tracks.filter(track => !owned.has(track.id));
  for (const track of scratch.tracks) {
    track.clips = track.clips.filter(clip => clip.id === instance.input.clipId || !owned.has(clip.id));
    for (const clip of track.clips) {
      clip.keyframes = clip.keyframes.filter(key => !owned.has(key.id));
      if (clip.masks) clip.masks = clip.masks.filter(mask => !owned.has(mask.id));
    }
  }
  if (instance.roles.some(role => role.kind === "clip" && role.id === instance.input.clipId)) {
    const original = primary(scratch, instance);
    if (instance.primaryBefore.layout) original.layout = structuredClone(instance.primaryBefore.layout); else delete original.layout;
    // A source backdrop enlarged and blurred the primary itself; scratch reconstruction returns the user's own clip.
    if (instance.primaryBefore.transform) original.transform = structuredClone(instance.primaryBefore.transform);
    if (instance.primaryBefore.creative !== undefined) {
      if (instance.primaryBefore.creative) original.creative = structuredClone(instance.primaryBefore.creative); else delete original.creative;
    }
    if (ownsSoftComparisonFrame(instance.input)) delete original.floatingFrame;
  }
  scratch.referenceMotionInstances = scratch.referenceMotionInstances?.filter(value => value.id !== instance.id);
  return scratch;
}
function withoutId<T extends { id: string }>(value: T): Omit<T, "id"> { const { id: _id, ...rest } = value; return rest; }
function visualFree(clip: TimelineClip, managedFloatingFrame: boolean) {
  const { layout: _layout, masks: _masks, keyframes: _keys, ...rest } = clip;
  if (!managedFloatingFrame) return rest;
  const { floatingFrame: _floatingFrame, ...sourceAndUnmanaged } = rest;
  return sourceAndUnmanaged;
}
function revisionCommands(project: EditProject, instance: ReferenceMotionTemplateInstance, compiled: EditProject,
  roles: readonly ReferenceMotionInstanceRole[]): EditorCommand[] {
  const commands: EditorCommand[] = [], previous = new Map(instance.roles.map(role => [role.key, role])), next = new Map(roles.map(role => [role.key, role]));
  for (const role of instance.roles) if (!next.has(role.key)) {
    const windowKey = fixedTemplateWindowKeyRevisionV3(project, instance, compiled, role, "remove");
    if (windowKey) { commands.push(windowKey); continue; }
    if (role.kind !== "graphic") throw new Error("Template revision cannot remove source, track, mask or keyframe topology");
    commands.push({ type: "delete_motion_graphic", graphicId: role.id });
  }
  for (const role of roles) {
    const old = previous.get(role.key), value = element(compiled, role);
    if (old && (old.kind !== role.kind || old.id !== role.id || old.parentId !== role.parentId)) throw new Error("Template semantic identity changed during revision");
    if (!old) {
      const windowKey = fixedTemplateWindowKeyRevisionV3(project, instance, compiled, role, "add");
      if (windowKey) { commands.push(windowKey); continue; }
      if (role.kind !== "graphic") throw new Error("Template revision cannot add source, track, mask or keyframe topology");
      commands.push({ type: "add_motion_graphic", graphic: value as MotionGraphic }); continue;
    }
    const current = element(project, old);
    if (same(current, value)) continue;
    if (role.kind === "graphic") {
      // A merge patch cannot drop an optional field the new compilation no longer authors (for example a halo when
      // returning to the original scene); replace that graphic in place under the same stable identity instead.
      const retired = Object.keys(current as object).some(key => !(key in (value as object)));
      if (retired) commands.push({ type: "delete_motion_graphic", graphicId: role.id }, { type: "add_motion_graphic", graphic: value as MotionGraphic });
      else commands.push({ type: "update_motion_graphic", graphicId: role.id, patch: withoutId(value as MotionGraphic) });
    } else if (role.kind === "clip") {
      const before = current as TimelineClip, after = value as TimelineClip;
      const managedFloatingFrame = ownsSoftComparisonFrame(instance.input);
      if (managedFloatingFrame && (before.floatingFrame?.schema !== "editkin.floating-video-frame/v2" || after.floatingFrame?.schema !== "editkin.floating-video-frame/v2")) {
        throw new Error("Template revision lost its managed source soft v2 frame");
      }
      if (!same(visualFree(before, managedFloatingFrame), visualFree(after, managedFloatingFrame))) throw new Error("Template revision attempted to change source windows, audio or unmanaged clip fields");
      if (!same(before.layout, after.layout)) commands.push({ type: "set_clip_layout", clipId: role.id, layout: after.layout });
      if (managedFloatingFrame && !same(before.floatingFrame, after.floatingFrame)) commands.push({ type: "set_clip_floating_frame", clipId: role.id, frame: after.floatingFrame });
    } else if (role.kind === "track") {
      const before = project.tracks.find(track => track.id === role.id)!, after = compiled.tracks.find(track => track.id === role.id)!;
      if (!same({ ...before, clips: before.clips.map(clip => clip.id) }, { ...after, clips: after.clips.map(clip => clip.id) })) throw new Error("Template revision changed generated track ownership or state");
    } else if (role.kind === "mask") {
      const mask = clips(compiled).find(clip => clip.id === role.parentId)!.masks!.find(mask => mask.id === role.id)!;
      if ((current as ClipMask).fixedWindowV3 && !mask.fixedWindowV3) {
        commands.push({ type: "delete_clip_mask", clipId: role.parentId!, maskId: role.id }, { type: "add_clip_mask", clipId: role.parentId!, mask });
      } else commands.push({ type: "update_clip_mask", clipId: role.parentId!, maskId: role.id, patch: withoutId(mask) });
    } else {
      const key = clips(compiled).find(clip => clip.id === role.parentId)!.keyframes.find(key => key.id === role.id)!;
      commands.push({ type: "update_keyframe", clipId: role.parentId!, keyframeId: role.id, patch: withoutId(key) });
    }
  }
  const selected = new Set(roles.filter(role => role.kind === "graphic").map(role => role.id));
  const deletedIds = new Set(commands.flatMap(command => command.type === "delete_motion_graphic" ? [command.graphicId] : []));
  const addedIds = commands.flatMap(command => command.type === "add_motion_graphic" ? [command.graphic.id] : []);
  const actualOrder = [...project.motionGraphics.filter(graphic => !deletedIds.has(graphic.id)).map(graphic => graphic.id), ...addedIds]
    .filter(id => selected.has(id));
  const compiledOrder = compiled.motionGraphics.filter(graphic => selected.has(graphic.id)).map(graphic => graphic.id);
  if (!same(actualOrder, compiledOrder)) commands.push({ type: "reorder_motion_graphics", graphicIds: compiledOrder });
  return commands;
}
/** Shared existing compiler primitives for the opt-in source transaction. Legacy creation/revision paths are unchanged. */
export const referenceMotionInstanceRecompilePrimitivesV1 = Object.freeze({
  lifetime, scratchProject, allocator, dependenciesFor, revisionCommands, scopePayload, digest,
});

export async function prepareReferenceMotionTemplateRevision(project: EditProject, id: string, patch: ReferenceMotionTemplateRevisionPatch,
  dependencies: ReferenceMotionTemplateRevisionDependencies) {
  // The editor's 「依目前片段重新套用」 button travels through the same revise channel as a copy edit.
  if (isReferenceMotionTemplateReapplyPatch(patch)) return prepareReferenceMotionTemplateReapply(project, id, dependencies);
  return lifetime(project, patch, dependencies, async (deps, check) => {
    const inspection = await inspectReferenceMotionTemplateInstance(project, id); check();
    if (inspection.status !== "CURRENT" || !inspection.instance) throw new Error(`${inspection.status}: ${inspection.reason}`);
    const instance = inspection.instance;
    if (instance.instanceRevision !== dependencies.expectedInstanceRevision) throw new Error("Saved template instance revision is stale");
    const input = patchInput(instance, patch), scratch = scratchProject(project, instance);
    const makeId = dependencies.idFactory ?? ((prefix: string) => `${prefix}-${globalThis.crypto.randomUUID()}`);
    const ids = allocator(project, makeId, instance.roles);
    const packet = await prepareReferenceMotionTemplate(scratch, input, ids, deps); check();
    const compiled = applyCommand(scratch, { type: "batch", commands: packet.commands });
    const next: ReferenceMotionTemplateInstance = { ...structuredClone(instance), input, roles: packet.roles!,
      instanceRevision: instance.instanceRevision + 1, dependencies: await dependenciesFor(packet, input) };
    const commands = revisionCommands(project, instance, compiled, next.roles);
    next.appliedScopeSha256 = await referenceMotionTemplateInstanceScopeSha256(compiled, next); check();
    referenceMotionInstanceSchema.parse(next);
    const sourceGeneration = { ...packet.sourceGeneration, projectSha256: await digest(project) };
    if (!commands.length && same(instance.input, next.input) && same(instance.dependencies, next.dependencies) && same(instance.roles, next.roles)) {
      return { ...packet, sourceGeneration, status: "UNCHANGED" as const, instance, commands: [] as EditorCommand[] };
    }
    commands.push({ type: "upsert_reference_motion_instance", instance: next, expectedInstanceRevision: instance.instanceRevision });
    const batch: EditorCommand = { type: "batch", commands };
    const context: EditorCommandContext | undefined = isNativeReferenceMotionPresentation(instance.input.graphicPresentation)
      || isNativeReferenceMotionPresentation(next.input.graphicPresentation)
      ? { nativePaintOwnerRevisionProof: issueNativePaintOwnerRevisionProof(project, batch, [instance.id]) } : undefined;
    const final = applyCommand(project, batch, context);
    // Prove the emitted updates recreate the same owned graph rather than merely claiming a new hash.
    if (!same(scopePayload(final, next), scopePayload(compiled, next))) throw new Error("Template delta did not reproduce the exact compiled managed scope");
    check();
    const result = { ...packet, sourceGeneration, instance: next, commands };
    if (context) revisionContexts.set(result, context);
    return result;
  });
}

// ── A saved template follows its main clip ──────────────────────────────────────────────────────────────────────────
// A trim, an extension, a move, a split, a new in-point (slip) or a ripple of the main clip lays the template out again
// on the edited clip, in the same command, with the real compiler: the template keeps its words, fonts, colours and
// identities and stays CURRENT. An edit that only carries the whole template along the timeline by whole frames (a
// ripple or a push, never onto or off 0 s) re-records it at its new place instead, exactly as a move does. The same
// rebuild re-applies a template that went out of date (「依目前片段重新套用」).

/** Why a template cannot be laid out again on its main clip, in plain words; the message is shown as it is. */
export class ReferenceMotionRebuildRefusal extends Error {}
export const TEMPLATE_REBUILD_TOO_SHORT = "片段太短，放不下模板的文字；把片段拉長一點再試。";
export const TEMPLATE_REBUILD_SOURCE_SHORT = "模板裡另一段影片不夠長，跟不上新的片段長度。";
export const TEMPLATE_REBUILD_OVERLAP = "片段上還有別的標題或圖卡，會和模板疊在一起；請先移開。";
export const TEMPLATE_REBUILD_TRACK = "主片段所在的軌道被鎖定或關掉了；請先打開。";
export const TEMPLATE_REBUILD_NATIVE_PAINT = "這個模板用原生繪製，不能自動重新排；可以解除模板連結。";
export const TEMPLATE_REBUILD_NOT_CURRENT = "模板之前已經被改過，所以沒有跟著片段改。";
/** The same words the template editor shows for a template whose recipe or font version changed. */
export const TEMPLATE_REBUILD_ENVIRONMENT = "這個模板或字型的版本已經更新，要重新套用後才能改字。";
export const TEMPLATE_REBUILD_DEPENDENT = "有別的動畫、遮罩或片段接在模板上，要先拿掉才能重新套用。";
export const TEMPLATE_REBUILD_MISSING = "找不到模板的主片段或影片，不能重新套用；可以解除模板連結。";
export const TEMPLATE_REBUILD_TIMEOUT = "這次準備太久，模板沒有更新；請再試一次。";
export const TEMPLATE_REBUILD_OTHER = "模板沒辦法照目前的片段重新排好。";
const formatSeconds = (frames: number, fps: number) => (Math.abs(frames / fps) < 0.005 ? 0 : frames / fps).toFixed(2);
/** The clip became shorter than the template's own minimum. */
export function templateRebuildTooShortMessage(clipFrames: number, minFrames: number, fps: number): string {
  return `片段只有 ${formatSeconds(clipFrames, fps)} 秒，這個模板至少要 ${formatSeconds(minFrames, fps)} 秒；先把片段拉長。`;
}
/** True for the reasons that mean "the clip is too short for this template". */
export function isTemplateRebuildTooShort(reason: string): boolean {
  return reason === TEMPLATE_REBUILD_TOO_SHORT || reason.startsWith("片段只有 ");
}

/** The compiler's and the inspection's refusals, said plainly for a creator. */
export function plainReferenceMotionRebuildReason(error: unknown): string {
  if (error instanceof ReferenceMotionRebuildRefusal) return error.message;
  const message = error instanceof Error ? error.message : "";
  if (/閱讀停留|聚焦停留|沒有留下動作|沒有足夠停留|沒有有效範圍/.test(message)) return TEMPLATE_REBUILD_TOO_SHORT;
  if (/素材槽缺少/.test(message)) return TEMPLATE_REBUILD_SOURCE_SHORT;
  if (/此段已有 Motion/.test(message)) return TEMPLATE_REBUILD_OVERLAP;
  if (/模板需要可編輯的真實影片/.test(message)) return TEMPLATE_REBUILD_TRACK;
  if (/^MISSING:/.test(message)) return TEMPLATE_REBUILD_MISSING;
  if (/^EDITED:/.test(message)) return TEMPLATE_REBUILD_DEPENDENT;
  if (/deadline/.test(message)) return TEMPLATE_REBUILD_TIMEOUT;
  return TEMPLATE_REBUILD_OTHER;
}

const REAPPLY_REQUESTS = new WeakSet<object>();
/**
 * A request to re-apply a saved template against its current main clip, sent through the editor's ordinary revise
 * channel (onRevise → prepareReferenceMotionTemplateRevision). Only this in-process object carries the request: a
 * serialized patch never does, so the revision contract of other callers is unchanged.
 */
export function referenceMotionTemplateReapplyPatch(): ReferenceMotionTemplateRevisionPatch {
  const request = Object.freeze({}) as ReferenceMotionTemplateRevisionPatch;
  REAPPLY_REQUESTS.add(request);
  return request;
}
export function isReferenceMotionTemplateReapplyPatch(patch: unknown): boolean {
  return typeof patch === "object" && patch !== null && REAPPLY_REQUESTS.has(patch);
}

export interface ReferenceMotionTemplateRebuildDependencies extends ReferenceMotionTemplatePreparationDependencies {
  expectedInstanceRevision?: number;
  idFactory?: ReferenceMotionTemplateInstanceIdFactory;
}

/** A clip edit carried with its template leaves the template's own layers to the recompile. */
function assertEditLeavesTemplate(edit: readonly EditorCommand[], instance: ReferenceMotionTemplateInstance): void {
  const owned = new Set(instance.roles.filter(role => role.id !== instance.input.clipId).map(role => role.id));
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (owned.has(value)) throw new Error("A clip edit followed by its template must leave the template's own layers to the recompile");
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(edit);
}
/** The main clip as a whole; masks and keyframes in a stable order (template layers are appended after the user's). */
function comparableClip(clip: TimelineClip) {
  const byId = <T extends { id: string }>(items: readonly T[] | undefined) => items && [...items].sort((a, b) => a.id.localeCompare(b.id));
  return { ...clip, masks: byId(clip.masks), keyframes: byId(clip.keyframes) };
}
function findAnyClip(project: EditProject, id: string): TimelineClip | undefined {
  return clips(project).find(clip => clip.id === id);
}
/** The user's own main clip after the edit, as the template must restore it when it is removed. */
function primaryBeforeAfterEdit(clip: TimelineClip, before: ReferenceMotionTemplateInstance["primaryBefore"]): ReferenceMotionTemplateInstance["primaryBefore"] {
  return { layout: clip.layout ? structuredClone(clip.layout) : null,
    ...(before.transform !== undefined ? { transform: structuredClone(clip.transform) } : {}),
    ...(before.creative !== undefined ? { creative: clip.creative ? structuredClone(clip.creative) : null } : {}) };
}
function creativeCommand(clipId: string, before: ClipCreativeState | undefined, after: ClipCreativeState | undefined): EditorCommand {
  if (!after) throw new Error("Template rebuild cannot remove the main clip's look");
  const named = new Set(["lookPresetId", "effectPresetIds", "transitionIn", "transitionOut"]);
  const rest = (value: ClipCreativeState | undefined) => Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => !named.has(key)));
  if (!same(rest(before), rest(after))) throw new Error("Template rebuild cannot change the main clip's other creative settings");
  const patch: Extract<EditorCommand, { type: "set_clip_creative" }>["patch"] = {};
  if (!same(before?.lookPresetId, after.lookPresetId)) patch.lookPresetId = after.lookPresetId ?? null;
  if (!same(before?.effectPresetIds, after.effectPresetIds)) patch.effectPresetIds = [...after.effectPresetIds];
  if (!same(before?.transitionIn, after.transitionIn)) patch.transitionIn = after.transitionIn ? { ...after.transitionIn } : null;
  if (!same(before?.transitionOut, after.transitionOut)) patch.transitionOut = after.transitionOut ? { ...after.transitionOut } : null;
  return { type: "set_clip_creative", clipId, patch };
}

/**
 * How a clip edit carries a template. A split gives both pieces the plain clip first (`liftWholeClip`), so the piece
 * that does not keep the template never inherits its window, masks, look or entrance; `retargetTo` names the new clip a
 * template moves to (the second piece of a split). The other edits keep the template on its own main clip.
 */
export interface ReferenceMotionTemplateFollowOptions {
  liftWholeClip?: boolean;
  retargetTo?: string;
}

/**
 * Commands that lift the template off its live main clip before the edit: always its own keyframes (a trim would
 * otherwise bake a half-played entrance into the clip or cut keyframes off); with `whole`, also its masks, window,
 * transform, look and floating frame, so the clip is the user's own clip again, as scratchProject reconstructs it.
 */
function liftCommands(project: EditProject, instance: ReferenceMotionTemplateInstance, whole: boolean): EditorCommand[] {
  const primaryId = instance.input.clipId;
  const commands: EditorCommand[] = instance.roles.filter(role => role.kind === "keyframe" && role.parentId === primaryId && element(project, role) !== undefined)
    .map(role => ({ type: "delete_keyframe", clipId: primaryId, keyframeId: role.id }));
  if (!whole) return commands;
  for (const role of instance.roles) {
    if (role.kind === "mask" && role.parentId === primaryId && element(project, role) !== undefined) commands.push({ type: "delete_clip_mask", clipId: primaryId, maskId: role.id });
  }
  if (!instance.roles.some(role => role.kind === "clip" && role.id === primaryId)) return commands;
  const clip = primary(project, instance), before = instance.primaryBefore, layout = before.layout ?? undefined;
  if (!same(clip.layout, layout)) commands.push({ type: "set_clip_layout", clipId: primaryId, layout: layout && structuredClone(layout) });
  if (before.transform && !same(clip.transform, before.transform)) commands.push({ type: "update_clip_transform", clipId: primaryId, patch: { ...before.transform } });
  if (before.creative !== undefined) {
    // The template only adds a look or an effect; transitions stay the user's own.
    const own = before.creative ?? undefined, patch: Extract<EditorCommand, { type: "set_clip_creative" }>["patch"] = {};
    if (!same(clip.creative?.lookPresetId, own?.lookPresetId)) patch.lookPresetId = own?.lookPresetId ?? null;
    if (!same(clip.creative?.effectPresetIds ?? [], own?.effectPresetIds ?? [])) patch.effectPresetIds = [...(own?.effectPresetIds ?? [])];
    if (Object.keys(patch).length) commands.push({ type: "set_clip_creative", clipId: primaryId, patch });
  }
  if (ownsSoftComparisonFrame(instance.input) && clip.floatingFrame) commands.push({ type: "set_clip_floating_frame", clipId: primaryId });
  return commands;
}

/**
 * Commands that turn the template's layers in `current` (the live graph, the clip edit already applied) into the
 * freshly compiled ones. Only the template's own layers and the main clip's picture state change. Unlike a copy
 * revision, the layout may differ in which layers it has (a template that opens the video animates its first frame
 * differently): retired layers are removed and new ones added under fresh identities, kept ones keep theirs. A
 * generated clip whose clock changed is replaced in place under the same identity (its masks and keyframes travel
 * inside it); the main clip's own keyframes were lifted before the edit and are all added back. A template moved to
 * another clip (`nextPrimaryId`) keeps every identity; only its main clip, and the parent of what sits on it, change.
 */
function rebuildCommands(current: EditProject, instance: ReferenceMotionTemplateInstance, compiled: EditProject,
  roles: readonly ReferenceMotionInstanceRole[], nextPrimaryId = instance.input.clipId): EditorCommand[] {
  const commands: EditorCommand[] = [], primaryId = instance.input.clipId, retiredTracks: string[] = [];
  const previous = new Map(instance.roles.map(role => [role.key, role])), next = new Map(roles.map(role => [role.key, role]));
  for (const role of instance.roles) {
    if (next.has(role.key)) continue;
    if (role.kind === "graphic") { if (element(current, role) !== undefined) commands.push({ type: "delete_motion_graphic", graphicId: role.id }); }
    else if (role.kind === "clip") { if (role.id !== primaryId && findAnyClip(current, role.id)) commands.push({ type: "delete_clip", clipId: role.id }); }
    else if (role.kind === "track") { if (current.tracks.some(track => track.id === role.id)) retiredTracks.push(role.id); }
    else if (role.kind === "mask" && role.parentId === primaryId && element(current, role) !== undefined) {
      commands.push({ type: "delete_clip_mask", clipId: primaryId, maskId: role.id });
    }
  }
  for (const trackId of retiredTracks) commands.push({ type: "delete_track", trackId });
  const carried = (id: string | undefined) => id === primaryId ? nextPrimaryId : id;
  for (const role of roles) {
    const old = previous.get(role.key);
    if (old && (old.kind !== role.kind || carried(old.id) !== role.id || carried(old.parentId) !== role.parentId)) throw new Error("Template semantic identity changed during rebuild");
    const before = old ? element(current, role) : undefined, after = element(compiled, role);
    if (role.kind === "graphic") {
      const graphic = after as MotionGraphic;
      if (before === undefined) commands.push({ type: "add_motion_graphic", graphic });
      else if (!same(before, graphic)) {
        // A merge patch cannot drop an optional field the new compilation no longer authors.
        const retired = Object.keys(before as object).some(key => !(key in graphic));
        if (retired) commands.push({ type: "delete_motion_graphic", graphicId: role.id }, { type: "add_motion_graphic", graphic });
        else commands.push({ type: "update_motion_graphic", graphicId: role.id, patch: withoutId(graphic) });
      }
    } else if (role.kind === "track") {
      const { clips: _was, ...was } = (before ?? {}) as TimelineTrack, { clips: _now, ...now } = after as TimelineTrack;
      if (before === undefined) commands.push({ type: "add_track", track: { ...structuredClone(now), clips: [] } });
      else if (!same(was, now)) throw new Error("Template rebuild changed generated track state");
    } else if (role.kind === "clip") {
      if (role.id === nextPrimaryId || (before !== undefined && same(before, after))) continue;
      if (old && findAnyClip(current, role.id)) commands.push({ type: "delete_clip", clipId: role.id });
      commands.push({ type: "add_clip", clip: structuredClone(after as TimelineClip) });
    } else if (role.parentId === nextPrimaryId) {
      if (role.kind === "keyframe") commands.push({ type: "add_keyframe", clipId: nextPrimaryId, keyframe: structuredClone(after as ClipKeyframe) });
      else if (before === undefined) commands.push({ type: "add_clip_mask", clipId: nextPrimaryId, mask: structuredClone(after as ClipMask) });
      else if (!same(before, after)) commands.push({ type: "update_clip_mask", clipId: nextPrimaryId, maskId: role.id, patch: withoutId(after as ClipMask) });
    }
  }
  const onNext = { input: { clipId: nextPrimaryId } };
  const was = primary(current, onNext), now = primary(compiled, onNext);
  if (!same(was.layout, now.layout)) commands.push({ type: "set_clip_layout", clipId: nextPrimaryId, layout: now.layout && structuredClone(now.layout) });
  if (!same(was.floatingFrame, now.floatingFrame)) commands.push({ type: "set_clip_floating_frame", clipId: nextPrimaryId, frame: now.floatingFrame && structuredClone(now.floatingFrame) });
  if (!same(was.transform, now.transform)) commands.push({ type: "update_clip_transform", clipId: nextPrimaryId, patch: { ...now.transform } });
  if (!same(was.color, now.color)) commands.push({ type: "set_clip_color", clipId: nextPrimaryId, patch: { ...now.color } });
  if (!same(was.creative, now.creative)) commands.push(creativeCommand(nextPrimaryId, was.creative, now.creative));
  const selected = new Set(roles.filter(role => role.kind === "graphic").map(role => role.id));
  const deletedIds = new Set(commands.flatMap(command => command.type === "delete_motion_graphic" ? [command.graphicId] : []));
  const addedIds = commands.flatMap(command => command.type === "add_motion_graphic" ? [command.graphic.id] : []);
  const actualOrder = [...current.motionGraphics.filter(graphic => !deletedIds.has(graphic.id)).map(graphic => graphic.id), ...addedIds].filter(id => selected.has(id));
  const compiledOrder = compiled.motionGraphics.filter(graphic => selected.has(graphic.id)).map(graphic => graphic.id);
  if (compiledOrder.length && !same(actualOrder, compiledOrder)) commands.push({ type: "reorder_motion_graphics", graphicIds: compiledOrder });
  return commands;
}

/**
 * Lay `instance` out again on its main clip as `edit` leaves it (or on `options.retargetTo`, the clip it moves to). The
 * template is lifted off the main clip first (liftCommands), so the edit acts on the plain clip; the compiler then runs
 * on the plain edited clip, exactly as when the template was applied. Returns one flat command list: lift, edit, the
 * rebuilt layers and the next instance revision.
 */
async function rebuildOnMainClip(project: EditProject, instance: ReferenceMotionTemplateInstance, edit: readonly EditorCommand[],
  deps: ReferenceMotionTemplatePreparationDependencies, check: () => void, idFactory: ReferenceMotionTemplateInstanceIdFactory, tolerateMissing: boolean,
  options: ReferenceMotionTemplateFollowOptions = {}) {
  if (isNativeReferenceMotionPresentation(instance.input.graphicPresentation)) throw new ReferenceMotionRebuildRefusal(TEMPLATE_REBUILD_NATIVE_PAINT);
  assertEditLeavesTemplate(edit, instance);
  const primaryId = instance.input.clipId, nextPrimaryId = options.retargetTo ?? primaryId, fps = project.fps;
  const lift = liftCommands(project, instance, options.liftWholeClip === true);
  const current = lift.length || edit.length ? applyCommand(project, { type: "batch", commands: [...lift, ...edit] }) : project;
  const plain = scratchProject(project, instance, tolerateMissing);
  const scratch = edit.length ? applyCommand(plain, { type: "batch", commands: [...edit] }) : plain;
  // Long synchronous steps: let the editor paint (the 「標題跟著調整中…」 hint) and take input between them.
  await yieldToBrowser(); check();
  const clip = primary(scratch, { input: { clipId: nextPrimaryId } });
  const startFrame = Math.round(clip.timelineStart * fps), durationFrames = Math.round(clip.duration * fps);
  const minFrames = Math.ceil(referenceMotionTemplate(instance.input.templateId).minSeconds * fps);
  if (durationFrames < minFrames) throw new ReferenceMotionRebuildRefusal(templateRebuildTooShortMessage(durationFrames, minFrames, fps));
  const input = normalizeReferenceMotionTemplateInput({ ...structuredClone(instance.input), clipId: nextPrimaryId, startFrame, durationFrames });
  const packet = await prepareReferenceMotionTemplate(scratch, input, allocator(project, idFactory, instance.roles), deps);
  await yieldToBrowser(); check();
  const compiled = applyCommand(scratch, { type: "batch", commands: packet.commands });
  const managedPrimary = instance.roles.some(role => role.kind === "clip" && role.id === primaryId)
    || packet.roles!.some(role => role.kind === "clip" && role.id === nextPrimaryId);
  const next: ReferenceMotionTemplateInstance = { ...structuredClone(instance), input, roles: packet.roles!, instanceRevision: instance.instanceRevision + 1,
    frameFormat: { width: project.width, height: project.height, fps },
    primaryBefore: managedPrimary ? primaryBeforeAfterEdit(clip, instance.primaryBefore) : structuredClone(instance.primaryBefore),
    dependencies: await dependenciesFor(packet, input) };
  next.appliedScopeSha256 = await referenceMotionTemplateInstanceScopeSha256(compiled, next); check();
  referenceMotionInstanceSchema.parse(next);
  const commands: EditorCommand[] = [...lift, ...edit, ...rebuildCommands(current, instance, compiled, next.roles, nextPrimaryId),
    { type: "upsert_reference_motion_instance", instance: next, expectedInstanceRevision: instance.instanceRevision }];
  await yieldToBrowser(); check();
  const final = applyCommand(project, { type: "batch", commands });
  // Prove the commands recreate exactly the compiled template and the edited main clip, rather than claiming a hash.
  if (!same(scopePayload(final, next), scopePayload(compiled, next))) throw new Error("Template rebuild did not reproduce the exact compiled managed scope");
  if (!same(comparableClip(primary(final, next)), comparableClip(primary(compiled, next)))) throw new Error("Template rebuild changed the main clip differently from the edit");
  check();
  const settled = (value: EditProject) => canonicalJson({ ...value, revision: 0, updatedAt: "",
    referenceMotionInstances: value.referenceMotionInstances?.map(item => item.id === instance.id ? { ...item, instanceRevision: 0 } : item) });
  return { packet, instance: next, commands, unchanged: !edit.length && settled(final) === settled(project) };
}

/** A time moved `frames` whole project frames along the timeline (a time on the frame grid stays on it). */
function shiftedTime(time: number, frames: number, fps: number): number {
  return (Math.round(time * fps) + frames) / fps;
}

/**
 * The whole frames `after` carried the template along the timeline, when that is all the edit did to it: its main clip
 * and every layer it owns moved by the same frames and nothing else about them changed (a ripple, or a push from an
 * earlier clip that grew). Undefined otherwise.
 */
function pureTranslationFrames(project: EditProject, after: EditProject, instance: ReferenceMotionTemplateInstance): number | undefined {
  const fps = project.fps, moved = findAnyClip(after, instance.input.clipId);
  if (!moved) return undefined;
  const frames = Math.round(moved.timelineStart * fps) - instance.input.startFrame;
  if (frames === 0) return undefined;
  const shifted: ReferenceMotionTemplateInstance = { ...instance, input: { ...instance.input, startFrame: instance.input.startFrame + frames } };
  let before: ReturnType<typeof scopePayload>, now: ReturnType<typeof scopePayload>;
  try { before = scopePayload(project, instance); now = scopePayload(after, shifted); } catch { return undefined; }
  const expected = structuredClone(before);
  expected.input = shifted.input;
  expected.primarySource.timelineStart = shiftedTime(before.primarySource.timelineStart, frames, fps);
  for (const role of expected.roles) {
    if ((role.kind === "graphic" || role.kind === "clip") && role.value && typeof role.value === "object") {
      const value = role.value as { timelineStart: number };
      value.timelineStart = shiftedTime(value.timelineStart, frames, fps);
    }
  }
  return same(expected, now) ? frames : undefined;
}

/**
 * When `after` moved a template's main clip along the timeline (same in-point, same length) but left the template's
 * own layers where they were — an agent's move_clip, compact_track — the commands that carry those layers by the same
 * whole frames, so they stay on their clip. [] when the main clip did not simply move, or the edit already moved a layer.
 */
export function referenceMotionTemplateCarryCommands(project: EditProject, after: EditProject, instance: ReferenceMotionTemplateInstance): EditorCommand[] {
  const fps = project.fps, was = findAnyClip(project, instance.input.clipId), now = findAnyClip(after, instance.input.clipId);
  if (!was || !now) return [];
  const frames = Math.round(now.timelineStart * fps) - Math.round(was.timelineStart * fps);
  if (frames === 0 || Math.round(now.duration * fps) !== Math.round(was.duration * fps)
    || Math.round(now.sourceStart * fps) !== Math.round(was.sourceStart * fps)) return [];
  const commands: EditorCommand[] = [];
  for (const role of instance.roles) {
    if (role.kind === "graphic") {
      const before = project.motionGraphics.find(graphic => graphic.id === role.id), current = after.motionGraphics.find(graphic => graphic.id === role.id);
      if (!before || !current || current.timelineStart !== before.timelineStart) return [];
      commands.push({ type: "update_motion_graphic", graphicId: role.id, patch: { timelineStart: shiftedTime(current.timelineStart, frames, fps) } });
    } else if (role.kind === "clip" && role.id !== instance.input.clipId) {
      const before = findAnyClip(project, role.id), current = findAnyClip(after, role.id);
      if (!before || !current || current.timelineStart !== before.timelineStart) return [];
      commands.push({ type: "move_clip", clipId: role.id, timelineStart: shiftedTime(current.timelineStart, frames, fps) });
    }
  }
  return commands;
}

/**
 * A template the edit only carried along by whole frames is re-recorded at its new place (its start, a new instance
 * revision and the scope of the moved graph), exactly as a move records it: the compiler lays a template out the same
 * way at any start except 0 s, so a move onto or off 0 s is laid out again instead (undefined here). An edit that moved
 * only the main clip carries the template's layers along first (referenceMotionTemplateCarryCommands).
 */
async function translatedRecord(project: EditProject, instance: ReferenceMotionTemplateInstance, edit: readonly EditorCommand[], check: () => void) {
  if (!edit.length) return undefined;
  const moved = applyCommand(project, { type: "batch", commands: [...edit] });
  const carry = pureTranslationFrames(project, moved, instance) === undefined ? referenceMotionTemplateCarryCommands(project, moved, instance) : [];
  const carried = [...edit, ...carry];
  let after = moved;
  if (carry.length) { try { after = applyCommand(project, { type: "batch", commands: carried }); } catch { return undefined; } }
  const frames = pureTranslationFrames(project, after, instance);
  if (frames === undefined) return undefined;
  const newStart = instance.input.startFrame + frames;
  if (instance.input.startFrame === 0 || newStart === 0) return undefined;
  // The compiler never lays a template over another title or graphic. When the edit carries the template onto one (a
  // title left behind by a deleted clip, say), it is laid out again instead, and the compiler says plainly why it cannot.
  const owned = new Set(instance.roles.map(role => role.id)), fps = project.fps;
  const [from, to] = [newStart / fps, (newStart + instance.input.durationFrames) / fps];
  if (after.motionGraphics.some(graphic => !owned.has(graphic.id) && graphic.timelineStart < to && graphic.timelineStart + graphic.duration > from)) return undefined;
  const next: ReferenceMotionTemplateInstance = { ...structuredClone(instance), instanceRevision: instance.instanceRevision + 1,
    input: { ...structuredClone(instance.input), startFrame: newStart } };
  next.appliedScopeSha256 = await referenceMotionTemplateInstanceScopeSha256(after, next); check();
  referenceMotionInstanceSchema.parse(next);
  const commands: EditorCommand[] = [...carried, { type: "upsert_reference_motion_instance", instance: next, expectedInstanceRevision: instance.instanceRevision }];
  return { instance: next, commands };
}

/**
 * A clip edit that changes a CURRENT saved template (`edit`, which must leave the template's own layers alone: a trim,
 * extension, move, split, new in-point or ripple of its main clip), with the template recompiled against the edited
 * clip in the same command — or, when the edit only carried it along by whole frames, re-recorded at its new place.
 * The returned commands are the whole gesture: commit them as one batch for one Undo. Throws without changing anything
 * when the template cannot follow; plainReferenceMotionRebuildReason says why.
 */
export async function prepareReferenceMotionTemplateFollow(project: EditProject, id: string, edit: readonly EditorCommand[],
  dependencies: ReferenceMotionTemplateRebuildDependencies, options: ReferenceMotionTemplateFollowOptions = {}) {
  return lifetime(project, edit, dependencies, async (deps, check) => {
    const inspection = await inspectReferenceMotionTemplateInstance(project, id); check();
    if (inspection.status !== "CURRENT" || !inspection.instance) throw new ReferenceMotionRebuildRefusal(inspection.status === "ENVIRONMENT_CHANGED"
      ? TEMPLATE_REBUILD_ENVIRONMENT : inspection.status === "MISSING" ? TEMPLATE_REBUILD_MISSING : TEMPLATE_REBUILD_NOT_CURRENT);
    const instance = inspection.instance;
    if (dependencies.expectedInstanceRevision !== undefined && instance.instanceRevision !== dependencies.expectedInstanceRevision) throw new Error("Saved template instance revision is stale");
    if (!options.liftWholeClip && options.retargetTo === undefined) {
      assertEditLeavesTemplate(edit, instance);
      const moved = await translatedRecord(project, instance, edit, check);
      if (moved) return moved;
    }
    const makeId = dependencies.idFactory ?? ((prefix: string) => `${prefix}-${globalThis.crypto.randomUUID()}`);
    const { instance: next, commands } = await rebuildOnMainClip(project, instance, edit, deps, check, makeId, false, options);
    return { instance: next, commands };
  });
}

/**
 * 「依目前片段重新套用」: lay a saved template out again on its main clip as the clip is now, keeping its words, fonts
 * and colours. For a template that went out of date (its clip was trimmed or moved before templates followed, or its
 * own layers were changed or are gone); anything external that depends on the template is never removed to make room.
 * UNCHANGED when the template is already exactly what the compiler makes for the current clip.
 */
export async function prepareReferenceMotionTemplateReapply(project: EditProject, id: string, dependencies: ReferenceMotionTemplateRebuildDependencies) {
  return lifetime(project, { reapply: id }, dependencies, async (deps, check) => {
    const inspection = await inspectReferenceMotionTemplateInstance(project, id); check();
    const instance = inspection.instance;
    if (!instance) throw new ReferenceMotionRebuildRefusal(TEMPLATE_REBUILD_MISSING);
    if (dependencies.expectedInstanceRevision !== undefined && instance.instanceRevision !== dependencies.expectedInstanceRevision) throw new Error("Saved template instance revision is stale");
    const makeId = dependencies.idFactory ?? ((prefix: string) => `${prefix}-${globalThis.crypto.randomUUID()}`);
    let result: Awaited<ReturnType<typeof rebuildOnMainClip>>;
    try { result = await rebuildOnMainClip(project, instance, [], deps, check, makeId, true); }
    catch (error) {
      // Cancellation stays cancellation; every other refusal is said plainly, and nothing was changed.
      if (dependencies.signal?.aborted || (error instanceof Error && /cancelled|source generation changed/.test(error.message))) throw error;
      throw new ReferenceMotionRebuildRefusal(plainReferenceMotionRebuildReason(error));
    }
    const sourceGeneration = { ...result.packet.sourceGeneration, projectSha256: await digest(project) };
    if (result.unchanged) return { ...result.packet, sourceGeneration, status: "UNCHANGED" as const, instance, commands: [] as EditorCommand[] };
    return { ...result.packet, sourceGeneration, instance: result.instance, commands: result.commands };
  });
}

// ── Titles made with an earlier Editkin ─────────────────────────────────────────────────────────────────────────────
// An Editkin update can move a template's recipe, one of its presets or a bundled font on; the project's saved titles
// then read ENVIRONMENT_CHANGED and take no new words until each one is re-applied by hand. 「把標題更新到新版」
// re-applies all of them at once — the ones nobody changed after they were made — on their main clip as it is now,
// with their saved words, fonts and colours, through today's compiler and bundled fonts, as one command (one Undo).
// Hand-edited (EDITED) and MISSING templates are left alone, and so is a canvas or frame-rate change: that is the
// project's own change, not an update. The inspection itself is unchanged; this only reads its verdict.

/** assertEnvironment's words when Editkin itself moved on: the template recipe, a preset or a bundled font. */
const EDITKIN_UPDATE_REASONS: ReadonlySet<string> = new Set([
  "ENVIRONMENT_CHANGED: template recipe contract changed",
  "ENVIRONMENT_CHANGED: registered template preset is unavailable",
  "ENVIRONMENT_CHANGED: registered template preset changed",
  "ENVIRONMENT_CHANGED: compiled physical template font is unavailable",
  "ENVIRONMENT_CHANGED: physical template font dependency changed",
]);
/** True when an ENVIRONMENT_CHANGED reason means an Editkin update (not the project's canvas or frame rate). */
export function isEditkinUpdateReason(reason: string): boolean {
  return EDITKIN_UPDATE_REASONS.has(reason);
}
/** Why an old title was not updated with the others: someone changed it, or its clip, after it was made. */
export const TEMPLATE_UPDATE_EDITED = "這個標題做好之後被改過（或它的片段被修剪、移動過），沒有自動更新；可以在標題模板編輯器按「依目前片段重新套用」。";
export const TEMPLATES_UPDATE_NONE = "標題都已經是新版，不用更新。";

export interface ReferenceMotionTemplateBehindUpdate {
  instance: ReferenceMotionTemplateInstance;
  /** Changed after it was made (its own layers or its main clip no longer hash to what was saved): reported, not updated. */
  editedSince: boolean;
}

/** The saved titles an Editkin update left behind, in timeline order. */
export async function referenceMotionTemplatesBehindUpdate(project: EditProject): Promise<ReferenceMotionTemplateBehindUpdate[]> {
  const found: ReferenceMotionTemplateBehindUpdate[] = [];
  for (const stored of project.referenceMotionInstances ?? []) {
    const inspection = await inspectReferenceMotionTemplateInstance(project, stored.id);
    if (inspection.status !== "ENVIRONMENT_CHANGED" || !inspection.instance || !isEditkinUpdateReason(inspection.reason)) continue;
    let editedSince = true;
    try { editedSince = await referenceMotionTemplateInstanceScopeSha256(project, inspection.instance) !== inspection.instance.appliedScopeSha256; }
    catch { /* A scope that cannot be read is not the one that was saved. */ }
    found.push({ instance: inspection.instance, editedSince });
  }
  return found.sort((a, b) => a.instance.input.startFrame - b.instance.input.startFrame);
}

export interface ReferenceMotionTemplatesUpdate {
  /** The whole update as one flat command list: commit it as one batch for one Undo. Empty when nothing changes. */
  commands: EditorCommand[];
  updated: Array<{ instanceId: string; title: string }>;
  /** Old titles that stay as they were, with the plain reason (too short for today's template, changed by hand…). */
  notUpdated: Array<{ instanceId: string; title: string; reason: string }>;
  /** The plain report for the status line: 「已更新 3 個標題…」; the reasons themselves go with notUpdated. */
  message: string;
}

/** The status-line report of 「把標題更新到新版」. */
export function referenceMotionTemplatesUpdateMessage(updated: number, notUpdated: ReadonlyArray<{ title: string }>): string {
  if (!notUpdated.length) return updated ? `已更新 ${updated} 個標題；文字、字型和配色都保留，一次復原即可還原。` : TEMPLATES_UPDATE_NONE;
  const which = notUpdated.length === 1 ? `「${notUpdated[0].title}」` : `${notUpdated.length} 個標題`;
  return updated ? `已更新 ${updated} 個標題；${which}沒有更新，原因列在標題更新提示裡；一次復原即可還原。`
    : `標題沒有更新：${which}不能自動更新，原因列在標題更新提示裡。`;
}

/**
 * 「把標題更新到新版」: every title an Editkin update left behind is re-applied (prepareReferenceMotionTemplateReapply)
 * in timeline order, each on the project as the ones before it leave it, and must read CURRENT afterwards. A title that
 * cannot be laid out by today's template (its clip is now too short, say) is reported with the reason and left exactly
 * as it was — never forced. Running it again changes nothing. Cancellation cancels the whole update.
 */
export async function prepareReferenceMotionTemplatesUpdate(project: EditProject, dependencies: ReferenceMotionTemplateRebuildDependencies): Promise<ReferenceMotionTemplatesUpdate> {
  const commands: EditorCommand[] = [], updated: ReferenceMotionTemplatesUpdate["updated"] = [], notUpdated: ReferenceMotionTemplatesUpdate["notUpdated"] = [];
  let current = project;
  for (const { instance, editedSince } of await referenceMotionTemplatesBehindUpdate(project)) {
    const row = { instanceId: instance.id, title: instance.input.title };
    if (editedSince) { notUpdated.push({ ...row, reason: TEMPLATE_UPDATE_EDITED }); continue; }
    try {
      const prepared = await prepareReferenceMotionTemplateReapply(current, instance.id, { ...dependencies, expectedInstanceRevision: instance.instanceRevision });
      if (!prepared.commands.length) throw new ReferenceMotionRebuildRefusal(TEMPLATE_REBUILD_OTHER);
      const next = applyCommand(current, { type: "batch", commands: prepared.commands });
      if ((await inspectReferenceMotionTemplateInstance(next, instance.id)).status !== "CURRENT") throw new ReferenceMotionRebuildRefusal(TEMPLATE_REBUILD_OTHER);
      commands.push(...prepared.commands); current = next; updated.push(row);
    } catch (error) {
      if (dependencies.signal?.aborted || (error instanceof Error && /cancelled|source generation changed/.test(error.message))) throw error;
      notUpdated.push({ ...row, reason: plainReferenceMotionRebuildReason(error) });
    }
  }
  return { commands, updated, notUpdated, message: referenceMotionTemplatesUpdateMessage(updated.length, notUpdated) };
}

/** The update in the shape the editor's template runner takes (REVIEW_REQUIRED to commit, UNCHANGED when nothing changes). */
export async function prepareReferenceMotionTemplatesUpdatePacket(project: EditProject, dependencies: ReferenceMotionTemplateRebuildDependencies) {
  const templatesUpdate = await prepareReferenceMotionTemplatesUpdate(project, dependencies);
  return { status: templatesUpdate.commands.length ? "REVIEW_REQUIRED" as const : "UNCHANGED" as const, commands: templatesUpdate.commands, templatesUpdate };
}
