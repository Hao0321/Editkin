import * as z from "zod/v4";
import { isAbsolute, resolve } from "node:path";
import type { EditorCommand } from "../domain/commandTypes";
import { applyCommand } from "../domain/commands";
import { dispatchCommandSafely } from "../domain/history";
import { canonicalJson } from "../shared/canonicalJson";
import { buildGpuEngineVideoPreviewGraph } from "../render/gpuCompositor";
import { resolveMediaPath } from "../render/mediaProcess";
import { beginEditorialDataGraphicsV1, requireEditorialDataClipV1, type EditorialDataContextV1, type EditorialDataRuntimeV1 } from "./editorialDataGraphicsV1";
import { createProjectSession, type ProjectSession } from "./projectSession";
import { rotoV2FileIdentity, assertRotoV2IdentityUnchanged } from "./rotoV2Workspace";
import { valueParticleRequestV1Schema, prepareValueParticlesV1, applyPreparedValueParticlesV1, type PreparedValueParticlesV1, type ValueParticleRuntimeV1 } from "./valueParticlesV1";

const old = valueParticleRequestV1Schema.shape;
export const manualValueParticleRequestV1Schema = z.strictObject({ schema: z.literal("editkin.manual-value-particles/v1"),
  expectedRevision: old.expectedRevision, id: old.id, clipId: old.clipId, range: old.range, parameters: old.parameters,
  createdAt: z.string().datetime(), value: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("material_evidence"), evidence: old.evidence }),
    z.strictObject({ kind: z.literal("user_asserted"), quotedValue: old.evidence.shape.quotedValue, confirmed: z.literal(true) }),
  ]) });
