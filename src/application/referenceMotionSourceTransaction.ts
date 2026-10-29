import type { EditProject, MediaAsset } from "../domain/types";
import type { EditorCommand } from "../domain/commandTypes";
import { applyCommand, type EditorCommandContext } from "../domain/commands";
import { referenceMotionInstanceSchema } from "../domain/referenceMotionInstance";
import { getSourceWindowError, getSourceAnalysisBindingError } from "../domain/clipSourceReplacement";
import { REFERENCE_MOTION_SOURCE_LINK_MESSAGE, referenceMotionSourceShrinkError } from "../domain/referenceMotionSourceRebind";
import { issueReferenceMotionSourceOwnerProof } from "../domain/referenceMotionSourceOwnerProof";
import { mediaFrameRateSchema, type MediaFrameRate } from "../domain/mediaFrameRate";
import { issueNativePaintOwnerRevisionProof } from "../domain/nativePaintOwnerRevision";
import { canonicalJson } from "../shared/canonicalJson";
import { isNativeReferenceMotionPresentation } from "../motion/referenceMotionTemplates";
import { referenceMotionTemplateSourceColorAdmitted } from "./referenceMotionTemplateCommands";
import { referenceMotionReuseSourceIdentity } from "./referenceMotionTemplateReuse";
import { normalizeReferenceMotionTemplateInput, prepareReferenceMotionTemplate, type ReferenceMotionTemplatePreparationDependencies } from "./referenceMotionTemplates";
import { inspectReferenceMotionTemplateInstance, referenceMotionInstanceRecompilePrimitivesV1 as shared,
  type ReferenceMotionTemplateInstanceIdFactory } from "./referenceMotionTemplateInstances";
import { referenceMotionSourceReplacementRequestSchema, referenceMotionSourceSlots, sourceReplacementExactFrame,
  sourceReplacementMinimumFrames, SOURCE_REPLACEMENT_MESSAGES as messages, type ReferenceMotionSourceReplacementRequest } from "./referenceMotionSourceReplacement";

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const allClips = (project: EditProject) => project.tracks.flatMap(track => track.clips);
const clipOf = (project: EditProject, id: string) => allClips(project).find(clip => clip.id === id)!;
const live = new WeakMap<object, { original: string; commands: string; context?: EditorCommandContext }>();

