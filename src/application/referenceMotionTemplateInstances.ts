import type { EditProject, MotionGraphic, TimelineClip } from "../domain/types";
import type { EditorCommand } from "../domain/commandTypes";
import { applyCommand, type EditorCommandContext } from "../domain/commands";
import { issueNativePaintOwnerRevisionProof } from "../domain/nativePaintOwnerRevision";
import { referenceMotionInstanceSchema, referenceMotionTemplateRevisionPatchSchema,
  type ReferenceMotionTemplateInstance, type ReferenceMotionInstanceRole, type ReferenceMotionTemplateRevisionPatch } from "../domain/referenceMotionInstance";
import { referenceMotionTemplate, REFERENCE_MOTION_SEMANTIC_REPLACE_CONTRACT, REFERENCE_MOTION_SOURCE_OVERLAY_CONTRACT, REFERENCE_MOTION_NATIVE_PAINT_PRESENTATION_CONTRACT, REFERENCE_MOTION_DISPLAY_PAINT_PRESENTATION_CONTRACT, isNativeReferenceMotionPresentation, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { GRAPHIC_CADENCE_CONTRACT, compileGraphicCadence } from "../motion/graphicCadence";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { canonicalJson } from "../shared/canonicalJson";
import { prepareReferenceMotionTemplate, normalizeReferenceMotionTemplateInput, REFERENCE_MOTION_INSTANCE_RECIPE_VERSION,
  REFERENCE_MOTION_PREPARATION_TIMEOUT_MS, type ReferenceMotionTemplatePreparationDependencies } from "./referenceMotionTemplates";

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
function primary(project: EditProject, instance: Pick<ReferenceMotionTemplateInstance, "input">) {
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

/** External graph dependencies cannot be silently deleted during scratch reconstruction. */
function assertIsolated(project: EditProject, instance: ReferenceMotionTemplateInstance): void {
  const owned = new Set(instance.roles.map(role => role.id));
  const generatedClips = new Set(instance.roles.filter(role => role.kind === "clip" && role.id !== instance.input.clipId).map(role => role.id));
  if (instance.roles.some(role => role.kind === "clip" && role.id === instance.input.clipId)) {
    const original = primary(project, instance);
    if (original.keyframes.some(key => !owned.has(key.id)) || original.masks?.some(mask => mask.enabled && !owned.has(mask.id))) {
      throw new Error("EDITED: primary template visuals contain an external keyframe or enabled mask");
    }
  }
  for (const role of instance.roles) {
    if (element(project, role) === undefined) throw new Error(`MISSING: template role ${role.key} no longer exists in its original parent`);
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
function ownsSoftComparisonFrame(input: ReferenceMotionTemplateInput) {
  return input.templateId === "comparison_pair" && input.mediaPresentation === "source_soft_v2";
}
async function recipeVersion(input: ReferenceMotionTemplateInput) {
  if (input.graphicPresentation === "native_paint_display_v2") {
    return `editkin.reference-motion-recipes/display-paint-v2:${await digest({ recipe: referenceMotionTemplate(input.templateId),
      paint: REFERENCE_MOTION_DISPLAY_PAINT_PRESENTATION_CONTRACT,
      graphicCadence: input.graphicCadence === "brisk" ? GRAPHIC_CADENCE_CONTRACT : "legacy" })}`;
  }
  if (input.graphicPresentation === "native_paint_v1") {
    return `editkin.reference-motion-recipes/native-paint-v1:${await digest({ recipe: referenceMotionTemplate(input.templateId),
      paint: REFERENCE_MOTION_NATIVE_PAINT_PRESENTATION_CONTRACT,
      graphicCadence: input.graphicCadence === "brisk" ? GRAPHIC_CADENCE_CONTRACT : "legacy" })}`;
  }
  if (input.templateId === "strike_reframe" && input.strikePresentation === "semantic_replace_v1") {
    const { staggerFrames, ...profileFrames } = compileGraphicCadence(30, 1, input.graphicCadence);
    const contract = { recipe: referenceMotionTemplate(input.templateId),
      strikePresentation: "semantic_replace_v1", semanticReplace: REFERENCE_MOTION_SEMANTIC_REPLACE_CONTRACT,
      graphicCadence: input.graphicCadence === "brisk" ? GRAPHIC_CADENCE_CONTRACT : "legacy",
      profileFrames: { ...profileFrames, staggerFrames: [1, 2, 16, 128].map(count => ({ count, frames: staggerFrames(count) })) } };
    if (input.strikeSurface === "source_overlay") return `editkin.reference-motion-recipes/source-overlay-v1:${await digest({
      ...contract, sourceOverlay: REFERENCE_MOTION_SOURCE_OVERLAY_CONTRACT })}`;
    return `editkin.reference-motion-recipes/semantic-replace-v1:${await digest(contract)}`;
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
      check(); const run = await dependencies.prepareText(faceId, text); check(); return run;
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
    const normalized = normalizeReferenceMotionTemplateInput(input.templateId === "comparison_pair" && input.mediaPresentation === undefined
      ? { ...input, mediaPresentation: "source_soft_v2" } : input), ids = allocator(project, idFactory);
    const instanceId = ids("reference-motion-instance", "instance");
    const original = primary(project, { input: normalized });
    const packet = await prepareReferenceMotionTemplate(project, normalized, ids, deps); check();
    const candidate = applyCommand(project, { type: "batch", commands: packet.commands });
    const instance: ReferenceMotionTemplateInstance = { schema: "editkin.reference-motion-instance/v1", id: instanceId,
      authoringGeneration: 2, instanceRevision: 1, input: normalized, frameFormat: { width: project.width, height: project.height, fps: project.fps },
      roles: packet.roles!, primaryBefore: { layout: original.layout ? structuredClone(original.layout) : null },
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
  if (patch.strikePresentation !== undefined || patch.brandMark !== undefined || patch.strikeSurface !== undefined) {
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
    } else if (patch.brandMark === null || patch.brandMark === "") delete next.brandMark;
    else if (patch.brandMark !== undefined) next.brandMark = patch.brandMark;
    if (patch.strikeSurface !== undefined) next.strikeSurface = patch.strikeSurface;
  }
  if (patch.graphicCadence !== undefined) next.graphicCadence = patch.graphicCadence;
  if (patch.graphicPresentation !== undefined) {
    if (next.templateId !== "level_bridge") throw new Error("Display paint upgrade requires the saved level_bridge template");
    next.graphicPresentation = patch.graphicPresentation;
  }
  if (patch.title !== undefined) next.title = patch.title;
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
function scratchProject(project: EditProject, instance: ReferenceMotionTemplateInstance): EditProject {
  assertIsolated(project, instance);
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
    if (role.kind !== "graphic") throw new Error("Template revision cannot remove source, track, mask or keyframe topology");
    commands.push({ type: "delete_motion_graphic", graphicId: role.id });
  }
  for (const role of roles) {
    const old = previous.get(role.key), value = element(compiled, role);
    if (old && (old.kind !== role.kind || old.id !== role.id || old.parentId !== role.parentId)) throw new Error("Template semantic identity changed during revision");
    if (!old) {
      if (role.kind !== "graphic") throw new Error("Template revision cannot add source, track, mask or keyframe topology");
      commands.push({ type: "add_motion_graphic", graphic: value as MotionGraphic }); continue;
    }
    const current = element(project, old);
    if (same(current, value)) continue;
    if (role.kind === "graphic") commands.push({ type: "update_motion_graphic", graphicId: role.id, patch: withoutId(value as MotionGraphic) });
    else if (role.kind === "clip") {
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
      commands.push({ type: "update_clip_mask", clipId: role.parentId!, maskId: role.id, patch: withoutId(mask) });
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
export async function prepareReferenceMotionTemplateRevision(project: EditProject, id: string, patch: ReferenceMotionTemplateRevisionPatch,
  dependencies: ReferenceMotionTemplateRevisionDependencies) {
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