export type ManualValueParticleRequestV1 = z.infer<typeof manualValueParticleRequestV1Schema>;
export interface ManualValueParticleHostV1 extends ValueParticleRuntimeV1 {
  assetBase: string;
  /** H15 supplies plain human-readable provenance notes. These become visible project notes. */
  notes: Record<ManualValueParticleRequestV1["value"]["kind"], string>;
}
export interface PreparedManualValueParticlesV1 {
  schema: "editkin.manual-value-particle-plan/v1"; basis: ManualValueParticleRequestV1["value"]["kind"];
  quotedValue: string; projectId: string; expectedRevision: number; range: ManualValueParticleRequestV1["range"];
  nativeEmitterId: string; provenanceMarkerId: string; sourceSha256: string;
  qualityState: "ART_PENDING_CLAUDE"; defaultEnabled: false; currencyGlyphs: false; directApplyAllowed: false;
}
interface Owned {
  context: EditorialDataContextV1; command: EditorCommand; fingerprint: string;
  receipt: PreparedManualValueParticlesV1;
  source: Awaited<ReturnType<typeof rotoV2FileIdentity>>;
  evidence?: { session: ProjectSession; packet: PreparedValueParticlesV1 };
}
const plans = new WeakMap<PreparedManualValueParticlesV1, Owned>();
/** Explicit manual authoring only. Failed evidence never falls back to a declared value. */
export async function prepareManualValueParticlesV1(session: ProjectSession, payload: unknown, requestedHost: ManualValueParticleHostV1, runtime: EditorialDataRuntimeV1 = {}) {
  const request = manualValueParticleRequestV1Schema.parse(structuredClone(payload));
  const context = beginEditorialDataGraphicsV1(session, request.expectedRevision, runtime), { track, clip } = requireEditorialDataClipV1(context, request.clipId);
  const host = { cacheRoot: requestedHost.cacheRoot, assetBase: requestedHost.assetBase, resolveSource: requestedHost.resolveSource.bind(requestedHost), notes: { ...requestedHost.notes } };
  const asset = context.source.assets.find(a => a.id === clip.assetId), start = request.range.startFrame / context.source.fps, end = request.range.endFrame / context.source.fps;
  if (!asset || asset.kind !== "video" || asset.compositionId || asset.clipRetime || clip.timeRemap || (clip.speed ?? 1) !== 1 || track.hidden
    || end <= start || start < clip.timelineStart - 1e-8 || end > clip.timelineStart + clip.duration + 1e-8 || end > 86400) throw Error("MANUAL_VALUE_SOURCE_OR_RANGE_UNSUPPORTED");
  if (!isAbsolute(host.assetBase) || resolve(host.assetBase) !== host.assetBase) throw Error("MANUAL_VALUE_ABSOLUTE_ASSET_BASE_REQUIRED");
  const path = await context.wait(() => host.resolveSource(asset.id));
  const local = resolve(resolveMediaPath(asset.uri, host.assetBase));
  if (resolve(path).toLowerCase() !== local.toLowerCase()) throw Error("MANUAL_VALUE_ORIGINAL_SOURCE_REQUIRED");
  const source = await context.wait(() => rotoV2FileIdentity(path, context.remaining));
  if (asset.derivatives?.sourceSha256 !== undefined && asset.derivatives.sourceSha256 !== source.sha256) throw Error("MANUAL_VALUE_SOURCE_SHA_CHANGED");
  let command: EditorCommand, nativeEmitterId: string, evidence: Owned["evidence"];
  if (request.value.kind === "material_evidence") {
    const materialEvidence = request.value.evidence;
    const shadow = createProjectSession(structuredClone(context.source));
    const packet = await context.wait(() => prepareValueParticlesV1(shadow, { cacheRoot: host.cacheRoot,
      resolveSource: async id => { context.remaining(); const p = await context.wait(() => host.resolveSource(id)); context.remaining(); return p; } },
    { expectedRevision: request.expectedRevision, id: request.id, clipId: request.clipId, range: request.range, parameters: request.parameters, evidence: materialEvidence }, context.settings.signal));
    command = structuredClone(packet.command); nativeEmitterId = packet.nativeEmitterId; evidence = { session: shadow, packet };
  } else {
    const existing = context.source.particleSimulation, id = `value-${request.id}`, parameters = { ...structuredClone(request.parameters), timeline: { start, duration: end - start } };
    if (existing && (!existing.enabled || existing.additionalEmitters?.some(e => e.id === id))) throw Error("MANUAL_VALUE_EMITTER_DISABLED_OR_DUPLICATE");
    nativeEmitterId = existing ? id : "primary";
    const settings = existing ? { ...structuredClone(existing), additionalEmitters: [...structuredClone(existing.additionalEmitters ?? []), { id, ...parameters }] }
      : { schema: "editkin.particle-simulation/v1" as const, enabled: true, ...parameters };
    command = { type: "batch", commands: [...(existing ? [] : [{ type: "configure_particle_simulation" as const, enabled: true }]), { type: "set_particle_simulation_settings", settings }] };
  }
  const basis = request.value.kind, quotedValue = request.value.kind === "user_asserted" ? request.value.quotedValue : request.value.evidence.quotedValue;
  const markerId = `value-${basis}-${request.id}`, note = host.notes[basis];
  if (typeof note !== "string" || !note.trim() || note.length > 500 || context.source.director.markers.some(m => m.id === markerId)) throw Error("MANUAL_VALUE_PROVENANCE_NOTE_REQUIRED_OR_DUPLICATE");
  const batch: EditorCommand = { type: "batch", commands: [command, { type: "add_director_marker", marker: { id: markerId, time: start, title: quotedValue, note, kind: "note", status: "open", createdAt: request.createdAt } }] };
  const candidate = applyCommand(structuredClone(context.source), batch);
  if (!buildGpuEngineVideoPreviewGraph(candidate, start)) throw Error("MANUAL_VALUE_NATIVE_VIDEO_ROUTE_UNAVAILABLE");
  context.remaining();
  const plan: PreparedManualValueParticlesV1 = { schema: "editkin.manual-value-particle-plan/v1", basis, quotedValue, projectId: context.source.id,
    expectedRevision: request.expectedRevision, range: structuredClone(request.range), nativeEmitterId, provenanceMarkerId: markerId, sourceSha256: source.sha256,
    qualityState: "ART_PENDING_CLAUDE", defaultEnabled: false, currencyGlyphs: false, directApplyAllowed: false };
  plans.set(plan, { context, command: batch, source, evidence, fingerprint: canonicalJson(plan), receipt: structuredClone(plan) }); return plan;
}
/** Revalidate the actual source/evidence, then use the existing history once. Notes and
 * particles persist together; no new schema, dispatcher or save owner is introduced. */
export async function applyPreparedManualValueParticlesV1(session: ProjectSession, plan: PreparedManualValueParticlesV1, signal?: AbortSignal) {
  const owned = plans.get(plan);
  if (!owned || owned.context.session !== session || canonicalJson(plan) !== owned.fingerprint) throw Error("MANUAL_VALUE_PREPARATION_INVALID_OR_USED");
  plans.delete(plan); const { context } = owned; context.renewForApply(signal);
  const current = () => { context.remaining(); if (canonicalJson(plan) !== owned.fingerprint) throw Error("MANUAL_VALUE_PREPARATION_CHANGED_DURING_APPLY"); };
  await context.wait(() => assertRotoV2IdentityUnchanged(owned.source, context.remaining));
  if (owned.evidence) await context.wait(() => applyPreparedValueParticlesV1(owned.evidence!.session, owned.evidence!.packet, signal ?? context.settings.signal));
  current();
  const result = dispatchCommandSafely(session.getSnapshot().history, structuredClone(owned.command));
  if (result.error) throw Error(result.error);
  current(); session.setHistory(result.state);
  return { status: "applied" as const, undoSteps: 1 as const, basis: owned.receipt.basis, quotedValue: owned.receipt.quotedValue, nativeEmitterId: owned.receipt.nativeEmitterId,
    provenanceMarkerId: owned.receipt.provenanceMarkerId, qualityState: "ART_PENDING_CLAUDE" as const, defaultEnabled: false as const, currencyGlyphs: false as const };
}