/** This operation compiles graph/glyph changes. Filesystem and measured-media admission remain at GUI/MCP ingress. */
export async function prepareReferenceMotionTemplateSourceReplacement(project: EditProject, raw: ReferenceMotionSourceReplacementRequest,
  idFactory: ReferenceMotionTemplateInstanceIdFactory,
  dependencies: ReferenceMotionTemplatePreparationDependencies & { pendingImport?: MediaAsset; sourceFrameRates?: Readonly<Record<string, MediaFrameRate>> }) {
  const incoming = dependencies.pendingImport ? structuredClone(dependencies.pendingImport) : undefined;
  const incomingIdentity = canonicalJson(dependencies.pendingImport ?? null);
  const measuredRates = structuredClone(dependencies.sourceFrameRates ?? {}), rateIdentity = canonicalJson(dependencies.sourceFrameRates ?? {});
  for (const rate of Object.values(measuredRates)) mediaFrameRateSchema.parse(rate);
  return shared.lifetime(project, raw, dependencies, async (deps, lifetimeCheck) => {
    const check = () => { lifetimeCheck(); if (canonicalJson(dependencies.pendingImport ?? null) !== incomingIdentity
      || canonicalJson(dependencies.sourceFrameRates ?? {}) !== rateIdentity) throw new Error(messages.stale); };
    const request = referenceMotionSourceReplacementRequestSchema.parse(raw); check();
    if (project.revision !== request.expectedProjectRevision) throw new Error(messages.stale);
    if (incoming && project.assets.some(asset => asset.id === incoming.id)) throw new Error("新匯入的影片識別已存在，模板沒有變更。");
    const base = incoming ? applyCommand(project, { type: "import_asset", asset: incoming }) : project;
    const inspection = await inspectReferenceMotionTemplateInstance(base, request.instanceId); check();
    if (inspection.status !== "CURRENT" || !inspection.instance) throw new Error(messages.edited);
    const before = inspection.instance;
    if (before.instanceRevision !== request.expectedInstanceRevision) throw new Error(messages.stale);
    const previousSlots = referenceMotionSourceSlots(base, before), input = structuredClone(before.input);
    if ((request.sources?.length ?? 0) > input.sources.length) throw new Error(messages.topology);
    if (input.sources.length && request.audio.extra?.length !== input.sources.length
      || !input.sources.length && (request.audio.extra?.length ?? 0) !== 0) throw new Error(messages.extraAudio);
    if (request.audio.extra?.some(audio => audio !== "muted")) throw new Error(messages.extraAudio);
    const durationFrames = request.durationFrames ?? input.durationFrames;
    if (durationFrames < sourceReplacementMinimumFrames(base, before)) throw new Error("影片長度不足以保留模板的閱讀停留。");
    const duration = durationFrames / base.fps, primary = clipOf(base, input.clipId);
    const shrinkError = referenceMotionSourceShrinkError(base, before, duration); if (shrinkError) throw new Error(shrinkError);
    const primaryWindow = request.primary ?? { assetId: primary.assetId, sourceStart: primary.sourceStart };
    const primaryVolume = request.audio.primary === "keep_level" ? primary.volume : request.audio.primary === "mute" ? 0 : 1;
    input.durationFrames = durationFrames;
    input.sources = input.sources.map((source, index) => {
      const patch = request.sources?.[index];
      if (patch && patch.assetId !== source.assetId && patch.label === undefined) throw new Error(messages.extraLabel);
      return { ...source, ...(patch ?? {}) };
    });
    const assetChanged = primaryWindow.assetId !== primary.assetId || input.sources.some((source, index) => source.assetId !== before.input.sources[index].assetId);
    if (assetChanged) {
      if (!request.evidenceRefs?.length || request.evidenceRefs.some(ref => before.input.evidenceRefs.includes(ref))) throw new Error(messages.freshEvidence);
      if (request.focusRegion === undefined || request.textRegion === undefined) throw new Error(messages.regions);
    }
    for (const key of ["focusRegion", "textRegion"] as const) {
      if (request[key] === null) delete input[key]; else if (request[key] !== undefined) input[key] = structuredClone(request[key]);
    }
    if (request.purpose !== undefined) input.purpose = request.purpose;
    if (request.evidenceRefs !== undefined) input.evidenceRefs = [...request.evidenceRefs];
    const nextInput = normalizeReferenceMotionTemplateInput(input);
    const nextSlots = [primaryWindow, ...nextInput.sources], nativePaint = isNativeReferenceMotionPresentation(input.graphicPresentation);
    const assets: MediaAsset[] = [], idsSeen = new Set<string>(), urisSeen = new Set<string>(), hashesSeen = new Set<string>();
    for (const [index, slot] of nextSlots.entries()) {
      const asset = base.assets.find(asset => asset.id === slot.assetId), originalSlot = previousSlots[index];
      if (!asset || asset.kind !== "video" || asset.compositionId || asset.imageSequence || /^editkin-composition:/i.test(asset.uri)) throw new Error(messages.videoOnly);
      if (!Number.isSafeInteger(asset.width) || !Number.isSafeInteger(asset.height) || asset.width! <= 0 || asset.height! <= 0
        || asset.displayAspectRatio !== undefined && (!Number.isFinite(asset.displayAspectRatio) || asset.displayAspectRatio <= 0)) throw new Error(messages.geometry);
      if (input.mediaPresentation === "source_soft_v2" && (!Number.isFinite(asset.displayAspectRatio) || asset.displayAspectRatio! <= 0)) throw new Error(messages.geometry);
      if (input.mediaPresentation === "source_soft_v2" && ![undefined, "auto", "rec709"].includes(asset.color?.interpretation)) throw new Error(messages.color);
      if (!referenceMotionTemplateSourceColorAdmitted(base, asset, nativePaint)) throw new Error(messages.color);
      if (sourceReplacementExactFrame(slot.sourceStart, base.fps) === undefined) throw new Error(messages.frame);
      if (!Number.isFinite(asset.duration) || slot.sourceStart + duration > asset.duration + 1e-7 / base.fps) throw new Error("影片從指定起點起不夠長，模板沒有變更。");
      const identity = referenceMotionReuseSourceIdentity(asset.uri), sha = asset.derivatives?.sourceSha256?.toLowerCase();
      if (idsSeen.has(asset.id) || urisSeen.has(identity) || sha && hashesSeen.has(sha)) throw new Error(messages.alias);
      idsSeen.add(asset.id); urisSeen.add(identity); if (sha) hashesSeen.add(sha); assets.push(asset);
      if (index > 0 && !originalSlot.clipIds.length) throw new Error(messages.topology);
      for (const clipId of originalSlot.clipIds) {
        const clip = clipOf(base, clipId), track = base.tracks.find(track => track.id === clip.trackId)!;
        if (clip.linkGroupId) throw new Error(REFERENCE_MOTION_SOURCE_LINK_MESSAGE);
        if (Math.abs(clip.timelineStart - before.input.startFrame / base.fps) > 1e-7
          || Math.abs(clip.duration - before.input.durationFrames / base.fps) > 1e-7) throw new Error(messages.topology);
        const reason = getSourceWindowError(base, track, clip, asset, slot.sourceStart, duration) ?? getSourceAnalysisBindingError(base, clip);
        if (reason) throw new Error(reason);
      }
    }
    const ownedClipIds = new Set(previousSlots.flatMap(slot => slot.clipIds));
    for (const slot of previousSlots) for (const clipId of slot.clipIds) {
      const clip = clipOf(base, clipId), track = base.tracks.find(track => track.id === clip.trackId)!;
      if (duration > clip.duration && track.clips.some(other => !ownedClipIds.has(other.id) && other.timelineStart >= clip.timelineStart
        && other.timelineStart < clip.timelineStart + duration - 1e-7)) throw new Error(messages.nextClip);
    }
    const ownedGraphics = new Set(before.roles.filter(role => role.kind === "graphic").map(role => role.id)), start = before.input.startFrame / base.fps;
    if (base.motionGraphics.some(graphic => !ownedGraphics.has(graphic.id) && graphic.timelineStart < start + duration - 1e-7 && graphic.timelineStart + graphic.duration > start + 1e-7)) {
      throw new Error(messages.foreignMotion);
    }
    const scratch = shared.scratchProject(base, before), scratchPrimary = clipOf(scratch, input.clipId);
    if (incoming && !nextSlots.some(slot => slot.assetId === incoming.id)) throw new Error("新匯入的影片沒有對應到模板素材槽，模板沒有變更。");
    Object.assign(scratchPrimary, primaryWindow, { duration, volume: primaryVolume });
    const allocator = shared.allocator(base, idFactory, before.roles);
    let packet: Awaited<ReturnType<typeof prepareReferenceMotionTemplate>>;
    try { packet = await prepareReferenceMotionTemplate(scratch, nextInput, allocator, deps); }
    catch (error) {
      if (request.focusRegion === undefined && input.focusRegion && error instanceof Error && /主體範圍/.test(error.message)) throw new Error(messages.crop);
      if (assetChanged && error instanceof Error && /影像區塊沒有足夠空間|主標太長.*影像|source area|media area|source-safe area/i.test(error.message)) throw new Error(messages.layout);
      throw error;
    }
    check();
    const compiled = applyCommand(scratch, { type: "batch", commands: packet.commands });
    const next = { ...structuredClone(before), input: nextInput, roles: packet.roles!, instanceRevision: before.instanceRevision + 1,
      dependencies: await shared.dependenciesFor(packet, nextInput), appliedScopeSha256: "" };
    const projection = structuredClone(base), sourceCommands: EditorCommand[] = [];
    const binding = { slots: previousSlots.map((slot, index) => ({ slot: index, clipIds: [...slot.clipIds],
      before: { assetId: slot.assetId, sourceStart: slot.sourceStart, durationFrames: slot.durationFrames },
      after: { assetId: nextSlots[index].assetId, sourceStart: nextSlots[index].sourceStart, durationFrames } })) };
    for (const slot of previousSlots) for (const clipId of slot.clipIds) {
      const original = clipOf(base, clipId), after = clipOf(compiled, clipId);
      if (!after) throw new Error(messages.topology);
      if (original.assetId !== after.assetId || original.sourceStart !== after.sourceStart || original.duration !== after.duration) sourceCommands.push({
        type: "rebind_reference_motion_clip_source", clipId, expected: { assetId: original.assetId, sourceStart: original.sourceStart, duration: original.duration },
        assetId: after.assetId, sourceStart: after.sourceStart, duration: after.duration });
      if (original.volume !== after.volume) sourceCommands.push({ type: "set_clip_volume", clipId, volume: after.volume });
      Object.assign(clipOf(projection, clipId), { assetId: after.assetId, sourceStart: after.sourceStart, duration: after.duration, volume: after.volume });
    }
    for (const role of before.roles.filter(role => role.kind === "track")) {
      const original = projection.tracks.find(track => track.id === role.id), after = compiled.tracks.find(track => track.id === role.id);
      if (!original || !after) throw new Error(messages.topology);
      if (original.name !== after.name) {
        sourceCommands.push({ type: "rename_track", trackId: role.id, name: after.name }); original.name = after.name;
      }
    }
    let visualCommands: EditorCommand[];
    try { visualCommands = shared.revisionCommands(projection, before, compiled, next.roles); }
    catch (error) { if (error instanceof Error && /topology|semantic identity/.test(error.message)) throw new Error(messages.topology); throw error; }
    next.appliedScopeSha256 = await shared.digest(shared.scopePayload(compiled, next)); referenceMotionInstanceSchema.parse(next); check();
    const changed = sourceCommands.length || visualCommands.length || !same(before.input, next.input) || !same(before.dependencies, next.dependencies) || !same(before.roles, next.roles);
    const commands: EditorCommand[] = changed ? [...(incoming ? [{ type: "import_asset" as const, asset: incoming }] : []), ...sourceCommands, ...visualCommands,
      { type: "upsert_reference_motion_instance", instance: next, expectedInstanceRevision: before.instanceRevision }] : [];
    const batch: EditorCommand = { type: "batch", commands }, context: EditorCommandContext | undefined = changed ? {
      ...(sourceCommands.some(command => command.type === "rebind_reference_motion_clip_source")
        ? { referenceMotionSourceOwnerProof: issueReferenceMotionSourceOwnerProof(project, batch, [before.id]) } : {}),
      ...(nativePaint ? { nativePaintOwnerRevisionProof: issueNativePaintOwnerRevisionProof(project, batch, [before.id]) } : {}),
    } : undefined;
    if (changed) {
      const final = applyCommand(project, batch, context);
      if (!same(shared.scopePayload(final, next), shared.scopePayload(compiled, next))) throw new Error("Template source delta did not reproduce the exact physically compiled scope");
      if ((await inspectReferenceMotionTemplateInstance(final, before.id)).status !== "CURRENT") throw new Error("Template source delta did not leave its saved instance CURRENT");
    }
    check();
    const materialRequirements = binding.slots.filter(slot => !same(slot.before, slot.after)).map(slot => ({ assetId: slot.after.assetId,
      sourceStart: slot.after.sourceStart, duration }));
    const result = { status: changed ? "PREPARED_NOT_APPLIED" as const : "UNCHANGED" as const, readOnly: true as const,
      instance: changed ? next : before, before, commands, binding, materialRequirements,
      audioDisposition: { primary: { clipId: primary.id, volumeBefore: primary.volume, volumeAfter: primaryVolume },
        extraPolicy: "muted_fixed_v1" as const,
        extra: nextInput.sources.map((_source, index) => ({ slot: index + 1, clipIds: previousSlots[index + 1].clipIds, audio: "muted" as const })) },
      sourceFrameRates: assets.map(asset => ({ assetId: asset.id, frameRate: measuredRates[asset.id] ?? null })),
      sourceGeneration: { ...packet.sourceGeneration, projectSha256: await shared.digest(project) },
      previousQaOrArtworkApprovalReusable: false as const, physicalLayoutBindings: packet.physicalLayoutBindings, editorialGraphics: packet.editorialGraphics,
      footageDecision: { assetChanged, observationsKeptForSameAsset: !assetChanged && request.evidenceRefs === undefined },
      textRegionKeptFromPreviousFootage: Boolean(input.textRegion && request.textRegion === undefined && !assetChanged
        && primaryWindow.sourceStart !== primary.sourceStart) };
    check(); live.set(result, { original: canonicalJson(project), commands: canonicalJson(commands), context }); return result;
  });
}
export type ReferenceMotionSourceReplacementPreparation = Awaited<ReturnType<typeof prepareReferenceMotionTemplateSourceReplacement>>;
/** Only the live, unchanged preparation and original project own a commit context; serialized receipts carry no grant. */
export function referenceMotionSourceReplacementCommandContext(project: EditProject, prepared: ReferenceMotionSourceReplacementPreparation): EditorCommandContext | undefined {
  const proof = live.get(prepared);
  if (!proof || proof.original !== canonicalJson(project) || proof.commands !== canonicalJson(prepared.commands)) throw new Error(messages.stale);
  return proof.context;
}
